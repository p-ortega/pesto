"""The parameter view's routes: the per-group summary, one group's
per-parameter change and histograms, one parameter's own distribution, and the
placement notes behind each group's layer.

All read the cache, never a run directory. A group or parameter name arrives as
query text and is matched by value against the cached names; it is never used to
build a path.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import APIRouter, Query, Request
from starlette.responses import JSONResponse, Response

from pesto.api.enscache import get_stored
from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.api.tables import arrow_response
from pesto.cache.layout import CacheLayout
from pesto.ingest.ensembles import align_realizations, read_par_across_reals
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parcell import load_par_cell
from pesto.ingest.parhist import load_par_hist, shared_edge_histogram
from pesto.ingest.parview import (
    DRILL_DOWN_MAX_PARAMS,
    drill_down_offer,
    load_par_change,
    load_par_groups,
)

router = APIRouter(prefix="/api/run")


class ParGroupQuery(RunQuery):
    """``group`` is the one accepted field; ``RunQuery`` turns any other into a 422."""

    group: str


class ParParameterQuery(RunQuery):
    """``parameter`` is the one accepted field; ``RunQuery`` turns any other into a 422."""

    parameter: str


def _drill_down_refusal(layout: CacheLayout, group: str, n_par: int) -> Response | None:
    """A 409 when the group is over the drill-down limit, else None. The stored
    offer from ``par_groups`` decides, so the sentence shown is the one written
    at ingest. Checked before any ensemble is read."""
    groups = load_par_groups(layout)
    if isinstance(groups, ReadFailure):
        return problem_from_failure(404, groups)
    entry = next((g for g in groups["groups"] if g["group"] == group), None)
    offer = entry["drill_down"] if entry is not None else drill_down_offer(n_par, DRILL_DOWN_MAX_PARAMS)
    if offer["offered"]:
        return None
    return problem(
        409,
        "drill-down is not offered for this group",
        artifact="par_groups",
        detail=offer["reason"],
    )


def _finite(value) -> float | None:
    """A JSON-safe number: a finite float, or None where there is none."""
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


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


@router.get("/par/values")
async def get_par_values(request: Request, params: Annotated[ParParameterQuery, Query()]) -> Response:
    """One parameter's own distribution in the first and the last iteration, on
    shared edges, over the realizations present in both. Distributions only:
    no per-realization pairing leaves this route."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    layout = CacheLayout(root=Path(cache_root))
    loaded = load_par_change(layout)
    if isinstance(loaded, ReadFailure):
        return problem_from_failure(404, loaded)
    frame, meta = loaded

    hit = frame[frame["parnme"] == params.parameter]
    if hit.empty:
        return problem(
            404,
            "no parameter has that name",
            artifact="par_change",
            detail=f"the cached change table holds no parameter named {params.parameter!r}",
        )
    row = hit.iloc[0]
    group = str(row["pargp"])
    n_group = int((frame["pargp"] == group).sum())
    refusal = _drill_down_refusal(layout, group, n_group)
    if refusal is not None:
        return refusal

    first, last = int(meta["first_iteration"]), int(meta["last_iteration"])
    single = bool(meta["single_iteration"])
    body = {
        "parameter": params.parameter,
        "group": group,
        "space": str(row["space"]),
        "n_common": int(meta["n_common"]),
        "left_out": _left_out(meta),
        "edges": None,
        "first": None,
        "last": None,
        "refused": None,
        "notes": [],
    }
    if not bool(row["included"]):
        body["refused"] = str(row["excluded_reason"])
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    state = request.app.state
    ensembles = []
    for iteration in (first,) if single else (first, last):
        stored = get_stored(state, cache_root, iteration)
        if isinstance(stored, ReadFailure):
            return problem_from_failure(404, stored)
        found = read_par_across_reals(stored, params.parameter)
        if isinstance(found, ReadFailure):
            return problem_from_failure(404, found)
        ensembles.append((stored, found.astype(np.float64)))

    if single:
        values = [ensembles[0][1]]
        body["notes"].append(
            f"only iteration {first} was ingested, so one series is drawn and there is no before and after"
        )
    else:
        aligned = align_realizations(ensembles[0][0].real_names, ensembles[1][0].real_names)
        values = [ensembles[0][1][list(aligned.index_a)], ensembles[1][1][list(aligned.index_b)]]
        body["notes"].extend(aligned.notes)
    if body["space"] == "log10":
        values = [np.log10(v) for v in values]

    shared = shared_edge_histogram(
        values[0], None if single else values[1], subject="parameter"
    )
    if shared.refused is not None:
        body["refused"] = shared.refused
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    body["edges"] = [float(v) for v in shared.edges]
    moments = (
        ("mean_first", "sd_first"),
        ("mean_last", "sd_last"),
    )
    for key, iteration, series, (mean_key, sd_key) in zip(
        ("first", "last"), (first, last), (shared.first, shared.last), moments
    ):
        if series is None:
            continue
        body[key] = {
            "iteration": iteration,
            "n": series.n,
            "counts": [int(v) for v in series.counts],
            "density": [float(v) for v in series.density],
            "mean": _finite(row[mean_key]),
            "sd": _finite(row[sd_key]),
        }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/par/change")
async def get_par_change(request: Request, params: Annotated[ParGroupQuery, Query()]) -> Response:
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    import pyarrow as pa

    layout = CacheLayout(root=Path(cache_root))
    loaded = load_par_change(layout)
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
    refusal = _drill_down_refusal(layout, params.group, len(block))
    if refusal is not None:
        return refusal
    notes = tuple(str(n) for n in meta["notes"])
    if meta.get("reason"):
        notes = (str(meta["reason"]), *notes)
    return arrow_response(pa.Table.from_pandas(block, preserve_index=False), notes=notes)
