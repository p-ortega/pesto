"""GET /api/run/config -- the tracer's one cache-reading route -- plus
GET/PUT /api/run/view (D-11), the per-run view state kept server-side.

Reads the active run's own facts out of the cache's config.json, never a
fact about any ingest. A run that has not been opened yet (no
``app.state.cache_root``) is a 409, not a 404 -- there is nothing missing,
there is simply no run selected.

The view-state routes carry no filesystem path in either direction: the
request body has no such field, and the server keys the store from its own
``cache_root``, never from anything the browser sends.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import JSONResponse

from pesto.api.prefs import read_view_state, write_view_state
from pesto.api.problem import problem, problem_from_failure
from pesto.cache.layout import CacheLayout
from pesto.cache.runconfig import load_config
from pesto.ingest.failures import ReadFailure

router = APIRouter(prefix="/api/run")


@router.get("/config")
async def get_run_config(request: Request) -> JSONResponse:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    layout = CacheLayout(root=Path(cache_root))
    config = load_config(layout)

    if not config.case:
        failure = ReadFailure(
            name="config",
            path=str(layout.config),
            reason="run configuration could not be read",
        )
        return problem_from_failure(502, failure)

    body = {
        "cache_version": config.cache_version,
        "run_dir": config.run_dir,
        "case": config.case,
        "n_par": config.n_par,
        "n_real": config.n_real,
        "base_realization": config.base_realization,
        "n_iterations": config.n_iterations,
        "noptmax": config.noptmax,
        "first_iteration": config.first_iteration,
        "last_iteration": config.last_iteration,
        "projection": config.projection,
        "projection_known": config.projection_known,
        "noise": {
            "has_noise": config.noise.has_noise,
            "decided_by": config.noise.decided_by,
            "evidence": list(config.noise.evidence),
            "notes": list(config.noise.notes),
        },
        "notes": list(config.notes),
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


class ViewState(BaseModel):
    """The whole view-state wire shape, in both directions. ``extra="forbid"``
    keeps this body free of any field that could carry a filesystem path --
    the server always keys the store from its own ``cache_root``."""

    model_config = ConfigDict(extra="forbid")

    divider: float = 0.72
    colormap: str = "viridis"
    reverse: bool = False
    scale: Literal["linear", "log10"] = "linear"
    limits_mode: Literal["robust", "minmax", "manual"] = "robust"
    group: str | None = None
    stat: str = "value"
    layer: int | None = Field(default=None, ge=0)


@router.get("/view")
async def get_view_state(request: Request) -> JSONResponse:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    state = read_view_state(cache_root)
    return JSONResponse(state, headers={"Cache-Control": "no-store"})


@router.put("/view")
async def put_view_state(request: Request, body: ViewState) -> JSONResponse:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    state = body.model_dump()
    write_view_state(cache_root, state)
    return JSONResponse(state, headers={"Cache-Control": "no-store"})
