"""Arrow named-column tables (Plan 05-04): control tables and realization names.

SERVE-01 splits the serving surface in two on purpose: named-column tables
go out as Arrow IPC streams, because that is exactly the problem Arrow
solves, while pure numeric blocks (Plan 05-05) go out as raw bytes, because
that is where the zero-copy property actually lives. Both routes here read
straight out of the cache -- never a run directory -- and every failure
becomes a ``problem+json`` body naming the artifact, never a partial or
empty table presented as the whole answer.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import APIRouter, Query, Request
from starlette.responses import JSONResponse, Response

from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.ingest.basereal import find_base
from pesto.ingest.failures import ReadFailure
from pesto.ingest.tables import UnknownColumn, load_control_table

if TYPE_CHECKING:
    import pyarrow as pa

router = APIRouter(prefix="/api/run")


def arrow_response(
    table: "pa.Table",
    *,
    notes: tuple[str, ...] = (),
    cache_control: str = "no-store",
    absent_columns: Sequence[str] = (),
    meta: dict | None = None,
) -> Response:
    """Serialise ``table`` to an Arrow IPC *stream* and wrap it in a response.

    ``pyarrow`` is imported here, inside the function body, not at module
    scope, for the same reason other heavy scientific-stack libraries are
    deferred elsewhere: the launcher has to open a browser window before
    heavy imports finish.

    ``notes`` are the ingest layer's own record of what it repaired, dropped
    or could not state about the table being served. A route boundary is
    the first place a person can see them, so they travel on as the
    ``X-Pesto-Notes`` header -- a JSON array of strings -- rather than
    stopping here. The header is omitted entirely when there are none.

    ``absent_columns`` are optional columns the caller asked for and the table
    does not have; they go out as ``X-Pesto-Absent-Columns``, a JSON array,
    omitted when empty.

    ``meta`` goes out as the ``X-Pesto-Meta`` JSON header, the same one the raw-bytes
    routes use, for facts about the table that are not columns.
    """
    import pyarrow as pa

    sink = pa.BufferOutputStream()
    writer = pa.ipc.new_stream(sink, table.schema)
    writer.write_table(table)
    writer.close()

    headers = {"Cache-Control": cache_control}
    if notes:
        headers["X-Pesto-Notes"] = json.dumps(list(notes))
    if absent_columns:
        headers["X-Pesto-Absent-Columns"] = json.dumps(list(absent_columns))
    if meta:
        headers["X-Pesto-Meta"] = json.dumps(meta, separators=(",", ":"))

    return Response(
        content=sink.getvalue().to_pybytes(),
        media_type="application/vnd.apache.arrow.stream",
        headers=headers,
    )


@router.get("/meta")
async def get_run_meta(
    request: Request,
    kind: Literal["par", "obs"],
    columns: str | None = None,
    optional_columns: str | None = None,
) -> Response:
    """Serve the control file's parameter or observation table as an Arrow
    stream, column order exactly as the cache file holds it.

    ``kind`` is a closed set typed as a ``Literal``, so an unknown value is
    rejected by FastAPI's own validation handler as a 422 problem body
    before this function ever runs -- there is no branch here to write.

    ``columns`` is an optional comma-separated list. Only those columns are
    sent, in the table's own order. An empty name or one the table does not
    have is refused with a 422 naming it, never dropped.

    ``optional_columns`` is the same kind of list, but a name the table does
    not have is not an error: it is left out, and the names left out come
    back in the ``X-Pesto-Absent-Columns`` header (a JSON array) and as a
    note, so a missing optional column is never silent.
    """
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    wanted: list[str] | None = None
    optional: list[str] | None = None
    for label, raw in (("columns", columns), ("optional_columns", optional_columns)):
        if raw is not None and any(name == "" for name in raw.split(",")):
            return problem(
                422,
                "a requested column name is empty",
                artifact=f"meta/{kind}",
                detail=f"{label} holds an empty name",
            )
    if columns is not None:
        wanted = columns.split(",")
    if optional_columns is not None:
        optional = optional_columns.split(",")

    layout = CacheLayout(root=Path(cache_root))
    result = load_control_table(layout, kind, wanted, optional)
    if isinstance(result, ReadFailure):
        if isinstance(result, UnknownColumn):
            return problem(
                422,
                "a requested column is not in the table",
                artifact=f"meta/{kind}",
                detail=result.reason,
            )
        return problem_from_failure(502, result)

    table, notes = result
    absent = [name for name in optional or () if name not in table.column_names]
    return arrow_response(table, notes=notes, absent_columns=absent)


@router.get("/reals")
async def get_run_reals(request: Request, iteration: int) -> Response:
    """Serve one iteration's realization names, in the order the ensemble
    file recorded them, as a single-column Arrow stream.

    A realization's identity is its name, never its row position (CLAUDE.md's
    second hard rule; PROJECT.md's cross-iteration-join constraint), so the
    sidecar is validated the same defensive way the cache readers validate
    theirs -- an unreadable file, a non-object payload, and a foreign
    ``cache_version`` are each refused with a reason naming the file, rather
    than served as an empty or half-believed table.
    """
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    names = _read_par_reals(CacheLayout(root=Path(cache_root)), iteration)
    if isinstance(names, Response):
        return names

    import pyarrow as pa

    table = pa.table({"realization": names})
    return arrow_response(table)


def _read_par_reals(layout: CacheLayout, iteration: int) -> list | Response:
    """The names ``par_reals/K`` recorded, or the problem saying why the file cannot be believed."""
    target = layout.par_reals(iteration)
    artifact = f"par_reals/{iteration}"

    try:
        raw = json.loads(target.read_text())
    except (OSError, json.JSONDecodeError):
        return problem(
            404,
            "no realization names were recorded for that iteration",
            artifact=artifact,
        )

    if not isinstance(raw, dict):
        return problem(502, f"{target.name} is not a JSON object", artifact=artifact)

    if raw.get("cache_version") != CACHE_VERSION:
        return problem(
            502,
            "realization index was written at a different cache version",
            artifact=artifact,
            detail=(
                f"{target.name} was written at cache_version {raw.get('cache_version')!r}, "
                f"this reader expects {CACHE_VERSION}"
            ),
        )

    names = raw.get("names")
    if not isinstance(names, list):
        return problem(502, f"{target.name} has an unexpected shape", artifact=artifact)
    return names


class RealsBaseQuery(RunQuery):
    """``iteration`` is the one accepted field."""

    iteration: int


@router.get("/reals/base")
async def get_reals_base(request: Request, params: Annotated[RealsBaseQuery, Query()]) -> Response:
    """The base realization of one iteration's parameter ensemble, found by ``find_base`` and
    given in the file's own spelling, or no name with the reason there is none."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    layout = CacheLayout(root=Path(cache_root))
    names = _read_par_reals(layout, params.iteration)
    if isinstance(names, Response):
        return names
    if not all(isinstance(name, str) for name in names):
        target = layout.par_reals(params.iteration)
        return problem(
            502, f"{target.name} has an unexpected shape", artifact=f"par_reals/{params.iteration}"
        )

    positions, note = find_base(tuple(names))
    found = bool(positions)
    body = {
        "iteration": int(params.iteration),
        "name": names[positions[0]] if found else None,
        "note": note,
        "reason": None if found else f"no realization named base in iteration {params.iteration}",
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})
