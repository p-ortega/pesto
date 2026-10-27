"""The parameter view's routes: the per-group summary and one group's
per-parameter change.

Both read the cache, never a run directory. A group name arrives as query
text and is matched by value against the cached ``pargp`` column; it is never
used to build a path.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query, Request
from starlette.responses import JSONResponse, Response

from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.api.tables import arrow_response
from pesto.cache.layout import CacheLayout
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parview import load_par_change, load_par_groups

router = APIRouter(prefix="/api/run")


class ParGroupQuery(RunQuery):
    """``group`` is the one accepted field; ``RunQuery`` turns any other into a 422."""

    group: str


@router.get("/par/groups")
async def get_par_groups(request: Request, params: Annotated[RunQuery, Query()]) -> Response:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    loaded = load_par_groups(CacheLayout(root=Path(cache_root)))
    if isinstance(loaded, ReadFailure):
        return problem_from_failure(404, loaded)
    return JSONResponse(loaded, headers={"Cache-Control": "no-store"})


@router.get("/par/change")
async def get_par_change(request: Request, params: Annotated[ParGroupQuery, Query()]) -> Response:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    import pyarrow as pa

    loaded = load_par_change(CacheLayout(root=Path(cache_root)))
    if isinstance(loaded, ReadFailure):
        return problem_from_failure(404, loaded)
    frame, meta = loaded

    block = frame[frame["pargp"] == params.group]
    if block.empty:
        return problem(
            404,
            "no parameter group has that name",
            artifact="par_change",
            detail=f"the cached change table holds no parameter group named {params.group!r}",
        )
    notes = tuple(str(n) for n in meta["notes"])
    if meta.get("reason"):
        notes = (str(meta["reason"]), *notes)
    return arrow_response(pa.Table.from_pandas(block, preserve_index=False), notes=notes)
