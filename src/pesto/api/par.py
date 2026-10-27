"""The parameter view's routes: the per-group summary, one group's
per-parameter change, and the placement notes behind each group's layer.

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
from pesto.ingest.parcell import load_par_cell
from pesto.ingest.parhist import load_par_hist
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


@router.get("/grid/placement")
async def get_placement(request: Request, params: Annotated[RunQuery, Query()]) -> Response:
    """Each parameter group's placement rule and counts, with the notes that name
    it. A note that names no group comes back at the top level: nothing is dropped."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    placed = load_par_cell(CacheLayout(root=Path(cache_root)))
    if isinstance(placed, ReadFailure):
        return problem_from_failure(404, placed)

    claimed: set[int] = set()
    groups = []
    for entry in placed.groups:
        prefix = f"group {entry['group']!r}"
        mine = [i for i, note in enumerate(placed.notes) if i not in claimed and note.startswith(prefix)]
        claimed.update(mine)
        groups.append({**entry, "notes": [placed.notes[i] for i in mine]})
    rest = [note for i, note in enumerate(placed.notes) if i not in claimed]
    body = {"groups": groups, "summary": placed.summary, "notes": rest}
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


def _left_out(meta: dict) -> dict:
    """The realizations left out of every figure: present in only one of the two iterations."""
    count = int(meta["only_first"]["count"]) + int(meta["only_last"]["count"])
    reason = None
    if count:
        reason = (
            f"a realization present in only one of iteration {meta['first_iteration']} and "
            f"iteration {meta['last_iteration']} is left out of every figure"
        )
    return {"count": count, "reason": reason}


def _hist_series(rows, entry: dict | None) -> dict | None:
    if entry is None:
        return None
    mine = rows[rows["iteration"] == entry["iteration"]].sort_values("bin")
    return {
        "iteration": int(entry["iteration"]),
        "n": int(entry["n"]),
        "counts": [int(v) for v in mine["count"]],
        "density": [float(v) for v in mine["density"]],
    }


@router.get("/par/hist")
async def get_par_hist(request: Request, params: Annotated[ParGroupQuery, Query()]) -> Response:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    loaded = load_par_hist(CacheLayout(root=Path(cache_root)))
    if isinstance(loaded, ReadFailure):
        return problem_from_failure(404, loaded)
    frame, meta = loaded

    entry = next((g for g in meta["groups"] if g["group"] == params.group), None)
    if entry is None:
        return problem(
            404,
            "no parameter group has that name",
            artifact="par_hist",
            detail=f"the cached histograms hold no parameter group named {params.group!r}",
        )
    rows = frame[frame["group"] == params.group]
    body = {
        "group": entry["group"],
        "space": entry["space"],
        "edges": entry["edges"],
        "first": _hist_series(rows, entry["first"]),
        "last": _hist_series(rows, entry["last"]),
        "n_common": int(meta["n_common"]),
        "left_out": _left_out(meta),
        "excluded": entry["excluded"],
        "refused": entry["refused"],
        "notes": [*entry["notes"], *meta["notes"]],
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


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
