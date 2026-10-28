"""What the map needs to colour observation sites: dot positions, the time axis with
fixed colour limits, and one frame of values per exact time.

Everything is read through the memo in ``obscache``. Row ``i`` of ``/obs/sites`` and
entry ``i`` of a ``/obs/frame`` are the same site, in ``obs_index`` order. Each of the
three answers carries the ``order_digest`` of that index so a client can refuse a frame
cut for a different table. A time is matched exactly, never to the nearest one, and a
site is matched by its ``site_id`` value, never by position.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, Query, Request
from pydantic import Field
from starlette.responses import JSONResponse, Response

from pesto.api import obscache
from pesto.api.blob import blob_response
from pesto.api.problem import problem, problem_from_failure, redact_paths
from pesto.api.query import RunQuery
from pesto.api.tables import arrow_response
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure

router = APIRouter(prefix="/api/run")

MAX_SITES_PER_GROUP = 100_000

STATS = ("resid_mean", "rmse", "std", "mean")
AGG_PREFIX = "obs_agg/"
CENTRE_TEXT = "a cell centre is the centre of the cell's vertices"
NO_NEAREST_TEXT = "the group has no observation at that time; pesto never uses the nearest time"
LIMITS_RULE = (
    "2nd to 98th percentile over every time of this group and both iterations, so colours do "
    "not shift while the slider moves; the mean residual is symmetric about 0"
)
NO_LIMITS_REASON = "no iteration has observation statistics, so no colour limits can be made"
POSITION_NOTE = "this group has no times, so the slider steps by position in site"
MIXED_SITES_NOTE = (
    "the sites of this group mix kinds of time, so the slider steps by position in site"
)
NO_PLACEMENT_REASON = "no observation placement was ingested for this run"


class ObsMapGroupQuery(RunQuery):
    """``group`` is the one accepted field; ``RunQuery`` turns any other into a 422."""

    group: str


class ObsFrameQuery(RunQuery):
    """A frame is one statistic of every site of ``group`` at one exact ``time``."""

    group: str
    iteration: int
    time: float = Field(allow_inf_nan=False)
    stat: Literal["resid_mean", "rmse", "std", "mean"]


@dataclass(frozen=True, eq=False)
class GroupRows:
    """What a frame needs about one group, built once per ``obs_index`` write.

    ``order`` lists the group's rows with a finite time, sorted by time (ties keep
    index order); the rows of ``times[k]`` are ``order[bounds[k]:bounds[k + 1]]``.
    ``site_of_order`` gives the site position inside the group of each of those rows.
    """

    sites_pos: np.ndarray
    n_sites: int
    start: int
    stop: int
    time_kind: str
    refused: str | None
    times: np.ndarray
    order: np.ndarray
    site_of_order: np.ndarray
    bounds: np.ndarray
    n_at_time: np.ndarray
    n_duplicate: int


@dataclass(frozen=True, eq=False)
class CellCentres:
    """Origin-relative centre of every cell's vertices, indexed by cell number."""

    origin: tuple[float, float]
    x: np.ndarray
    y: np.ndarray


def _reason(failure: ReadFailure) -> str:
    """The failure's reason with the real path reduced to its file name."""
    reason = failure.reason
    if failure.path:
        reason = reason.replace(failure.path, Path(failure.path).name)
    return redact_paths(reason)


