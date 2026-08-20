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
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from fastapi import APIRouter, Request
from starlette.responses import Response

from pesto.api.problem import problem, problem_from_failure
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.ingest.failures import ReadFailure
from pesto.ingest.tables import load_control_tables

if TYPE_CHECKING:
    import pyarrow as pa

router = APIRouter(prefix="/api/run")


def arrow_response(
    table: "pa.Table",
    *,
    notes: tuple[str, ...] = (),
    cache_control: str = "no-store",
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
    """
    import pyarrow as pa

    sink = pa.BufferOutputStream()
    writer = pa.ipc.new_stream(sink, table.schema)
    writer.write_table(table)
    writer.close()

    headers = {"Cache-Control": cache_control}
    if notes:
        headers["X-Pesto-Notes"] = json.dumps(list(notes))

    return Response(
        content=sink.getvalue().to_pybytes(),
        media_type="application/vnd.apache.arrow.stream",
        headers=headers,
    )


@router.get("/meta")
async def get_run_meta(request: Request, kind: Literal["par", "obs"]) -> Response:
    """Serve the control file's parameter or observation table as an Arrow
    stream, column order exactly as ``load_control_tables`` read it back.

    ``kind`` is a closed set typed as a ``Literal``, so an unknown value is
    rejected by FastAPI's own validation handler as a 422 problem body
    before this function ever runs -- there is no branch here to write.
    """
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    layout = CacheLayout(root=Path(cache_root))
    tables = load_control_tables(layout)
    if isinstance(tables, ReadFailure):
        return problem_from_failure(502, tables)

    import pyarrow as pa

    df = tables.par if kind == "par" else tables.obs
    table = pa.Table.from_pandas(df, preserve_index=False)
    return arrow_response(table, notes=tables.notes)


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

    layout = CacheLayout(root=Path(cache_root))
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

    import pyarrow as pa

    table = pa.table({"realization": names})
    return arrow_response(table)
