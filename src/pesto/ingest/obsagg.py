"""Per-observation statistics and residuals for one ingested iteration.

Every observation in ``obs_index`` gets a row of numbers computed from the
cached observation ensemble: the same mean, standard deviation, extremes and
quantiles ``aggregate.summarise`` gives a parameter (the same numbers as
numpy's percentile), plus the mean and root-mean-square of simulated minus
observed. Zero-weight observations are model outputs and keep all of it.

Residuals exist wherever ``obs_index`` says the observation has a target:
a real obsval below the sentinel limit, weighted or not. Nothing here
re-tests the stored float32 values. The stored file is stat-major,
``(len(OBS_STATS), n_obs)``, row ``i`` of every stat being sorted position
``i`` of ``obs_index``; the sidecar records the digest of that order.

The noise band is the same shape for the realizations pestpp used as
observations plus noise: it is built only from the ``obs+noise`` file that
discovery found, never from a starting observation ensemble, and without the
realization named ``base``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.aggregate import summarise
from pesto.ingest.basereal import find_base
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsens import load_obs_ensemble
from pesto.ingest.obsindex import (
    FLAG_GREATER,
    FLAG_HAS_TARGET,
    FLAG_LESS,
    SENTINEL_LIMIT,
    ObsIndex,
    blank_sentinels,
    load_obs_index,
)
from pesto.ingest.tables import load_control_table

OBS_STATS = (
    "mean",
    "std",
    "min",
    "max",
    "q05",
    "q25",
    "q50",
    "q75",
    "q95",
    "n_valid",
    "resid_mean",
    "rmse",
)
NOISE_STATS = (
    "mean",
    "std",
    "min",
    "max",
    "q05",
    "q25",
    "q50",
    "q75",
    "q95",
    "n_valid",
)
RESIDUAL_TEXT = "simulated minus observed"
_EXAMPLES = 3


@dataclass(frozen=True, eq=False)
class StoredObsAgg:
    """An observation summary read back through its sidecar. ``values`` is a
    read-only memory map of shape (len(stats), n_obs), float32."""

    iteration: int
    values: np.ndarray
    stats: tuple[str, ...]
    order_digest: str
    counts: dict
    notes: tuple[str, ...]


@dataclass(frozen=True, eq=False)
class StoredNoiseAgg:
    """The noise band read back through its sidecar. ``values`` is a
    read-only memory map of shape (len(stats), n_obs), float32. ``base`` is
    ``"excluded"`` or ``"not present"``."""

    values: np.ndarray
    stats: tuple[str, ...]
    order_digest: str
    source: str
    n_real_used: int
    base: str
    notes: tuple[str, ...]


def _fail(name: str, path: Path | str, reason: str) -> ReadFailure:
    return ReadFailure(name=name, path=str(path), reason=f"{name}: {reason}")


def _block_names(names, positions: np.ndarray) -> list[str]:
    import pyarrow as pa

    return [str(v) for v in names.take(pa.array(positions)).to_pylist()]


def _examples(names, order: np.ndarray, positions: np.ndarray) -> str:
    """Up to three observation names, earliest sorted positions first."""
    picked = np.sort(positions)[:_EXAMPLES]
    return ", ".join(_block_names(names, order[picked]))


def _residual_stats(
    block: np.ndarray, target: np.ndarray, value: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Mean and root-mean-square of simulated minus observed per row, in
    float64, NaN where the row has no target or no valid realization. Only
    rows with a target are ever subtracted, so a placeholder obsval is never
    squared."""
    n = block.shape[0]
    mean = np.full(n, np.nan)
    rmse = np.full(n, np.nan)
    rows = np.flatnonzero(target)
    if rows.size == 0:
        return mean, rmse
    resid = block[rows].astype(np.float64) - value[rows, None]
    valid = ~np.isnan(resid)
    count = valid.sum(axis=1)
    filled = np.where(valid, resid, 0.0)
    has = count > 0
    row_mean = np.full(rows.size, np.nan)
    row_rmse = np.full(rows.size, np.nan)
    row_mean[has] = filled.sum(axis=1)[has] / count[has]
    row_rmse[has] = np.sqrt((filled**2).sum(axis=1)[has] / count[has])
    mean[rows] = row_mean
    rmse[rows] = row_rmse
    return mean, rmse


