"""Per-parameter summaries for one ingested iteration, in one pass.

Every statistic in the table -- mean, std, min, max, five quantiles and how
many realizations went into them -- comes from one pass over the ensemble.
The quantiles are linearly interpolated the way ``numpy.percentile``
interpolates by default, so a modeller typing ``np.percentile`` against the
same ensemble gets the same number back, whether or not any realization in
it failed. Mean and standard deviation are arithmetic, in the parameter's
native control-file units whatever its ``partrans`` -- one number each, so
every column means exactly one thing; the stored quantiles are what carry
the shape of a distribution the mean cannot.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Sequence

import numpy as np
import pandas as pd

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure

if TYPE_CHECKING:
    from pesto.ingest.control import ControlTables
    from pesto.ingest.ensfile import EnsembleData

PERCENTILES = (5, 25, 50, 75, 95)


def _interpolated_percentiles(
    values: np.ndarray, percentiles: tuple[int, ...]
) -> dict[str, np.ndarray]:
    """Every percentile in ``percentiles``, linearly interpolated, from one
    ``np.partition`` call.

    ``values`` is ``(n, k)`` (or ``(n,)`` for a single column) with no NaN
    in it -- a caller with missing data extracts each column's own valid
    values first. Each percentile's virtual index is ``(n - 1) * p / 100``;
    its floor and ceiling are the two order statistics that bracket it, and
    every distinct index any requested percentile needs is collected into
    one sorted ``kth`` list before ``np.partition`` runs once. Duplicate
    indices collapse harmlessly. This is exactly what ``numpy.percentile``'s
    default (``interpolation="linear"``) computes -- the same run must not
    get two different numbers for the same quantile depending on how it was
    read.

    This one call allocates an output array the same size as its input --
    measured at 2.0 GB for a 500-by-1,000,000 float32 ensemble, taking
    7.33 s. Peak memory for this step is therefore about twice the size of
    the array it is called on, paid inside the artifact's own worker
    process.
    """
    n = values.shape[0]
    virtual_idx = {p: (n - 1) * p / 100 for p in percentiles}
    lowers = {p: int(np.floor(virtual_idx[p])) for p in percentiles}
    uppers = {p: int(np.ceil(virtual_idx[p])) for p in percentiles}
    wanted = sorted(set(lowers.values()) | set(uppers.values()))
    partitioned = np.partition(values, wanted, axis=0)
    out: dict[str, np.ndarray] = {}
    for p in percentiles:
        lo, hi = lowers[p], uppers[p]
        frac = virtual_idx[p] - lo
        out[f"q{p:02d}"] = (
            partitioned[lo] + frac * (partitioned[hi] - partitioned[lo])
        ).astype(np.float32)
    return out


@dataclass(frozen=True, eq=False)
class ParSummary:
    """One iteration's per-parameter summary table, and the notes reading
    it produced -- held together so a caller does not have to zip two
    return values back up itself."""

    table: pd.DataFrame
    notes: tuple[str, ...]

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ParSummary):
            return NotImplemented
        return self.table.equals(other.table) and self.notes == other.notes

    __hash__ = None


def summarise(values: np.ndarray, names: Sequence[str]) -> tuple[pd.DataFrame, list[str]]:
    """Summarise a realization-major ``(n_real, n_par)`` float32 array into
    one row per parameter: ``parnme``, ``mean``, ``std``, ``min``, ``max``,
    the five columns in ``PERCENTILES`` and ``n_valid``.

    ``n_valid`` counts values that are not NaN and nothing else: pestpp-ies
    removes a failed realization from the ensemble rather than writing a
    NaN row for it (verified against the pestpp-ies source), so there is no
    separate "present but marked failed" state for this count to also
    account for.

    Columns share the same set of valid rows only when every column does --
    the all-valid case runs ``_interpolated_percentiles`` once, over the
    whole array, in one ``np.partition`` call. Otherwise columns are
    grouped by how many valid values they actually have, and each group
    gets its own single ``np.partition`` call over just its own valid
    values, densified into a rectangular array first -- there is no fast
    path that computes a quantile any other way, so ``q05`` means the same
    thing whether or not a realization in this ensemble failed.

    A parameter with no valid realizations gets ``n_valid`` zero, a missing
    value in every statistic, and a note naming it. A parameter with
    exactly one valid realization gets that value for min, max, mean and
    every quantile, and a missing value for std -- a standard deviation
    over one sample is not a number this function states.
    """
    values = np.asarray(values, dtype=np.float32)
    n_real, n_par = values.shape
    names = list(names)
    notes: list[str] = []

    valid_mask = ~np.isnan(values)
    n_valid = valid_mask.sum(axis=0)

    mean = np.full(n_par, np.nan, dtype=np.float64)
    std = np.full(n_par, np.nan, dtype=np.float64)
    minv = np.full(n_par, np.nan, dtype=np.float32)
    maxv = np.full(n_par, np.nan, dtype=np.float32)
    quantile_cols = {f"q{p:02d}": np.full(n_par, np.nan, dtype=np.float32) for p in PERCENTILES}

    all_valid = bool(np.all(valid_mask)) if n_par else True
    if all_valid:
        groups: dict[int, list[int]] = {n_real: list(range(n_par))} if n_par else {}
    else:
        groups = {}
        for col in range(n_par):
            nv = int(n_valid[col])
            if nv == 0:
                continue
            groups.setdefault(nv, []).append(col)

    for group_n, cols in groups.items():
        if all_valid:
            group_values = values[:, cols]
        else:
            group_values = np.empty((group_n, len(cols)), dtype=np.float32)
            for j, col in enumerate(cols):
                group_values[:, j] = values[valid_mask[:, col], col]

        qdict = _interpolated_percentiles(group_values, PERCENTILES)
        for key, arr in qdict.items():
            quantile_cols[key][cols] = arr
        minv[cols] = np.min(group_values, axis=0)
        maxv[cols] = np.max(group_values, axis=0)
        mean[cols] = np.mean(group_values, axis=0, dtype=np.float64)
        if group_n > 1:
            std[cols] = np.std(group_values, axis=0, dtype=np.float64, ddof=0)
        # group_n == 1: std stays NaN -- not a number this function states.

    for idx, name in enumerate(names):
        if n_valid[idx] == 0:
            notes.append(
                f"parameter {name!r} has no valid realizations; all statistics are missing"
            )

    data: dict[str, object] = {
        "parnme": names,
        "mean": mean,
        "std": std,
        "min": minv,
        "max": maxv,
    }
    data.update(quantile_cols)
    data["n_valid"] = n_valid.astype(np.int64)

    summary = ParSummary(table=pd.DataFrame(data), notes=tuple(notes))
    return summary.table, list(summary.notes)


def align_to_control(
    data: "EnsembleData", tables: "ControlTables"
) -> tuple[np.ndarray, tuple[str, ...], list[str]]:
    """Reorder ``data.values`` into control-file order -- what a person
    reads, whatever order the ensemble file happens to hold.

    Matches by name directly against ``data.entity_names``, not through
    ``EnsembleData.permutation``: that field comes back ``None`` the moment
    even one control-file parameter cannot be found in the ensemble
    (``_build_permutation``'s all-or-nothing refusal -- the right answer
    for a two-block file writer that must place every control-file
    parameter somewhere, wrong here). A control-file parameter genuinely
    absent from the ensemble is exactly the case this function must still
    handle: it gets a column of NaN and a note naming it, never a shorter
    table -- a table that quietly loses a row is indistinguishable from a
    run that never had that parameter.

    Identity is exact string equality, byte for byte -- the same discipline
    ``align_realizations`` applies to realization names and is tested for,
    because a match that folds case or whitespace can join two genuinely
    different parameters and nothing in the table afterwards can tell. A
    control-file name that differs from an ensemble entity name only in
    letter case or surrounding whitespace does not join: it falls into the
    same missing-value branch as a genuinely absent parameter, but its note
    also names the ensemble entity it nearly matched and says the two were
    not joined because the strings are not equal -- so a caller can tell an
    upstream spelling mistake from a parameter the run genuinely does not
    have.
    """
    control_names = tuple(str(n) for n in tables.par["parnme"])
    n_real = data.values.shape[0]
    n_control = len(control_names)
    out = np.full((n_real, n_control), np.nan, dtype=np.float32)
    notes: list[str] = []

    entity_index: dict[str, int] = {}
    for idx, name in enumerate(data.entity_names):
        entity_index.setdefault(name, idx)

    # Consulted only for a name the exact lookup above did not find, so a
    # near match never joins -- it only ever names what was nearly, and
    # deliberately not, matched.
    folded_index: dict[str, str] = {}
    for name in data.entity_names:
        folded_index.setdefault(name.strip().lower(), name)

    for control_pos, name in enumerate(control_names):
        idx = entity_index.get(name)
        if idx is None:
            near_match = folded_index.get(name.strip().lower())
            if near_match is not None:
                notes.append(
                    f"parameter {name!r} is present in the control file but absent from the "
                    f"ensemble; recorded as a row of missing values -- the ensemble holds "
                    f"{near_match!r}, which matches only after folding case and whitespace, "
                    f"so the two were not joined"
                )
            else:
                notes.append(
                    f"parameter {name!r} is present in the control file but absent from the "
                    f"ensemble; recorded as a row of missing values"
                )
            continue
        out[:, control_pos] = data.values[:, idx]

    return out, control_names, notes


# ---------------------------------------------------------------------------
# Task 2: pestpp's own near-bound rule, and the table on disk
# ---------------------------------------------------------------------------


def _bound_label(col: int, names: Sequence[str] | None) -> str:
    if names is not None:
        return repr(names[col])
    return f"column {col}"


def at_bounds_fraction(
    values: np.ndarray,
    lower: np.ndarray,
    upper: np.ndarray,
    log_mask: np.ndarray,
    names: Sequence[str] | None = None,
    adjustable_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, list[str]]:
    """The per-parameter fraction of realizations pestpp-ies's own rule
    counts at or near a bound.

    The rule is read out of ``ParChangeSummarizer::update`` in the
    pestpp-ies source, not invented here: a value counts near the *upper*
    bound when it exceeds ``upper - abs(upper) * 0.01``; a value counts
    near the *lower* bound, checked only when it was not already counted
    near the upper one, when it is below ``lower + abs(lower) * 0.01``.
    This is a one-percent tolerance on each bound's own magnitude, upper
    checked first, and the two tests are mutually exclusive per value.

    ``ParChangeSummarizer::update`` iterates ``pe.get_var_names()`` --
    pestpp-ies's *adjustable* parameters only, never the fixed or tied
    ones a ``.par`` ensemble file still carries a column for. A fixed
    parameter typically holds the same value in every realization, and
    that value can legitimately sit near a bound without pestpp-ies ever
    reporting it in ``case.N.pcs.csv``, because it was never a candidate
    for adjustment in the first place -- confirmed empirically against a
    real benchmark's own file (a "fixed"-only parameter group whose
    members do sit at a bound, and whose ``pcs.csv`` row is genuinely
    zero). ``adjustable_mask``, when given, is ``True`` for every
    parameter pestpp-ies would actually adjust; every other column's
    fraction is recorded as missing rather than a number that would not
    reconcile with ``pcs.csv``.

    The comparison happens in the numeric space ``partrans`` implies, to
    match what pestpp-ies itself does internally: for every column
    ``log_mask`` marks, both the value and its bounds are converted to
    base-ten logarithms before the one-percent test, because the ensemble
    files this function reads hold native units for every ``partrans``,
    while pestpp's own near-bound comparison runs against the numeric
    (log10, for a log-transformed parameter) space its solve is in. Where
    a log-transformed parameter's lower or upper bound is not positive, the
    logarithm is not defined and the rule cannot be applied: that
    parameter's fraction comes back missing, with a note naming it and
    saying the bound could not be put into log space -- a number produced
    by silently applying the native-space rule instead would not be
    reconcilable with the run it describes.

    ``values`` is ``(n_real, n_par)``; ``lower``, ``upper`` and ``log_mask``
    are each ``(n_par,)``. ``names`` labels each column in a note; when
    omitted, the column's zero-based position stands in for a name.
    """
    values = np.asarray(values, dtype=np.float64)
    lower = np.asarray(lower, dtype=np.float64)
    upper = np.asarray(upper, dtype=np.float64)
    log_mask = np.asarray(log_mask, dtype=bool)

    n_real, n_par = values.shape
    notes: list[str] = []

    valid_mask = ~np.isnan(values)
    n_valid = valid_mask.sum(axis=0)

    log_bound_invalid = log_mask & ~((lower > 0) & (upper > 0))
    for col in np.nonzero(log_bound_invalid)[0]:
        notes.append(
            f"parameter {_bound_label(int(col), names)}: bound could not be converted to "
            f"log space (lower={lower[col]!r}, upper={upper[col]!r}); at-bounds value is missing"
        )

    apply_log = log_mask & ~log_bound_invalid

    lo = lower.copy()
    hi = upper.copy()
    log_cols = np.nonzero(apply_log)[0]
    v = values
    if log_cols.size:
        v = values.copy()
        with np.errstate(divide="ignore", invalid="ignore"):
            v[:, log_cols] = np.log10(values[:, log_cols])
            lo[log_cols] = np.log10(lower[log_cols])
            hi[log_cols] = np.log10(upper[log_cols])

    with np.errstate(invalid="ignore"):
        near_upper = valid_mask & (v > (hi[np.newaxis, :] - np.abs(hi[np.newaxis, :]) * 0.01))
        near_lower = (
            valid_mask
            & ~near_upper
            & (v < (lo[np.newaxis, :] + np.abs(lo[np.newaxis, :]) * 0.01))
        )

    count_near = near_upper.sum(axis=0) + near_lower.sum(axis=0)

    fraction = np.full(n_par, np.nan, dtype=np.float64)
    has_valid = n_valid > 0
    fraction[has_valid] = count_near[has_valid] / n_valid[has_valid]
    fraction[log_bound_invalid] = np.nan

    if adjustable_mask is not None:
        adjustable_mask = np.asarray(adjustable_mask, dtype=bool)
        not_adjustable = ~adjustable_mask
        n_not_adjustable = int(np.count_nonzero(not_adjustable))
        if n_not_adjustable:
            fraction[not_adjustable] = np.nan
            notes.append(
                f"{n_not_adjustable} parameter(s) are fixed or tied, so pestpp-ies never "
                f"adjusts them and its own near-bound rule never considers them either; "
                f"their at-bounds value is recorded as missing"
            )

    return fraction, notes


def write_par_agg(
    data: "EnsembleData", tables: "ControlTables", iteration: int, layout: CacheLayout
) -> WrittenArtifact | ReadFailure:
    """Write ``agg/par_{iteration}.parquet``: one row per control-file
    parameter, in control-file order, carrying ``parnme``, ``pargp``,
    ``mean``, ``std``, ``min``, ``max``, the five quantiles, ``n_valid``
    and ``at_bounds``.

    Calls ``align_to_control``, ``summarise`` and ``at_bounds_fraction`` in
    turn and carries every note the three of them produce into the
    returned :class:`WrittenArtifact`. The table is written through
    ``write_atomic_bytes``, handing the open temp file straight to
    ``DataFrame.to_parquet`` -- a crash mid-write leaves the previous
    finished file in place (or nothing, on the first write), never a
    half-written table a later size check would call fresh. Any exception
    anywhere in this function returns a :class:`ReadFailure` naming the
    iteration and what was being attempted, rather than propagating.

    Writes ``agg/par_{iteration}.notes.json`` beside the table, after it,
    holding every note in full -- the manifest carries only a bounded copy
    of these notes (``MANIFEST_NOTE_CAP``), so a caller who finds the "N
    further notes" note there knows this file is where the rest of them
    are.
    """
    name = f"par_agg/{iteration}"
    target = layout.par_agg(iteration)
    try:
        par = tables.par
        values, control_names, align_notes = align_to_control(data, tables)
        summary_df, summary_notes = summarise(values, control_names)

        notes: list[str] = list(align_notes) + list(summary_notes)

        if "pargp" in par.columns:
            pargp = par["pargp"].astype(str).tolist()
        else:
            pargp = [None] * len(control_names)
            notes.append(
                "control file has no 'pargp' column; pargp is recorded as missing for "
                "every parameter"
            )

        if "parlbnd" in par.columns and "parubnd" in par.columns:
            lower = par["parlbnd"].to_numpy(dtype=np.float64)
            upper = par["parubnd"].to_numpy(dtype=np.float64)
        else:
            lower = np.full(len(control_names), np.nan)
            upper = np.full(len(control_names), np.nan)
            notes.append(
                "control file is missing 'parlbnd' and/or 'parubnd'; at_bounds is recorded "
                "as missing for every parameter"
            )

        if "partrans" in par.columns:
            partrans_lower = [str(t).strip().lower() for t in par["partrans"]]
            log_mask = np.array([t == "log" for t in partrans_lower], dtype=bool)
            adjustable_mask = np.array(
                [t not in ("fixed", "tied") for t in partrans_lower], dtype=bool
            )
        else:
            log_mask = np.zeros(len(control_names), dtype=bool)
            adjustable_mask = np.ones(len(control_names), dtype=bool)
            notes.append(
                "control file has no 'partrans' column; no parameter is treated as "
                "log-transformed or as fixed/tied for the at-bounds test"
            )

        at_bounds, bounds_notes = at_bounds_fraction(
            values, lower, upper, log_mask, names=control_names, adjustable_mask=adjustable_mask
        )
        notes.extend(bounds_notes)

        df = summary_df.copy()
        df.insert(1, "pargp", pargp)
        df["at_bounds"] = at_bounds
        column_order = [
            "parnme",
            "pargp",
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
            "at_bounds",
        ]
        df = df[column_order]

        def _write_payload(fileobj) -> int:
            df.to_parquet(fileobj, index=False)
            return fileobj.tell()

        written_bytes = write_atomic_bytes(target, _write_payload)
        file_entry = CacheFile(path=str(target.relative_to(layout.root)), bytes=written_bytes)

        # Written after the table, never before: a reader must never find a
        # sidecar naming a file that is not there yet (write_mesh's rule).
        notes_target = layout.par_agg_notes(iteration)
        notes_payload = {
            "cache_version": CACHE_VERSION,
            "iteration": iteration,
            "n_par": len(control_names),
            "notes": notes,
        }
        notes_bytes = write_atomic_text(notes_target, json.dumps(notes_payload, indent=2))
        notes_entry = CacheFile(
            path=str(notes_target.relative_to(layout.root)), bytes=notes_bytes
        )

        return WrittenArtifact(name=name, files=(file_entry, notes_entry), notes=tuple(notes))
    except Exception as exc:
        return ReadFailure(
            name=name,
            path=str(target),
            reason=f"failed to write per-parameter summary for iteration {iteration}: {exc}",
        )
