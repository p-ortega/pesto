"""The observation view's routes: one site's observed values and noise band, and
one site's simulated series.

All read the cache through the memo in ``obscache``, never a run directory. The
site arrives as query text and is matched by value against the cached site ids;
it is never used as a row position.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Annotated

import numpy as np
import pandas as pd
from fastapi import APIRouter, Query, Request
from pydantic import Field, field_validator
from starlette.responses import JSONResponse, Response

from pesto.api import obscache
from pesto.api.blob import blob_response
from pesto.api.ingest import NO_NOISE_REASON
from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.api.tables import arrow_response
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.basereal import find_base
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obs1to1 import (
    RMSE_RULE,
    _group_bounds,
    load_obs_1to1,
    rms_of_mean_residual,
)
from pesto.ingest.obsagg import OBS_STATS, RESIDUAL_TEXT
from pesto.ingest.obsindex import (
    FLAG_HAS_TARGET,
    FLAG_WEIGHTED,
    SENTINEL_LIMIT,
    SENTINEL_RULE_VERSION,
    blank_sentinels,
    sentinel_mask,
    usable_mask,
)
from pesto.ingest.parhist import shared_edge_histogram

router = APIRouter(prefix="/api/run")


class ObsSiteQuery(RunQuery):
    """``site`` is the one accepted field; ``RunQuery`` turns any other into a 422."""

    site: int


class ObsGroupQuery(RunQuery):
    """``group`` is the one accepted field; ``RunQuery`` turns any other into a 422."""

    group: str


MAX_POINT_SITES = 20


def _parse_site_ids(text: str) -> list[int]:
    """Comma-separated whole numbers, at least one and at most ``MAX_POINT_SITES``."""
    try:
        ids = [int(part) for part in text.split(",")]
    except ValueError:
        raise ValueError("sites must be whole numbers separated by commas") from None
    if len(ids) > MAX_POINT_SITES:
        raise ValueError(f"at most {MAX_POINT_SITES} sites can be asked for at once, got {len(ids)}")
    return ids


class ObsPointsQuery(RunQuery):
    """``group`` and ``sites`` (comma-separated site ids) are the accepted fields."""

    group: str
    sites: str

    @field_validator("sites")
    @classmethod
    def _sites_are_ids(cls, value: str) -> str:
        _parse_site_ids(value)
        return value

    @property
    def site_ids(self) -> list[int]:
        return _parse_site_ids(self.sites)


class ObsSeriesQuery(RunQuery):
    """``site`` and ``iteration`` are the accepted fields."""

    site: int
    iteration: int


def _site_row(index, site: int) -> pd.Series | None:
    """The ``sites`` row whose ``site_id`` equals ``site``, or None."""
    found = pd.Index(index.sites["site_id"]).get_indexer([site])[0]
    if found < 0:
        return None
    return index.sites.iloc[int(found)]


def _unknown_site(site: int) -> Response:
    return problem(
        404,
        "no observation site has that id",
        artifact="obs_index",
        detail=f"the cached observation index holds no site with id {site}",
    )


def _numbers(values: np.ndarray) -> list[float | None]:
    """JSON-safe numbers: a finite float, or None where there is none or it is a sentinel."""
    array = np.asarray(values, dtype=np.float64)
    return [float(v) if ok else None for v, ok in zip(array, usable_mask(array))]


def _unavailable(artifact: str, reason: str) -> dict:
    return {"available": False, "artifact": artifact, "reason": reason}


def _recorded_reason(manifest: Manifest, name: str, fallback: str) -> str | None:
    """None when ``name`` is recorded ok; otherwise the reason it gives, or ``fallback``."""
    recorded = manifest.artifacts.get(name)
    if recorded is not None and recorded.state == "ok":
        return None
    return recorded.reason if recorded is not None and recorded.reason else fallback


def _noise_band(state, cache_root, manifest: Manifest, start: int, count: int) -> tuple[dict, list[str]]:
    reason = _recorded_reason(manifest, "noise_agg", NO_NOISE_REASON)
    if reason is not None:
        return _unavailable("noise_agg", reason), []
    stored = obscache.get_noise(state, cache_root)
    if isinstance(stored, ReadFailure):
        return _unavailable("noise_agg", stored.reason), []
    rows = {name: stored.values[i, start : start + count] for i, name in enumerate(stored.stats)}
    band = {
        "available": True,
        "q05": _numbers(rows["q05"]),
        "q95": _numbers(rows["q95"]),
        "source": stored.source,
        "base": stored.base,
        "n_real_used": int(stored.n_real_used),
    }
    return band, list(stored.notes)


def _placement(state, cache_root, manifest: Manifest, site: int) -> dict:
    reason = _recorded_reason(
        manifest, "obs_cell", "no observation placement was ingested for this run"
    )
    if reason is not None:
        return _unavailable("obs_cell", reason)
    table = obscache.get_cell(state, cache_root)
    if isinstance(table, ReadFailure):
        return _unavailable("obs_cell", table.reason)
    found = pd.Index(table.site_id).get_indexer([site])[0]
    if found < 0:
        return _unavailable("obs_cell", f"the cached placement holds no site with id {site}")
    note = table.note[int(found)] if table.note is not None else ""
    return {
        "available": True,
        "rule": table.rule[int(found)],
        "note": note or None,
        "layer": int(table.layer[int(found)]),
        "cell": int(table.cell[int(found)]),
    }


@router.get("/obs/site")
async def get_obs_site(request: Request, params: Annotated[ObsSiteQuery, Query()]) -> Response:
    """One site's observed values and flags, noise band and placement. A piece
    that is not there says which artifact and why."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    row = _site_row(index, params.site)
    if row is None:
        return _unknown_site(params.site)

    start, count = int(row["start"]), int(row["count"])
    window = slice(start, start + count)
    value = index.value[window]
    flags = index.flags[window]
    group = index.groups.loc[index.groups["group"] == row["group"], "inequality"]
    manifest = Manifest.load(CacheLayout(root=Path(cache_root)))
    noise, notes = _noise_band(state, cache_root, manifest, start, count)

    body = {
        "site_id": int(params.site),
        "site": str(row["site"]),
        "group": str(row["group"]),
        "time_kind": str(row["time_kind"]),
        "inequality": str(group.iloc[0]) if len(group) else "none",
        "n_obs": count,
        "time": _numbers(index.time[window]),
        "obsval": _numbers(np.where(np.abs(value) >= SENTINEL_LIMIT, np.nan, value)),
        "no_value": [bool(v) for v in np.isnan(value)],
        "sentinel": [bool(v) for v in np.abs(value) >= SENTINEL_LIMIT],
        "weighted": [bool(v) for v in (flags & FLAG_WEIGHTED) != 0],
        "noise": noise,
        "placement": _placement(state, cache_root, manifest, params.site),
        "iterations": obscache.obs_iterations(manifest),
        "notes": notes,
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/obs/series")
async def get_obs_series(request: Request, params: Annotated[ObsSeriesQuery, Query()]) -> Response:
    """One site's rows of one iteration's observation ensemble, float32 (n_obs of
    the site, n_real), in time order. Base is found in this iteration's own names."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    row = _site_row(index, params.site)
    if row is None:
        return _unknown_site(params.site)

    name = f"{obscache.OBS_ENS_PREFIX}{params.iteration}"
    manifest = Manifest.load(CacheLayout(root=Path(cache_root)))
    recorded = manifest.artifacts.get(name)
    if recorded is None or recorded.state != "ok":
        reason = recorded.reason if recorded is not None and recorded.reason else None
        return problem(
            404,
            "no observation ensemble for that iteration",
            artifact=name,
            detail=reason or f"no observation ensemble was ingested for iteration {params.iteration}",
        )
    stored = obscache.get_ens(state, cache_root, params.iteration)
    if isinstance(stored, ReadFailure):
        return problem_from_failure(404, stored)

    start, count = int(row["start"]), int(row["count"])
    rows = np.asarray(stored.values[start : start + count], dtype="<f4")
    n_nan = int(np.count_nonzero(~np.isfinite(rows)))
    rows, n_sentinel = blank_sentinels(rows)
    base_index, base_note = find_base(stored.real_names)
    meta = {
        "site_id": int(params.site),
        "iteration": int(params.iteration),
        "n_real": len(stored.real_names),
        "base_index": base_index,
        "base_note": base_note,
        "n_nan": n_nan,
        "n_sentinel": n_sentinel,
    }
    return blob_response(rows, meta=meta, cache_control="no-store")


_RESID_ROW = OBS_STATS.index("resid_mean")
NO_OBS_ENS_REASON = "no observation ensemble was ingested for this run"
NO_1TO1_REASON = "no 1:1 grid was ingested for this run"


def _no_ensemble() -> Response:
    return problem(404, "no observation ensemble was ingested", artifact="obs_ens", detail=NO_OBS_ENS_REASON)


def _ranges(index) -> list[tuple[str, int, int]] | ReadFailure:
    """Each group's name and stored rows. A table whose group sizes do not add up is a failure."""
    try:
        return _group_bounds(index)
    except ValueError as exc:
        return ReadFailure(name="obs_index", path="obs_index", reason=f"obs_index: {exc}")


def _placed_sites(state, cache_root, manifest: Manifest, index) -> tuple[np.ndarray | None, str | None]:
    """One flag per site of ``index`` (placed in a cell), or None with the reason there is none.
    Sites are matched to the placement table by id, never by position."""
    reason = _recorded_reason(
        manifest, "obs_cell", "no observation placement was ingested for this run"
    )
    table = None
    if reason is None:
        table = obscache.get_cell(state, cache_root)
        if isinstance(table, ReadFailure):
            reason = table.reason
    if reason is not None:
        return None, reason
    found = pd.Index(table.site_id).get_indexer(index.sites["site_id"].to_numpy())
    cell = np.asarray(table.cell)[np.where(found >= 0, found, 0)]
    return (found >= 0) & (cell != -1), None


def _build_groups(state, cache_root, layout: CacheLayout, first: int, last: int | None):
    import pyarrow as pa

    manifest = Manifest.load(layout)
    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return index
    bounds = _ranges(index)
    if isinstance(bounds, ReadFailure):
        return bounds

    notes = [RMSE_RULE]
    residuals: list[np.ndarray | None] = []
    for iteration in (first, last):
        if iteration is None:
            residuals.append(None)
            continue
        agg = obscache.get_agg(state, cache_root, iteration)
        if isinstance(agg, ReadFailure):
            notes.append(f"iteration {iteration}: {agg.reason}")
            residuals.append(None)
            continue
        residuals.append(np.asarray(agg.values[_RESID_ROW], dtype=np.float64))
    if last is None:
        notes.append(f"only iteration {first} has observation statistics, so there is no last iteration")

    placed, reason = _placed_sites(state, cache_root, manifest, index)
    if placed is None:
        notes.append(f"obs_cell: {reason}; the number of placed sites is not shown")
    site_group = index.sites["group"].to_numpy()

    columns: dict[str, list] = {
        name: []
        for name in (
            "n_placed", "n_with_target", "n_zero_weight", "rmse_first", "rmse_last",
            "n_resid_first", "n_resid_last",
        )
    }
    for group, start, stop in bounds:
        flags = index.flags[start:stop]
        target = (flags & FLAG_HAS_TARGET) != 0
        columns["n_with_target"].append(int(target.sum()))
        columns["n_zero_weight"].append(int((target & ((flags & FLAG_WEIGHTED) == 0)).sum()))
        columns["n_placed"].append(None if placed is None else int(placed[site_group == group].sum()))
        for slot, resid in zip(("first", "last"), residuals):
            value, used = (None, 0) if resid is None else rms_of_mean_residual(resid[start:stop])
            columns[f"rmse_{slot}"].append(value)
            columns[f"n_resid_{slot}"].append(used)

    groups = index.groups
    n = len(bounds)
    table = pa.table(
        {
            "group": pa.array([str(g) for g in groups["group"]], pa.string()),
            "n_obs": pa.array([int(v) for v in groups["n_obs"]], pa.int64()),
            "n_sites": pa.array([int(v) for v in groups["n_sites"]], pa.int64()),
            "n_placed": pa.array(columns["n_placed"], pa.int64()),
            "n_weighted": pa.array([int(v) for v in groups["n_weighted"]], pa.int64()),
            "n_with_target": pa.array(columns["n_with_target"], pa.int64()),
            "n_zero_weight": pa.array(columns["n_zero_weight"], pa.int64()),
            "n_sentinel": pa.array([int(v) for v in groups["n_sentinel"]], pa.int64()),
            "n_no_value": pa.array([int(v) for v in groups["n_no_value"]], pa.int64()),
            "time_kind": pa.array([str(v) for v in groups["time_kind"]], pa.string()),
            "inequality": pa.array([str(v) for v in groups["inequality"]], pa.string()),
            "first_iteration": pa.array([first] * n, pa.int32()),
            "last_iteration": pa.array([last] * n, pa.int32()),
            "rmse_first": pa.array(columns["rmse_first"], pa.float64()),
            "rmse_last": pa.array(columns["rmse_last"], pa.float64()),
            "n_resid_first": pa.array(columns["n_resid_first"], pa.int64()),
            "n_resid_last": pa.array(columns["n_resid_last"], pa.int64()),
        }
    )
    return table, tuple(notes)


@router.get("/obs/groups")
async def get_obs_groups(request: Request, params: Annotated[RunQuery, Query()]) -> Response:
    """One row per observation group: counts, and the RMSE of the ensemble-mean residual at
    the first and last observation iteration with how many observations it used."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    ends = obscache.obs_ends(state, cache_root, Manifest.load(CacheLayout(root=Path(cache_root))))
    if ends is None:
        return _no_ensemble()
    first, last = ends
    names = ("obs_index", *(f"obs_agg/{k}" for k in (first, last) if k is not None), "obs_cell")
    built = obscache.memoised(
        state,
        cache_root,
        ("groups", first, last),
        names,
        lambda layout: _build_groups(state, cache_root, layout, first, last),
    )
    if isinstance(built, ReadFailure):
        return problem_from_failure(404, built)
    table, notes = built
    return arrow_response(table, notes=notes)


def _group_range(index, group: str) -> tuple[int, int] | None:
    """The stored rows of the group called ``group``, matched by name, or None."""
    bounds = _ranges(index)
    if isinstance(bounds, ReadFailure):
        return None
    for name, start, stop in bounds:
        if name == group:
            return start, stop
    return None


def _unknown_group(group: str, artifact: str) -> Response:
    return problem(
        404,
        "no observation group has that name",
        artifact=artifact,
        detail=f"the cached observations hold no group named {group!r}",
    )


def _site_points(index, aggs: list[tuple[int, object]], site_ids: list[int]) -> list[dict]:
    """Each site's observations that have a target, one series per iteration in ``aggs``:
    observed value, ensemble mean, 5th and 95th percentile, and whether it carries weight.
    ``rmse_last`` is ``RMSE_RULE`` at the last of ``aggs``."""
    rows = {name: OBS_STATS.index(name) for name in ("mean", "q05", "q95", "resid_mean")}
    site_index = pd.Index(index.sites["site_id"])
    out = []
    for site_id in site_ids:
        if not site_index.is_unique:
            raise ValueError("the observation index holds a site id more than once")
        found = int(site_index.get_indexer([site_id])[0])
        if found < 0:
            raise ValueError(f"the observation index holds no site with id {site_id}")
        site = index.sites.iloc[found]
        window = slice(int(site["start"]), int(site["start"]) + int(site["count"]))
        flags = index.flags[window]
        target = (flags & FLAG_HAS_TARGET) != 0
        series = [
            {
                "iteration": int(iteration),
                "obsval": _numbers(index.value[window][target]),
                "mean": _numbers(agg.values[rows["mean"], window][target]),
                "q05": _numbers(agg.values[rows["q05"], window][target]),
                "q95": _numbers(agg.values[rows["q95"], window][target]),
                "weighted": [bool(v) for v in (flags[target] & FLAG_WEIGHTED) != 0],
            }
            for iteration, agg in aggs
        ]
        rmse_last, _used = rms_of_mean_residual(aggs[-1][1].values[rows["resid_mean"], window])
        out.append(
            {"site_id": int(site_id), "site": str(site["site"]), "rmse_last": rmse_last, "series": series}
        )
    return out


def _load_aggs(state, cache_root, iterations: list[int]) -> list[tuple[int, object]] | ReadFailure:
    aggs = []
    for iteration in iterations:
        agg = obscache.get_agg(state, cache_root, iteration)
        if isinstance(agg, ReadFailure):
            return agg
        aggs.append((iteration, agg))
    return aggs


def _densify(rows: pd.DataFrame, n_bins: int) -> list[int] | None:
    """The stored non-empty bins as ``n_bins`` squared counts, index ``iy * n_bins + ix``;
    None when a bin lies outside the grid."""
    ix = rows["ix"].to_numpy(dtype=np.int64)
    iy = rows["iy"].to_numpy(dtype=np.int64)
    if ix.size and (ix.min() < 0 or iy.min() < 0 or ix.max() >= n_bins or iy.max() >= n_bins):
        return None
    counts = np.zeros(n_bins * n_bins, dtype=np.int64)
    counts[iy * n_bins + ix] = rows["count"].to_numpy(dtype=np.int64)
    return counts.tolist()


@router.get("/obs/1to1")
async def get_obs_1to1(request: Request, params: Annotated[ObsGroupQuery, Query()]) -> Response:
    """One group's 1:1 grid for each end, the counts left out, and the points of its most
    outlying sites. A group that cannot be drawn says why and has no grid."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    # Files left by an older ingest are not served when the last one failed or was blocked.
    reason = _recorded_reason(
        Manifest.load(CacheLayout(root=Path(cache_root))), "obs_1to1", NO_1TO1_REASON
    )
    if reason is not None:
        return problem(404, "no 1:1 grid", artifact="obs_1to1", detail=reason)

    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    loaded = obscache.memoised(
        state, cache_root, ("1to1",), ("obs_index", "obs_1to1"), lambda layout: load_obs_1to1(layout)
    )
    if isinstance(loaded, ReadFailure):
        return problem_from_failure(404, loaded)
    frame, meta = loaded
    if meta["order_digest"] != index.order_digest:
        return problem(
            409,
            "the 1:1 grid does not match the observations",
            artifact="obs_1to1",
            detail="the 1:1 grid was built from a different observation table; run the ingest again",
        )
    if meta.get("sentinel_rule_version") != SENTINEL_RULE_VERSION:
        return problem(
            409,
            "the 1:1 grid was built before simulated sentinels were left out",
            artifact="obs_1to1",
            detail=(
                "this grid may count a 1e30 dry or no-flow placeholder as a value, so it is not "
                "served; ingest the run again"
            ),
        )
    entry = next((g for g in meta["groups"] if g["group"] == params.group), None)
    if entry is None:
        return _unknown_group(params.group, "obs_1to1")

    n_bins = int(meta["n_bins"])
    body = {
        "group": entry["group"],
        "n_bins": n_bins,
        "lo": entry["lo"],
        "hi": entry["hi"],
        "x_label": "observed (obsval)",
        "y_label": "simulated",
        "grids": [],
        "n_with_target": int(entry["n_with_target"]),
        "n_zero_weight": int(entry["n_zero_weight"]),
        "left_out": {k: int(entry["left_out"][k]) for k in ("no_value", "sentinel")},
        "outlying": [],
        "ranking_rule": str(meta["ranking_rule"]),
        "rmse_rule": str(meta["rmse_rule"]),
        "refused": entry["refused"],
        "notes": [],
    }
    if entry["refused"] is not None:
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    mine = frame[(frame["group"] == entry["group"]).to_numpy()]
    for counted in entry["iterations"]:
        counts = _densify(mine[(mine["iteration"] == counted["iteration"]).to_numpy()], n_bins)
        if counts is None:
            return problem(
                404,
                "the 1:1 grid is damaged",
                artifact="obs_1to1",
                detail=f"a stored bin of group {entry['group']!r} lies outside the {n_bins} x {n_bins} grid",
            )
        body["grids"].append({**{key: int(value) for key, value in counted.items()}, "counts": counts})
        if counted.get("n_sentinel"):
            body["notes"].append(
                f"iteration {counted['iteration']}: {counted['n_sentinel']} simulated value(s) are a "
                "sentinel (a dry or no-flow placeholder) and are not drawn"
            )
        if counted["n_outside"]:
            body["notes"].append(
                f"iteration {counted['iteration']}: {counted['n_outside']} simulated value(s) fall "
                "outside the drawn range and are not drawn"
            )
    if meta["single_iteration"]:
        body["notes"].append(
            f"only iteration {meta['first_iteration']} has an observation ensemble, "
            "so the 1:1 plot has one panel"
        )

    ends = [int(meta["first_iteration"])]
    if not meta["single_iteration"]:
        ends.append(int(meta["last_iteration"]))
    aggs = _load_aggs(state, cache_root, ends)
    if isinstance(aggs, ReadFailure):
        return problem_from_failure(404, aggs)
    try:
        body["outlying"] = _site_points(index, aggs, [int(v) for v in entry["outlying"]])
    except ValueError as exc:
        return problem(
            409,
            "the 1:1 grid does not match the observations",
            artifact="obs_1to1",
            detail=f"{exc}; run the ingest again",
        )
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/obs/points")
async def get_obs_points(request: Request, params: Annotated[ObsPointsQuery, Query()]) -> Response:
    """The 1:1 points of chosen sites of one group. An id that is not in the group, or in
    no group, is listed back, never skipped quietly."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    if _group_range(index, params.group) is None:
        return _unknown_group(params.group, "obs_index")
    ends = obscache.obs_ends(state, cache_root, Manifest.load(CacheLayout(root=Path(cache_root))))
    if ends is None:
        return _no_ensemble()
    first, last = ends
    aggs = _load_aggs(state, cache_root, [first] if last is None else [first, last])
    if isinstance(aggs, ReadFailure):
        return problem_from_failure(404, aggs)

    known = pd.Index(index.sites["site_id"])
    wanted, not_in_group, unknown = [], [], []
    for site_id in dict.fromkeys(params.site_ids):
        found = int(known.get_indexer([site_id])[0])
        if found < 0:
            unknown.append(site_id)
        elif str(index.sites.iloc[found]["group"]) != params.group:
            not_in_group.append(site_id)
        else:
            wanted.append(site_id)
    body = {
        "group": params.group,
        "sites": _site_points(index, aggs, wanted),
        "not_in_group": not_in_group,
        "unknown": unknown,
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


INEQUALITY_NOTE = (
    "this is an inequality group; the residual shown is plain simulated minus observed, "
    "not one-sided"
)


def _no_residual_reason(n_sentinel: int, n_no_value: int, no_valid: dict[str, int | None]) -> str:
    parts = []
    if n_sentinel:
        parts.append(f"{n_sentinel} sentinel")
    if n_no_value:
        parts.append(f"{n_no_value} without a numeric value")
    for slot, count in no_valid.items():
        if count:
            parts.append(f"{count} with no valid realization at the {slot} iteration")
    detail = f" ({', '.join(parts)})" if parts else ""
    return f"no observation in this group has a residual{detail}"


def _build_resid_hist(state, cache_root, group: str, first: int, last: int | None):
    """The residual histogram of one group as the JSON-ready answer, or a ``ReadFailure``."""
    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return index
    span = _group_range(index, group)
    if span is None:
        return ReadFailure(name="obs_index", path="obs_index", reason=f"obs_index: no group named {group!r}")
    start, stop = span
    aggs = _load_aggs(state, cache_root, [first] if last is None else [first, last])
    if isinstance(aggs, ReadFailure):
        return aggs

    flags = index.flags[start:stop]
    value = index.value[start:stop]
    target = (flags & FLAG_HAS_TARGET) != 0
    n_no_value = int(np.isnan(value).sum())
    n_sentinel = int((np.abs(value) >= SENTINEL_LIMIT).sum())
    n_zero_weight = int((target & ((flags & FLAG_WEIGHTED) == 0)).sum())
    inequality = index.groups.loc[index.groups["group"] == group, "inequality"]
    inequality = str(inequality.iloc[0]) if len(inequality) else "none"

    values, no_valid, n_sim_sentinel = [], {}, {}
    for slot, (_iteration, agg) in zip(("first", "last"), aggs):
        resid = np.asarray(agg.values[_RESID_ROW, start:stop], dtype=np.float64)[target]
        finite = usable_mask(resid)
        values.append(resid[finite])
        no_valid[slot] = int((~finite).sum())
        n_sim_sentinel[slot] = int(np.count_nonzero(sentinel_mask(resid) & np.isfinite(resid)))
    pair = {"first": no_valid["first"], "last": no_valid.get("last")}

    body = {
        "group": group,
        "residual": RESIDUAL_TEXT,
        "inequality": inequality,
        "inequality_note": INEQUALITY_NOTE if inequality != "none" else None,
        "edges": [],
        "first": None,
        "last": None,
        "n_outside": {"first": 0, "last": 0},
        "left_out": {
            "no_value": n_no_value,
            "sentinel": n_sentinel,
            "no_valid_realization": {"first": pair["first"], "last": pair["last"] or 0},
        },
        "n_zero_weight": n_zero_weight,
        "refused": None,
        "notes": [],
    }
    notes = body["notes"]
    if last is None:
        notes.append(f"only iteration {first} has observation statistics, so one series is drawn")
    if n_zero_weight:
        notes.append(f"{n_zero_weight} zero-weight observation(s) with a target are included")
    if n_sentinel or n_no_value:
        notes.append(
            f"{n_sentinel + n_no_value} observation(s) have no measured value "
            f"({n_sentinel} sentinel, {n_no_value} without a numeric value) and are left out"
        )
    for (iteration, _agg), slot in zip(aggs, ("first", "last")):
        if n_sim_sentinel[slot]:
            notes.append(
                f"iteration {iteration}: {n_sim_sentinel[slot]} observation(s) have a sentinel "
                "residual (a dry or no-flow placeholder) and are left out"
            )
        if no_valid[slot]:
            notes.append(
                f"iteration {iteration}: {no_valid[slot]} observation(s) have no valid realization "
                "and are left out"
            )

    if sum(v.size for v in values) == 0:
        body["refused"] = _no_residual_reason(n_sentinel, n_no_value, pair)
        return body
    shared = shared_edge_histogram(values[0], values[1] if last is not None else None, subject="group")
    if shared.refused is not None:
        body["refused"] = shared.refused
        return body

    body["edges"] = [float(v) for v in shared.edges]
    for key, (iteration, _agg), series in zip(("first", "last"), aggs, (shared.first, shared.last)):
        body[key] = {
            "iteration": int(iteration),
            "n": series.n,
            "counts": [int(v) for v in series.counts],
            "density": [float(v) for v in series.density],
        }
    return body


def _resid_hist(state, cache_root, group: str, first: int, last: int | None):
    """The memoised residual histogram body; the brush reads this same entry."""
    names = ("obs_index", *(f"obs_agg/{k}" for k in (first, last) if k is not None))
    return obscache.memoised(
        state,
        cache_root,
        ("resid_hist", group, first, last),
        names,
        lambda layout: _build_resid_hist(state, cache_root, group, first, last),
    )


@router.get("/obs/resid_hist")
async def get_obs_resid_hist(request: Request, params: Annotated[ObsGroupQuery, Query()]) -> Response:
    """One group's ensemble-mean residual, simulated minus observed, at the first and last
    observation iteration on shared edges. Every observation left out is counted by reason."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    if _group_range(index, params.group) is None:
        return _unknown_group(params.group, "obs_index")
    ends = obscache.obs_ends(state, cache_root, Manifest.load(CacheLayout(root=Path(cache_root))))
    if ends is None:
        return _no_ensemble()
    first, last = ends
    body = _resid_hist(state, cache_root, params.group, first, last)
    if isinstance(body, ReadFailure):
        return problem_from_failure(404, body)
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


class ObsBrushQuery(RunQuery):
    """``group``, one end ``iteration`` and the closed residual range ``lo`` to ``hi``."""

    group: str
    iteration: int
    lo: float = Field(allow_inf_nan=False)
    hi: float = Field(allow_inf_nan=False)


def _row_sites(index, group: str, start: int, stop: int) -> np.ndarray | None:
    """The site id of each stored row of the group, from the sites' own starts and counts;
    None when those do not cover the group's rows exactly once."""
    mine = index.sites[(index.sites["group"] == group).to_numpy()].sort_values("start")
    starts = mine["start"].to_numpy(dtype=np.int64)
    counts = mine["count"].to_numpy(dtype=np.int64)
    ends = starts + counts
    if starts.size == 0:
        return np.empty(0, dtype=np.int64) if start == stop else None
    if starts[0] != start or ends[-1] != stop or np.any(starts[1:] != ends[:-1]):
        return None
    return np.repeat(mine["site_id"].to_numpy(dtype=np.int64), counts)


def _other_series(
    hist: dict, slot: str, iteration: int, resid: np.ndarray, picked: np.ndarray, row_site: np.ndarray
) -> dict:
    """The picked residuals of the other end on the histogram's own edges. Density uses that
    series' own n, so the outline sits on the same scale as the bars it is drawn over."""
    edges = np.asarray(hist["edges"], dtype=np.float64)
    values = resid[picked]
    within = (values >= edges[0]) & (values <= edges[-1])
    counts, _ = np.histogram(values[within], bins=edges)
    n = int(hist[slot]["n"])
    density = counts / (n * np.diff(edges)) if n else np.zeros(counts.size)
    return {
        "iteration": int(iteration),
        "counts": [int(v) for v in counts],
        "density": [float(v) for v in density],
        "n_sites": int(np.unique(row_site[picked][within]).size),
        "n_obs": int(counts.sum()),
    }


@router.get("/obs/brush")
async def get_obs_brush(request: Request, params: Annotated[ObsBrushQuery, Query()]) -> Response:
    """The sites of one group with at least one observation whose ensemble-mean residual at
    one end of the residual histogram lies in ``lo <= r <= hi``, what was left out, and how
    the same sites fall at the other end on the histogram's own edges."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state
    if params.lo > params.hi:
        return problem(
            422,
            "the residual range is reversed",
            detail=f"lo ({params.lo!r}) is greater than hi ({params.hi!r})",
        )

    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    span = _group_range(index, params.group)
    if span is None:
        return _unknown_group(params.group, "obs_index")
    ends = obscache.obs_ends(state, cache_root, Manifest.load(CacheLayout(root=Path(cache_root))))
    if ends is None:
        return _no_ensemble()
    first, last = ends
    if params.iteration not in (first, last):
        accepted = f"only iteration {first}" if last is None else f"iterations {first} and {last}"
        return problem(
            422,
            "that iteration is not an end of the residual histogram",
            artifact="obs_agg",
            detail=f"the residual histogram has {accepted}; iteration {params.iteration} is neither",
        )
    start, stop = span
    row_site = _row_sites(index, params.group, start, stop)
    if row_site is None:
        return problem(
            404,
            "the observation index is damaged",
            artifact="obs_index",
            detail=f"the sites of group {params.group!r} do not cover its observations exactly once",
        )

    agg = obscache.get_agg(state, cache_root, params.iteration)
    if isinstance(agg, ReadFailure):
        return problem_from_failure(404, agg)
    target = (index.flags[start:stop] & FLAG_HAS_TARGET) != 0
    resid = np.asarray(agg.values[_RESID_ROW, start:stop], dtype=np.float64)
    finite = np.isfinite(resid)
    usable = target & usable_mask(resid)
    inside = usable & (resid >= params.lo) & (resid <= params.hi)
    sites = np.unique(row_site[inside])

    other = None
    if last is not None:
        hist = _resid_hist(state, cache_root, params.group, first, last)
        if isinstance(hist, ReadFailure):
            return problem_from_failure(404, hist)
        if hist["edges"]:
            other_iteration, slot = (last, "last") if params.iteration == first else (first, "first")
            other_agg = obscache.get_agg(state, cache_root, other_iteration)
            if isinstance(other_agg, ReadFailure):
                return problem_from_failure(404, other_agg)
            other_resid = np.asarray(other_agg.values[_RESID_ROW, start:stop], dtype=np.float64)
            picked = target & usable_mask(other_resid) & np.isin(row_site, sites)
            other = _other_series(hist, slot, other_iteration, other_resid, picked, row_site)

    body = {
        "group": params.group,
        "iteration": int(params.iteration),
        "lo": params.lo,
        "hi": params.hi,
        "sites": [int(v) for v in sites],
        "n_obs_in_range": int(inside.sum()),
        "left_out": {
            "no_target": int((~target).sum()),
            "sentinel": int((target & sentinel_mask(resid) & finite).sum()),
            "no_valid_realization": int((target & ~finite).sum()),
        },
        "other": other,
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})
