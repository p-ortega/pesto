"""Pilot-point routes: which groups interpolate, one group's field, and the
points behind one cell."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Annotated, Literal

import numpy as np
from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict
from starlette.responses import JSONResponse, Response

from pesto.api.blob import blob_response, cache_headers, cache_tag
from pesto.api.enscache import STATS, get_stored
from pesto.api.fields import compute_field, contributors, memo_field, point_values, stat_values
from pesto.api.problem import problem, problem_from_failure
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.ppfactors import PpGroup, load_pp_index
from pesto.model import GridShape

router = APIRouter(prefix="/api/run/grid")


class FieldQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    iteration: int
    group: str
    stat: Literal[STATS] | None = None
    realization: str | None = None
    v: str | None = None


class CellQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    iteration: int
    group: str
    cell: int


def _open(request: Request):
    cache_root = getattr(request.app.state, "cache_root", None)
    run_dir = getattr(request.app.state, "initial_run_dir", None)
    if cache_root is None or run_dir is None:
        return None
    return CacheLayout(root=Path(cache_root)), Path(run_dir)


def _group(layout: CacheLayout, name: str) -> PpGroup | Response:
    index = load_pp_index(layout)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    for group in index.groups:
        if group.group == name:
            return group
    return problem(404, f"group {name!r} is not an interpolable pilot-point group", artifact="pp_factors")


def _shape(layout: CacheLayout) -> GridShape | Response:
    """The cell and layer counts from mesh.json alone; the field route needs
    no vertex or triangle buffer, so it never reads them."""
    path = layout.grid / "mesh.json"
    try:
        raw = json.loads(path.read_text())
        if raw.get("cache_version") != CACHE_VERSION:
            raise ValueError(f"written at cache_version {raw.get('cache_version')!r}, expected {CACHE_VERSION}")
        return GridShape(ncpl=int(raw["n_cells"]), nlay=int(raw["nlay"]), nrow=None, ncol=None)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        failure = ReadFailure(name="grid", path=str(path), reason=f"failed to read {path.name}: {exc}")
        return problem_from_failure(404, failure)


def _with_factor_file(tag: str, run_dir: Path, group: PpGroup) -> str | None:
    """The ensemble tag joined with the factor file's size and modified time
    and the group's points, so an edited factor file never reuses a memo.
    None when the file cannot be read, which computes fresh."""
    try:
        st = (run_dir / group.factor_file).stat()
    except OSError:
        return None
    stamp = f"{st.st_size}:{st.st_mtime_ns}:{','.join(group.parnames)}"
    return f"{tag}-{hashlib.sha256(stamp.encode()).hexdigest()[:12]}"


@router.get("/pp")
async def get_pp(request: Request) -> Response:
    opened = _open(request)
    if opened is None:
        return problem(409, "no run is open")
    layout, _ = opened
    index = load_pp_index(layout)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    return JSONResponse(
        {
            "groups": [
                {"group": g.group, "layer": g.layer, "n_pp": len(g.parnames), "log_space": g.log_space, "format": g.format, "notes": list(g.notes)}
                for g in index.groups
            ],
            "not_interpolable": [{"group": a, "reason": b} for a, b in index.not_interpolable],
            "notes": list(index.notes),
        }
    )


@router.get("/field")
async def get_field(request: Request, params: Annotated[FieldQuery, Query()]) -> Response:
    opened = _open(request)
    if opened is None:
        return problem(409, "no run is open")
    layout, run_dir = opened
    stat = params.stat or "value"
    if stat == "value" and params.realization is None:
        return problem(422, "realization is required when stat is value or absent")
    if stat != "value" and params.realization is not None:
        return problem(422, f"realization must not be given together with stat={stat}")
    group = _group(layout, params.group)
    if isinstance(group, Response):
        return group
    shape = _shape(layout)
    if isinstance(shape, Response):
        return shape
    stored = get_stored(request.app.state, layout.root, params.iteration)
    if isinstance(stored, ReadFailure):
        return problem_from_failure(404, stored)
    manifest = Manifest.load(layout)
    if stat == "value":
        values = point_values(stored, group.parnames, params.realization)
        artifact = f"par_ens/{params.iteration}"
        key = params.realization
    else:
        values = stat_values(layout, params.iteration, group.parnames, stored, stat)
        artifact = f"par_agg/{params.iteration}"
        key = stat
    if isinstance(values, ReadFailure):
        return problem_from_failure(404, values)
    tag = cache_tag(manifest, artifact)
    if tag is not None:
        tag = _with_factor_file(tag, run_dir, group)

    def compute():
        return compute_field(run_dir, group, values, shape)

    # Without a tag a re-ingest could not invalidate the memo, so compute fresh.
    if tag is None:
        field = compute()
    else:
        field = memo_field(layout, group.group, params.iteration, tag, key, shape.ncpl, compute)
    if isinstance(field, ReadFailure):
        return problem_from_failure(404, field)
    meta = {
        "order": "cell",
        "iteration": params.iteration,
        "group": group.group,
        "layer": group.layer,
        "n_pp": len(group.parnames),
        "log_space": group.log_space,
        "stat": stat,
        "realization": params.realization,
    }
    response = blob_response(np.ascontiguousarray(field, dtype="<f4"), meta=meta)
    response.headers.update(cache_headers(tag, params.v))
    return response


@router.get("/field/cell")
async def get_field_cell(request: Request, params: Annotated[CellQuery, Query()]) -> Response:
    opened = _open(request)
    if opened is None:
        return problem(409, "no run is open")
    layout, run_dir = opened
    group = _group(layout, params.group)
    if isinstance(group, Response):
        return group
    found = contributors(run_dir, group, params.cell)
    if isinstance(found, ReadFailure):
        return problem_from_failure(404, found)
    return JSONResponse({"group": group.group, "cell": params.cell, "contributors": [{"parnme": n, "weight": w} for n, w in found]})
