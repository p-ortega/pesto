"""The observation view's fit routes: the group table, the 1:1 grid with its points and
the residual histogram, read back through a real app from a generated, ingested run."""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np

import pesto.api.obs as obs_routes
import pesto.ingest.obs1to1 as obs1to1
from ingest.obs_fixtures import DEFAULT_SITES, SiteSpec, make_obs_run
from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.obsagg import OBS_STATS, RESIDUAL_TEXT, load_obs_agg
from pesto.ingest.obsindex import FLAG_HAS_TARGET, FLAG_WEIGHTED, load_obs_index
from pesto.ingest.parhist import identical_values_reason, shared_edge_histogram
from pesto.ingest.runner import ingest_run

from .obs_helpers import HEAD_SITE, open_obs_run, site_id

RESID = OBS_STATS.index("resid_mean")


def _root(client) -> str:
    return client.pesto_app.state.cache_root


def _layout(client) -> CacheLayout:
    return CacheLayout(root=Path(_root(client)))


def _arrow(response):
    import pyarrow as pa

    assert response.status_code == 200, response.text
    return pa.ipc.open_stream(io.BytesIO(response.content)).read_all()


def _notes(response) -> list[str]:
    return json.loads(response.headers.get("x-pesto-notes", "[]"))


def _group_rows(index, group: str) -> tuple[int, int]:
    """The stored rows of a group, found by its name."""
    start = 0
    for name, n_obs in zip(index.groups["group"], index.groups["n_obs"]):
        if name == group:
            return start, start + int(n_obs)
        start += int(n_obs)
    raise AssertionError(group)


# ---------------------------------------------------------------------------
# the tracer: /obs/groups
# ---------------------------------------------------------------------------


def test_groups_has_one_row_per_group_in_obs_index_order(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    index = load_obs_index(_layout(client))

    table = _arrow(client.get("/api/run/obs/groups")).to_pandas()

    assert list(table["group"]) == list(index.groups["group"])
    for column in ("n_obs", "n_sites", "n_weighted", "n_sentinel", "n_no_value", "time_kind", "inequality"):
        assert list(table[column]) == list(index.groups[column]), column


def test_groups_rmse_is_the_rms_of_the_ensemble_mean_residual_at_each_end(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    layout = _layout(client)
    index = load_obs_index(layout)
    table = _arrow(client.get("/api/run/obs/groups")).to_pandas().set_index("group")

    for iteration, rmse_column, n_column in ((0, "rmse_first", "n_resid_first"), (1, "rmse_last", "n_resid_last")):
        resid = np.asarray(load_obs_agg(iteration, layout).values[RESID], dtype=np.float64)
        start, stop = _group_rows(index, "gw_head")
        expected, used = obs1to1.rms_of_mean_residual(resid[start:stop])
        assert used == 3
        assert table.loc["gw_head", rmse_column] == expected
        assert table.loc["gw_head", n_column] == used
    assert table.loc["gw_head", "first_iteration"] == 0
    assert table.loc["gw_head", "last_iteration"] == 1


def test_a_group_with_no_target_has_no_rmse_and_no_residual_count(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    table = _arrow(client.get("/api/run/obs/groups")).to_pandas().set_index("group")

    none = table.loc["gw_none"]
    assert np.isnan(none["rmse_first"]) and np.isnan(none["rmse_last"])
    assert none["n_resid_first"] == 0 and none["n_resid_last"] == 0
    assert none["n_sentinel"] == 1
    assert none["n_with_target"] == 0


def test_a_zero_weight_group_counts_its_zero_weights(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    table = _arrow(client.get("/api/run/obs/groups")).to_pandas().set_index("group")

    assert table.loc["gw_date", "n_zero_weight"] == 3
    assert table.loc["gw_date", "n_weighted"] == 0
    assert table.loc["gw_date", "n_with_target"] == 3
    assert table.loc["gw_head", "n_zero_weight"] == 0


def test_n_placed_counts_sites_whose_cell_is_not_minus_one(tmp_path, in_process):  # noqa: F811
    from pesto.ingest.obscell import load_obs_cell

    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, grid=True)
    cells = load_obs_cell(_layout(client))
    response = client.get("/api/run/obs/groups")
    table = _arrow(response).to_pandas().set_index("group")

    for group in set(g for g in cells.group if g is not None):
        expected = sum(1 for g, c in zip(cells.group, cells.cell) if g == group and int(c) != -1)
        assert table.loc[group, "n_placed"] == expected


def test_n_placed_is_null_and_the_notes_name_obs_cell_when_it_is_unavailable(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    layout = _layout(client)
    manifest = Manifest.load(layout)
    manifest.mark_failed("obs_cell", "the grid file could not be read")
    manifest.save(layout)

    response = client.get("/api/run/obs/groups")

    table = _arrow(response).to_pandas()
    assert table["n_placed"].isna().all()
    assert any("obs_cell" in n and "the grid file could not be read" in n for n in _notes(response))
    assert any(obs1to1.RMSE_RULE == n for n in _notes(response))


def test_with_one_iteration_the_last_end_is_null_and_a_note_says_so(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0,), n_real=4)

    response = client.get("/api/run/obs/groups")

    table = _arrow(response).to_pandas().set_index("group")
    assert table.loc["gw_head", "first_iteration"] == 0
    assert table["last_iteration"].isna().all()
    assert table["rmse_last"].isna().all()
    assert table.loc["gw_head", "rmse_first"] > 0
    assert any("only iteration 0 has observation statistics" in n for n in _notes(response))


def test_a_failed_statistics_end_leaves_its_columns_null_and_says_why(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    layout = _layout(client)
    layout.obs_agg_meta(1).write_text("not json")

    response = client.get("/api/run/obs/groups")

    table = _arrow(response).to_pandas()
    assert table["rmse_last"].isna().all()
    assert table["rmse_first"].notna().any()
    assert any("iteration 1" in n and "obs_agg/1" in n for n in _notes(response))


def test_groups_with_no_run_open_is_409():
    from fastapi.testclient import TestClient

    from pesto.api.app import create_app

    app, token = create_app()
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers["x-pesto-token"] = token

    assert client.get("/api/run/obs/groups").status_code == 409


def test_groups_for_a_run_with_no_observation_ensemble_is_a_404_naming_it(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(), par_iterations=(0,), n_real=4)

    response = client.get("/api/run/obs/groups")

    assert response.status_code == 404


def test_a_site_in_no_cell_is_not_counted_as_placed(tmp_path, in_process, monkeypatch):  # noqa: F811
    import dataclasses

    from pesto.api import obscache

    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, grid=True)
    real = obscache.get_cell(client.pesto_app.state, _root(client))
    unplaced = np.asarray(real.cell).copy()
    unplaced[list(real.site).index("oname:hds_otype:lst_usecol:icpl-a")] = -1
    monkeypatch.setattr(
        obscache, "get_cell", lambda state, root: dataclasses.replace(real, cell=unplaced)
    )

    table = _arrow(client.get("/api/run/obs/groups")).to_pandas().set_index("group")

    assert table.loc["gw_icpl", "n_placed"] == 1
    assert table.loc["gw_icpl", "n_sites"] == 2
    assert table.loc["gw_xy", "n_placed"] == 1
