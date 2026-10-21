"""obs_cell: where every observation site sits on the grid.

The tracer ingests a run with a real vertex grid and checks each site's cell,
layer and rule by site name. The later tests pin the name check, staleness
and every way the artifact can fail.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import pesto.ingest.runner as runner
from pesto.api.app import create_app
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import Manifest, WrittenArtifact
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obscell import ObsCellTable, load_obs_cell, write_obs_cell
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.runner import ingest_run, plan_artifacts
from pesto.model import GroupResolution, ObsCells

from .obs_fixtures import GRID_SITES, make_obs_run

# Taken at import time, before any fixture swaps the runner's isolation out.
_REAL_RUN_ISOLATED = runner._run_isolated

_SITE_A = "oname:hds_otype:lst_usecol:icpl-a"
_SITE_B = "oname:hds_otype:lst_usecol:icpl-b"
_SITE_C = "oname:hds_otype:lst_usecol:xy-c"


@pytest.fixture
def in_process(monkeypatch):
    """Run every worker in this process, with the real adapter."""

    def _call(fn, *args):
        try:
            return True, fn(*args)
        except Exception as exc:
            return False, exc

    monkeypatch.setattr(runner, "_run_isolated", _call)


def _ingest_grid_run(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, grid=True, iterations=(0,), **kwargs)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root), manifest


def _by_site(table: ObsCellTable) -> dict[str, int]:
    return {name: i for i, name in enumerate(table.site)}


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_a_run_with_a_vertex_grid_gets_obs_cell_with_cell_layer_and_rule_by_site_name(
    tmp_path, in_process
):
    run, layout, manifest = _ingest_grid_run(tmp_path)

    assert manifest.artifacts["obs_cell"].state == "ok", manifest.artifacts["obs_cell"].reason
    table = load_obs_cell(layout)
    assert isinstance(table, ObsCellTable)
    at = _by_site(table)

    a, b, c = at[_SITE_A], at[_SITE_B], at[_SITE_C]
    assert (table.cell[a], table.layer[a], table.rule[a]) == (0, 0, "icpl-layer")
    # A blank layer keeps its cell and is stored as -1, never as layer 0.
    assert (table.cell[b], table.layer[b], table.rule[b]) == (2, -1, "icpl-layer")
    assert (table.cell[c], table.rule[c]) == (1, "xyz-host-cell")
    assert np.isfinite(table.x[c]) and np.isfinite(table.y[c])
    assert table.group[a] == "gw_icpl" and table.group[c] == "gw_xy"
    assert table.placed_sites == 3
    assert table.layer_unknown == 1
    assert {g["group"]: g["rule"] for g in table.groups} == {
        "gw_icpl": "icpl-layer",
        "gw_xy": "xyz-host-cell",
    }


def test_the_blank_layer_site_is_never_stored_as_layer_zero(tmp_path, in_process):
    _run, layout, _manifest = _ingest_grid_run(tmp_path)

    frame = pd.read_parquet(layout.obs_cell)

    row = frame[frame["site"] == _SITE_B].iloc[0]
    assert int(row["cell"]) == 2
    assert int(row["layer"]) == -1
    assert frame["layer"].dtype == np.int32 and frame["cell"].dtype == np.int32


def test_sites_are_joined_by_name_in_obs_index_order(tmp_path, in_process):
    _run, layout, _manifest = _ingest_grid_run(tmp_path)

    index = load_obs_index(layout)
    table = load_obs_cell(layout)

    assert table.site == tuple(index.sites["site"])
    assert list(table.site_id) == list(index.sites["site_id"])
    assert table.order_digest == index.order_digest


def test_the_manifest_notes_carry_the_layer_unknown_count_and_the_layer_base_evidence(
    tmp_path, in_process
):
    _run, _layout, manifest = _ingest_grid_run(tmp_path)

    notes = manifest.artifacts["obs_cell"].notes

    assert any("layer unknown" in note and "1" in note for note in notes)
    assert any(note.startswith("layer base") for note in notes)


def test_the_sidecar_holds_the_digest_counts_summary_and_notes(tmp_path, in_process):
    _run, layout, _manifest = _ingest_grid_run(tmp_path)

    raw = json.loads(layout.obs_cell_meta.read_text())

    assert raw["cache_version"] == CACHE_VERSION
    assert raw["order_digest"] == load_obs_index(layout).order_digest
    assert raw["placed_sites"] == 3 and raw["layer_unknown"] == 1
    assert raw["summary"]
    assert raw["notes"]
    assert {g["group"] for g in raw["groups"]} == {"gw_icpl", "gw_xy"}


def test_the_state_route_lists_obs_cell_as_ok(tmp_path, in_process):
    run, layout, _manifest = _ingest_grid_run(tmp_path)

    app, token = create_app()
    app.state.initial_run_dir = str(run.root)
    app.state.cache_root = str(layout.root)
    client = TestClient(app, base_url="http://127.0.0.1")
    body = client.get("/api/run/ingest/state", headers={"x-pesto-token": token}).json()

    states = {a["name"]: a["state"] for a in body["artifacts"]}
    assert states["obs_cell"] == "ok"


def test_grid_sites_fixture_gives_the_three_sites():
    assert [s.site for s in GRID_SITES] == [_SITE_A, _SITE_B, _SITE_C]
