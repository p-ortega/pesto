"""The parameter view's routes: the per-group summary, one group's
per-parameter change and histograms, one parameter's own distribution, and the
placement notes behind each group's layer.

All read the cache, never a run directory. A group or parameter name arrives as
query text and is matched by value against the cached names; it is never used to
build a path.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

import numpy as np
import pandas as pd
from fastapi import APIRouter, Query, Request
from starlette.responses import JSONResponse, Response

from pesto.api import obscache
from pesto.api.enscache import get_stored
from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.api.tables import arrow_response
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.ensembles import align_realizations, read_par_across_reals
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parcell import load_par_cell
from pesto.ingest.parhist import load_par_hist, shared_edge_histogram
from pesto.ingest.parview import (
    DRILL_DOWN_MAX_PARAMS,
    NEAR_BOUND_NOTE,
    NEAR_SHARE_COLUMNS,
    drill_down_offer,
    load_par_change,
    load_par_groups,
)

router = APIRouter(prefix="/api/run")

# A whole percent so the threshold test stays in integers and exactly 10% counts.
AT_BOUNDS_MIN_PERCENT = 10
AT_BOUNDS_RULE = (
    "A parameter is at its bounds in the shown iteration when it has at least "
    f"{AT_BOUNDS_MIN_PERCENT}% of realizations near a bound, by pestpp's own rule. " + NEAR_BOUND_NOTE
)
AT_BOUNDS_CAVEAT = (
    "counts from the float32 cache can be one high against pestpp's pcs.csv on a few groups, "
    "because float32 can round a value across the threshold"
)
NOT_COUNTED = "not counted"
NO_CHANGE_REASON = "no parameter change was ingested for this run"


class ParGroupQuery(RunQuery):
    """``group`` is the one accepted field; ``RunQuery`` turns any other into a 422."""

    group: str


class ParParameterQuery(RunQuery):
    """``parameter`` is the one accepted field; ``RunQuery`` turns any other into a 422."""

    parameter: str


class AtBoundsQuery(RunQuery):
    """``iteration`` is required; ``group`` asks for that group's at-bounds names too."""

    iteration: int
    group: str | None = None


@dataclass(frozen=True, eq=False)
class AtBounds:
    """One iteration's at-bounds answer, built once per ``par_change`` write.
    ``known`` holds every group in par_change, so an unknown group is told apart
    from an iteration that has no counts."""

    first: int
    last: int
    known: frozenset[str]
    reason: str | None
    groups: list[dict]
    names: dict[str, list[str]]


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


def _build_at_bounds(layout: CacheLayout, iteration: int) -> AtBounds | ReadFailure:
    loaded = load_par_change(layout)
    if isinstance(loaded, ReadFailure):
        return loaded
    frame, meta = loaded
    first, last = int(meta["first_iteration"]), int(meta["last_iteration"])
    single = bool(meta["single_iteration"])
    pargp = frame["pargp"].astype(str)
    known = frozenset(pargp)

    if iteration == first:
        suffix = "first"
    elif iteration == last and not single:
        suffix = "last"
    else:
        where = f"iteration {first}" if single else f"iterations {first} and {last}"
        reason = f"near-bound counts exist for {where} only"
        return AtBounds(first=first, last=last, known=known, reason=reason, groups=[], names={})

    absent = [c for c in NEAR_SHARE_COLUMNS if c not in frame.columns]
    if absent:
        return ReadFailure(
            name="par_change",
            path=str(layout.par_change),
            reason=(
                f"par_change: the cached change table has no {', '.join(absent)} column, so the "
                "share of realizations near a bound cannot be told; ingest the run again"
            ),
        )
    # Nullable Int64 throughout: a missing count stays missing, never 0 and never a float.
    lower = frame[f"near_lower_{suffix}"].astype("Int64")
    upper = frame[f"near_upper_{suffix}"].astype("Int64")
    held = frame[f"near_n_{suffix}"].astype("Int64")
    counted = (lower.notna() & upper.notna() & held.notna() & (held > 0)).fillna(False).to_numpy(dtype=bool)
    near = (lower + upper) * 100 >= held * AT_BOUNDS_MIN_PERCENT
    at = near.fillna(False).to_numpy(dtype=bool) & counted
    kinds = frame["excluded_kind"].map(lambda k: k if isinstance(k, str) and k else NOT_COUNTED)

    work = pd.DataFrame({"group": pargp, "counted": counted, "at": at})
    summary = work.groupby("group", sort=False).agg(
        n_par=("counted", "size"), n_counted=("counted", "sum"), n_at_bounds=("at", "sum")
    )
    left = work.loc[~counted, ["group"]].assign(kind=kinds[~counted].to_numpy())
    excluded: dict[str, dict[str, int]] = {}
    for (group, kind), count in left.groupby(["group", "kind"], sort=False).size().items():
        excluded.setdefault(str(group), {})[str(kind)] = int(count)
    groups = [
        {
            "group": str(group),
            "n_par": int(row.n_par),
            "n_counted": int(row.n_counted),
            "n_at_bounds": int(row.n_at_bounds),
            "n_excluded": excluded.get(str(group), {}),
        }
        for group, row in summary.iterrows()
    ]
    hits = pd.DataFrame({"group": pargp[at], "parnme": frame["parnme"][at].astype(str)})
    names = {str(g): list(block["parnme"]) for g, block in hits.groupby("group", sort=False)}
    return AtBounds(first=first, last=last, known=known, reason=None, groups=groups, names=names)


@router.get("/par/at_bounds")
async def get_par_at_bounds(request: Request, params: Annotated[AtBoundsQuery, Query()]) -> Response:
    """How many parameters of each group are at their bounds in one iteration: at least
    ``AT_BOUNDS_MIN_PERCENT``% of realizations near a bound by pestpp's rule; with ``group``,
    every at-bounds name of it.
    No drill-down limit: the map needs every name to hatch every cell."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")

    body = {
        "available": False,
        "reason": None,
        "artifact": "par_change",
        "iteration": params.iteration,
        "first_iteration": None,
        "last_iteration": None,
        "rule": AT_BOUNDS_RULE,
        "caveat": AT_BOUNDS_CAVEAT,
        "groups": [],
        "names": None,
    }
    manifest = Manifest.load(CacheLayout(root=Path(cache_root)))
    recorded = manifest.artifacts.get("par_change")
    if recorded is None or recorded.state != "ok":
        body["reason"] = recorded.reason if recorded is not None and recorded.reason else NO_CHANGE_REASON
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    built = obscache.memoised(
        request.app.state,
        cache_root,
        ("at_bounds", params.iteration),
        ("par_change",),
        lambda layout: _build_at_bounds(layout, params.iteration),
    )
    if isinstance(built, ReadFailure):
        return problem_from_failure(404, built)
    if params.group is not None and params.group not in built.known:
        return problem(
            404,
            "no parameter group has that name",
            artifact="par_change",
            detail=f"the cached change table holds no parameter group named {params.group!r}",
        )

    body["first_iteration"], body["last_iteration"] = built.first, built.last
    if built.reason is not None:
        body["reason"] = built.reason
        return JSONResponse(body, headers={"Cache-Control": "no-store"})
    body["available"] = True
    body["groups"] = built.groups
    if params.group is not None:
        body["names"] = built.names.get(params.group, [])
    return JSONResponse(body, headers={"Cache-Control": "no-store"})
