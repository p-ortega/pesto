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


# ---------------------------------------------------------------------------
# /obs/1to1 and /obs/points
# ---------------------------------------------------------------------------


def _stored_1to1(client):
    loaded = obs1to1.load_obs_1to1(_layout(client))
    assert not isinstance(loaded, obs1to1.ReadFailure)
    return loaded


def _agg_rows(client, iteration: int) -> dict[str, np.ndarray]:
    agg = load_obs_agg(iteration, _layout(client))
    return {name: np.asarray(agg.values[i], dtype=np.float64) for i, name in enumerate(OBS_STATS)}


def test_1to1_densifies_the_stored_rows_into_one_grid_per_end(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    frame, meta = _stored_1to1(client)
    entry = next(g for g in meta["groups"] if g["group"] == "gw_head")

    response = client.get("/api/run/obs/1to1", params={"group": "gw_head"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["n_bins"] == 180
    assert (body["lo"], body["hi"]) == (entry["lo"], entry["hi"])
    assert [g["iteration"] for g in body["grids"]] == [0, 1]
    for grid, stored in zip(body["grids"], entry["iterations"]):
        counts = np.asarray(grid["counts"]).reshape(180, 180)
        rows = frame[(frame["group"] == "gw_head") & (frame["iteration"] == grid["iteration"])]
        expected = np.zeros((180, 180), dtype=np.int64)
        for ix, iy, count in zip(rows["ix"], rows["iy"], rows["count"]):
            expected[int(iy), int(ix)] = int(count)
        assert (counts == expected).all()
        assert counts.sum() == rows["count"].sum() > 0
        assert grid["n_points"] == stored["n_points"]
        assert grid["n_outside"] == stored["n_outside"]
    assert body["x_label"] == "observed (obsval)"
    assert body["y_label"] == "simulated"
    assert body["ranking_rule"] == obs1to1.RANKING_RULE
    assert body["rmse_rule"] == obs1to1.RMSE_RULE
    assert body["refused"] is None


def test_1to1_outlying_sites_carry_the_aggregate_rows_for_both_ends(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    _frame, meta = _stored_1to1(client)
    entry = next(g for g in meta["groups"] if g["group"] == "gw_head")
    index = load_obs_index(_layout(client))
    aggs = {0: _agg_rows(client, 0), 1: _agg_rows(client, 1)}

    body = client.get("/api/run/obs/1to1", params={"group": "gw_head"}).json()

    assert [s["site_id"] for s in body["outlying"]] == entry["outlying"]
    assert entry["outlying"]
    for served in body["outlying"]:
        row = index.sites.loc[index.sites["site_id"] == served["site_id"]].iloc[0]
        window = slice(int(row["start"]), int(row["start"]) + int(row["count"]))
        assert served["site"] == row["site"]
        assert [s["iteration"] for s in served["series"]] == [0, 1]
        for series in served["series"]:
            agg = aggs[series["iteration"]]
            assert series["mean"] == list(agg["mean"][window])
            assert series["q05"] == list(agg["q05"][window])
            assert series["q95"] == list(agg["q95"][window])
            assert series["obsval"] == list(index.value[window])
            assert series["weighted"] == [bool(f & FLAG_WEIGHTED) for f in index.flags[window]]
        expected, _used = obs1to1.rms_of_mean_residual(aggs[1]["resid_mean"][window])
        assert served["rmse_last"] == expected


def test_1to1_for_a_group_with_no_target_is_refused_with_the_stored_reason(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    _frame, meta = _stored_1to1(client)
    entry = next(g for g in meta["groups"] if g["group"] == "gw_none")

    body = client.get("/api/run/obs/1to1", params={"group": "gw_none"}).json()

    assert body["refused"] == entry["refused"]
    assert "no observation in this group has a measured value" in body["refused"]
    assert body["grids"] == []
    assert body["lo"] is None and body["hi"] is None
    assert body["left_out"] == {"no_value": 0, "sentinel": 1}
    assert body["outlying"] == []


def test_1to1_for_an_unknown_group_is_a_404_naming_obs_1to1(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    response = client.get("/api/run/obs/1to1", params={"group": "nope"})

    assert response.status_code == 404
    assert response.json()["artifact"] == "obs_1to1"


def test_1to1_built_from_a_different_observation_table_is_a_409_naming_obs_1to1(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    assert client.get("/api/run/obs/1to1", params={"group": "gw_head"}).status_code == 200
    sidecar = _layout(client).obs_1to1_meta
    stored = json.loads(sidecar.read_text())
    stored["order_digest"] = "0" * 64
    sidecar.write_text(json.dumps(stored))

    response = client.get("/api/run/obs/1to1", params={"group": "gw_head"})

    assert response.status_code == 409
    body = response.json()
    assert body["artifact"] == "obs_1to1"
    assert "the 1:1 grid was built from a different observation table; run the ingest again" in body["detail"]


def test_1to1_with_no_obs_1to1_cached_is_a_404_naming_it(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    _layout(client).obs_1to1_meta.unlink()

    response = client.get("/api/run/obs/1to1", params={"group": "gw_head"})

    assert response.status_code == 404
    assert response.json()["artifact"] == "obs_1to1"


def test_1to1_whose_outlying_site_is_not_in_the_index_is_a_409_and_never_the_last_site(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    sidecar = _layout(client).obs_1to1_meta
    stored = json.loads(sidecar.read_text())
    next(g for g in stored["groups"] if g["group"] == "gw_head")["outlying"] = [987654]
    sidecar.write_text(json.dumps(stored))

    response = client.get("/api/run/obs/1to1", params={"group": "gw_head"})

    assert response.status_code == 409
    body = response.json()
    assert body["artifact"] == "obs_1to1"
    assert "no site with id 987654" in body["detail"]


def test_1to1_left_over_from_an_older_ingest_is_not_served_when_the_last_one_failed(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    assert client.get("/api/run/obs/1to1", params={"group": "gw_head"}).status_code == 200
    layout = _layout(client)
    manifest = Manifest.load(layout)
    manifest.mark_failed("obs_1to1", "obs_1to1 depends on obs_ens/1, which failed: the file is unreadable")
    manifest.save(layout)
    assert layout.obs_1to1.exists() and layout.obs_1to1_meta.exists()

    response = client.get("/api/run/obs/1to1", params={"group": "gw_head"})

    assert response.status_code == 404
    body = response.json()
    assert body["artifact"] == "obs_1to1"
    assert "which failed: the file is unreadable" in body["detail"]


def test_1to1_with_no_record_of_it_in_the_manifest_says_none_was_ingested(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    layout = _layout(client)
    manifest = Manifest.load(layout)
    del manifest.artifacts["obs_1to1"]
    manifest.save(layout)

    response = client.get("/api/run/obs/1to1", params={"group": "gw_head"})

    assert response.status_code == 404
    assert response.json()["detail"] == "no 1:1 grid was ingested for this run"


def test_1to1_with_one_iteration_has_one_grid_and_says_so(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0,), n_real=4)

    body = client.get("/api/run/obs/1to1", params={"group": "gw_head"}).json()

    assert [g["iteration"] for g in body["grids"]] == [0]
    assert [s["iteration"] for s in body["outlying"][0]["series"]] == [0]
    assert any("only iteration 0" in n for n in body["notes"])


MIXED_SITES = (
    *DEFAULT_SITES,
    SiteSpec("gw_mix", "oname:mix:a", (None,), "none", obsval=2.0),
    SiteSpec("gw_mix", "oname:mix:b", (None,), "none", obsval=1e30),
)


def _mixed(tmp_path):
    return open_obs_run(tmp_path, iterations=(0, 1), n_real=4, sites=MIXED_SITES)


def test_points_for_chosen_sites_match_the_aggregate_rows(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    site = site_id(_root(client), HEAD_SITE)
    index = load_obs_index(_layout(client))
    row = index.sites.loc[index.sites["site_id"] == site].iloc[0]
    window = slice(int(row["start"]), int(row["start"]) + int(row["count"]))

    body = client.get("/api/run/obs/points", params={"group": "gw_head", "sites": str(site)}).json()

    assert body["not_in_group"] == [] and body["unknown"] == []
    assert [s["site_id"] for s in body["sites"]] == [site]
    series = body["sites"][0]["series"]
    assert [s["iteration"] for s in series] == [0, 1]
    assert series[1]["mean"] == list(_agg_rows(client, 1)["mean"][window])
    assert series[1]["obsval"] == [1.5, 1.5, 1.5]


def test_points_lists_ids_that_are_not_in_the_group_or_unknown(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    head = site_id(_root(client), HEAD_SITE)
    other = site_id(_root(client), "oname:hds_otype:lst_usecol:trgw-0-2")

    body = client.get(
        "/api/run/obs/points", params={"group": "gw_head", "sites": f"{head},{other},999999"}
    ).json()

    assert [s["site_id"] for s in body["sites"]] == [head]
    assert body["not_in_group"] == [other]
    assert body["unknown"] == [999999]


def test_points_for_a_site_with_no_target_has_empty_series_and_no_rmse(tmp_path, in_process):  # noqa: F811
    client, _run = _mixed(tmp_path)
    no_target = site_id(_root(client), "oname:mix:b")
    with_target = site_id(_root(client), "oname:mix:a")

    body = client.get(
        "/api/run/obs/points", params={"group": "gw_mix", "sites": f"{no_target},{with_target}"}
    ).json()

    bare, full = body["sites"]
    assert bare["rmse_last"] is None
    assert all(s["obsval"] == [] and s["mean"] == [] and s["weighted"] == [] for s in bare["series"])
    assert full["rmse_last"] is not None
    assert all(len(s["obsval"]) == 1 for s in full["series"])


def test_the_1to1_outlying_list_leaves_out_a_site_with_no_residual(tmp_path, in_process):  # noqa: F811
    client, _run = _mixed(tmp_path)
    no_target = site_id(_root(client), "oname:mix:b")
    with_target = site_id(_root(client), "oname:mix:a")

    body = client.get("/api/run/obs/1to1", params={"group": "gw_mix"}).json()

    assert [s["site_id"] for s in body["outlying"]] == [with_target]
    assert no_target not in [s["site_id"] for s in body["outlying"]]
    assert body["left_out"]["sentinel"] == 1


def test_points_refuses_more_than_twenty_ids_and_ids_that_are_not_numbers(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    twenty = client.get("/api/run/obs/points", params={"group": "gw_head", "sites": ",".join(["1"] * 20)})
    over = client.get("/api/run/obs/points", params={"group": "gw_head", "sites": ",".join(["1"] * 21)})
    words = client.get("/api/run/obs/points", params={"group": "gw_head", "sites": "a,b"})
    blank = client.get("/api/run/obs/points", params={"group": "gw_head", "sites": "1,,2"})

    assert twenty.status_code == 200
    assert over.status_code == 422
    assert words.status_code == 422
    assert blank.status_code == 422


def test_points_for_an_unknown_group_is_a_404(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    response = client.get("/api/run/obs/points", params={"group": "nope", "sites": "1"})

    assert response.status_code == 404
    assert response.json()["artifact"] == "obs_index"


def test_1to1_and_points_with_no_run_open_are_409():
    from fastapi.testclient import TestClient

    from pesto.api.app import create_app

    app, token = create_app()
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers["x-pesto-token"] = token

    assert client.get("/api/run/obs/1to1", params={"group": "g"}).status_code == 409
    assert client.get("/api/run/obs/points", params={"group": "g", "sites": "1"}).status_code == 409


# ---------------------------------------------------------------------------
# /obs/resid_hist
# ---------------------------------------------------------------------------

REAL_NAMES = ("base", "34", "35", "176")
INEQUALITY_NOTE = (
    "this is an inequality group; the residual shown is plain simulated minus observed, "
    "not one-sided"
)


def _hist(client, group: str):
    return client.get("/api/run/obs/resid_hist", params={"group": group})


def _target_resid(client, iteration: int, group: str) -> np.ndarray:
    """The cached ensemble-mean residual of the group's observations that have a target."""
    index = load_obs_index(_layout(client))
    start, stop = _group_rows(index, group)
    target = (index.flags[start:stop] & FLAG_HAS_TARGET) != 0
    return _agg_rows(client, iteration)["resid_mean"][start:stop][target]


def test_resid_hist_bins_each_ends_residuals_on_shared_edges(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    response = _hist(client, "gw_head")

    assert response.status_code == 200, response.text
    body = response.json()
    expected = shared_edge_histogram(
        _target_resid(client, 0, "gw_head"), _target_resid(client, 1, "gw_head"), subject="group"
    )
    assert len(body["edges"]) == 51
    assert body["edges"] == sorted(body["edges"])
    assert body["edges"] == [float(v) for v in expected.edges]
    assert (body["first"]["iteration"], body["last"]["iteration"]) == (0, 1)
    assert body["first"]["counts"] == [int(v) for v in expected.first.counts]
    assert body["last"]["counts"] == [int(v) for v in expected.last.counts]
    assert body["first"]["n"] == body["last"]["n"] == 3
    widths = np.diff(body["edges"])
    for series in (body["first"], body["last"]):
        assert abs(float(np.sum(np.asarray(series["density"]) * widths)) - 1.0) < 1e-9
    assert body["refused"] is None
    assert body["n_outside"] == {"first": 0, "last": 0}


def test_the_smallest_residual_is_in_the_first_bin_and_the_largest_in_the_last(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    body = _hist(client, "gw_head").json()

    pooled = np.concatenate(
        [np.asarray(body["first"]["counts"]), np.asarray(body["last"]["counts"])]
    ).reshape(2, 50).sum(axis=0)
    assert pooled[0] >= 1
    assert pooled[-1] >= 1
    assert pooled.sum() == 6


def test_the_residual_is_named_simulated_minus_observed(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    body = _hist(client, "gw_head").json()

    assert body["residual"] == RESIDUAL_TEXT == "simulated minus observed"
    assert body["inequality"] == "none"
    assert body["inequality_note"] is None


def test_an_inequality_group_says_its_residual_is_not_one_sided(tmp_path, in_process):  # noqa: F811
    sites = (*DEFAULT_SITES, SiteSpec("greater_head", "oname:gt:a", (None,), "none", obsval=3.0),
             SiteSpec("less_head", "oname:lt:a", (None,), "none", obsval=3.0))
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, sites=sites)

    greater = _hist(client, "greater_head").json()
    lesser = _hist(client, "less_head").json()
    plain = _hist(client, "gw_head").json()

    assert greater["inequality"] == "greater"
    assert lesser["inequality"] == "less"
    assert greater["inequality_note"] == INEQUALITY_NOTE
    assert lesser["inequality_note"] == INEQUALITY_NOTE
    assert plain["inequality_note"] is None
    # The bins are the plain simulated minus observed, so some residuals are on each side of zero.
    expected = shared_edge_histogram(
        _target_resid(client, 0, "greater_head"), _target_resid(client, 1, "greater_head")
    )
    assert greater["first"]["counts"] == [int(v) for v in expected.first.counts]


def test_zero_weight_observations_with_a_target_are_binned_and_counted(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    body = _hist(client, "gw_date").json()

    assert body["n_zero_weight"] == 3
    assert body["first"]["n"] == 3 and body["last"]["n"] == 3
    assert any("3 zero-weight" in n for n in body["notes"])


def test_an_observation_with_no_valid_realization_is_counted_and_not_binned(tmp_path, in_process):  # noqa: F811
    hit = f"{HEAD_SITE}_time:9.0"
    client, _run = open_obs_run(
        tmp_path, iterations=(0, 1), n_real=4, nan_values={1: [(hit, name) for name in REAL_NAMES]}
    )

    body = _hist(client, "gw_head").json()

    assert body["left_out"]["no_valid_realization"] == {"first": 0, "last": 1}
    assert body["first"]["n"] == 3
    assert body["last"]["n"] == 2
    assert any("no valid realization" in n for n in body["notes"])


def test_a_group_with_no_measured_value_is_refused_with_the_counts_left_out(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    body = _hist(client, "gw_none").json()

    assert "no observation in this group has a residual" in body["refused"]
    assert "1 sentinel" in body["refused"]
    assert body["left_out"]["sentinel"] == 1
    assert body["left_out"]["no_value"] == 0
    assert body["edges"] == []
    assert body["first"] is None and body["last"] is None


def test_a_group_whose_residuals_are_all_missing_says_how_many_had_no_valid_realization(
    tmp_path, in_process  # noqa: F811
):
    names = [f"{HEAD_SITE}_time:{t}" for t in ("1.0", "9.0", "10.0")]
    nan_all = [(name, real) for name in names for real in REAL_NAMES]
    client, _run = open_obs_run(
        tmp_path, iterations=(0, 1), n_real=4, nan_values={0: nan_all, 1: nan_all}
    )

    body = _hist(client, "gw_head").json()

    assert "no observation in this group has a residual" in body["refused"]
    assert "3 with no valid realization" in body["refused"]
    assert body["left_out"]["no_valid_realization"] == {"first": 3, "last": 3}


def test_identical_residuals_are_refused_with_the_shared_sentence(tmp_path, in_process):  # noqa: F811
    sites = (SiteSpec("gw_one", "oname:one:a", (None,), "none", obsval=3.0),)
    client, _run = open_obs_run(tmp_path, iterations=(0,), n_real=4, sites=sites)

    body = _hist(client, "gw_one").json()

    assert body["refused"] == identical_values_reason("group")
    assert body["edges"] == []


def test_with_one_iteration_only_the_first_series_is_given_and_a_note_says_so(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0,), n_real=4)

    body = _hist(client, "gw_head").json()

    assert body["first"]["iteration"] == 0
    assert body["last"] is None
    assert any("only iteration 0" in n for n in body["notes"])
    assert body["left_out"]["no_valid_realization"] == {"first": 0, "last": 0}


def test_the_first_series_is_the_first_observation_iteration_not_one_from_the_request(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(2, 5), n_real=4)

    body = client.get("/api/run/obs/resid_hist", params={"group": "gw_head"}).json()

    assert (body["first"]["iteration"], body["last"]["iteration"]) == (2, 5)
    rejected = client.get("/api/run/obs/resid_hist", params={"group": "gw_head", "iteration": 5})
    assert rejected.status_code == 422


def test_an_unknown_group_is_a_404_and_no_run_open_is_409(tmp_path, in_process):  # noqa: F811
    from fastapi.testclient import TestClient

    from pesto.api.app import create_app

    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    missing = _hist(client, "nope")
    assert missing.status_code == 404
    assert missing.json()["artifact"] == "obs_index"

    app, token = create_app()
    closed = TestClient(app, base_url="http://127.0.0.1")
    closed.headers["x-pesto-token"] = token
    assert closed.get("/api/run/obs/resid_hist", params={"group": "g"}).status_code == 409


def test_the_histogram_is_computed_once_per_group_and_again_after_a_re_ingest(  # noqa: F811
    tmp_path, in_process, monkeypatch
):
    client, run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    calls: list = []
    real = obs_routes.shared_edge_histogram

    def counted(*args, **kwargs):
        calls.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(obs_routes, "shared_edge_histogram", counted)

    first = _hist(client, "gw_head").json()
    again = _hist(client, "gw_head").json()
    assert first == again
    assert len(calls) == 1

    _hist(client, "gw_date")
    assert len(calls) == 2

    make_obs_run(run.root, iterations=(0, 1), n_real=3)
    ingest_run(run.root, cache_root=Path(_root(client)))
    after = _hist(client, "gw_head").json()

    assert len(calls) == 3
    assert after["first"]["counts"] != first["first"]["counts"] or after["edges"] != first["edges"]