def _build_rows(index, group: str) -> GroupRows | ReadFailure:
    sites = index.sites
    member = np.flatnonzero((sites["group"] == group).to_numpy())
    starts = sites["start"].to_numpy(dtype=np.int64)[member]
    counts = sites["count"].to_numpy(dtype=np.int64)[member]
    start = int(starts[0])
    if not np.array_equal(starts, start + np.cumsum(counts) - counts):
        return ReadFailure(
            name="obs_index",
            path="",
            reason=f"the sites of group {group!r} are not one unbroken block of rows in obs_index",
        )
    stop = start + int(counts.sum())
    n_sites = int(member.size)

    kinds = sorted({str(k) for k in sites["time_kind"].to_numpy()[member]})
    group_row = index.groups.loc[index.groups["group"] == group, "time_kind"]
    time_kind = str(group_row.iloc[0]) if len(group_row) else (kinds[0] if len(kinds) == 1 else "mixed")
    refused = None
    if time_kind == "mixed":
        refused = (
            f"this group mixes time kinds ({' and '.join(kinds)}), so one time axis would mean two "
            "things; pesto shows no time slider for it"
        )

    row_site = np.repeat(np.arange(n_sites, dtype=np.int64), counts)
    if refused is None:
        window = index.time[start:stop]
        finite = np.flatnonzero(np.isfinite(window))
        order = finite[np.argsort(window[finite], kind="stable")]
        times, first = np.unique(window[order], return_index=True)
        bounds = np.append(first, order.size).astype(np.int64)
        rank = np.repeat(np.arange(times.size, dtype=np.int64), np.diff(bounds))
        site_of_order = row_site[order]
        pairs = np.unique(rank * n_sites + site_of_order)
        n_at_time = np.bincount(pairs // n_sites, minlength=times.size).astype(np.int64)
        n_duplicate = int(order.size - pairs.size)
        order = order + start
    else:
        times = np.zeros(0, dtype=np.float64)
        order = np.zeros(0, dtype=np.int64)
        site_of_order = np.zeros(0, dtype=np.int64)
        bounds = np.zeros(1, dtype=np.int64)
        n_at_time = np.zeros(0, dtype=np.int64)
        n_duplicate = 0

    return GroupRows(
        sites_pos=member,
        n_sites=n_sites,
        start=start,
        stop=stop,
        time_kind=time_kind,
        refused=refused,
        times=times,
        order=order,
        site_of_order=site_of_order,
        bounds=bounds,
        n_at_time=n_at_time,
        n_duplicate=n_duplicate,
    )


def _group_context(state, cache_root, group: str):
    """``(index, rows)`` for ``group``, or the error response to send back."""
    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    if not (index.groups["group"] == group).any():
        return problem(
            404,
            "no observation group has that name",
            artifact="obs_index",
            detail=f"the cached observation index holds no group named {group!r}",
        )
    n_sites = int((index.sites["group"] == group).sum())
    if n_sites > MAX_SITES_PER_GROUP:
        return problem(
            409,
            "the group has too many sites for the map",
            artifact="obs_index",
            detail=(
                f"group {group!r} has {n_sites} sites in obs_index, more than the "
                f"{MAX_SITES_PER_GROUP} the map serves in one request"
            ),
        )
    rows = obscache.memoised(
        state,
        cache_root,
        ("frame_rows", group),
        ("obs_index",),
        lambda _layout: _build_rows(index, group),
    )
    if isinstance(rows, ReadFailure):
        return problem_from_failure(404, rows)
    return index, rows


def _recorded_reason(manifest: Manifest, name: str, fallback: str) -> str | None:
    """None when ``name`` is recorded ok; otherwise the reason it gives, or ``fallback``."""
    recorded = manifest.artifacts.get(name)
    if recorded is not None and recorded.state == "ok":
        return None
    return recorded.reason if recorded is not None and recorded.reason else fallback


def _agg_iterations(manifest: Manifest) -> list[int]:
    """Every iteration with an ``obs_agg/K`` record, ok or not, ascending."""
    found = []
    for name in manifest.artifacts:
        if name.startswith(AGG_PREFIX) and name[len(AGG_PREFIX) :].isdigit():
            found.append(int(name[len(AGG_PREFIX) :]))
    return sorted(found)


def _iteration_status(state, cache_root, manifest: Manifest) -> list[dict]:
    status = []
    for k in _agg_iterations(manifest):
        name = f"{AGG_PREFIX}{k}"
        reason = _recorded_reason(manifest, name, f"{name} is not recorded as ok")
        if reason is None:
            loaded = obscache.get_agg(state, cache_root, k)
            if isinstance(loaded, ReadFailure):
                reason = _reason(loaded)
        status.append({"iteration": k, "available": reason is None, "reason": reason})
    return status


def _cell_centres(state, cache_root) -> CellCentres | ReadFailure:
    def build(layout: CacheLayout):
        from pesto.ingest.mesh import load_mesh

        mesh = load_mesh(layout)
        if isinstance(mesh, ReadFailure):
            return mesh
        cell = np.asarray(mesh.cell_index, dtype=np.int64)
        n_cells = int(mesh.n_cells)
        if cell.size and (cell.min() < 0 or cell.max() >= n_cells):
            return ReadFailure(
                name="grid", path="", reason="the cached mesh names a cell outside its own cell count"
            )
        vertices = np.bincount(cell, minlength=n_cells).astype(np.float64)
        shown = np.maximum(vertices, 1.0)
        positions = np.asarray(mesh.positions, dtype=np.float64)
        cx = np.bincount(cell, weights=positions[:, 0], minlength=n_cells) / shown
        cy = np.bincount(cell, weights=positions[:, 1], minlength=n_cells) / shown
        cx[vertices == 0] = np.nan
        cy[vertices == 0] = np.nan
        return CellCentres(
            origin=(float(mesh.origin[0]), float(mesh.origin[1])),
            x=cx.astype(np.float32),
            y=cy.astype(np.float32),
        )

    return obscache.memoised(state, cache_root, ("cell_centres",), ("grid",), build)


def _join(*parts: str | None) -> str | None:
    text = "; ".join(p for p in parts if p)
    return text or None


def _site_table(state, cache_root, manifest: Manifest, index, rows: GroupRows, group: str):
    """The arrays of ``/obs/sites`` and the notes that go with them."""
    pos = rows.sites_pos
    site_id = index.sites["site_id"].to_numpy(dtype=np.int64)[pos]
    names = [str(v) for v in index.sites["site"].to_numpy()[pos]]
    n_obs = index.sites["count"].to_numpy(dtype=np.int32)[pos]
    n = pos.size

    x = np.full(n, np.nan, dtype=np.float32)
    y = np.full(n, np.nan, dtype=np.float32)
    source = np.full(n, "none", dtype=object)
    layer = np.full(n, -1, dtype=np.int32)
    cell = np.full(n, -1, dtype=np.int32)
    rule = np.full(n, "", dtype=object)
    note: list[str | None] = [None] * n
    notes: list[str] = []

    reason = _recorded_reason(manifest, "obs_cell", NO_PLACEMENT_REASON)
    table = None
    if reason is None:
        table = obscache.get_cell(state, cache_root)
        if isinstance(table, ReadFailure):
            reason = _reason(table)
            table = None
    if table is None:
        notes.append(f"obs_cell: {reason}, so no site of this group is placed on the map")
        rule[:] = "unavailable"
        note = [reason] * n
        return site_id, names, n_obs, x, y, source, layer, cell, rule, note, notes

    found = pd.Index(table.site_id).get_indexer(site_id)
    here = found >= 0
    at = found[here]
    cell[here] = table.cell[at]
    layer[here] = table.layer[at]
    rule[here] = [table.rule[i] for i in at]
    own_x = np.full(n, np.nan)
    own_y = np.full(n, np.nan)
    own_x[here] = table.x[at]
    own_y[here] = table.y[at]
    stored = table.note
    for i in np.flatnonzero(here):
        j = int(found[i])
        note[i] = (stored[j] or None) if stored is not None else None
    for i in np.flatnonzero(~here):
        rule[i] = "unplaced"
        note[i] = f"the cached placement holds no site with id {int(site_id[i])}"

    placed = cell >= 0
    if placed.any():
        centres = _cell_centres(state, cache_root)
        if isinstance(centres, ReadFailure):
            why = f"the grid could not be read: {_reason(centres)}"
            notes.append(f"grid: {why}, so no placed site has a position")
            for i in np.flatnonzero(placed):
                note[i] = _join(note[i], why)
        else:
            ox, oy = centres.origin
            n_centres = centres.x.size
            own = placed & np.isfinite(own_x) & np.isfinite(own_y)
            x[own] = (own_x[own] - ox).astype(np.float32)
            y[own] = (own_y[own] - oy).astype(np.float32)
            source[own] = "own"
            inside = placed & ~own & (cell < n_centres)
            take = np.flatnonzero(inside)
            cx, cy = centres.x[cell[take]], centres.y[cell[take]]
            good = np.isfinite(cx) & np.isfinite(cy)
            x[take[good]] = cx[good]
            y[take[good]] = cy[good]
            source[take[good]] = "cell_centre"
            for i in np.flatnonzero(placed & ~own & (cell >= n_centres)):
                note[i] = _join(note[i], f"cell {int(cell[i])} is not in the cached mesh of {n_centres} cells")
            for i in take[~good]:
                note[i] = _join(note[i], f"cell {int(cell[i])} has no vertices in the cached mesh")

    counts = {s: int((source == s).sum()) for s in ("own", "cell_centre", "none")}
    notes.append(
        f"{counts['own']} site(s) at their own coordinates, {counts['cell_centre']} at the centre of "
        f"their cell's vertices, {counts['none']} not placed"
    )
    notes.append(CENTRE_TEXT)
    for entry in table.groups:
        if entry["group"] == group:
            notes.append(
                f"placement rule {entry['rule']}: {entry['mapped']} of {entry['total']} sites placed"
            )
    # A note that opens with another group's name is that group's own; its /obs/sites carries it.
    notes.extend(
        t for t in table.notes if not t.startswith("group '") or t.startswith(f"group '{group}'")
    )
    return site_id, names, n_obs, x, y, source, layer, cell, rule, note, notes


@router.get("/obs/sites")
async def get_obs_sites(request: Request, params: Annotated[ObsMapGroupQuery, Query()]) -> Response:
    """One row per site of the group, in ``obs_index`` order, with where its dot sits and
    how that was decided."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    context = _group_context(state, cache_root, params.group)
    if isinstance(context, Response):
        return context
    index, rows = context
    manifest = Manifest.load(CacheLayout(root=Path(cache_root)))
    columns = _site_table(state, cache_root, manifest, index, rows, params.group)
    site_id, names, n_obs, x, y, source, layer, cell, rule, note, notes = columns

    import pyarrow as pa

    table = pa.table(
        {
            "site_id": pa.array(site_id, type=pa.int64()),
            "site": pa.array(names, type=pa.string()),
            "n_obs": pa.array(n_obs, type=pa.int32()),
            "x": pa.array(x, type=pa.float32()),
            "y": pa.array(y, type=pa.float32()),
            "xy_source": pa.array(list(source), type=pa.string()),
            "layer": pa.array(layer, type=pa.int32()),
            "cell": pa.array(cell, type=pa.int32()),
            "rule": pa.array(list(rule), type=pa.string()),
            "note": pa.array(note, type=pa.string()),
        }
    )
    return arrow_response(table, notes=tuple(notes), meta={"order_digest": index.order_digest})


def _limits(
    state, cache_root, rows: GroupRows, group: str, ends: list[int]
) -> tuple[dict, str | None]:
    """Colour limits per statistic, pooled over every row of the group in both ends, and the
    reason they could not be made when they could not."""
    unknown = {stat: None for stat in STATS}
    if not ends:
        return unknown, NO_LIMITS_REASON
    first, last = ends[0], ends[-1]
    names = tuple(dict.fromkeys(("obs_index", f"{AGG_PREFIX}{first}", f"{AGG_PREFIX}{last}")))

    def build(_layout):
        aggs = [obscache.get_agg(state, cache_root, k) for k in dict.fromkeys((first, last))]
        for agg in aggs:
            if isinstance(agg, ReadFailure):
                return agg
        out: dict = {}
        for stat in STATS:
            pooled = np.concatenate(
                [
                    np.asarray(agg.values[agg.stats.index(stat), rows.start : rows.stop], dtype=np.float64)
                    for agg in aggs
                ]
            )
            pooled = pooled[np.isfinite(pooled)]
            if pooled.size == 0:
                out[stat] = None
            elif stat == "resid_mean":
                m = float(np.percentile(np.abs(pooled), 98))
                out[stat] = [-m, m]
            else:
                lo, hi = np.percentile(pooled, [2, 98])
                out[stat] = [float(lo), float(hi)]
        return out

    limits = obscache.memoised(state, cache_root, ("limits", group, first, last), names, build)
    if isinstance(limits, ReadFailure):
        return unknown, f"the colour limits could not be made: {_reason(limits)}"
    return limits, None


@router.get("/obs/times")
async def get_obs_times(request: Request, params: Annotated[ObsMapGroupQuery, Query()]) -> Response:
    """The exact times a group has observations at, how many sites have one at each, and
    the colour limits that stay fixed while the slider moves."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    context = _group_context(state, cache_root, params.group)
    if isinstance(context, Response):
        return context
    index, rows = context
    manifest = Manifest.load(CacheLayout(root=Path(cache_root)))
    iterations = _iteration_status(state, cache_root, manifest)
    # The same ends every other observation route uses; an end without statistics is left out of the limits.
    shared = obscache.obs_ends(state, cache_root, manifest)
    planned = [] if shared is None else list(dict.fromkeys(k for k in shared if k is not None))
    usable = {item["iteration"] for item in iterations if item["available"]}
    ends = [k for k in planned if k in usable]

    notes: list[str] = []
    if ends and len(ends) < len(planned):
        left_out = [str(k) for k in planned if k not in usable]
        notes.append(
            f"the colour limits use iteration {ends[0]} only; iteration {', '.join(left_out)} has no "
            "observation statistics"
        )
    steps_by = "time"
    if rows.time_kind.startswith("ordinal"):
        steps_by = "position"
        notes.append(POSITION_NOTE if "no time found" in rows.time_kind else MIXED_SITES_NOTE)
    if rows.n_duplicate:
        notes.append(
            f"{rows.n_duplicate} observation(s) share a time with another observation of the same "
            "site; a frame shows the last of them and counts the rest as hidden"
        )

    if rows.refused is not None:
        limits, limits_refused = {stat: None for stat in STATS}, None
    else:
        limits, limits_refused = _limits(state, cache_root, rows, params.group, ends)
    body = {
        "group": params.group,
        "order_digest": index.order_digest,
        "time_kind": rows.time_kind,
        "steps_by": steps_by,
        "times": [float(t) for t in rows.times],
        "n_at_time": [int(v) for v in rows.n_at_time],
        "n_sites": rows.n_sites,
        "iterations": iterations,
        "limits": limits,
        "limits_rule": LIMITS_RULE,
        "limits_refused": limits_refused,
        "refused": rows.refused,
        "notes": notes,
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


def build_frame(
    rows: GroupRows, stat_values: np.ndarray, time: float
) -> tuple[np.ndarray, int, int] | None:
    """The statistic of every site of the group at exactly ``time``, NaN where a site has
    no observation then, how many sites have one, and how many rows lost to a later row of
    the same site at this time. None when the group has no such time.

    A site with two rows at one time shows the last of them in index order; the readout
    uses the same rule."""
    k = int(np.searchsorted(rows.times, time))
    if k >= rows.times.size or rows.times[k] != time:
        return None
    lo, hi = int(rows.bounds[k]), int(rows.bounds[k + 1])
    sites = rows.site_of_order[lo:hi]
    chosen = rows.order[lo:hi]
    # Reversed, the first hit of each site is its last row.
    site_ids, first_from_end = np.unique(sites[::-1], return_index=True)
    last = (hi - lo - 1) - first_from_end
    out = np.full(rows.n_sites, np.nan, dtype=np.float32)
    out[site_ids] = stat_values[chosen[last]]
    return out, int(rows.n_at_time[k]), int((hi - lo) - site_ids.size)


@router.get("/obs/frame")
async def get_obs_frame(request: Request, params: Annotated[ObsFrameQuery, Query()]) -> Response:
    """One float32 per site of the group, in ``/obs/sites`` row order, for one iteration,
    one statistic and one exact time."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    context = _group_context(state, cache_root, params.group)
    if isinstance(context, Response):
        return context
    index, rows = context
    if rows.refused is not None:
        return problem(409, "the group has no time axis", artifact="obs_index", detail=rows.refused)

    name = f"{AGG_PREFIX}{params.iteration}"
    manifest = Manifest.load(CacheLayout(root=Path(cache_root)))
    reason = _recorded_reason(manifest, name, f"no observation statistics were ingested for iteration {params.iteration}")
    if reason is not None:
        return problem(404, "no observation statistics for that iteration", artifact=name, detail=reason)
    agg = obscache.get_agg(state, cache_root, params.iteration)
    if isinstance(agg, ReadFailure):
        return problem_from_failure(404, agg)
    if params.stat not in agg.stats:
        return problem(404, "that statistic is not stored", artifact=name, detail=f"{name} has no row named {params.stat!r}")

    if agg.order_digest != index.order_digest:
        return problem(
            409,
            "the statistics do not match the observations",
            artifact=name,
            detail=f"{name} was built from a different observation table; ingest the run again",
        )

    built = build_frame(rows, agg.values[agg.stats.index(params.stat)], params.time)
    if built is None:
        return problem(404, "no observation at that time", artifact="obs_index", detail=NO_NEAREST_TEXT)
    values, n_at_time, n_rows_hidden = built
    meta = {
        "group": params.group,
        "iteration": int(params.iteration),
        "order_digest": index.order_digest,
        "time": float(params.time),
        "stat": params.stat,
        "n_sites": rows.n_sites,
        "n_at_time": n_at_time,
        "n_rows_hidden": n_rows_hidden,
        "n_finite": int(np.count_nonzero(np.isfinite(values))),
    }
    return blob_response(values, meta=meta, cache_control="no-store")
