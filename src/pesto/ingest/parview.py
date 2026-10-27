"""The parameter view's two tables, built from the cached parameter ensembles.

``par_change`` has one row per control-file parameter: its mean and standard
deviation in the first and the last iteration, and how far they moved. Both
iterations are read through their cache memmaps, never the source files, and
joined by realization name over the realizations present in both. Statistics
are taken in the numeric space pestpp works in: log10 for a log-transformed
parameter, native units otherwise.

``par_groups`` is one JSON file with one entry per parameter group, built from
``par_change`` and the control table.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.ensembles import StoredEnsemble, align_realizations, load_stored
from pesto.ingest.failures import ReadFailure
from pesto.ingest.tables import _write_parquet_atomic, load_control_table

CHUNK_PARAMS = 4096
_EXAMPLES = 3


@dataclass(frozen=True, eq=False)
class Moments:
    """Per-parameter figures in control-file order, float64. ``n_valid`` is the
    number of realizations that held a number; ``n_nonpositive`` counts the
    values a log parameter cannot take the logarithm of."""

    mean: np.ndarray
    sd: np.ndarray
    n_valid: np.ndarray
    n_nonpositive: np.ndarray


def _fail(name: str, path: Path | str, reason: str) -> ReadFailure:
    return ReadFailure(name=name, path=str(path), reason=f"{name}: {reason}")


def _number(value) -> float | None:
    """A JSON-safe number: a finite float, or None where there is none."""
    if value is None:
        return None
    value = float(value)
    return value if np.isfinite(value) else None


def _control_chunks(stored: StoredEnsemble, step: int = CHUNK_PARAMS):
    """Yield ``(control positions, values)`` blocks of about ``step``
    parameters, values as float64 of shape (n_real, k). Reading in column
    chunks keeps memory flat however many parameters there are."""
    n_map = stored.map_values.shape[1]
    n_nomap = stored.nomap_values.shape[0]
    for start in range(0, n_map, step):
        stop = min(start + step, n_map)
        block = np.asarray(stored.map_values[:, start:stop], dtype=np.float64)
        yield stored.block_to_control[start:stop], block
    for start in range(0, n_nomap, step):
        stop = min(start + step, n_nomap)
        block = np.asarray(stored.nomap_values[start:stop], dtype=np.float64).T
        yield stored.block_to_control[n_map + start : n_map + stop], block


def parameter_moments(
    stored: StoredEnsemble, rows: np.ndarray, log_mask: np.ndarray
) -> Moments:
    """Mean and population standard deviation (ddof 0) of every parameter over
    the realizations at ``rows``, in control-file order.

    A log parameter is measured in log10. One holding any non-positive value
    among ``rows`` has no logarithm to take, so its mean and sd are missing
    and ``n_nonpositive`` says how many values stopped it.
    """
    rows = np.asarray(rows, dtype=np.int64)
    n_par = len(stored.par_names)
    mean = np.full(n_par, np.nan)
    sd = np.full(n_par, np.nan)
    n_valid = np.zeros(n_par, dtype=np.int64)
    n_nonpositive = np.zeros(n_par, dtype=np.int64)
    log_mask = np.asarray(log_mask, dtype=bool)

    for control, block in _control_chunks(stored):
        sel = block[rows]
        valid = ~np.isnan(sel)
        is_log = log_mask[control]
        with np.errstate(all="ignore"):
            nonpositive = np.where(is_log, (valid & (sel <= 0)).sum(axis=0), 0)
            values = sel.copy()
            log_cols = np.flatnonzero(is_log)
            if log_cols.size:
                values[:, log_cols] = np.log10(sel[:, log_cols])
            n = valid.sum(axis=0)
            total = np.where(valid, values, 0.0).sum(axis=0)
            chunk_mean = np.where(n > 0, total / np.maximum(n, 1), np.nan)
            spread = np.where(valid, values - chunk_mean, 0.0)
            chunk_sd = np.where(n > 0, np.sqrt((spread**2).sum(axis=0) / np.maximum(n, 1)), np.nan)
        stopped = nonpositive > 0
        chunk_mean[stopped] = np.nan
        chunk_sd[stopped] = np.nan
        mean[control] = chunk_mean
        sd[control] = chunk_sd
        n_valid[control] = n
        n_nonpositive[control] = nonpositive
    return Moments(mean=mean, sd=sd, n_valid=n_valid, n_nonpositive=n_nonpositive)


def _names_text(names: list[str]) -> str:
    return ", ".join(repr(n) for n in names[:_EXAMPLES])


def write_par_change(
    first: int, last: int, layout: CacheLayout
) -> WrittenArtifact | ReadFailure:
    """Write ``agg/par_change.parquet`` and then its sidecar
    ``agg/par_change.json``, or leave nothing behind. Reads the cached
    ``par_ens/first`` and ``par_ens/last`` and the cached control table."""
    name = "par_change"
    payload_path = layout.par_change
    sidecar_path = layout.par_change_meta
    written: list[Path] = []
    try:
        single = first == last
        stored_first = load_stored(first, layout)
        if isinstance(stored_first, ReadFailure):
            return _fail(
                name,
                stored_first.path,
                f"the parameter ensemble of iteration {first} could not be read: "
                f"{stored_first.reason}",
            )
        stored_last = stored_first if single else load_stored(last, layout)
        if isinstance(stored_last, ReadFailure):
            return _fail(
                name,
                stored_last.path,
                f"the parameter ensemble of iteration {last} could not be read: "
                f"{stored_last.reason}",
            )
        loaded = load_control_table(
            layout, "par", columns=["parnme", "pargp", "partrans", "parlbnd", "parubnd"]
        )
        if isinstance(loaded, ReadFailure):
            return _fail(name, loaded.path, f"the control table: {loaded.reason}")
        table, _table_notes = loaded
        parnme = [str(v) for v in table.column("parnme").to_pylist()]
        for stored in (stored_first, stored_last):
            if tuple(parnme) != tuple(stored.par_names):
                return _fail(
                    name,
                    payload_path,
                    f"the control table and the ensemble of iteration {stored.iteration} "
                    "do not hold the same parameters in the same order; ingest the run again",
                )
        pargp = [str(v) for v in table.column("pargp").to_pylist()]
        partrans = [str(v).strip().lower() for v in table.column("partrans").to_pylist()]
        log_mask = np.array([t == "log" for t in partrans], dtype=bool)

        notes: list[str] = []
        if single:
            rows_first = np.arange(len(stored_first.real_names))
            rows_last = rows_first
            only_first: tuple[str, ...] = ()
            only_last: tuple[str, ...] = ()
            n_common = len(rows_first)
        else:
            aligned = align_realizations(stored_first.real_names, stored_last.real_names)
            if not aligned.names:
                return _fail(
                    name,
                    payload_path,
                    f"no realization name is shared between iteration {first} and "
                    f"iteration {last}",
                )
            rows_first = np.asarray(aligned.index_a, dtype=np.int64)
            rows_last = np.asarray(aligned.index_b, dtype=np.int64)
            only_first, only_last = aligned.only_a, aligned.only_b
            n_common = len(aligned.names)
            notes.extend(aligned.notes)

        sidecar_path.unlink(missing_ok=True)

        moments_first = parameter_moments(stored_first, rows_first, log_mask)
        moments_last = (
            moments_first if single else parameter_moments(stored_last, rows_last, log_mask)
        )

        mean_first, sd_first = moments_first.mean, moments_first.sd
        mean_last = np.full(len(parnme), np.nan) if single else moments_last.mean
        sd_last = np.full(len(parnme), np.nan) if single else moments_last.sd
        with np.errstate(all="ignore"):
            mean_change_pct = 100.0 * np.abs(mean_last - mean_first) / np.abs(mean_first)
            sd_change_pct = 100.0 * np.abs(sd_last - sd_first) / sd_first
            sd_ratio = sd_last / sd_first
            mean_shift_sd = (mean_last - mean_first) / sd_first
        none_int = pd.array([None] * len(parnme), dtype="Int64")
        frame = pd.DataFrame(
            {
                "parnme": pd.Series(parnme, dtype="object"),
                "pargp": pd.Series(pargp, dtype="object"),
                "partrans": pd.Series(partrans, dtype="object"),
                "space": pd.Series(["log10" if m else "native" for m in log_mask], dtype="object"),
                "included": np.ones(len(parnme), dtype=bool),
                "excluded_kind": pd.Series([None] * len(parnme), dtype="object"),
                "excluded_reason": pd.Series([None] * len(parnme), dtype="object"),
                "mean_first": mean_first,
                "sd_first": sd_first,
                "mean_last": mean_last,
                "sd_last": sd_last,
                "mean_change_pct": mean_change_pct,
                "mean_change_refused": pd.Series([None] * len(parnme), dtype="object"),
                "sd_change_pct": sd_change_pct,
                "sd_change_refused": pd.Series([None] * len(parnme), dtype="object"),
                "sd_ratio": sd_ratio,
                "mean_shift_sd": mean_shift_sd,
                "near_lower_first": none_int,
                "near_upper_first": none_int,
                "near_lower_last": none_int,
                "near_upper_last": none_int,
            }
        )
        payload_bytes = _write_parquet_atomic(frame, payload_path)
        written.append(payload_path)

        reason = (
            f"only iteration {first} was ingested, so there is no before and after"
            if single
            else None
        )
        sidecar = {
            "cache_version": CACHE_VERSION,
            "first_iteration": int(first),
            "last_iteration": int(last),
            "single_iteration": single,
            "n_real_first": len(stored_first.real_names),
            "n_real_last": len(stored_last.real_names),
            "n_common": int(n_common),
            "only_first": {"count": len(only_first), "names": list(only_first[:_EXAMPLES])},
            "only_last": {"count": len(only_last), "names": list(only_last[:_EXAMPLES])},
            "reason": reason,
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
            f"failed to write the parameter change: {exc} -- cleaned up {removed} file(s) "
            "already written for this artifact",
        )


def load_par_change(layout: CacheLayout) -> tuple[pd.DataFrame, dict] | ReadFailure:
    """Read ``par_change`` back as a table and its sidecar. The sidecar and its
    ``cache_version`` are checked before the table is trusted."""
    name = "par_change"
    sidecar = _read_json(name, layout.par_change_meta)
    if isinstance(sidecar, ReadFailure):
        return sidecar
    try:
        int(sidecar["first_iteration"])
        int(sidecar["last_iteration"])
        int(sidecar["n_common"])
        bool(sidecar["single_iteration"])
        if not isinstance(sidecar["notes"], list):
            raise TypeError("notes is not a list")
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(
            name,
            layout.par_change_meta,
            f"{layout.par_change_meta.name} is not shaped like a par_change sidecar: {exc}",
        )
    try:
        frame = pd.read_parquet(layout.par_change)
    except Exception as exc:
        return _fail(name, layout.par_change, f"could not read {layout.par_change.name}: {exc}")
    return frame, sidecar


def _read_json(name: str, path: Path) -> dict | ReadFailure:
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return _fail(name, path, f"could not read {path.name}: {exc}")
    if not isinstance(raw, dict):
        return _fail(name, path, f"{path.name} is not a JSON object")
    if raw.get("cache_version") != CACHE_VERSION:
        return _fail(
            name,
            path,
            f"{path.name} was written at cache_version {raw.get('cache_version')!r}, "
            f"this reader expects {CACHE_VERSION}",
        )
    return raw


def write_par_groups(run_dir: Path, layout: CacheLayout) -> WrittenArtifact | ReadFailure:
    """Write ``agg/par_groups.json``: one entry per parameter group, in the
    order the control table first names them."""
    name = "par_groups"
    path = layout.par_groups
    try:
        loaded = load_par_change(layout)
        if isinstance(loaded, ReadFailure):
            return _fail(name, loaded.path, f"par_change could not be read: {loaded.reason}")
        frame, meta = loaded

        groups = []
        for group, block in frame.groupby("pargp", sort=False):
            groups.append(
                {
                    "group": str(group),
                    "n_par": int(len(block)),
                    "n_included": int(block["included"].sum()),
                    "excluded": {"fixed": 0, "tied": 0, "nonpositive_log": 0, "no_values": 0},
                    "type": {"value": None, "source": None, "note": "not read"},
                    "layer": {"value": None, "source": None, "note": "not read"},
                    "change": {"pesto": None, "pestpp": None, "reason": None},
                    "at_bounds_last": {"near_lower": None, "near_upper": None},
                    "drill_down": {"offered": True, "reason": None},
                    "notes": [],
                }
            )
        payload = {
            "cache_version": CACHE_VERSION,
            "first_iteration": meta["first_iteration"],
            "last_iteration": meta["last_iteration"],
            "n_common": meta["n_common"],
            "single_iteration": meta["single_iteration"],
            "left_out": {
                "count": int(meta["only_first"]["count"]) + int(meta["only_last"]["count"]),
                "only_first": list(meta["only_first"]["names"]),
                "only_last": list(meta["only_last"]["names"]),
                "reason": None,
            },
            "groups": groups,
            "notes": [],
        }
        size = write_atomic_text(path, json.dumps(payload, indent=2))
        files = (CacheFile(path=str(path.relative_to(layout.root)), bytes=size),)
        return WrittenArtifact(name=name, files=files, notes=())
    except Exception as exc:
        return _fail(name, path, f"failed to write the group summary: {exc}")


def load_par_groups(layout: CacheLayout) -> dict | ReadFailure:
    """Read ``par_groups.json`` back, refusing a file of the wrong version or shape."""
    name = "par_groups"
    raw = _read_json(name, layout.par_groups)
    if isinstance(raw, ReadFailure):
        return raw
    if not isinstance(raw.get("groups"), list) or not isinstance(raw.get("notes"), list):
        return _fail(
            name,
            layout.par_groups,
            f"{layout.par_groups.name} is not shaped like a group summary",
        )
    return raw