def write_obs_agg(
    iteration: int, layout: CacheLayout, *, block_rows: int = 50_000
) -> WrittenArtifact | ReadFailure:
    """Write ``agg/obs_K.f32`` and then its sidecar ``agg/obs_K.json``, or
    leave nothing behind. Reads the cached ``obs_ens/K``, never the source
    file."""
    name = f"obs_agg/{iteration}"
    payload_path = layout.obs_agg(iteration)
    sidecar_path = layout.obs_agg_meta(iteration)
    written: list[Path] = []
    try:
        index = load_obs_index(layout)
        if isinstance(index, ReadFailure):
            return _fail(name, index.path, f"the obs_index could not be read: {index.reason}")
        stored = load_obs_ensemble(iteration, layout)
        if isinstance(stored, ReadFailure):
            return _fail(name, stored.path, f"the observation ensemble could not be read: {stored.reason}")
        if stored.order_digest != index.order_digest:
            return _fail(
                name,
                payload_path,
                "the observation ensemble was built against a different obs_index than the "
                "one in the cache; ingest the run again",
            )
        n_obs, n_real = stored.values.shape
        if n_obs != index.n_obs:
            return _fail(
                name,
                payload_path,
                f"the observation ensemble holds {n_obs} observations but the obs_index "
                f"holds {index.n_obs}",
            )
        loaded = load_control_table(layout, "obs", columns=["obsnme"])
        if isinstance(loaded, ReadFailure):
            return _fail(name, loaded.path, f"the control table: {loaded.reason}")
        table, _table_notes = loaded
        if table.num_rows != index.control_rows:
            return _fail(
                name,
                payload_path,
                f"the control table holds {table.num_rows} observations but the obs_index "
                f"was built from {index.control_rows}",
            )
        names = table.column("obsnme")

        # An older sidecar must not outlive a failed rewrite of its payload.
        sidecar_path.unlink(missing_ok=True)

        has_target = (index.flags & FLAG_HAS_TARGET) != 0
        no_value = np.isnan(index.value)
        sentinel = ~has_target & ~no_value
        inequality = (index.flags & (FLAG_GREATER | FLAG_LESS)) != 0
        n_stats = len(OBS_STATS)
        step = max(int(block_rows), 1)
        summary_notes: list[str] = []
        counted = {"no_valid": 0, "sim_sentinel": 0}

        def _write_payload(fileobj) -> int:
            fileobj.truncate(n_stats * n_obs * 4)
            for start in range(0, n_obs, step):
                stop = min(start + step, n_obs)
                block, n_sim_sentinel = blank_sentinels(np.asarray(stored.values[start:stop]))
                counted["sim_sentinel"] += n_sim_sentinel
                block_names = _block_names(names, index.order[start:stop])
                summary, notes = summarise(block.T, block_names, noun="observation")
                summary_notes.extend(notes)
                counted["no_valid"] += int((summary["n_valid"].to_numpy() == 0).sum())
                resid_mean, rmse = _residual_stats(
                    block, has_target[start:stop], index.value[start:stop]
                )
                for row, stat in enumerate(OBS_STATS):
                    if stat == "resid_mean":
                        column = resid_mean
                    elif stat == "rmse":
                        column = rmse
                    else:
                        column = summary[stat].to_numpy()
                    fileobj.seek((row * n_obs + start) * 4)
                    fileobj.write(np.ascontiguousarray(column, dtype="<f4").tobytes())
            return n_stats * n_obs * 4

        payload_bytes = write_atomic_bytes(payload_path, _write_payload)
        written.append(payload_path)

        notes: list[str] = list(summary_notes)
        if int(sentinel.sum()):
            notes.append(
                f"{int(sentinel.sum())} observation(s) have an obsval of {SENTINEL_LIMIT:g} or "
                "more (a placeholder, not a target); their statistics are kept and their "
                f"residuals are missing; for example "
                f"{_examples(names, index.order, np.flatnonzero(sentinel))}"
            )
        if counted["sim_sentinel"]:
            notes.append(
                f"{counted['sim_sentinel']} simulated value(s) are {SENTINEL_LIMIT:g} or more (a "
                "dry or no-flow placeholder, not a head); they are left out of every statistic "
                "and residual of their observation"
            )
        if int(no_value.sum()):
            notes.append(
                f"{int(no_value.sum())} observation(s) have no numeric obsval; their "
                "statistics are kept and their residuals are missing; for example "
                f"{_examples(names, index.order, np.flatnonzero(no_value))}"
            )
        if int(inequality.sum()):
            notes.append(
                f"{int(inequality.sum())} observation(s) are in inequality groups; their "
                "residual here is the plain simulated minus observed, and phi counts it "
                "one-sided"
            )

        counts = {
            "n_obs": int(n_obs),
            "n_real": int(n_real),
            "n_with_target": int(has_target.sum()),
            "n_sentinel": int(sentinel.sum()),
            "n_no_value": int(no_value.sum()),
            "n_simulated_sentinel": counted["sim_sentinel"],
            "n_inequality": int(inequality.sum()),
            "n_no_valid_realizations": counted["no_valid"],
        }
        sidecar = {
            "cache_version": CACHE_VERSION,
            "iteration": iteration,
            "stats": list(OBS_STATS),
            "shape": [n_stats, int(n_obs)],
            "dtype": "<f4",
            "layout": "stat-major, columns in obs_index order",
            "order_digest": index.order_digest,
            "residual": RESIDUAL_TEXT,
            "sentinel_limit": SENTINEL_LIMIT,
            "counts": counts,
            "notes": notes,
        }
        sidecar_bytes = write_atomic_text(sidecar_path, json.dumps(sidecar, indent=2))
        written.append(sidecar_path)
        files = (
            CacheFile(path=str(payload_path.relative_to(layout.root)), bytes=payload_bytes),
            CacheFile(path=str(sidecar_path.relative_to(layout.root)), bytes=sidecar_bytes),
        )
        return WrittenArtifact(name=name, files=files, notes=tuple(notes))
    except Exception as exc:
        removed = 0
        for path in written:
            try:
                path.unlink(missing_ok=True)
                removed += 1
            except Exception:
                pass
        return _fail(
            name,
            payload_path,
            f"failed to write the observation statistics: {exc} -- cleaned up {removed} "
            "file(s) already written for this artifact",
        )


