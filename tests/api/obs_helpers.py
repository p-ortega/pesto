"""Shared by every /obs route test: ingest a generated observation run and open it in a real app."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from ingest.obs_fixtures import ObsRun, make_obs_run
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.ingest.runner import ingest_run

BASE_URL = "http://127.0.0.1"
HEAD_SITE = "oname:hds_otype:lst_usecol:trgw-0-1"


def open_obs_run(tmp_path, **make_obs_run_kwargs) -> tuple[TestClient, ObsRun]:
    """Ingest a ``make_obs_run`` run into ``tmp_path / "cache"`` and return a client with it open.

    The caller needs the ``in_process`` fixture, as every ingest test does.
    """
    run = make_obs_run(tmp_path / "run", **make_obs_run_kwargs)
    cache_root = tmp_path / "cache"
    ingest_run(run.root, cache_root=cache_root)
    return open_cache(cache_root), run


def open_cache(cache_root) -> TestClient:
    app, token = create_app()
    app.state.cache_root = str(cache_root)
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    client.pesto_app = app
    return client


def site_id(cache_root, name: str) -> int:
    """The id of the site called ``name``, read from the cached index by name."""
    import pandas as pd

    sites = pd.read_parquet(CacheLayout(root=Path(cache_root)).obs_sites)
    return int(sites.loc[sites["site"] == name, "site_id"].iloc[0])


def series_meta(response) -> dict:
    return json.loads(response.headers["x-pesto-meta"])
