"""The observation view's routes: one site's observed values and noise band, and
one site's simulated series.

All read the cache through the memo in ``obscache``, never a run directory. The
site arrives as query text and is matched by value against the cached site ids;
it is never used as a row position.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import numpy as np
import pandas as pd
from fastapi import APIRouter, Query, Request
from starlette.responses import Response

from pesto.api import obscache
from pesto.api.blob import blob_response
from pesto.api.problem import problem, problem_from_failure
from pesto.api.query import RunQuery
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.basereal import find_base
from pesto.ingest.failures import ReadFailure

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
