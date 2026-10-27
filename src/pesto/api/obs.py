"""The observation view's routes: one site's observed values and noise band, and
one site's simulated series.

All read the cache through the memo in ``obscache``, never a run directory. The
site arrives as query text and is matched by value against the cached site ids;
it is never used as a row position.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Annotated

import numpy as np
import pandas as pd
from fastapi import APIRouter, Query, Request
from starlette.responses import JSONResponse, Response

from pesto.api import obscache
from pesto.api.blob import blob_response
from pesto.api.ingest import NO_NOISE_REASON
from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.basereal import find_base
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsindex import FLAG_WEIGHTED, SENTINEL_LIMIT

router = APIRouter(prefix="/api/run")


class ObsSiteQuery(RunQuery):
    """``site`` is the one accepted field; ``RunQuery`` turns any other into a 422."""

    site: int


class ObsSeriesQuery(RunQuery):
    """``site`` and ``iteration`` are the accepted fields."""

    site: int
    iteration: int


def _site_row(index, site: int) -> pd.Series | None:
    """The ``sites`` row whose ``site_id`` equals ``site``, or None."""
    found = pd.Index(index.sites["site_id"]).get_indexer([site])[0]
    if found < 0:
        return None
    return index.sites.iloc[int(found)]


def _unknown_site(site: int) -> Response:
    return problem(
        404,
        "no observation site has that id",
        artifact="obs_index",
        detail=f"the cached observation index holds no site with id {site}",
    )


def _numbers(values: np.ndarray) -> list[float | None]:
    """JSON-safe numbers: a finite float, or None where there is none."""
    return [float(v) if math.isfinite(v) else None for v in np.asarray(values, dtype=np.float64)]


def _unavailable(artifact: str, reason: str) -> dict:
    return {"available": False, "artifact": artifact, "reason": reason}


def _recorded_reason(manifest: Manifest, name: str, fallback: str) -> str | None:
    """None when ``name`` is recorded ok; otherwise the reason it gives, or ``fallback``."""
    recorded = manifest.artifacts.get(name)
    if recorded is not None and recorded.state == "ok":
        return None
    return recorded.reason if recorded is not None and recorded.reason else fallback


def _noise_band(state, cache_root, manifest: Manifest, start: int, count: int) -> tuple[dict, list[str]]:
    reason = _recorded_reason(manifest, "noise_agg", NO_NOISE_REASON)
    if reason is not None:
        return _unavailable("noise_agg", reason), []
    stored = obscache.get_noise(state, cache_root)
    if isinstance(stored, ReadFailure):
        return _unavailable("noise_agg", stored.reason), []
    rows = {name: stored.values[i, start : start + count] for i, name in enumerate(stored.stats)}
    band = {
        "available": True,
        "q05": _numbers(rows["q05"]),
        "q95": _numbers(rows["q95"]),
        "source": stored.source,
        "base": stored.base,
        "n_real_used": int(stored.n_real_used),
    }
    return band, list(stored.notes)


def _placement(state, cache_root, manifest: Manifest, site: int) -> dict:
    reason = _recorded_reason(
        manifest, "obs_cell", "no observation placement was ingested for this run"
    )
    if reason is not None:
        return _unavailable("obs_cell", reason)
    table = obscache.get_cell(state, cache_root)
    if isinstance(table, ReadFailure):
        return _unavailable("obs_cell", table.reason)
    found = pd.Index(table.site_id).get_indexer([site])[0]
    if found < 0:
        return _unavailable("obs_cell", f"the cached placement holds no site with id {site}")
    note = table.note[int(found)] if table.note is not None else ""
    return {
        "available": True,
        "rule": table.rule[int(found)],
        "note": note or None,
        "layer": int(table.layer[int(found)]),
        "cell": int(table.cell[int(found)]),
    }


@router.get("/obs/site")
async def get_obs_site(request: Request, params: Annotated[ObsSiteQuery, Query()]) -> Response:
    """One site's observed values and flags, noise band and placement. A piece
    that is not there says which artifact and why."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    row = _site_row(index, params.site)
    if row is None:
        return _unknown_site(params.site)

    start, count = int(row["start"]), int(row["count"])
    window = slice(start, start + count)
    value = index.value[window]
    flags = index.flags[window]
    group = index.groups.loc[index.groups["group"] == row["group"], "inequality"]
    manifest = Manifest.load(CacheLayout(root=Path(cache_root)))
    noise, notes = _noise_band(state, cache_root, manifest, start, count)

    body = {
        "site_id": int(params.site),
        "site": str(row["site"]),
        "group": str(row["group"]),
        "time_kind": str(row["time_kind"]),
        "inequality": str(group.iloc[0]) if len(group) else "none",
        "n_obs": count,
        "time": _numbers(index.time[window]),
        "obsval": _numbers(np.where(np.abs(value) >= SENTINEL_LIMIT, np.nan, value)),
        "no_value": [bool(v) for v in np.isnan(value)],
        "sentinel": [bool(v) for v in np.abs(value) >= SENTINEL_LIMIT],
        "weighted": [bool(v) for v in (flags & FLAG_WEIGHTED) != 0],
        "noise": noise,
        "placement": _placement(state, cache_root, manifest, params.site),
        "iterations": obscache.obs_iterations(manifest),
        "notes": notes,
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/obs/series")
async def get_obs_series(request: Request, params: Annotated[ObsSeriesQuery, Query()]) -> Response:
    """One site's rows of one iteration's observation ensemble, float32 (n_obs of
    the site, n_real), in time order. Base is found in this iteration's own names."""
    cache_root = getattr(request.app.state, "cache_root", None)
    if cache_root is None:
        return problem(409, "no run is open")
    state = request.app.state

    index = obscache.get_index(state, cache_root)
    if isinstance(index, ReadFailure):
        return problem_from_failure(404, index)
    row = _site_row(index, params.site)
    if row is None:
        return _unknown_site(params.site)

    name = f"{obscache.OBS_ENS_PREFIX}{params.iteration}"
    manifest = Manifest.load(CacheLayout(root=Path(cache_root)))
    recorded = manifest.artifacts.get(name)
    if recorded is None or recorded.state != "ok":
        reason = recorded.reason if recorded is not None and recorded.reason else None
        return problem(
            404,
            "no observation ensemble for that iteration",
            artifact=name,
            detail=reason or f"no observation ensemble was ingested for iteration {params.iteration}",
        )
    stored = obscache.get_ens(state, cache_root, params.iteration)
    if isinstance(stored, ReadFailure):
        return problem_from_failure(404, stored)

    start, count = int(row["start"]), int(row["count"])
    rows = np.asarray(stored.values[start : start + count], dtype="<f4")
    base_index, base_note = find_base(stored.real_names)
    meta = {
        "site_id": int(params.site),
        "iteration": int(params.iteration),
        "n_real": len(stored.real_names),
        "base_index": base_index,
        "base_note": base_note,
        "n_nan": int(np.count_nonzero(~np.isfinite(rows))),
    }
    return blob_response(rows, meta=meta, cache_control="no-store")
