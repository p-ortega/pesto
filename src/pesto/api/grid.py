"""The mesh and the cell arrays (Plan 05-05): raw little-endian bytes, no
parsing.

``GET /mesh`` is the small document a client reads once to know the grid's
shape and the tag to ask for on every buffer after that. ``GET
/mesh/{buffer}`` serves the geometry itself, straight from ``load_mesh`` --
this router never opens a grid file itself, since ``load_mesh`` already
checks the cache version and refuses a file whose size disagrees with its
declared element count, and a second check here would just be a second
place for the two to disagree.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse

from pesto.api.blob import blob_response, cache_headers, cache_tag
from pesto.api.problem import problem, problem_from_failure
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import load_mesh

router = APIRouter(prefix="/api/run/grid")


@router.get("/mesh")
async def get_mesh(request: Request) -> JSONResponse:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    layout = CacheLayout(root=Path(cache_root))
    mesh = load_mesh(layout)
    if isinstance(mesh, ReadFailure):
        return problem_from_failure(502, mesh)

    manifest = Manifest.load(layout)
    tag = cache_tag(manifest, "grid")

    body = {
        "n_vert": int(mesh.positions.shape[0]),
        "n_tri": int(mesh.indices.shape[0] // 3),
        "n_cells": mesh.n_cells,
        "nlay": mesh.nlay,
        "bounds": list(mesh.bounds),
        "crs": mesh.crs,
        "buffers": {
            "positions": {"dtype": mesh.positions.dtype.str, "count": int(mesh.positions.size)},
            "cell_index": {
                "dtype": mesh.cell_index.dtype.str,
                "count": int(mesh.cell_index.size),
            },
            "indices": {"dtype": mesh.indices.dtype.str, "count": int(mesh.indices.size)},
        },
        "tag": tag,
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/mesh/{buffer}")
async def get_mesh_buffer(
    buffer: Literal["positions", "cell_index", "indices"], request: Request
) -> JSONResponse:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    layout = CacheLayout(root=Path(cache_root))
    mesh = load_mesh(layout)
    if isinstance(mesh, ReadFailure):
        return problem_from_failure(502, mesh)

    manifest = Manifest.load(layout)
    tag = cache_tag(manifest, "grid")
    requested = request.query_params.get("v")

    array = getattr(mesh, buffer)
    response = blob_response(array, meta={"buffer": buffer})
    response.headers.update(cache_headers(tag, requested))
    return response
