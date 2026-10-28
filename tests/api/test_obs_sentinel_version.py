"""A statistics or 1:1 sidecar written before the sentinel rule is stale, rebuilt alone on the next
ingest, and never served meanwhile."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import pesto.api.obs as api_obs
import pesto.ingest.obs1to1 as obs1to1
import pesto.ingest.obsagg as obsagg
import pesto.ingest.obsindex as obsindex
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.runner import ingest_run, is_planned_stale, plan_artifacts

from .obs_helpers import open_cache, open_obs_run
from .test_obs_map_routes import GRID_RUN, in_process  # noqa: F401

REBUILT = {"obs_agg/0", "obs_agg/1", "obs_1to1"}
KEPT = {"control", "obs_index", "obs_ens/0", "obs_ens/1"}


def _planned(run, layout):
    return {a.name: a for a in plan_artifacts(discover(run.root), layout)}


def _newer_rule(monkeypatch, version: int = 2) -> None:
    for module in (obsindex, obsagg, obs1to1, api_obs):
        monkeypatch.setattr(module, "SENTINEL_RULE_VERSION", version)


def test_a_fresh_ingest_writes_the_rule_version_and_is_not_stale(tmp_path, in_process):  # noqa: F811
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    layout = CacheLayout(root=Path(tmp_path / "cache"))
    manifest = Manifest.load(layout)

    for path in (layout.obs_1to1_meta, layout.obs_agg_meta(0), layout.obs_agg_meta(1)):
        assert json.loads(path.read_text())["sentinel_rule_version"] == obsindex.SENTINEL_RULE_VERSION
    planned = _planned(run, layout)
    assert not any(is_planned_stale(manifest, layout, planned[name]) for name in REBUILT)


def test_a_sidecar_from_an_older_rule_is_stale_and_the_next_ingest_rebuilds_only_those(
    tmp_path, in_process, monkeypatch  # noqa: F811
):
    _client, run = open_obs_run(tmp_path, **GRID_RUN)
    layout = CacheLayout(root=Path(tmp_path / "cache"))
    _newer_rule(monkeypatch)
    manifest = Manifest.load(layout)
    planned = _planned(run, layout)

    assert all(is_planned_stale(manifest, layout, planned[name]) for name in REBUILT)
    assert not any(is_planned_stale(manifest, layout, planned[name]) for name in KEPT)

    rows = []
    ingest_run(run.root, cache_root=layout.root, on_progress=rows.append)

    state = {row.artifact: row.state for row in rows}
    assert all(state[name] != "skipped" for name in REBUILT), state
    assert all(state[name] == "skipped" for name in KEPT), state
    for path in (layout.obs_1to1_meta, layout.obs_agg_meta(0), layout.obs_agg_meta(1)):
        assert json.loads(path.read_text())["sentinel_rule_version"] == 2
    manifest = Manifest.load(layout)
    assert not any(is_planned_stale(manifest, layout, planned[name]) for name in REBUILT)


def test_a_sidecar_with_no_rule_version_is_stale(tmp_path, in_process):  # noqa: F811
    _client, run = open_obs_run(tmp_path, **GRID_RUN)
    layout = CacheLayout(root=Path(tmp_path / "cache"))
    data = json.loads(layout.obs_1to1_meta.read_text())
    del data["sentinel_rule_version"]
    layout.obs_1to1_meta.write_text(json.dumps(data))

    assert obsindex.sentinel_rule_outdated(layout.obs_1to1_meta)
    assert not obsindex.sentinel_rule_outdated(layout.obs_agg_meta(1))


def test_the_1to1_route_refuses_a_sidecar_with_no_rule_version_and_names_obs_1to1(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, **GRID_RUN)
    layout = CacheLayout(root=Path(tmp_path / "cache"))
    data = json.loads(layout.obs_1to1_meta.read_text())
    del data["sentinel_rule_version"]
    layout.obs_1to1_meta.write_text(json.dumps(data))

    response = open_cache(layout.root).get("/api/run/obs/1to1", params={"group": "gw_head"})

    assert response.status_code == 409
    assert "obs_1to1" in response.text and "ingest the run again" in response.text
    assert "grids" not in response.json()


def test_the_1to1_route_refuses_a_sidecar_from_an_older_rule(tmp_path, in_process, monkeypatch):  # noqa: F811
    client, _run = open_obs_run(tmp_path, **GRID_RUN)
    assert client.get("/api/run/obs/1to1", params={"group": "gw_head"}).status_code == 200
    monkeypatch.setattr(api_obs, "SENTINEL_RULE_VERSION", 2)

    response = client.get("/api/run/obs/1to1", params={"group": "gw_head"})

    assert response.status_code == 409
