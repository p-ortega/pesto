"""Check the cache against pestpp's own phi, ``phi_check/K``.

pestpp writes ``case.phi.actual.csv``: one row per iteration, one column per
realization. This module recomputes each realization's phi from the stored
observation ensemble, as the sum of (weight times residual) squared over the
weighted observations, and compares it with the file's value for the same
realization name. A phi that agrees by name is the strongest evidence that
the names, the order and the weights in the cache are right.

Realizations are joined by name only. A mismatch is stored with both values
and never rounded away: the artifact is recorded ok because the check ran,
and the result says what it found.

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
from pesto.ingest.obsens import load_obs_ensemble
from pesto.ingest.obsindex import (
    FLAG_GREATER,
    FLAG_HAS_TARGET,
    FLAG_LESS,
    ObsIndex,
    load_obs_index,
)
from pesto.ingest.obsread import _examples
from pesto.ingest.obsweights import AdjustedWeights
from pesto.ingest.tables import load_control_table

PHI_TOLERANCE = 1e-3  # relative; observed agreement on real runs is 4e-6 to 3.3e-4

PHI_STAT_COLUMNS = ("iteration", "total_runs", "mean", "standard_deviation", "min", "max")
STATUS_CHECKED = "checked"
STATUS_NOT_CHECKED = "not checked"

CONTROL_WEIGHTS_SOURCE = "control file weights"
NO_WEIGHTS_FILE_NOTE = (
    "no adjusted weights file was found for this run, so the control file's weights were used; "
    "pestpp's phi may differ"
)
BLOCK_ROWS = 20_000


@dataclass(frozen=True)
class PhiRow:
    """One realization: phi recomputed from the cache, phi in pestpp's file,
    their relative difference (``None`` when it is undefined) and whether
    they agree within the tolerance."""

    realization: str
    recomputed: float | None
    file: float | None
    rel_diff: float | None
    match: bool


@dataclass(frozen=True, eq=False)
class PhiCheck:
    """The result of comparing one iteration's phi with pestpp's file."""

    iteration: int
    tolerance: float
    weights_source: str
    phi_file: str
    status: str
    reason: str
    n_compared: int
    n_mismatch: int
    n_only_in_cache: int
    n_only_in_file: int
    max_rel_diff: float | None
    median_rel_diff: float | None
    rows: tuple[PhiRow, ...]
    summary: str
    notes: tuple[str, ...]

    __hash__ = None


def _fail(name: str, path: Path | str, reason: str) -> ReadFailure:
    return ReadFailure(name=name, path=str(path), reason=f"{name}: {reason}")


def compare_phi(recomputed: float, file_value: float) -> tuple[float | None, bool]:
    """The relative difference ``|recomputed - file| / |file|`` and whether it
    is within ``PHI_TOLERANCE``. Both zero agree. A file value of 0 against a
    non-zero recomputation, or a value that is not a finite number, does not
    agree; the difference is then ``None``."""
    if not (np.isfinite(recomputed) and np.isfinite(file_value)):
        return None, False
    if file_value == 0.0:
        return (0.0, True) if recomputed == 0.0 else (None, False)
    rel = abs(recomputed - file_value) / abs(file_value)
    return float(rel), bool(rel <= PHI_TOLERANCE)


def _join_names(
    cache_names: tuple[str, ...], other_names: list[str], other_label: str
) -> tuple[list[tuple[int, int]], list[int], list[int], list[str]]:
    """Pair the cache's realization names with another set, by name only.

    Returns ``(pairs, cache_only, other_only, notes)``: ``pairs`` holds
    ``(cache index, other index)``. A name matches exactly, or after trimming
    spaces and lower-casing when that is unambiguous on both sides, with a
    note. Nothing is ever paired by position.
    """
    notes: list[str] = []
    exact: dict[str, list[int]] = {}
    for j, name in enumerate(other_names):
        exact.setdefault(name, []).append(j)
    taken: set[int] = set()
    pairs: list[tuple[int, int]] = []
    left: list[int] = []
    for i, name in enumerate(cache_names):
        found = exact.get(name, [])
        if len(found) == 1:
            pairs.append((i, found[0]))
            taken.add(found[0])
        else:
            left.append(i)
    other_left = [j for j in range(len(other_names)) if j not in taken]
    cache_keys = Counter(_clean(cache_names[i]) for i in left)
    other_keys = Counter(_clean(other_names[j]) for j in other_left)
    other_by_key = {_clean(other_names[j]): j for j in other_left}
    repaired: list[tuple[str, str]] = []
    cache_only: list[int] = []
    for i in left:
        key = _clean(cache_names[i])
        if key in other_by_key and cache_keys[key] == 1 and other_keys[key] == 1:
            j = other_by_key[key]
            pairs.append((i, j))
            taken.add(j)
            repaired.append((cache_names[i], other_names[j]))
        else:
            cache_only.append(i)
    other_only = [j for j in range(len(other_names)) if j not in taken]
    if repaired:
        shown = ", ".join(f"{a!r} for {b!r}" for a, b in repaired[:3])
        notes.append(
            f"{len(repaired)} realization name(s) matched {other_label} only after trimming "
            f"spaces and lower-casing (e.g. {shown})"
        )
    repeated = [n for n, k in Counter(other_names).items() if k > 1]
    if repeated:
        notes.append(
            f"{len(repeated)} realization name(s) appear more than once in {other_label} and "
            f"were not matched{_examples_text(repeated)}"
        )
    return pairs, cache_only, other_only, notes


def _examples_text(names: list[str]) -> str:
    shown = ", ".join(repr(n) for n in names[:3])
    return f" (e.g. {shown})" if shown else ""


def _read_phi_row(
    path: Path, iteration: int
) -> tuple[list[str], np.ndarray, int, int] | ReadFailure | str:
    """The realization names and values of the file's row for ``iteration``.

    Returns ``(names, values, n_unreadable, n_blank)``, a reason string when
    the file has no (or more than one) row for the iteration, or a
    ``ReadFailure`` when the file cannot be read as a phi file.
    """
    name = f"phi_check/{iteration}"
    try:
        raw = pd.read_csv(path, dtype=str, keep_default_na=False, na_filter=False, header=None)
    except pd.errors.EmptyDataError:
        return _fail(name, path, f"{path.name} is empty; it has no header row")
    except (OSError, UnicodeDecodeError, pd.errors.ParserError) as exc:
        return _fail(name, path, f"could not read {path.name}: {exc}")
    header = [str(c).strip() for c in raw.iloc[0].tolist()]
    if tuple(header[: len(PHI_STAT_COLUMNS)]) != PHI_STAT_COLUMNS:
        return _fail(
            name,
            path,
            f"{path.name} does not start with the columns {', '.join(PHI_STAT_COLUMNS)}, so "
            "its realization columns cannot be told apart",
        )
    body = raw.iloc[1:]
    iterations = pd.to_numeric(body[0], errors="coerce")
    rows = np.flatnonzero((iterations == iteration).to_numpy())
    if rows.size == 0:
        return f"{path.name} has no row for iteration {iteration}"
    if rows.size > 1:
        return f"{path.name} has {rows.size} rows for iteration {iteration}, so none was used"
    cells = body.iloc[int(rows[0])].tolist()[len(PHI_STAT_COLUMNS) :]
    names = [str(n) for n in header[len(PHI_STAT_COLUMNS) :]]
    texts = [str(c).strip() for c in cells]
    values = pd.to_numeric(pd.Series(texts, dtype="object"), errors="coerce").to_numpy(
        dtype=np.float64
    )
    blank = np.array([t == "" for t in texts], dtype=bool)
    unreadable = int((np.isnan(values) & ~blank).sum())
    # A realization with no value in this row was not part of that iteration.
    return names, values, unreadable, int(blank.sum())


def recompute_phi(
    index: ObsIndex,
    values: np.ndarray,
    cache_columns: list[int],
    weights: AdjustedWeights | None,
    weight_rows: list[int] | None,
    control_weight: np.ndarray | None,
) -> tuple[np.ndarray, list[str]]:
    """phi per chosen realization, float64: the sum over weighted
    observations of (weight times residual) squared, where residual is
    simulated minus obsval, one-sided for inequality groups. ``cache_columns``
    are columns of ``values`` (observations in ``obs_index`` order);
    ``weight_rows`` the matching rows of ``weights.weights`` when adjusted
    weights are used; otherwise ``control_weight`` holds one weight per
    sorted position. Also returns notes."""
    notes: list[str] = []
    n_pick = len(cache_columns)
    phi = np.zeros(n_pick, dtype=np.float64)
    has_target = (index.flags & FLAG_HAS_TARGET) != 0

    if weights is not None:
        position = np.empty(index.control_rows, dtype=np.int64)
        position[index.order.astype(np.int64)] = np.arange(index.n_obs, dtype=np.int64)
        pos = position[weights.control_rows]
        keep = has_target[pos]
        left_out = int((~keep).sum())
        if left_out:
            notes.append(
                f"{left_out} observation(s) in the adjusted weights have no real obsval and "
                "were left out of phi"
            )
        columns = np.flatnonzero(keep)
        columns = columns[np.argsort(pos[columns], kind="stable")]
        sorted_pos = pos[columns]
        picked_weights = np.asarray(weights.weights[weight_rows], dtype=np.float64)
        select_rows = np.asarray(cache_columns, dtype=np.int64)
        for start in range(0, columns.size, BLOCK_ROWS):
            block = slice(start, start + BLOCK_ROWS)
            phi += _block_phi(
                index,
                values,
                sorted_pos[block],
                select_rows,
                picked_weights[:, columns[block]].T,
            )
    else:
        weighted = np.flatnonzero((control_weight > 0) & has_target)
        left_out = int(((control_weight > 0) & ~has_target).sum())
        if left_out:
            notes.append(
                f"{left_out} observation(s) with a weight above 0 have no real obsval and "
                "were left out of phi"
            )
        select_rows = np.asarray(cache_columns, dtype=np.int64)
        for start in range(0, weighted.size, BLOCK_ROWS):
            sorted_pos = weighted[start : start + BLOCK_ROWS]
            w = np.repeat(control_weight[sorted_pos][:, None], n_pick, axis=1)
            phi += _block_phi(index, values, sorted_pos, select_rows, w)
    return phi, notes


def _block_phi(
    index: ObsIndex,
    values: np.ndarray,
    sorted_pos: np.ndarray,
    select_rows: np.ndarray,
    weight: np.ndarray,
) -> np.ndarray:
    """phi contribution of one block of observations (rows ``sorted_pos``) for
    the chosen realizations. ``weight`` is (observations, realizations)."""
    sim = np.asarray(values[sorted_pos][:, select_rows], dtype=np.float64)
    obsval = index.value[sorted_pos][:, None]
    flags = index.flags[sorted_pos]
    resid = sim - obsval
    greater = ((flags & FLAG_GREATER) != 0)[:, None]
    less = ((flags & FLAG_LESS) != 0)[:, None]
    # A greater-than observation counts only when simulated is below its value.
    resid = np.where(greater, np.minimum(resid, 0.0), resid)
    resid = np.where(less, np.maximum(resid, 0.0), resid)
    with np.errstate(invalid="ignore"):
        term = np.where(weight > 0, (weight * resid) ** 2, 0.0)
    return term.sum(axis=0)


def _not_checked(
    iteration: int,
    phi_file: Path,
    weights_source: str,
    reason: str,
    notes: list[str],
    n_only_in_cache: int = 0,
    n_only_in_file: int = 0,
) -> PhiCheck:
    summary = f"phi not checked for iteration {iteration}: {reason}"
    return PhiCheck(
        iteration=iteration,
        tolerance=PHI_TOLERANCE,
        weights_source=weights_source,
        phi_file=phi_file.name,
        status=STATUS_NOT_CHECKED,
        reason=reason,
        n_compared=0,
        n_mismatch=0,
        n_only_in_cache=n_only_in_cache,
        n_only_in_file=n_only_in_file,
        max_rel_diff=None,
        median_rel_diff=None,
        rows=(),
        summary=summary,
        notes=(*notes, summary),
    )


def check_phi(
    iteration: int,
    layout: CacheLayout,
    phi_file: Path,
    weights: AdjustedWeights | None,
) -> PhiCheck | ReadFailure:
    """Recompute phi for ``iteration`` from the cache and compare it with
    ``phi_file`` by realization name. Never raises.

    ``weights`` are the adjusted weights; ``None`` means the control file's
    weights are used, and the result says so. A row that disagrees is
    reported, never dropped.
    """
    name = f"phi_check/{iteration}"
    phi_path = Path(phi_file)
    try:
        index = load_obs_index(layout)
        if isinstance(index, ReadFailure):
            return _fail(name, index.path, f"the obs_index could not be read: {index.reason}")
        stored = load_obs_ensemble(iteration, layout)
        if isinstance(stored, ReadFailure):
            return _fail(
                name, stored.path, f"obs_ens/{iteration} could not be read: {stored.reason}"
            )
        weights_source = weights.source.name if weights is not None else CONTROL_WEIGHTS_SOURCE
        notes: list[str] = []
        if weights is None:
            notes.append(NO_WEIGHTS_FILE_NOTE)
        else:
            notes.extend(weights.notes)

        read = _read_phi_row(phi_path, iteration)
        if isinstance(read, ReadFailure):
            return read
        if isinstance(read, str):
            return _not_checked(iteration, phi_path, weights_source, read, notes)
        file_names, file_values, n_unreadable, _n_blank = read
        if n_unreadable:
            notes.append(
                f"{n_unreadable} value(s) in the iteration {iteration} row of {phi_path.name} "
                "could not be read as a number"
            )

        pairs, cache_only, file_only, join_notes = _join_names(
            stored.real_names, file_names, phi_path.name
        )
        notes.extend(join_notes)
        # An empty cell is a realization that was not run in this iteration.
        file_only_real = [j for j in file_only if not np.isnan(file_values[j])]
        blank_only = len(file_only) - len(file_only_real)
        if blank_only:
            notes.append(
                f"{blank_only} realization column(s) in {phi_path.name} have no value for "
                f"iteration {iteration} and are not counted"
            )

        weight_rows: dict[int, int] | None = None
        if weights is not None:
            w_pairs, _c_only, _w_only, w_notes = _join_names(
                stored.real_names, list(weights.real_names), weights.source.name
            )
            notes.extend(w_notes)
            weight_rows = {i: j for i, j in w_pairs}
            no_weights = [i for i, _j in pairs if i not in weight_rows]
            if no_weights:
                shown = _examples_text([stored.real_names[i] for i in no_weights])
                notes.append(
                    f"{len(no_weights)} realization(s) have no row in {weights.source.name}, so "
                    f"their phi was not recomputed{shown}"
                )
                pairs = [(i, j) for i, j in pairs if i in weight_rows]

        # A realization whose cell in the file is empty is not compared.
        absent_in_row = [(i, j) for i, j in pairs if np.isnan(file_values[j])]
        if absent_in_row:
            pairs = [(i, j) for i, j in pairs if not np.isnan(file_values[j])]
            cache_only = cache_only + [i for i, _ in absent_in_row]

        n_only_in_cache = len(cache_only)
        n_only_in_file = len(file_only_real)
        if n_only_in_cache:
            notes.append(
                f"{n_only_in_cache} realization(s) are in the cache but have no value in "
                f"{phi_path.name} for iteration {iteration}"
                f"{_examples_text([stored.real_names[i] for i in cache_only])}"
            )
        if n_only_in_file:
            notes.append(
                f"{n_only_in_file} realization(s) have a value in {phi_path.name} but are not "
                f"in the cache{_examples_text([file_names[j] for j in file_only_real])}"
            )
        if not pairs:
            return _not_checked(
                iteration,
                phi_path,
                weights_source,
                f"no realization is in both the cache and {phi_path.name} for iteration "
                f"{iteration}",
                notes,
                n_only_in_cache,
                n_only_in_file,
            )

        control_weight = None
        if weights is None:
            loaded = load_control_table(layout, "obs", columns=["obsnme", "weight"])
            if isinstance(loaded, ReadFailure):
                return _fail(name, loaded.path, f"the control table: {loaded.reason}")
            table, _table_notes = loaded
            if table.num_rows != index.control_rows:
                return _fail(
                    name,
                    phi_path,
                    f"the control table holds {table.num_rows} observations but the obs_index "
                    f"was built from {index.control_rows}",
                )
            by_row = np.asarray(table.column("weight").to_numpy(zero_copy_only=False), dtype=np.float64)
            control_weight = by_row[index.order.astype(np.int64)]

        cache_columns = [i for i, _j in pairs]
        recomputed, calc_notes = recompute_phi(
            index,
            stored.values,
            cache_columns,
            weights,
            [weight_rows[i] for i in cache_columns] if weight_rows is not None else None,
            control_weight,
        )
        notes.extend(calc_notes)

        rows: list[PhiRow] = []
        for k, (i, j) in enumerate(pairs):
            rel, match = compare_phi(float(recomputed[k]), float(file_values[j]))
            rows.append(
                PhiRow(
                    realization=stored.real_names[i],
                    recomputed=float(recomputed[k]) if np.isfinite(recomputed[k]) else None,
                    file=float(file_values[j]),
                    rel_diff=rel,
                    match=match,
                )
            )
        rows.sort(key=lambda r: r.realization)
        mismatched = [r.realization for r in rows if not r.match]
        defined = np.array([r.rel_diff for r in rows if r.rel_diff is not None], dtype=np.float64)
        undefined = len(rows) - defined.size
        if undefined:
            notes.append(
                f"{undefined} realization(s) have no relative difference (a value that is not a "
                "finite number, or a file value of 0 against a non-zero recomputation); they "
                "count as mismatches"
            )
        max_rel = float(defined.max()) if defined.size else None
        median_rel = float(np.median(defined)) if defined.size else None

        if mismatched:
            summary = (
                f"phi mismatch at iteration {iteration}: {len(mismatched)} of {len(rows)} "
                f"realization(s) differ from {phi_path.name} by more than {PHI_TOLERANCE:g}"
                f"{_examples_text(mismatched)}"
            )
            notes.append(summary)
        else:
            summary = (
                f"phi matches {phi_path.name} for all {len(rows)} realization(s) at iteration "
                f"{iteration} within {PHI_TOLERANCE:g}"
            )
        return PhiCheck(
            iteration=iteration,
            tolerance=PHI_TOLERANCE,
            weights_source=weights_source,
            phi_file=phi_path.name,
            status=STATUS_CHECKED,
            reason="",
            n_compared=len(rows),
            n_mismatch=len(mismatched),
            n_only_in_cache=n_only_in_cache,
            n_only_in_file=n_only_in_file,
            max_rel_diff=max_rel,
            median_rel_diff=median_rel,
            rows=tuple(rows),
            summary=summary,
            notes=tuple(notes),
        )
    except Exception as exc:
        return _fail(name, phi_path, f"failed to check phi: {exc}")


def write_phi_check(
    check: PhiCheck, iteration: int, layout: CacheLayout
) -> WrittenArtifact | ReadFailure:
    """Write ``agg/phi_check_K.json``. A mismatch is part of the result, so a
    check that found one is still written, and its notes carry the count."""
    name = f"phi_check/{iteration}"
    path = layout.phi_check(iteration)
    try:
        layout.ensure()
        payload = {
            "cache_version": CACHE_VERSION,
            "iteration": int(iteration),
            "tolerance": check.tolerance,
            "weights_source": check.weights_source,
            "phi_file": check.phi_file,
            "status": check.status,
            "reason": check.reason,
            "n_compared": check.n_compared,
            "n_mismatch": check.n_mismatch,
            "n_only_in_cache": check.n_only_in_cache,
            "n_only_in_file": check.n_only_in_file,
            "max_rel_diff": check.max_rel_diff,
            "median_rel_diff": check.median_rel_diff,
            "rows": [
                {
                    "realization": r.realization,
                    "recomputed": r.recomputed,
                    "file": r.file,
                    "rel_diff": r.rel_diff,
                    "match": r.match,
                }
                for r in check.rows
            ],
            "summary": check.summary,
            "notes": list(check.notes),
        }
        written = write_atomic_text(path, json.dumps(payload, indent=2, allow_nan=False))
        files = (CacheFile(path=str(path.relative_to(layout.root)), bytes=written),)
        return WrittenArtifact(name=name, files=files, notes=check.notes)
    except Exception as exc:
        path.unlink(missing_ok=True)
        return _fail(name, path, f"failed to write the phi check: {exc}")


def load_phi_check(iteration: int, layout: CacheLayout) -> PhiCheck | ReadFailure:
    """Read ``phi_check/K`` back. Refused when the version or the shape is
    not what this module wrote."""
    name = f"phi_check/{iteration}"
    path = layout.phi_check(iteration)
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

    def optional(value) -> float | None:
        return None if value is None else float(value)

    try:
        rows = tuple(
            PhiRow(
                realization=str(r["realization"]),
                recomputed=optional(r["recomputed"]),
                file=optional(r["file"]),
                rel_diff=optional(r["rel_diff"]),
                match=bool(r["match"]),
            )
            for r in raw["rows"]
        )
        return PhiCheck(
            iteration=int(raw["iteration"]),
            tolerance=float(raw["tolerance"]),
            weights_source=str(raw["weights_source"]),
            phi_file=str(raw["phi_file"]),
            status=str(raw["status"]),
            reason=str(raw["reason"]),
            n_compared=int(raw["n_compared"]),
            n_mismatch=int(raw["n_mismatch"]),
            n_only_in_cache=int(raw["n_only_in_cache"]),
            n_only_in_file=int(raw["n_only_in_file"]),
            max_rel_diff=optional(raw["max_rel_diff"]),
            median_rel_diff=optional(raw["median_rel_diff"]),
            rows=rows,
            summary=str(raw["summary"]),
            notes=tuple(str(n) for n in raw["notes"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(name, path, f"{path.name} has an unexpected shape: {exc}")
