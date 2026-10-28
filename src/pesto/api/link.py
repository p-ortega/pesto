"""The link routes: what a clicked set of cells holds, so the map can hand the Params and
Obs tabs one answer.

All read the cache, never a run directory. Cells and the layer arrive as query text and
are checked against the cached grid's own counts; parameters come back by ``parnme`` and
sites by ``site_id``, both read from the cached tables, never by row position.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import APIRouter, Query, Request
from starlette.responses import JSONResponse, Response

from pesto.api import obscache
from pesto.api.obsmap import _reason
from pesto.api.pp import _shape
from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parcell import load_par_cell
from pesto.ingest.ppfactors import load_pp_index

router = APIRouter(prefix="/api/run")

MAX_LINK_CELLS = 50
SITES_CAP = 50
PARS_CAP = 500

DIRECT_RULE = "sets this cell (par_cell)"
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


def _pilot_point_names(layout: CacheLayout, manifest: Manifest) -> tuple[set[str], list[str]]:
    """Every pilot-point parameter name, and a note when the index is recorded but unreadable.

    A run that recorded no pp_factors has no pilot points, so no note is due."""
    recorded = manifest.artifacts.get("pp_factors")
    if recorded is None:
        return set(), []
    index = load_pp_index(layout)
    if isinstance(index, ReadFailure):
        reason = recorded.reason if recorded.state != "ok" and recorded.reason else _reason(index)
        return set(), [f"pp_factors could not be read: {reason}, so pilot points are listed as plain parameters"]
    return {name for group in index.groups for name in group.parnames}, []


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


def _sites(table, layer: int, cells: list[int]) -> list[dict]:
    hit = (table.layer == layer) & np.isin(table.cell, np.asarray(cells, dtype=np.int32))
    rows = [
        {
            "site_id": int(table.site_id[i]),
            "site": table.site[i],
            "group": table.group[i],
            "layer": int(table.layer[i]),
            "cell": int(table.cell[i]),
            "in_clicked_cell": True,
        }
        for i in np.flatnonzero(hit)
    ]
    rows.sort(key=lambda row: row["site_id"])
    return rows


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

    manifest = Manifest.load(layout)
    these = _these(cells)
    # An artifact the ingest never recorded is a designed state with a reason; one recorded
    # but unreadable is a failure.
    pars: list[dict] = []
    par_notes: list[str] = []
    pars_reason = NO_PAR_PLACEMENT
    if "par_cell" in manifest.artifacts:
        placed = load_par_cell(layout)
        if isinstance(placed, ReadFailure):
            return problem_from_failure(404, placed)
        pilot, par_notes = _pilot_point_names(layout, manifest)
        pars = _direct_pars(placed, layer, cells, pilot)
        pars_reason = f"no parameter sets {these} on layer {layer}"

    sites: list[dict] = []
    sites_reason = NO_SITE_PLACEMENT
    if "obs_cell" in manifest.artifacts:
        table = obscache.get_cell(state, cache_root)
        if isinstance(table, ReadFailure):
            return problem_from_failure(404, table)
        sites = _sites(table, layer, cells)
        sites_reason = f"no observation site in {these} on layer {layer}"

    body = {
        "layer": layer,
        "cells": cells,
        "pars": pars,
        "pars_total": len(pars),
        "par_notes": par_notes,
        "sites": sites,
        "sites_total": len(sites),
        "reasons": {
            "pars": None if pars else pars_reason,
            "sites": None if sites else sites_reason,
        },
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})
