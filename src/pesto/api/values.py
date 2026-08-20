"""The field and the statistic (Plan 05-06): a realization or a permuted
summary, same shape.

``GET /values`` serves one realization's map-block parameter field or one
statistic across realizations, both as raw little-endian bytes in block
order under one ``shape``/``dtype`` contract -- so the two are
interchangeable in the same GPU buffer, and Phase 5.1's canvas never has
to know which one it received. ``GET /cells/{which}`` serves the block-
order companion arrays Phase 4 wrote at ingest time.

Neither route filters by layer or group, and neither re-derives a
permutation: D-05 puts layer filtering on the client, and the statistic
permutation is read from the sidecar Phase 4 recorded through
``enscache.map_permutation``, never recomputed here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal

import numpy as np
from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict
from starlette.responses import Response

from pesto.api.blob import blob_response, cache_headers, cache_tag
from pesto.api.enscache import STATS, get_stored, map_permutation
from pesto.api.problem import problem, problem_from_failure
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest import ensembles as _ensembles
from pesto.ingest.failures import ReadFailure

router = APIRouter(prefix="/api/run/grid")

_StatName = Literal[STATS]


class ValuesQuery(BaseModel):
    """The whole accepted query surface for ``GET /values``. ``extra="forbid"``
    is what turns an unknown parameter -- ``layer``, ``group``, or a typo --
    into a 422 rather than a silently ignored filter a client might believe
    the server applied."""

    model_config = ConfigDict(extra="forbid")

    iteration: int
    stat: _StatName | None = None
    realization: str | None = None
    v: str | None = None


def _stored_notes_header(response: Response, notes: tuple[str, ...]) -> None:
    if notes:
        import json

        response.headers["X-Pesto-Notes"] = json.dumps(list(notes))


@router.get("/values")
async def get_values(request: Request, params: Annotated[ValuesQuery, Query()]) -> Response:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    stat = params.stat or "value"
    if stat == "value":
        if params.realization is None:
            return problem(422, "realization is required when stat is value or absent")
    elif params.realization is not None:
        return problem(422, f"realization must not be given together with stat={stat}")

    layout = CacheLayout(root=Path(cache_root))
    stored = get_stored(request.app.state, cache_root, params.iteration)
    if isinstance(stored, ReadFailure):
        return problem_from_failure(404, stored)

    manifest = Manifest.load(layout)
    n_map = stored.blocks[0].n_par

    if stat == "value":
        # Never str-to-int-coerce a numeric-looking realization name: an
        # int here means a row position, not a name, and CLAUDE.md's
        # identity rule forbids the substitution.
        array = _ensembles.read_map_row(stored, params.realization)
        if isinstance(array, ReadFailure):
            return problem_from_failure(404, array)
        artifact_name = f"par_ens/{params.iteration}"
        meta = {
            "order": "block",
            "iteration": params.iteration,
            "stat": "value",
            "n_map": n_map,
            "realization": params.realization,
        }
    else:
        permutation = map_permutation(stored)
        if permutation is None:
            return problem(
                404,
                "no map-block permutation was recorded for that iteration",
                artifact=f"par_ens/{params.iteration}",
            )

        import pandas as pd

        artifact_name = f"par_agg/{params.iteration}"
        agg_path = layout.par_agg(params.iteration)
        try:
            column_df = pd.read_parquet(agg_path, columns=[stat])
        except FileNotFoundError:
            return problem(
                404,
                "no aggregate table was recorded for that iteration",
                artifact=artifact_name,
            )
        except Exception as exc:
            return problem(
                404,
                f"aggregate table has no column {stat!r}",
                artifact=artifact_name,
                detail=str(exc),
            )

        control_order = column_df[stat].to_numpy(dtype=np.float32)
        array = control_order[permutation]
        meta = {
            "order": "block",
            "iteration": params.iteration,
            "stat": stat,
            "n_map": n_map,
        }

    tag = cache_tag(manifest, artifact_name)
    response = blob_response(array, meta=meta)
    _stored_notes_header(response, stored.notes)
    response.headers.update(cache_headers(tag, params.v))
    return response


@router.get("/cells/{which}")
async def get_cells(
    which: Literal["cell", "layer"], request: Request, iteration: int, v: str | None = None
) -> Response:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    layout = CacheLayout(root=Path(cache_root))
    stored = get_stored(request.app.state, cache_root, iteration)
    if isinstance(stored, ReadFailure):
        return problem_from_failure(404, stored)

    array = stored.cell if which == "cell" else stored.layer
    if array is None:
        return problem(
            404,
            "no cell mapping was recorded for that iteration",
            artifact=f"par_ens/{iteration}",
        )

    manifest = Manifest.load(layout)
    tag = cache_tag(manifest, f"par_ens/{iteration}")
    response = blob_response(array, meta={"order": "block", "iteration": iteration})
    response.headers.update(cache_headers(tag, v))
    return response
