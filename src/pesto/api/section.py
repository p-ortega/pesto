"""The vertical section along one straight line: ``GET /api/run/grid/section``.

The answer is computed from the cache alone -- the float64 rings, the layer
elevations and the idomain -- so it never opens the run folder or the grid
file. The elevation arrays themselves are never served; the browser only gets
the pieces the line crosses.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import APIRouter, Query, Request
from pydantic import Field
from starlette.responses import Response

from pesto.api.blob import cache_tag
from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.elev import ELEV_PREDATES, elev_grid_mismatch, load_elev
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import load_idomain, load_mesh_extent
from pesto.section.assemble import STATUS_TEXT, answer_notes, assemble
from pesto.section.walk import LineTooShort, walk

router = APIRouter(prefix="/api/run/grid")

_UNAVAILABLE = "the section is not available"
# About 10 MB of JSON. Looked up at request time, so a test can lower it.
MAX_SECTION_QUADS = 400_000


class SectionQuery(RunQuery):
    """The two ends of the line, in world coordinates."""

    ax: float = Field(allow_inf_nan=False)
    ay: float = Field(allow_inf_nan=False)
    bx: float = Field(allow_inf_nan=False)
    by: float = Field(allow_inf_nan=False)


def _finite_or_none(row: np.ndarray) -> list[float | None]:
    return [float(v) if math.isfinite(v) else None for v in row.tolist()]


@router.get("/section")
def get_section(request: Request, params: Annotated[SectionQuery, Query()]) -> Response:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    layout = CacheLayout(root=Path(cache_root))

    manifest = Manifest.load(layout)
    recorded = manifest.artifacts.get("elev")
    if recorded is None:
        return problem(409, _UNAVAILABLE, artifact="elev", detail=ELEV_PREDATES)
    if recorded.state != "ok":
        reason = recorded.reason or f"the elev artifact is recorded as {recorded.state}"
        return problem(409, _UNAVAILABLE, artifact="elev", detail=reason)
    # Otherwise the answer's cell numbers would be looked up in a mesh built from another grid.
    mismatch = elev_grid_mismatch(manifest.artifacts.get("grid"), recorded)
    if mismatch is not None:
        return problem(409, _UNAVAILABLE, artifact="elev", detail=mismatch)

    elev = load_elev(layout)
    if isinstance(elev, ReadFailure):
        return problem_from_failure(502, elev)
    extent = load_mesh_extent(layout)
    if isinstance(extent, ReadFailure):
        return problem_from_failure(502, extent)
    xmin, xmax, ymin, ymax = extent
    tol = 1e-9 * max(xmax - xmin, ymax - ymin)

    # The ends are moved into the rings' frame in float64, never through float32.
    ox, oy = elev.origin
    a = (params.ax - ox, params.ay - oy)
    b = (params.bx - ox, params.by - oy)
    try:
        cell, s0, s1, walk_counts = walk(
            elev.ring[:, 0], elev.ring[:, 1], elev.ring_start, a, b, tol
        )
    except LineTooShort as exc:
        return problem(422, "the two ends are on the same spot", detail=str(exc))
    if cell.size == 0:
        near = walk_counts["candidates"]
        detail = (
            f"the line passes the bounding box of {near} cells but crosses none of them"
            if near
            else "the line does not reach the bounding box of any cell"
        )
        return problem(422, "the line crosses no model cell", detail=detail)
    n_quads = int(cell.size) * elev.nlay
    # Checked before any elevation is gathered, so an oversized line costs no more than the walk.
    if n_quads > MAX_SECTION_QUADS:
        return problem(
            422,
            "the section would hold too many cells",
            detail=(
                f"the line crosses {cell.size} pieces over {elev.nlay} layers, "
                f"{n_quads} section cells, more than the {MAX_SECTION_QUADS} one answer may hold; "
                "draw a shorter line"
            ),
        )

    idomain = load_idomain(layout)
    if isinstance(idomain, ReadFailure):
        return problem_from_failure(502, idomain)
    try:
        built = assemble(cell, elev.elev, idomain, elev.nlay, elev.ncpl)
    except ValueError as exc:
        return problem(502, "the section could not be assembled", artifact="elev", detail=str(exc))

    length = math.hypot(params.bx - params.ax, params.by - params.ay)
    counts = {**walk_counts, **built.counts}
    body = {
        "line": {"a": [params.ax, params.ay], "b": [params.bx, params.by], "length": length},
        "nlay": elev.nlay,
        "n_pieces": int(cell.size),
        "cell": [int(c) for c in cell.tolist()],
        "s0": [float(v) for v in s0.tolist()],
        "s1": [float(v) for v in s1.tolist()],
        "z": _finite_or_none(built.z.reshape(-1)),
        "status": [int(v) for v in built.status.reshape(-1).tolist()],
        "status_text": {str(k): v for k, v in STATUS_TEXT.items()},
        "has_idomain": idomain is not None,
        "grid_type": elev.grid_type,
        "length_units": None,
        "counts": counts,
        "notes": answer_notes(counts),
        "tag": cache_tag(manifest, "elev"),
    }
    return Response(
        content=json.dumps(body, allow_nan=False),
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )
