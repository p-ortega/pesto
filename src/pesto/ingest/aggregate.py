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

from dataclasses import dataclass
from typing import TYPE_CHECKING, Sequence

import numpy as np
import pandas as pd

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
    """
    control_names = tuple(str(n) for n in tables.par["parnme"])
    n_real = data.values.shape[0]
    n_control = len(control_names)
    out = np.full((n_real, n_control), np.nan, dtype=np.float32)
    notes: list[str] = []

    entity_index: dict[str, int] = {}
    for idx, name in enumerate(data.entity_names):
        entity_index.setdefault(name.strip().lower(), idx)

    for control_pos, name in enumerate(control_names):
        idx = entity_index.get(name.strip().lower())
        if idx is None:
            notes.append(
                f"parameter {name!r} is present in the control file but absent from the "
                f"ensemble; recorded as a row of missing values"
            )
            continue
        out[:, control_pos] = data.values[:, idx]

    return out, control_names, notes