def _open_stat_file(
    name: str,
    label: str,
    sidecar_path: Path,
    payload_path: Path,
    expected_stats: tuple[str, ...],
    layout: CacheLayout,
) -> tuple[dict, np.ndarray, tuple[str, ...], str] | ReadFailure:
    """Open a stat-major float32 file through its sidecar: the version, the
    shape, the statistic names, the payload size and the ``obs_index`` digest
    are all checked before a read-only memory map is handed back. Returns the
    sidecar, the map, the stat names and the digest."""
    try:
        sidecar = json.loads(sidecar_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return _fail(name, sidecar_path, f"could not read sidecar {sidecar_path.name}: {exc}")
    if not isinstance(sidecar, dict):
        return _fail(name, sidecar_path, f"sidecar {sidecar_path.name} is not a JSON object")
    if sidecar.get("cache_version") != CACHE_VERSION:
        return _fail(
            name,
            sidecar_path,
            f"sidecar {sidecar_path.name} was written at cache_version "
            f"{sidecar.get('cache_version')!r}, this reader expects {CACHE_VERSION}",
        )
    try:
        n_stats, n_obs = (int(v) for v in sidecar["shape"])
        digest = str(sidecar["order_digest"])
        stats = tuple(str(v) for v in sidecar["stats"])
        if sidecar.get("dtype") != "<f4":
            raise ValueError(f"dtype {sidecar.get('dtype')!r}")
        if len(stats) != n_stats:
            raise ValueError(f"{len(stats)} stat names for {n_stats} rows")
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(
            name,
            sidecar_path,
            f"sidecar {sidecar_path.name} is not shaped like {label} sidecar: {exc}",
        )
    if stats != expected_stats:
        return _fail(
            name,
            sidecar_path,
            f"sidecar {sidecar_path.name} names the statistics {list(stats)} but this reader "
            f"expects {list(expected_stats)}",
        )

    expected = n_stats * n_obs * 4
    try:
        actual = payload_path.stat().st_size
    except OSError as exc:
        return _fail(name, payload_path, f"could not stat payload {payload_path.name}: {exc}")
    if actual != expected:
        return _fail(
            name,
            payload_path,
            f"payload {payload_path.name} holds {actual} bytes but its sidecar describes "
            f"{expected}",
        )

    current = load_obs_index(layout)
    if isinstance(current, ReadFailure):
        return _fail(
            name,
            payload_path,
            f"the obs_index it was built against cannot be read: {current.reason}",
        )
    if current.order_digest != digest:
        return _fail(
            name,
            payload_path,
            "it was built against a different obs_index than the one in the cache "
            f"(recorded digest {digest[:12]}, current {current.order_digest[:12]}); "
            "ingest the run again",
        )
    if current.n_obs != n_obs:
        return _fail(
            name,
            payload_path,
            f"it holds {n_obs} observations but the obs_index holds {current.n_obs}",
        )

    values = np.memmap(payload_path, dtype="<f4", mode="r", shape=(n_stats, n_obs))
    return sidecar, values, stats, digest


def load_obs_agg(iteration: int, layout: CacheLayout) -> StoredObsAgg | ReadFailure:
    """Open the stored statistics through their sidecar. Refused when the
    sidecar is not the shape this writer used, the payload size disagrees
    with it, or the columns were ordered against a different ``obs_index``
    than the one in the cache."""
    name = f"obs_agg/{iteration}"
    opened = _open_stat_file(
        name,
        "an observation statistics",
        layout.obs_agg_meta(iteration),
        layout.obs_agg(iteration),
        OBS_STATS,
        layout,
    )
    if isinstance(opened, ReadFailure):
        return opened
    sidecar, values, stats, digest = opened
    return StoredObsAgg(
        iteration=iteration,
        values=values,
        stats=stats,
        order_digest=digest,
        counts=dict(sidecar.get("counts", {})),
        notes=tuple(str(v) for v in sidecar.get("notes", [])),
    )


def write_noise_agg(
    data: EnsembleData,
    index: ObsIndex,
    source_name: str,
    layout: CacheLayout,
    *,
    block_rows: int = 50_000,
) -> WrittenArtifact | ReadFailure:
    """Write ``agg/noise.f32`` and then its sidecar ``agg/noise.json``, or
    leave nothing behind.

    ``data`` is the obs+noise ensemble read through the guarded reader. The
    realization named ``base`` is left out, and the sidecar says so. Every
    column is placed by the observation name the file gave it
    (``data.permutation``), never by position.
    """
    name = "noise_agg"
    payload_path = layout.noise_agg
    sidecar_path = layout.noise_agg_meta
    written: list[Path] = []
    try:
        if data.permutation is None:
            return _fail(
                name,
                data.source_path,
                f"the observation names in {source_name} could not be matched to the control "
                "file, so no control-file order exists to store against -- refusing rather "
                "than falling back to file column position",
            )
        permutation = np.asarray(data.permutation, dtype=np.int64)
        if permutation.shape[0] != index.control_rows:
            return _fail(
                name,
                data.source_path,
                f"the name match for {source_name} covers {permutation.shape[0]} control "
                f"observations but the obs_index was built from {index.control_rows} -- "
                "refusing to store against a different control table",
            )
        n_obs = index.n_obs
        if n_obs == 0:
            return _fail(name, data.source_path, "the obs_index holds no observations")
        n_file_real = int(data.values.shape[0])
        if len(data.real_names) != n_file_real:
            return _fail(
                name,
                data.source_path,
                f"{source_name} has {n_file_real} realizations but {len(data.real_names)} names",
            )

        base_rows, base_note = find_base(tuple(data.real_names))
        base_set = set(base_rows)
        keep = np.array([i for i in range(n_file_real) if i not in base_set], dtype=np.int64)
        if keep.size == 0:
            return _fail(
                name,
                data.source_path,
                f"{source_name} holds no realization other than base, so there is no noise band "
                "to draw",
            )

        loaded = load_control_table(layout, "obs", columns=["obsnme"])
        if isinstance(loaded, ReadFailure):
            return _fail(name, loaded.path, f"the control table: {loaded.reason}")
        table, _table_notes = loaded
        if table.num_rows != index.control_rows:
            return _fail(
                name,
                payload_path,
                f"the control table holds {table.num_rows} observations but the obs_index "
                f"was built from {index.control_rows}",
            )
        names = table.column("obsnme")

        # An older sidecar must not outlive a failed rewrite of its payload.
        sidecar_path.unlink(missing_ok=True)

        n_stats = len(NOISE_STATS)
        step = max(int(block_rows), 1)
        summary_notes: list[str] = []

        def _write_payload(fileobj) -> int:
            fileobj.truncate(n_stats * n_obs * 4)
            for start in range(0, n_obs, step):
                stop = min(start + step, n_obs)
                control_rows = index.order[start:stop]
                file_columns = permutation[control_rows]
                block = np.asarray(data.values[np.ix_(keep, file_columns)])
                block_names = _block_names(names, control_rows)
                summary, notes = summarise(block, block_names, noun="observation")
                summary_notes.extend(notes)
                for row, stat in enumerate(NOISE_STATS):
                    fileobj.seek((row * n_obs + start) * 4)
                    fileobj.write(
                        np.ascontiguousarray(summary[stat].to_numpy(), dtype="<f4").tobytes()
                    )
            return n_stats * n_obs * 4

        payload_bytes = write_atomic_bytes(payload_path, _write_payload)
        written.append(payload_path)

        notes: list[str] = list(data.notes)
        notes.extend(summary_notes)
        if base_rows:
            base_state = "excluded"
            notes.append(
                f"{len(base_rows)} realization(s) named base were left out of the noise band"
            )
            if base_note is not None:
                notes.append(base_note)
        else:
            base_state = "not present"
            notes.append(f"{source_name} has no realization named base; every realization was used")
        sidecar = {
            "cache_version": CACHE_VERSION,
            "stats": list(NOISE_STATS),
            "shape": [n_stats, int(n_obs)],
            "dtype": "<f4",
            "layout": "stat-major, columns in obs_index order",
            "order_digest": index.order_digest,
            "source": source_name,
            "n_real_used": int(keep.size),
            "base": base_state,
            "notes": notes,
        }
        sidecar_bytes = write_atomic_text(sidecar_path, json.dumps(sidecar, indent=2))
        written.append(sidecar_path)
        files = (
            CacheFile(path=str(payload_path.relative_to(layout.root)), bytes=payload_bytes),
            CacheFile(path=str(sidecar_path.relative_to(layout.root)), bytes=sidecar_bytes),
        )
        return WrittenArtifact(name=name, files=files, notes=tuple(notes))
    except Exception as exc:
        removed = 0
        for path in written:
            try:
                path.unlink(missing_ok=True)
                removed += 1
            except Exception:
                pass
        return _fail(
            name,
            payload_path,
            f"failed to write the noise statistics from {source_name}: {exc} -- cleaned up "
            f"{removed} file(s) already written for this artifact",
        )


def load_noise_agg(layout: CacheLayout) -> StoredNoiseAgg | ReadFailure:
    """Open the stored noise band through its sidecar, with the same checks
    as :func:`load_obs_agg`."""
    name = "noise_agg"
    opened = _open_stat_file(
        name,
        "a noise statistics",
        layout.noise_agg_meta,
        layout.noise_agg,
        NOISE_STATS,
        layout,
    )
    if isinstance(opened, ReadFailure):
        return opened
    sidecar, values, stats, digest = opened
    try:
        source = str(sidecar["source"])
        n_real_used = int(sidecar["n_real_used"])
        base = str(sidecar["base"])
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(
            name,
            layout.noise_agg_meta,
            f"sidecar {layout.noise_agg_meta.name} is not shaped like a noise statistics "
            f"sidecar: {exc}",
        )
    return StoredNoiseAgg(
        values=values,
        stats=stats,
        order_digest=digest,
        source=source,
        n_real_used=n_real_used,
        base=base,
        notes=tuple(str(v) for v in sidecar.get("notes", [])),
    )
