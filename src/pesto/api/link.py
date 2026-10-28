"""The link routes: what a clicked set of cells holds, so the map can hand the Params and
Obs tabs one answer.

All read the cache; the one run-directory read is a pilot-point group's text factor
file, opened for reading only, at the path the cached pp_factors index records. Cells and
the layer arrive as query text and are checked against the cached grid's own counts;
parameters come back by ``parnme`` and sites by ``site_id``, both read from the cached
tables, never by row position.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import APIRouter, Query, Request
from starlette.responses import JSONResponse, Response

from pesto.api import obscache
from pesto.api.linkcache import RING_RULE, cell_neighbours, pp_factor_index
from pesto.api.obsmap import _cell_centres, _reason
from pesto.api.pp import _shape
from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parcell import load_par_cell
from pesto.ingest.ppfactors import PpGroup, load_pp_index

router = APIRouter(prefix="/api/run")

MAX_LINK_CELLS = 50
# Orchestrator decision D-06, which the user can overturn: the first ring and at most 50 sites.
SITES_CAP = 50
PARS_CAP = 500

DIRECT_RULE = "sets this cell (par_cell)"
FACTOR_RULE = "pilot-point factor on this cell"
NO_RUN_DIR = "the run directory is not open, so pilot-point factors cannot be read"
NO_PAR_PLACEMENT = "no parameter placement was ingested for this run"
NO_SITE_PLACEMENT = "no observation placement was ingested for this run"


class LinkCellQuery(RunQuery):
    """``layer`` and ``cells`` (comma-separated cell numbers within one layer)."""

    layer: int
    cells: str


def _parse_cells(text: str, ncpl: int) -> list[int]:
    """Sorted unique cell numbers, at least one and at most ``MAX_LINK_CELLS`` asked for,
    each inside ``0..ncpl-1``."""
    try:
        ids = [int(part) for part in text.split(",")]
    except ValueError:
        raise ValueError("cells must be whole numbers separated by commas") from None
    if len(ids) > MAX_LINK_CELLS:
        raise ValueError(f"at most {MAX_LINK_CELLS} cells can be asked for at once, got {len(ids)}")
    outside = [c for c in ids if c < 0 or c >= ncpl]
    if outside:
        raise ValueError(f"cell {outside[0]} is outside the grid, which has {ncpl} cells per layer")
    return sorted(set(ids))


def _these(cells: list[int]) -> str:
    return "this cell" if len(cells) == 1 else "these cells"


def _pilot_groups(layout: CacheLayout, manifest: Manifest) -> tuple[tuple[PpGroup, ...], list[str]]:
    """Every pilot-point group, and a note when the index is recorded but unreadable.

    A run that recorded no pp_factors has no pilot points, so no note is due."""
    recorded = manifest.artifacts.get("pp_factors")
    if recorded is None:
        return (), []
    index = load_pp_index(layout)
    if isinstance(index, ReadFailure):
        reason = recorded.reason if recorded.state != "ok" and recorded.reason else _reason(index)
        return (), [f"pp_factors could not be read: {reason}, so pilot points are listed as plain parameters"]
    return index.groups, []


def _weight(w) -> float:
    # The float32 weight's shortest text, so 0.3 goes out as 0.3 and not 0.30000001192092896.
    return float(str(np.float32(w)))


def _direct_pars(placed, layer: int, cells: list[int], pilot: set[str]) -> list[dict]:
    hit = (placed.layer == layer) & np.isin(placed.cell, np.asarray(cells, dtype=np.int32))
    rows = []
    for i in np.flatnonzero(hit):
        name = placed.parnme[i]
        rows.append(
            {
                "parnme": name,
                "pargp": placed.pargp[i],
                "kind": "pilot_point" if name in pilot else "cell",
                "cell": int(placed.cell[i]),
                "weights": [],
                "rule": DIRECT_RULE,
            }
        )
    return rows


def _factor_weights(state, cache_root, run_dir, groups, layer: int, cells: list[int]):
    """Every pilot point with a non-zero factor on a clicked cell, with one weight per cell,
    from the groups on ``layer``; a note for each group whose factors cannot be read."""
    found: dict[str, tuple[PpGroup, list[dict]]] = {}
    notes: list[str] = []
    for group in groups:
        if group.layer != layer:
            continue
        if run_dir is None:
            notes.append(f"group {group.group}: {NO_RUN_DIR}")
            continue
        index = pp_factor_index(state, cache_root, run_dir, group)
        if isinstance(index, ReadFailure):
            notes.append(f"group {group.group}: {_reason(index)}")
            continue
        for cell in cells:
            points, weights = index.points_on(cell)
            for p, w in zip(points.tolist(), weights.tolist()):
                name = group.parnames[p]
                found.setdefault(name, (group, []))[1].append({"cell": cell, "weight": _weight(w)})
    return found, notes


def _cell_pars(placed, groups, factors: dict, layer: int, cells: list[int]) -> list[dict]:
    """Direct rows and pilot-point rows as one list, grouped by pargp in the order the
    groups first appear in the control file; in each group the direct rows in control
    order, then the points reached only by a factor, largest weight first."""
    pilot = {name for group in groups for name in group.parnames}
    rows = _direct_pars(placed, layer, cells, pilot)
    order = {name: i for i, name in enumerate(placed.parnme)}
    by_name = {row["parnme"]: row for row in rows}
    extra = []
    for name, (group, weights) in factors.items():
        row = by_name.get(name)
        if row is not None:
            row["weights"] = weights
            row["rule"] = f"{DIRECT_RULE}; {FACTOR_RULE}"
            continue
        i = order.get(name)
        pargp = placed.pargp[i] if i is not None else None
        extra.append(
            {
                "parnme": name,
                "pargp": pargp if pargp is not None else group.group,
                "kind": "pilot_point",
                "cell": int(placed.cell[i]) if i is not None else -1,
                "weights": weights,
                "rule": FACTOR_RULE,
            }
        )
    last = len(order)
    extra.sort(key=lambda r: (-max(w["weight"] for w in r["weights"]), order.get(r["parnme"], last), r["parnme"]))
    every = rows + extra
    first_seen: dict = {}
    for row in every:
        at = order.get(row["parnme"], last)
        first_seen[row["pargp"]] = min(first_seen.get(row["pargp"], at), at)
    rank = {gp: k for k, gp in enumerate(sorted(first_seen, key=lambda gp: (first_seen[gp], str(gp))))}
    # A stable sort keeps direct-then-factor and each part's own order within a group.
    return sorted(every, key=lambda r: rank[r["pargp"]])


def _site_points(table, centres) -> tuple[np.ndarray, np.ndarray]:
    """Origin-relative position of each site: its own x and y when it has them, else its
    cell's centre."""
    ox, oy = centres.origin
    x = np.asarray(table.x, dtype=np.float64) - ox
    y = np.asarray(table.y, dtype=np.float64) - oy
    cell = np.asarray(table.cell, dtype=np.int64)
    placed = (cell >= 0) & (cell < centres.x.size)
    own = np.isfinite(x) & np.isfinite(y)
    use_centre = placed & ~own
    x[use_centre] = centres.x[cell[use_centre]]
    y[use_centre] = centres.y[cell[use_centre]]
    return x, y


