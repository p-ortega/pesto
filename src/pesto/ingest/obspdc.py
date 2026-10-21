"""Prior-data conflict per ingested iteration, ``pdc/K``.

pestpp writes ``case.K.pdc.csv``: one row per observation whose simulated
range and observation-plus-noise range do not overlap. When that file exists
it is read, joined to the control table by name, and every stored row says
``file``. Only when it is absent, and the cached statistics of the simulated
ensemble and of the noise band both exist, is conflict computed, and then
every stored row says ``computed``. The label is what lets a later reader
tell pestpp's own answer from pesto's reconstruction of it.

No module-level pyemu or flopy import.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.ensfile import _clean
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsagg import load_noise_agg, load_obs_agg
from pesto.ingest.obsindex import (
    FLAG_GREATER,
    FLAG_HAS_TARGET,
    FLAG_LESS,
    FLAG_WEIGHTED,
    ObsIndex,
    load_obs_index,
)
from pesto.ingest.obsread import _examples
from pesto.ingest.obsweights import AdjustedWeights
from pesto.ingest.tables import _write_parquet_atomic, load_control_table

PDC_FILE_COLUMNS = (
    "name",
    "obs_mean",
    "obs_std",
    "obs_min",
    "obs_max",
    "obs_stat_min",
    "obs_stat_max",
    "sim_mean",
    "sim_std",
    "sim_min",
    "sim_max",
    "sim_stat_min",
    "sim_stat_max",
    "distance",
)
NUMERIC_COLUMNS = PDC_FILE_COLUMNS[1:]
STORED_COLUMNS = ("obsnme", "position", *NUMERIC_COLUMNS, "source")

SOURCE_FILE = "file"
SOURCE_COMPUTED = "computed"

FILE_RULE = "read from the prior-data conflict file pestpp wrote"
COMPUTED_RULE = (
    "candidates have a real obsval and a weight above 0; a two-sided observation is in "
    "conflict when max(noise_min - sim_max, sim_min - noise_max) > 0, a greater-than group "
    "when noise_min - sim_max > 0, a less-than group when sim_min - noise_max > 0; that "
    "value is the distance"
)
NO_WEIGHTS_FILE_NOTE = (
    "no adjusted weights file was found for this run, so the control file's weights (above 0) "
    "decide which observations can be in conflict; pestpp zeroes the weight of a conflicted "
    "observation when it drops conflicts, so this can name more observations than pestpp did"
)


@dataclass(frozen=True, eq=False)
class PdcTable:
    """One iteration's prior-data conflict. ``frame`` holds one row per
    conflicted observation: ``obsnme`` as in the control table, its sorted
    ``position`` in ``obs_index``, the thirteen numbers pestpp writes (as
    float64) and ``source``, which is ``file`` or ``computed`` on every row.
    ``weights_source`` says which weights decided the candidates."""

    frame: pd.DataFrame
    source: str
    source_file: str
    weights_source: str
    notes: tuple[str, ...]
    n_unmatched: int = 0
    rule: str = ""

    __hash__ = None

    @property
    def n_conflict(self) -> int:
        return int(self.frame.shape[0])


def _fail(name: str, path: Path | str, reason: str) -> ReadFailure:
    return ReadFailure(name=name, path=str(path), reason=f"{name}: {reason}")


def _fail_at(artifact: str, path: Path, reason: str) -> ReadFailure:
    return ReadFailure(name=path.name, path=str(path), reason=f"{artifact}: {reason}")


def _sorted_position(index: ObsIndex) -> np.ndarray:
    """``position[control_row]`` is the sorted position of that control row."""
    position = np.empty(index.control_rows, dtype=np.int64)
    position[index.order.astype(np.int64)] = np.arange(index.n_obs, dtype=np.int64)
    return position


def read_pdc_file(
    path: Path,
    index: ObsIndex,
    control_names: list[str],
    *,
    artifact: str = "pdc",
) -> PdcTable | ReadFailure:
    """Read pestpp's prior-data conflict file and join its rows to the
    control table by name. Never raises.

    Names are read as text (``NA`` stays ``NA``). A name matches exactly, or
    after trimming spaces and lower-casing with a note; a name that matches
    neither is counted, named (up to three) and left out, never placed by
    position. A name listed twice refuses the file.
    """
    file_path = Path(path)
    file_name = file_path.name

    def fail(reason: str) -> ReadFailure:
        return _fail_at(artifact, file_path, reason)

    notes: list[str] = []
    try:
        if not file_path.is_file():
            return fail(f"{file_name} is not on disk at {file_path}")
        if len(control_names) != index.control_rows:
            return fail(
                f"the control table holds {len(control_names)} observations but the obs_index "
                f"was built from {index.control_rows}"
            )
        try:
            raw = pd.read_csv(file_path, dtype=str, keep_default_na=False, na_filter=False)
        except pd.errors.EmptyDataError:
            return fail(f"{file_name} is empty; it has no header row")

        header = [str(c).strip() for c in raw.columns]
        if header != [str(c) for c in raw.columns]:
            notes.append(f"column names in {file_name} had spaces around them, which were trimmed")
        raw.columns = header
        missing = [c for c in PDC_FILE_COLUMNS if c not in header]
        if missing:
            names = ", ".join(repr(c) for c in missing)
            return fail(f"{file_name} has no column named {names}")
        extra = [c for c in header if c not in PDC_FILE_COLUMNS]
        if extra:
            notes.append(
                f"{len(extra)} column(s) in {file_name} are not ones pesto stores and were "
                f"left out{_examples(extra)}"
            )

        file_names = raw["name"].tolist()
        counts = Counter(_clean(n) for n in file_names)
        repeated = list(dict.fromkeys(n for n in file_names if counts[_clean(n)] > 1))
        if repeated:
            return fail(
                f"{file_name}: {len(repeated)} name(s) appear more than once in the file"
                f"{_examples(repeated)}; pesto refuses rather than guess which row is which"
            )

        exact = {name: row for row, name in enumerate(control_names)}
        cleaned: dict[str, int] = {}
        collided: set[str] = set()
        for row, name in enumerate(control_names):
            key = _clean(name)
            if key in cleaned:
                collided.add(key)
            cleaned.setdefault(key, row)

        rows: list[int] = []
        keep: list[int] = []
        repaired: list[tuple[str, str]] = []
        unmatched: list[str] = []
        for i, name in enumerate(file_names):
            if name in exact:
                rows.append(exact[name])
                keep.append(i)
                continue
            key = _clean(name)
            if key in cleaned and key not in collided:
                rows.append(cleaned[key])
                keep.append(i)
                repaired.append((name, control_names[cleaned[key]]))
            else:
                unmatched.append(name)
        if repaired:
            shown = ", ".join(f"{a!r} for {b!r}" for a, b in repaired[:3])
            notes.append(
                f"{len(repaired)} name(s) in {file_name} matched the control table only after "
                f"trimming spaces and lower-casing (e.g. {shown})"
            )
        if unmatched:
            notes.append(
                f"{len(unmatched)} name(s) in {file_name} are not in the control table and were "
                f"left out{_examples(unmatched)}"
            )
        if not file_names:
            notes.append(f"{file_name} has no rows, so no observation is in conflict")

        position = _sorted_position(index)
        kept = raw.iloc[keep]
        data: dict = {
            "obsnme": pd.Series([control_names[r] for r in rows], dtype="object"),
            "position": position[np.asarray(rows, dtype=np.int64)]
            if rows
            else np.empty(0, dtype=np.int64),
        }
        for column in NUMERIC_COLUMNS:
            text = kept[column].reset_index(drop=True)
            number = pd.to_numeric(text, errors="coerce")
            written_nan = text.str.strip().str.lower() == "nan"
            bad = int((number.isna() & ~written_nan).sum())
            if bad:
                notes.append(
                    f"{bad} value(s) in column {column} of {file_name} could not be read as a "
                    "number and are stored as missing"
                )
            data[column] = number.to_numpy(dtype=np.float64)
        data["source"] = pd.Series([SOURCE_FILE] * len(rows), dtype="object")
        frame = pd.DataFrame(data, columns=list(STORED_COLUMNS))
        frame["position"] = frame["position"].astype(np.int64)

        return PdcTable(
            frame=frame,
            source=SOURCE_FILE,
            source_file=file_name,
            weights_source="not used; pestpp wrote the file",
            notes=tuple(notes),
            n_unmatched=len(unmatched),
            rule=FILE_RULE,
        )
    except Exception as exc:
        return fail(f"failed to read {file_name}: {exc}")


def compute_pdc(
    iteration: int, layout: CacheLayout, weights: AdjustedWeights | None
) -> PdcTable | ReadFailure:
    """Reconstruct prior-data conflict from the cached statistics: the
    simulated ensemble's ``obs_agg/K`` and the noise band ``noise_agg``.
    Used only when pestpp's own file is absent. Every row is labelled
    ``computed``. Never raises."""
    name = f"pdc/{iteration}"
    try:
        index = load_obs_index(layout)
        if isinstance(index, ReadFailure):
            return _fail(name, index.path, f"the obs_index could not be read: {index.reason}")
        sim = load_obs_agg(iteration, layout)
        if isinstance(sim, ReadFailure):
            return _fail(name, sim.path, f"obs_agg/{iteration} could not be read: {sim.reason}")
        noise = load_noise_agg(layout)
        if isinstance(noise, ReadFailure):
            return _fail(name, noise.path, f"noise_agg could not be read: {noise.reason}")
        for label, digest in (("obs_agg", sim.order_digest), ("noise_agg", noise.order_digest)):
            if digest != index.order_digest:
                return _fail(
                    name,
                    layout.pdc(iteration),
                    f"{label} was built against a different obs_index than the one in the "
                    "cache; ingest the run again",
                )
        loaded = load_control_table(layout, "obs", columns=["obsnme"])
        if isinstance(loaded, ReadFailure):
            return _fail(name, loaded.path, f"the control table: {loaded.reason}")
        table, _table_notes = loaded
        if table.num_rows != index.control_rows:
            return _fail(
                name,
                layout.pdc(iteration),
                f"the control table holds {table.num_rows} observations but the obs_index "
                f"was built from {index.control_rows}",
            )

        notes: list[str] = [
            f"simulated range from obs_agg/{iteration}; noise range from {noise.source} "
            f"({noise.n_real_used} realization(s), base {noise.base})"
        ]
        has_target = (index.flags & FLAG_HAS_TARGET) != 0
        if weights is None:
            candidate = has_target & ((index.flags & FLAG_WEIGHTED) != 0)
            weights_source = "control file weights (no adjusted weights file was found)"
            notes.append(NO_WEIGHTS_FILE_NOTE)
        else:
            positive = np.zeros(index.control_rows, dtype=bool)
            some_positive = (weights.weights > 0).any(axis=0)
            positive[weights.control_rows] = some_positive
            candidate = has_target & positive[index.order.astype(np.int64)]
            weights_source = f"adjusted weights from {weights.source.name}"
            mixed = int(((weights.weights == 0).any(axis=0) & some_positive).sum())
            if mixed:
                notes.append(
                    f"{mixed} observation(s) have an adjusted weight of 0 in some realizations "
                    "and above 0 in others; they count as candidates"
                )
            notes.extend(weights.notes)

        def stat(values: np.ndarray, stats: tuple[str, ...], which: str) -> np.ndarray:
            return np.asarray(values[stats.index(which)], dtype=np.float64)

        sim_min, sim_max = stat(sim.values, sim.stats, "min"), stat(sim.values, sim.stats, "max")
        noise_min = stat(noise.values, noise.stats, "min")
        noise_max = stat(noise.values, noise.stats, "max")

        greater = (index.flags & FLAG_GREATER) != 0
        less = (index.flags & FLAG_LESS) != 0
        with np.errstate(invalid="ignore"):
            above = noise_min - sim_max
            below = sim_min - noise_max
            distance = np.where(greater, above, np.where(less, below, np.fmax(above, below)))
        missing_stat = candidate & np.isnan(distance)
        if missing_stat.any():
            notes.append(
                f"{int(missing_stat.sum())} candidate observation(s) have no simulated or noise "
                "range (no valid realization), so they cannot be in conflict"
            )
        with np.errstate(invalid="ignore"):
            in_conflict = candidate & (distance > 0)
        positions = np.flatnonzero(in_conflict)

        names = table.column("obsnme").to_pylist()
        data: dict = {
            "obsnme": pd.Series([str(names[int(index.order[p])]) for p in positions], dtype="object"),
            "position": positions.astype(np.int64),
        }
        for prefix, values, stats in (("obs", noise.values, noise.stats), ("sim", sim.values, sim.stats)):
            mean = stat(values, stats, "mean")[positions]
            std = stat(values, stats, "std")[positions]
            data[f"{prefix}_mean"] = mean
            data[f"{prefix}_std"] = std
            data[f"{prefix}_min"] = stat(values, stats, "min")[positions]
            data[f"{prefix}_max"] = stat(values, stats, "max")[positions]
            data[f"{prefix}_stat_min"] = mean - std
            data[f"{prefix}_stat_max"] = mean + std
        data["distance"] = distance[positions]
        data["source"] = pd.Series([SOURCE_COMPUTED] * positions.size, dtype="object")
        frame = pd.DataFrame(data)[list(STORED_COLUMNS)]
        if positions.size == 0:
            notes.append("no observation is in conflict")

        return PdcTable(
            frame=frame,
            source=SOURCE_COMPUTED,
            source_file=noise.source,
            weights_source=weights_source,
            notes=tuple(notes),
            n_unmatched=0,
            rule=COMPUTED_RULE,
        )
    except Exception as exc:
        return _fail(name, layout.pdc(iteration), f"failed to compute prior-data conflict: {exc}")


def write_pdc(
    table: PdcTable, iteration: int, layout: CacheLayout
) -> WrittenArtifact | ReadFailure:
    """Write ``agg/pdc_K.parquet`` and then ``agg/pdc_K.json``, or leave
    nothing behind. The sidecar goes last, so a parquet without one is never
    taken for a finished artifact."""
    name = f"pdc/{iteration}"
    parquet_path = layout.pdc(iteration)
    sidecar_path = layout.pdc_meta(iteration)
    started = False
    try:
        index = load_obs_index(layout)
        if isinstance(index, ReadFailure):
            return _fail(name, index.path, f"the obs_index could not be read: {index.reason}")
        frame = table.frame
        if list(frame.columns) != list(STORED_COLUMNS):
            return _fail(name, parquet_path, f"the table's columns are {list(frame.columns)}")
        if not (frame["source"] == table.source).all():
            return _fail(
                name,
                parquet_path,
                f"refusing to write rows whose source label is not {table.source!r} on every row",
            )
        if frame.shape[0] and (
            int(frame["position"].min()) < 0 or int(frame["position"].max()) >= index.n_obs
        ):
            return _fail(name, parquet_path, "a row's position is outside the obs_index")

        layout.ensure()
        started = True
        # An older sidecar must not outlive a failed rewrite of its parquet.
        sidecar_path.unlink(missing_ok=True)
        parquet_bytes = _write_parquet_atomic(frame, parquet_path)
        payload = {
            "cache_version": CACHE_VERSION,
            "iteration": int(iteration),
            "source": table.source,
            "source_file": table.source_file,
            "n_conflict": int(frame.shape[0]),
            "n_unmatched": int(table.n_unmatched),
            "weights_source": table.weights_source,
            "rule": table.rule,
            "order_digest": index.order_digest,
            "notes": list(table.notes),
        }
        sidecar_bytes = write_atomic_text(sidecar_path, json.dumps(payload, indent=2))
        files = (
            CacheFile(path=str(parquet_path.relative_to(layout.root)), bytes=parquet_bytes),
            CacheFile(path=str(sidecar_path.relative_to(layout.root)), bytes=sidecar_bytes),
        )
        return WrittenArtifact(name=name, files=files, notes=table.notes)
    except Exception as exc:
        if started:
            parquet_path.unlink(missing_ok=True)
            sidecar_path.unlink(missing_ok=True)
        return _fail(name, parquet_path, f"failed to write prior-data conflict: {exc}")


def load_pdc(iteration: int, layout: CacheLayout) -> PdcTable | ReadFailure:
    """Read ``pdc/K`` back through its sidecar. Refused when the version,
    the columns, the label on any row or the ``obs_index`` digest disagree."""
    name = f"pdc/{iteration}"
    sidecar_path = layout.pdc_meta(iteration)
    parquet_path = layout.pdc(iteration)
    try:
        raw = json.loads(sidecar_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return _fail(name, sidecar_path, f"could not read sidecar {sidecar_path.name}: {exc}")
    if not isinstance(raw, dict):
        return _fail(name, sidecar_path, f"sidecar {sidecar_path.name} is not a JSON object")
    if raw.get("cache_version") != CACHE_VERSION:
        return _fail(
            name,
            sidecar_path,
            f"sidecar {sidecar_path.name} was written at cache_version "
            f"{raw.get('cache_version')!r}, this reader expects {CACHE_VERSION}",
        )
    try:
        source = str(raw["source"])
        source_file = str(raw["source_file"])
        n_conflict = int(raw["n_conflict"])
        n_unmatched = int(raw["n_unmatched"])
        weights_source = str(raw["weights_source"])
        rule = str(raw["rule"])
        digest = str(raw["order_digest"])
        notes = tuple(str(v) for v in raw["notes"])
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(name, sidecar_path, f"sidecar {sidecar_path.name} has an unexpected shape: {exc}")
    if source not in (SOURCE_FILE, SOURCE_COMPUTED):
        return _fail(name, sidecar_path, f"sidecar {sidecar_path.name} names an unknown source {source!r}")

    try:
        frame = pd.read_parquet(parquet_path)
    except Exception as exc:
        return _fail(name, parquet_path, f"failed to read {parquet_path.name}: {exc}")
    absent = [c for c in STORED_COLUMNS if c not in frame.columns]
    if absent:
        return _fail(name, parquet_path, f"{parquet_path.name} has no column named {absent[0]!r}")
    if frame.shape[0] != n_conflict:
        return _fail(
            name,
            parquet_path,
            f"{parquet_path.name} holds {frame.shape[0]} rows but its sidecar says {n_conflict}",
        )
    if not (frame["source"] == source).all():
        return _fail(
            name, parquet_path, f"a row of {parquet_path.name} does not carry the source {source!r}"
        )
    current = load_obs_index(layout)
    if isinstance(current, ReadFailure):
        return _fail(name, parquet_path, f"the obs_index it was built against cannot be read: {current.reason}")
    if current.order_digest != digest:
        return _fail(
            name,
            parquet_path,
            "it was built against a different obs_index than the one in the cache "
            f"(recorded digest {digest[:12]}, current {current.order_digest[:12]}); "
            "ingest the run again",
        )
    return PdcTable(
        frame=frame[list(STORED_COLUMNS)].reset_index(drop=True),
        source=source,
        source_file=source_file,
        weights_source=weights_source,
        notes=notes,
        n_unmatched=n_unmatched,
        rule=rule,
    )

