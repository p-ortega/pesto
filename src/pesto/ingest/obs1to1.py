"""The observation view's 1:1 density grids: for every observation group, the
simulated values of the first and last iteration counted against the observed
value on one square grid.

Everything is read from the cache (``obs_index``, ``obs_ens/K``, ``obs_agg/K``),
never from the run folder. Each iteration counts its own realizations; the two
are never paired. Every finite simulated value of an observation that has a
target is either counted in a bin or counted as outside the drawn range, so
nothing is dropped without a trace. Observations left out, and why, are counted
per group in the sidecar.

The range of a group is the 1st to 99th percentile of the observed values and
the 5th and 95th percentile of both iterations, widened by 5 percent each side.
x and y share it and so do both iterations, so the two panels can be compared.
A group that cannot be drawn says why in its own entry and costs no other group
its grid.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsagg import OBS_STATS, load_obs_agg
from pesto.ingest.obsens import load_obs_ensemble
from pesto.ingest.obsindex import (
    FLAG_HAS_TARGET,
    FLAG_WEIGHTED,
    load_obs_index,
    sentinel_mask,
    usable_mask,
)
from pesto.ingest.parhist import identical_values_reason
from pesto.ingest.parview import _fail, _read_json
from pesto.ingest.tables import _write_parquet_atomic

OBS_1TO1_BINS = 180
OUTLYING_SITES = 10
RANGE_PERCENTILES = (1.0, 99.0)
RANGE_PADDING = 0.05
RMSE_RULE = (
    "root mean square of the ensemble-mean residual (simulated minus observed) over the "
    "observations that have one"
)
RANKING_RULE = (
    "the 10 sites with the largest RMSE of the ensemble-mean residual at the last iteration; "
    "ties go to the lower site id"
)
# A float32 block of this size is read at a time; the float64 copy and masks stay near 4x it.
_CHUNK_BYTES = 16 * 1024 * 1024

_PAYLOAD_COLUMNS = ("group", "iteration", "ix", "iy", "count")
_SIDECAR_KEYS = (
    "first_iteration",
    "last_iteration",
    "single_iteration",
    "n_bins",
    "order_digest",
    "rmse_rule",
    "ranking_rule",
    "groups",
    "notes",
)
_GROUP_KEYS = (
    "group",
    "n_obs",
    "n_with_target",
    "n_zero_weight",
    "lo",
    "hi",
    "iterations",
    "left_out",
    "outlying",
    "refused",
)


def one_to_one_range(
    obsval: np.ndarray, q_low: np.ndarray, q_high: np.ndarray
) -> tuple[float, float] | str:
    """``(lo, hi)`` for one group, or the sentence saying why there is none.

    The pool is the observed values and the 5th and 95th percentile of every
    iteration; non-finite entries and sentinels are ignored. The range is the 1st to 99th
    percentile of the pool, widened by 5 percent of its span on each side."""
    pool = np.concatenate(
        [np.asarray(v, dtype=np.float64).ravel() for v in (obsval, q_low, q_high)]
    )
    pool = pool[usable_mask(pool)]
    if pool.size == 0:
        return "this group holds no value to draw"
    low, high = (float(v) for v in np.percentile(pool, RANGE_PERCENTILES))
    if not high > low:
        return identical_values_reason("group")
    pad = RANGE_PADDING * (high - low)
    return low - pad, high + pad


def bin_pairs(
    obsval: np.ndarray, block: np.ndarray, lo: float, hi: float, n_bins: int = OBS_1TO1_BINS
) -> tuple[np.ndarray, int, int, int, int]:
    """Count the finite values of ``block`` (one row per observation, one column
    per realization) against that row's ``obsval`` on ``n_bins`` x ``n_bins``
    uniform bins from ``lo`` to ``hi`` on both axes.

    Returns ``(counts, n_points, n_outside, n_no_valid, n_nonfinite)``.
    ``counts[ix, iy]`` has ix along the observed value and iy along the
    simulated one, as ``numpy.histogram2d(x, y)`` gives it: a value exactly on an
    inner edge counts in the bin to its right and ``hi`` counts in the last bin.
    ``n_points`` is every finite pair; those off the grid are ``n_outside`` and
    are not in ``counts``. ``n_no_valid`` rows have no finite value at all, and
    ``n_nonfinite`` counts the missing values inside the other rows. A sentinel
    simulated value is missing here, like NaN, and does not count as a point."""
    edges = np.linspace(lo, hi, n_bins + 1)
    x = np.asarray(obsval, dtype=np.float64).ravel()
    y = np.asarray(block, dtype=np.float64)
    if y.ndim != 2 or y.shape[0] != x.shape[0]:
        raise ValueError("block must hold one row for each observed value")
    finite = usable_mask(y)
    n_points = int(finite.sum())
    n_no_valid = int((~finite.any(axis=1)).sum()) if y.shape[1] else int(y.shape[0])
    n_nonfinite = int((~finite).sum()) - n_no_valid * y.shape[1]

    x_in = (x >= lo) & (x <= hi)
    ix = np.searchsorted(edges, x, side="right") - 1
    ix[x == edges[-1]] = n_bins - 1
    inside = finite & x_in[:, None] & (y >= lo) & (y <= hi)
    iy = np.searchsorted(edges, y[inside], side="right") - 1
    iy[y[inside] == edges[-1]] = n_bins - 1
    flat = np.broadcast_to(ix[:, None], y.shape)[inside] * n_bins + iy
    counts = np.bincount(flat, minlength=n_bins * n_bins).reshape(n_bins, n_bins)
    return counts.astype(np.int64), n_points, n_points - int(inside.sum()), n_no_valid, n_nonfinite


def rms_of_mean_residual(resid: np.ndarray) -> tuple[float | None, int]:
    """``RMSE_RULE`` over the finite entries of ``resid``, and how many there
    were; ``(None, 0)`` when there is none."""
    values = np.asarray(resid, dtype=np.float64).ravel()
    values = values[usable_mask(values)]
    if values.size == 0:
        return None, 0
    return float(np.sqrt(np.mean(values**2))), int(values.size)


def rank_outlying(
    site_ids: np.ndarray,
    starts: np.ndarray,
    counts: np.ndarray,
    resid_last: np.ndarray,
    limit: int = OUTLYING_SITES,
) -> list[int]:
    """Up to ``limit`` site ids with the largest RMSE (``RMSE_RULE``) of their own
    observations' residuals, largest first, ties to the lower site id. A site
    with no finite residual is not ranked. ``starts`` and ``counts`` say which
    entries of ``resid_last`` belong to each site."""
    ids = np.asarray(site_ids, dtype=np.int64)
    first = np.asarray(starts, dtype=np.int64)
    size = np.asarray(counts, dtype=np.int64)
    if ids.size == 0 or limit <= 0:
        return []
    resid = np.asarray(resid_last, dtype=np.float64)
    finite = usable_mask(resid)
    squares = np.append(np.where(finite, resid, 0.0) ** 2, 0.0)
    valid = np.append(finite.astype(np.float64), 0.0)
    # A pair of bounds per site; every second sum is the gap between two sites and is dropped.
    bounds = np.column_stack([first, first + size]).ravel()
    total = np.add.reduceat(squares, bounds)[::2]
    used = np.add.reduceat(valid, bounds)[::2]
    ranked = (size > 0) & (used > 0)
    if not ranked.any():
        return []
    rmse = np.sqrt(total[ranked] / used[ranked])
    pick = ids[ranked]
    order = np.lexsort((pick, -rmse))[:limit]
    return [int(v) for v in pick[order]]


def _no_target_reason(n_no_value: int, n_sentinel: int) -> str:
    parts = []
    if n_sentinel:
        parts.append(f"{n_sentinel} sentinel")
    if n_no_value:
        parts.append(f"{n_no_value} without a numeric value")
    detail = f" ({' and '.join(parts)})" if parts else ""
    return f"no observation in this group has a measured value{detail}"


def _group_bounds(index) -> list[tuple[str, int, int]]:
    """Each group's name and its stored rows, ``start`` to ``stop``, from the
    group sizes. ``obs_index`` stores a group as one unbroken run."""
    names = [str(g) for g in index.groups["group"]]
    sizes = [int(n) for n in index.groups["n_obs"]]
    if sum(sizes) != index.n_obs:
        raise ValueError(
            f"the groups hold {sum(sizes)} observations but the obs_index holds {index.n_obs}"
        )
    stops = np.cumsum(sizes)
    return [(g, int(stop - size), int(stop)) for g, size, stop in zip(names, sizes, stops)]


def _iteration_counts(
    stored, start: int, stop: int, rows: np.ndarray, obsval: np.ndarray, lo: float, hi: float
):
    """One iteration's grid for the stored rows ``start`` to ``stop`` of which
    ``rows`` (offsets) have a target, read in chunks."""
    n_bins = OBS_1TO1_BINS
    grid = np.zeros((n_bins, n_bins), dtype=np.int64)
    totals = [0, 0, 0, 0]
    n_sentinel = 0
    step = max(1, _CHUNK_BYTES // (4 * max(int(stored.values.shape[1]), 1)))
    for chunk in range(start, stop, step):
        end = min(chunk + step, stop)
        picked = rows[(rows >= chunk - start) & (rows < end - start)]
        if picked.size == 0:
            continue
        block = np.asarray(stored.values[chunk:end])[picked - (chunk - start)]
        counts, *numbers = bin_pairs(obsval[picked], block, lo, hi, n_bins)
        grid += counts
        totals = [a + b for a, b in zip(totals, numbers)]
        n_sentinel += int(np.count_nonzero(sentinel_mask(block) & np.isfinite(block)))
    return grid, totals, n_sentinel


def write_obs_1to1(first: int, last: int, layout: CacheLayout) -> WrittenArtifact | ReadFailure:
    """Write ``agg/obs_1to1.parquet`` and then its sidecar ``agg/obs_1to1.json``,
    or leave nothing behind. Reads ``obs_index`` and the cached ``obs_ens/K``
    and ``obs_agg/K`` of the first and last iteration, never a source file.

    With ``first == last`` only one iteration has an observation ensemble: one
    grid per group, and the sidecar says so."""
    name = "obs_1to1"
    payload_path = layout.obs_1to1
    sidecar_path = layout.obs_1to1_meta
    written: list[Path] = []
    # Whatever an older ingest left must not outlive a failed rewrite and be read as current.
    for stale in (payload_path, sidecar_path):
        stale.unlink(missing_ok=True)
    try:
        single = first == last
        iterations = [first] if single else [first, last]
        index = load_obs_index(layout)
        if isinstance(index, ReadFailure):
            return _fail(name, index.path, f"the obs_index could not be read: {index.reason}")

        ensembles, aggs = [], []
        for iteration in iterations:
            ens = load_obs_ensemble(iteration, layout)
            if isinstance(ens, ReadFailure):
                return _fail(
                    name,
                    ens.path,
                    f"the observation ensemble of iteration {iteration} could not be read: "
                    f"{ens.reason}",
                )
            agg = load_obs_agg(iteration, layout)
            if isinstance(agg, ReadFailure):
                return _fail(
                    name,
                    agg.path,
                    f"the observation statistics of iteration {iteration} could not be read: "
                    f"{agg.reason}",
                )
            if ens.order_digest != index.order_digest or agg.order_digest != index.order_digest:
                return _fail(
                    name,
                    payload_path,
                    f"the ensemble or statistics of iteration {iteration} were built against a "
                    "different obs_index than the one in the cache; ingest the run again",
                )
            ensembles.append(ens)
            aggs.append(agg)

        bounds = _group_bounds(index)
        resid_row = OBS_STATS.index("resid_mean")
        q_rows = (OBS_STATS.index("q05"), OBS_STATS.index("q95"))
        site_starts = index.sites["start"].to_numpy(dtype=np.int64)
        site_counts = index.sites["count"].to_numpy(dtype=np.int64)
        site_ids = index.sites["site_id"].to_numpy(dtype=np.int64)
        if site_starts.size > 1 and (np.diff(site_starts) < 0).any():
            raise ValueError("the sites of the obs_index are not stored in row order")

        records: list[pd.DataFrame] = []
        entries = []
        outside_total = [0] * len(iterations)
        nonfinite_total = [0] * len(iterations)
        no_valid_total = [0] * len(iterations)
        sentinel_total = [0] * len(iterations)
        refused_groups = 0
        for group, start, stop in bounds:
            flags = index.flags[start:stop]
            value = index.value[start:stop]
            has_target = (flags & FLAG_HAS_TARGET) != 0
            no_value = np.isnan(value)
            n_no_value = int(no_value.sum())
            n_sentinel = int((~has_target & ~no_value).sum())
            n_target = int(has_target.sum())
            entry = {
                "group": group,
                "n_obs": int(stop - start),
                "n_with_target": n_target,
                "n_zero_weight": int((has_target & ((flags & FLAG_WEIGHTED) == 0)).sum()),
                "lo": None,
                "hi": None,
                "iterations": [],
                "left_out": {"no_value": n_no_value, "sentinel": n_sentinel},
                "outlying": [],
                "refused": None,
            }
            entries.append(entry)
            if n_target == 0:
                entry["refused"] = _no_target_reason(n_no_value, n_sentinel)
                refused_groups += 1
                continue

            rows = np.flatnonzero(has_target)
            q_low, q_high = (
                np.concatenate(
                    [np.asarray(agg.values[q, start:stop], dtype=np.float64)[rows] for agg in aggs]
                )
                for q in q_rows
            )
            bounds_or_reason = one_to_one_range(value[rows], q_low, q_high)
            if isinstance(bounds_or_reason, str):
                entry["refused"] = bounds_or_reason
                refused_groups += 1
                continue
            lo, hi = bounds_or_reason
            entry["lo"], entry["hi"] = lo, hi

            for slot, (iteration, stored) in enumerate(zip(iterations, ensembles)):
                grid, (n_points, n_outside, n_no_valid, n_nonfinite), n_sim_sentinel = (
                    _iteration_counts(stored, start, stop, rows, value, lo, hi)
                )
                entry["iterations"].append(
                    {
                        "iteration": int(iteration),
                        "n_points": n_points,
                        "n_outside": n_outside,
                        "n_no_valid": n_no_valid,
                        "n_nonfinite": n_nonfinite,
                        "n_sentinel": n_sim_sentinel,
                    }
                )
                sentinel_total[slot] += n_sim_sentinel
                outside_total[slot] += n_outside
                nonfinite_total[slot] += n_nonfinite
                no_valid_total[slot] += n_no_valid
                # iy runs slowest, so the rows come out by iy then ix.
                iy, ix = np.nonzero(grid.T)
                records.append(
                    pd.DataFrame(
                        {
                            "group": pd.Series([group] * iy.size, dtype="object"),
                            "iteration": pd.Series(np.full(iy.size, iteration), dtype="int32"),
                            "ix": pd.Series(ix, dtype="int16"),
                            "iy": pd.Series(iy, dtype="int16"),
                            "count": pd.Series(grid[ix, iy], dtype="int64"),
                        }
                    )
                )

            low_site = int(np.searchsorted(site_starts, start, side="left"))
            high_site = int(np.searchsorted(site_starts, stop, side="left"))
            resid_last = np.asarray(aggs[-1].values[resid_row, start:stop], dtype=np.float64)
            entry["outlying"] = rank_outlying(
                site_ids[low_site:high_site],
                site_starts[low_site:high_site] - start,
                site_counts[low_site:high_site],
                resid_last,
            )

        if records:
            table = pd.concat(records, ignore_index=True)
        else:
            table = pd.DataFrame(
                {
                    "group": pd.Series([], dtype="object"),
                    "iteration": pd.Series([], dtype="int32"),
                    "ix": pd.Series([], dtype="int16"),
                    "iy": pd.Series([], dtype="int16"),
                    "count": pd.Series([], dtype="int64"),
                }
            )
        payload_bytes = _write_parquet_atomic(table, payload_path)
        written.append(payload_path)

        notes: list[str] = []
        if single:
            notes.append(
                f"only iteration {first} has an observation ensemble, so the 1:1 plot has one panel"
            )
        if refused_groups:
            notes.append(
                f"{refused_groups} of {len(entries)} group(s) have no 1:1 grid; each says why "
                "in its own entry"
            )
        for slot, iteration in enumerate(iterations):
            if outside_total[slot]:
                notes.append(
                    f"iteration {iteration}: {outside_total[slot]} simulated value(s) fall outside "
                    "the drawn range; they are counted per group and not drawn"
                )
            if sentinel_total[slot]:
                notes.append(
                    f"iteration {iteration}: {sentinel_total[slot]} simulated value(s) are a "
                    "sentinel (a dry or no-flow placeholder); they are counted per group as "
                    "n_sentinel, are not in any bin and do not set the range"
                )
            if no_valid_total[slot]:
                notes.append(
                    f"iteration {iteration}: {no_valid_total[slot]} observation(s) have no finite "
                    "simulated value and are left out"
                )
            if nonfinite_total[slot]:
                notes.append(
                    f"iteration {iteration}: {nonfinite_total[slot]} simulated value(s) are not "
                    "finite and are left out"
                )

        sidecar = {
            "cache_version": CACHE_VERSION,
            "first_iteration": int(first),
            "last_iteration": int(last),
            "single_iteration": single,
            "n_bins": OBS_1TO1_BINS,
            "order_digest": index.order_digest,
            "range_rule": (
                "the 1st to 99th percentile of the observed values and the 5th and 95th "
                "percentile of every iteration, widened by 5 percent on each side; the same "
                "range for x, y and both iterations"
            ),
            "rmse_rule": RMSE_RULE,
            "ranking_rule": RANKING_RULE,
            "groups": entries,
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
            f"failed to write the 1:1 grids: {exc} -- cleaned up {removed} file(s) "
            "already written for this artifact",
        )


def read_planned_ends(layout: CacheLayout) -> tuple[int, int | None] | ReadFailure:
    """The first and last observation iteration the last ingest planned, as the 1:1
    sidecar recorded them; the last is None when there was only one. Reads the sidecar only."""
    sidecar = _read_json("obs_1to1", layout.obs_1to1_meta)
    if isinstance(sidecar, ReadFailure):
        return sidecar
    try:
        first, last = int(sidecar["first_iteration"]), int(sidecar["last_iteration"])
        single = bool(sidecar["single_iteration"])
    except (KeyError, TypeError, ValueError) as exc:
        return _fail("obs_1to1", layout.obs_1to1_meta, f"the sidecar names no usable ends: {exc}")
    return first, (None if single else last)


def load_obs_1to1(layout: CacheLayout) -> tuple[pd.DataFrame, dict] | ReadFailure:
    """Read ``obs_1to1`` back as its rows and its sidecar. The sidecar and its
    ``cache_version`` are checked before the rows are trusted."""
    name = "obs_1to1"
    sidecar = _read_json(name, layout.obs_1to1_meta)
    if isinstance(sidecar, ReadFailure):
        return sidecar
    try:
        for key in _SIDECAR_KEYS:
            sidecar[key]
        for key in ("first_iteration", "last_iteration", "n_bins"):
            int(sidecar[key])
        if not isinstance(sidecar["groups"], list) or not isinstance(sidecar["notes"], list):
            raise TypeError("groups and notes must be lists")
        for group in sidecar["groups"]:
            for key in _GROUP_KEYS:
                group[key]
            if not isinstance(group["iterations"], list) or not isinstance(group["outlying"], list):
                raise TypeError(f"group {group['group']!r} has malformed lists")
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(
            name,
            layout.obs_1to1_meta,
            f"{layout.obs_1to1_meta.name} is not shaped like a 1:1 sidecar: {exc}",
        )
    try:
        frame = pd.read_parquet(layout.obs_1to1)
    except Exception as exc:
        return _fail(name, layout.obs_1to1, f"could not read {layout.obs_1to1.name}: {exc}")
    if tuple(frame.columns) != _PAYLOAD_COLUMNS:
        return _fail(
            name,
            layout.obs_1to1,
            f"{layout.obs_1to1.name} holds the columns {list(frame.columns)}, "
            f"not {list(_PAYLOAD_COLUMNS)}",
        )
    return frame, sidecar