def _sites(table, centres, layer: int, cells: list[int], ring: np.ndarray) -> tuple[list[dict], int, dict]:
    """The sites in reach, clicked cells first, then the ring; within each, nearest to a
    clicked cell's centre first, then by site_id. Capped at ``SITES_CAP``, with the full count."""
    cell = np.asarray(table.cell, dtype=np.int64)
    site_layer = np.asarray(table.layer, dtype=np.int64)
    clicked = np.isin(cell, np.asarray(cells, dtype=np.int64))
    in_reach = clicked | np.isin(cell, ring.astype(np.int64))
    same_layer = site_layer == layer
    unknown_layer = site_layer == -1
    taken = in_reach & (same_layer | unknown_layer)
    counts = {
        "unknown_layer_included": int(np.count_nonzero(in_reach & unknown_layer)),
        "other_layer_left_out": int(np.count_nonzero(in_reach & ~same_layer & ~unknown_layer)),
        "unplaced_in_run": int(np.count_nonzero(cell < 0)),
    }

    rows = np.flatnonzero(taken)
    x, y = _site_points(table, centres)
    cx = centres.x[np.asarray(cells, dtype=np.int64)].astype(np.float64)
    cy = centres.y[np.asarray(cells, dtype=np.int64)].astype(np.float64)
    dist = np.hypot(x[rows, None] - cx[None, :], y[rows, None] - cy[None, :]).min(axis=1)
    # A site with no position sorts after every placed one, never in front of them.
    dist = np.where(np.isfinite(dist), dist, np.inf)
    site_id = np.asarray(table.site_id, dtype=np.int64)
    order = np.lexsort((site_id[rows], dist, ~clicked[rows]))
    chosen = rows[order][:SITES_CAP]
    out = [
        {
            "site_id": int(site_id[i]),
            "site": table.site[i],
            "group": table.group[i],
            "layer": int(site_layer[i]),
            "cell": int(cell[i]),
            "in_clicked_cell": bool(clicked[i]),
        }
        for i in chosen
    ]
    return out, int(rows.size), counts


def _sites_reason(these: str, layer: int) -> str:
    whose = "its" if these == "this cell" else "their"
    return f"no observation site in {these} or {whose} neighbours on layer {layer}"


@router.get("/link/cell")
async def get_link_cell(request: Request, params: Annotated[LinkCellQuery, Query()]) -> Response:
    state = request.app.state
    cache_root = getattr(state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    layout = CacheLayout(root=Path(cache_root))

    shape = _shape(layout)
    if isinstance(shape, Response):
        return shape
    layer = params.layer
    if layer < 0 or layer >= shape.nlay:
        noun = "layer" if shape.nlay == 1 else "layers"
        return problem(
            422,
            "the layer is outside the grid",
            detail=f"layer {layer} is outside the grid, which has {shape.nlay} {noun}",
        )
    try:
        cells = _parse_cells(params.cells, shape.ncpl)
    except ValueError as exc:
        return problem(422, "the cells could not be used", detail=str(exc))

    neighbours = cell_neighbours(state, cache_root)
    if isinstance(neighbours, ReadFailure):
        return problem_from_failure(404, neighbours)
    ring = neighbours.ring(cells)

    manifest = Manifest.load(layout)
    these = _these(cells)
    # An artifact the ingest never recorded is a designed state with a reason; one recorded
    # but unreadable is a failure.
    pars: list[dict] = []
    pars_total = 0
    par_notes: list[str] = []
    pars_reason = NO_PAR_PLACEMENT
    if "par_cell" in manifest.artifacts:
        placed = load_par_cell(layout)
        if isinstance(placed, ReadFailure):
            return problem_from_failure(404, placed)
        groups, par_notes = _pilot_groups(layout, manifest)
        run_dir = getattr(state, "initial_run_dir", None)
        factors, factor_notes = _factor_weights(state, cache_root, run_dir, groups, layer, cells)
        par_notes += factor_notes
        pars = _cell_pars(placed, groups, factors, layer, cells)
        pars_total = len(pars)
        if pars_total > PARS_CAP:
            par_notes.append(
                f"{pars_total} parameters set {these} on layer {layer}; the first {PARS_CAP} are "
                "listed, by parameter group, direct parameters in control-file order and then "
                "pilot points by largest factor"
            )
            pars = pars[:PARS_CAP]
        pars_reason = f"no parameter sets {these} on layer {layer}"

    sites: list[dict] = []
    sites_total = 0
    site_counts = {"unknown_layer_included": 0, "other_layer_left_out": 0, "unplaced_in_run": 0}
    sites_reason = NO_SITE_PLACEMENT
    if "obs_cell" in manifest.artifacts:
        table = obscache.get_cell(state, cache_root)
        if isinstance(table, ReadFailure):
            return problem_from_failure(404, table)
        centres = _cell_centres(state, cache_root)
        if isinstance(centres, ReadFailure):
            return problem_from_failure(404, centres)
        sites, sites_total, site_counts = _sites(table, centres, layer, cells, ring)
        sites_reason = _sites_reason(these, layer)

    body = {
        "layer": layer,
        "cells": cells,
        "ring": [int(c) for c in ring],
        "ring_rule": RING_RULE,
        "pars": pars,
        "pars_total": pars_total,
        "par_notes": par_notes,
        "sites": sites,
        "sites_total": sites_total,
        "sites_cap": SITES_CAP,
        "site_counts": site_counts,
        "reasons": {
            "pars": None if pars else pars_reason,
            "sites": None if sites else sites_reason,
        },
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


# ---- /link/par: the cells each named parameter sets ----

MAX_LINK_PARS = 50
# The same cap the browser's outline uses, so the answer never holds cells it would not draw.
OUTLINE_MAX_CELLS = 20_000
NAMES_SHAPE = "names must be a JSON list of parameter names"


class LinkParQuery(RunQuery):
    """``names``: one JSON list of parameter names, because a PEST name can hold a comma."""

    names: str


def _parse_names(text: str) -> list[str]:
    try:
        names = json.loads(text)
    except json.JSONDecodeError:
        raise ValueError(NAMES_SHAPE) from None
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise ValueError(NAMES_SHAPE)
    if not names:
        raise ValueError("at least one parameter name must be asked for")
    if len(names) > MAX_LINK_PARS:
        raise ValueError(f"at most {MAX_LINK_PARS} parameters can be asked for at once, got {len(names)}")
    return names


def _point_cells(state, cache_root, run_dir, group: PpGroup, point: int, own: list[int]):
    """A pilot point's cells with a non-zero factor, capped, or its own cell with the reason
    its factors cannot be read: (cells, n_cells, capped, reason)."""
    if run_dir is None:
        return own, len(own), False, NO_RUN_DIR
    index = pp_factor_index(state, cache_root, run_dir, group)
    if isinstance(index, ReadFailure):
        return own, len(own), False, _reason(index)
    found = index.cells_of(point)
    n = int(found.size)
    if n == 0:
        return [], 0, False, f"no cell has a non-zero factor from this pilot point in {group.factor_file}"
    return found[:OUTLINE_MAX_CELLS].tolist(), n, n > OUTLINE_MAX_CELLS, None


@router.get("/link/par")
async def get_link_par(request: Request, params: Annotated[LinkParQuery, Query()]) -> Response:
    state = request.app.state
    cache_root = getattr(state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    layout = CacheLayout(root=Path(cache_root))
    try:
        names = _parse_names(params.names)
    except ValueError as exc:
        return problem(422, "the parameter names could not be used", detail=str(exc))

    manifest = Manifest.load(layout)
    if "par_cell" not in manifest.artifacts:
        # Without a placement table no name can be told known or unknown, so none is guessed.
        body = {"pars": [], "unknown": names, "reason": NO_PAR_PLACEMENT, "notes": []}
        return JSONResponse(body, headers={"Cache-Control": "no-store"})
    placed = load_par_cell(layout)
    if isinstance(placed, ReadFailure):
        return problem_from_failure(404, placed)
    groups, notes = _pilot_groups(layout, manifest)
    owner = {name: (group, p) for group in groups for p, name in enumerate(group.parnames)}
    row_of: dict[str, int] = {}
    for i, name in enumerate(placed.parnme):
        row_of.setdefault(name, i)
    run_dir = getattr(state, "initial_run_dir", None)

    pars: list[dict] = []
    unknown: list[str] = []
    for name in names:
        i = row_of.get(name)
        if i is None:
            unknown.append(name)
            continue
        cell, layer = int(placed.cell[i]), int(placed.layer[i])
        pargp = placed.pargp[i]
        if name in owner:
            group, point = owner[name]
            if layer < 0:
                # The factor file's cells are on the group's layer even when par_cell has none.
                layer = group.layer
            own = [cell] if cell >= 0 else []
            cells, n_cells, capped, reason = _point_cells(state, cache_root, run_dir, group, point, own)
            kind = "pilot_point"
            if pargp is None:
                pargp = group.group
        elif cell >= 0:
            kind, cells, n_cells, capped, reason = "cell", [cell], 1, False, None
        else:
            reason = f"no cell is recorded for this parameter: {placed.rule[i]}"
            kind, cells, n_cells, capped = "unplaced", [], 0, False
        if pargp is None:
            notes.append(f"{name} has no parameter group in par_cell, so its group is sent as empty text")
            pargp = ""
        pars.append(
            {
                "parnme": name,
                "pargp": pargp,
                "kind": kind,
                "layer": layer,
                "cell": cell,
                "cells": cells,
                "n_cells": n_cells,
                "cells_capped": capped,
                "reason": reason,
            }
        )
    body = {"pars": pars, "unknown": unknown, "reason": None, "notes": notes}
    return JSONResponse(body, headers={"Cache-Control": "no-store"})
