"""The map routes: a group's dots, its time axis with fixed colour limits, and one frame of
values at an exact time, read back through a real app from a cache made by ingesting a
generated run (real adapter, real vertex grid)."""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest

import pesto.ingest.runner as runner
from ingest.obs_fixtures import DEFAULT_SITES, GRID_SITES, SiteSpec
from pesto.api import obsmap
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.mesh import load_mesh, load_mesh_origin
from pesto.ingest.obsagg import load_obs_agg
from pesto.ingest.obscell import load_obs_cell
from pesto.ingest.obsindex import load_obs_index

from .obs_helpers import open_obs_run, series_meta

GRID_RUN = {"grid": True, "sites": DEFAULT_SITES + GRID_SITES, "iterations": (0, 1), "n_real": 4}
HEAD = "oname:hds_otype:lst_usecol:trgw-0-1"


@pytest.fixture
def in_process(monkeypatch):
    """Run every worker in this process, with the real adapter."""

    def _call(fn, *args):
        try:
            return True, fn(*args)
        except Exception as exc:
            return False, exc

    monkeypatch.setattr(runner, "_run_isolated", _call)


def _root(client) -> str:
    return client.pesto_app.state.cache_root


def _layout(client) -> CacheLayout:
    return CacheLayout(root=Path(_root(client)))


def _sites(client, group: str):
    """The /obs/sites answer as a pandas frame and its notes."""
    import pyarrow as pa

    response = client.get("/api/run/obs/sites", params={"group": group})
    assert response.status_code == 200, response.text
    frame = pa.ipc.open_stream(io.BytesIO(response.content)).read_all().to_pandas()
    return frame, json.loads(response.headers.get("x-pesto-notes", "[]")), response


def _times(client, group: str) -> dict:
    response = client.get("/api/run/obs/times", params={"group": group})
    assert response.status_code == 200, response.text
    return response.json()


def _frame(client, group: str, iteration: int, time: float, stat: str):
    return client.get(
        "/api/run/obs/frame",
        params={"group": group, "iteration": iteration, "time": time, "stat": stat},
    )


def _values(response) -> np.ndarray:
    assert response.status_code == 200, response.text
    return np.frombuffer(response.content, dtype="<f4")


# ---------------------------------------------------------------------------
# the tracer: one group from /obs/sites to /obs/times to one exact-time frame
# ---------------------------------------------------------------------------


def test_sites_come_in_index_order_with_the_placement_the_cache_holds(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)
    table = load_obs_cell(_layout(client))
    at = {name: i for i, name in enumerate(table.site)}

    frame, _notes, _response = _sites(client, "gw_icpl")

    assert list(frame["site"]) == [
        "oname:hds_otype:lst_usecol:icpl-a",
        "oname:hds_otype:lst_usecol:icpl-b",
    ]
    for _, row in frame.iterrows():
        i = at[row["site"]]
        assert int(row["site_id"]) == int(table.site_id[i])
        assert int(row["layer"]) == int(table.layer[i])
        assert int(row["cell"]) == int(table.cell[i])
        assert row["rule"] == table.rule[i]
        assert int(row["n_obs"]) == 1
    assert str(frame["x"].dtype) == "float32" and str(frame["layer"].dtype) == "int32"


def test_times_of_a_numeric_group_are_its_exact_times_in_order(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)

    body = _times(client, "gw_head")

    assert body["times"] == [1.0, 9.0, 10.0]
    assert body["time_kind"] == "numeric"
    assert body["steps_by"] == "time"
    assert body["n_at_time"] == [1, 1, 1]
    assert body["n_sites"] == 1
    assert body["refused"] is None


def test_a_frame_holds_the_statistic_of_each_site_at_that_exact_time(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    layout = _layout(client)
    j = run.obs_names.index(f"{HEAD}_time:9.0")
    expected = float(np.mean(run.values[1][:, j].astype(np.float64) - 1.5))

    response = _frame(client, "gw_head", 1, 9.0, "resid_mean")

    values = _values(response)
    assert values.shape == (1,)
    assert values[0] == pytest.approx(expected, abs=1e-5)
    index = load_obs_index(layout)
    row = index.sites.loc[index.sites["site"] == HEAD].iloc[0]
    agg = load_obs_agg(1, layout)
    at = int(row["start"]) + int(np.flatnonzero(index.time[int(row["start"]) : int(row["start"]) + 3] == 9.0)[0])
    assert values[0] == agg.values[agg.stats.index("resid_mean"), at]
    meta = series_meta(response)
    assert meta["shape"] == [1]
    assert meta["n_sites"] == 1 and meta["n_at_time"] == 1 and meta["n_finite"] == 1
    assert meta["group"] == "gw_head" and meta["iteration"] == 1 and meta["time"] == 9.0
    assert meta["stat"] == "resid_mean"
    assert response.headers["cache-control"] == "no-store"


def test_a_time_between_two_observation_times_is_a_404_and_never_the_nearest(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)

    for time in (9.5, 9.0000001, 0.0, 11.0):
        response = _frame(client, "gw_head", 1, time, "resid_mean")
        assert response.status_code == 404, time
        body = response.json()
        assert body["artifact"] == "obs_index"
        assert "never uses the nearest time" in body["detail"]


def test_a_statistic_that_is_not_listed_or_a_time_that_is_not_a_number_is_a_422(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)

    assert _frame(client, "gw_head", 1, 9.0, "value").status_code == 422
    for bad in ("nan", "inf", "-inf", "abc"):
        response = client.get(
            "/api/run/obs/frame",
            params={"group": "gw_head", "iteration": 1, "time": bad, "stat": "resid_mean"},
        )
        assert response.status_code == 422, bad
    extra = client.get("/api/run/obs/times", params={"group": "gw_head", "other": 1})
    assert extra.status_code == 422


def test_an_unknown_group_is_a_404_naming_obs_index_and_no_run_open_is_a_409(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)

    for route in ("sites", "times"):
        response = client.get(f"/api/run/obs/{route}", params={"group": "nope"})
        assert response.status_code == 404
        assert response.json()["artifact"] == "obs_index"
    assert _frame(client, "nope", 1, 9.0, "mean").status_code == 404

    client.pesto_app.state.cache_root = None
    assert client.get("/api/run/obs/times", params={"group": "gw_head"}).status_code == 409


# ---------------------------------------------------------------------------
# dot positions
# ---------------------------------------------------------------------------

SHARED_SITES = (
    SiteSpec("g_cell", "oname:hds_otype:lst_usecol:cell-p", (None,), "none", extras={"icpl": "1", "layer": "0"}),
    SiteSpec("g_cell", "oname:hds_otype:lst_usecol:cell-q", (None,), "none", extras={"icpl": "1", "layer": "0"}),
    SiteSpec("g_pt", "oname:hds_otype:lst_usecol:pt-p", (None,), "none", extras={"x": "1.5", "y": "0.6"}),
    SiteSpec("g_pt", "oname:hds_otype:lst_usecol:pt-q", (None,), "none", extras={"x": "1.5", "y": "0.6"}),
)


def _centre_of_cell(client, cell: int) -> tuple[float, float]:
    mesh = load_mesh(_layout(client))
    mine = np.asarray(mesh.cell_index) == cell
    return tuple(float(np.mean(mesh.positions[mine, k].astype(np.float64))) for k in (0, 1))


def test_a_site_with_its_own_coordinates_sits_at_them_relative_to_the_mesh_origin(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)
    ox, oy = load_mesh_origin(_layout(client))

    frame, _notes, _ = _sites(client, "gw_xy")

    row = frame.iloc[0]
    assert row["xy_source"] == "own"
    # The grid file's offset (1000, 2000) moves the control file's (1.5, 0.6).
    assert row["x"] == np.float32(1001.5 - ox)
    assert row["y"] == np.float32(2000.6 - oy)
    assert int(row["cell"]) == 1


def test_a_site_without_coordinates_sits_at_the_mean_of_its_cells_vertices(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)

    frame, _notes, _ = _sites(client, "gw_icpl")

    assert set(frame["xy_source"]) == {"cell_centre"}
    for _, row in frame.iterrows():
        cx, cy = _centre_of_cell(client, int(row["cell"]))
        assert row["x"] == pytest.approx(cx, abs=1e-6)
        assert row["y"] == pytest.approx(cy, abs=1e-6)
    a, b = frame.iloc[0], frame.iloc[1]
    assert (a["x"], a["y"]) != (b["x"], b["y"])


def test_a_site_with_an_unknown_layer_is_still_returned_with_layer_minus_one(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)

    frame, _notes, _ = _sites(client, "gw_icpl")

    blank = frame[frame["site"].str.endswith("icpl-b")].iloc[0]
    assert int(blank["layer"]) == -1
    assert int(blank["cell"]) == 2
    assert blank["xy_source"] == "cell_centre"
    assert "layer unknown" in blank["note"]


def test_an_unplaced_site_is_never_drawn_and_keeps_its_note(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)

    frame, notes, _ = _sites(client, "gw_head")

    row = frame.iloc[0]
    assert row["xy_source"] == "none"
    assert np.isnan(row["x"]) and np.isnan(row["y"])
    assert int(row["cell"]) == -1 and int(row["layer"]) == -1
    assert "no placement column rule" in row["note"]
    assert any("1 not placed" in n for n in notes)


def test_the_notes_say_what_a_cell_centre_is_and_carry_this_groups_placement_notes(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)

    _frame_icpl, notes, _ = _sites(client, "gw_icpl")
    _frame_xy, xy_notes, _ = _sites(client, "gw_xy")

    assert "a cell centre is the centre of the cell's vertices" in notes
    assert any("2 at the centre of their cell's vertices" in n for n in notes)
    assert any(n.startswith("layer unknown") for n in notes)
    assert not any(n.startswith("group 'gw_xy'") for n in notes)
    assert any(n.startswith("group 'gw_xy'") for n in xy_notes)


def test_a_run_without_a_readable_grid_returns_every_site_unplaced_with_the_reason(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, iterations=(0, 1))

    frame, notes, _ = _sites(client, "gw_head")

    assert list(frame["xy_source"]) == ["none"]
    assert np.isnan(frame["x"]).all()
    assert "failed to parse grid file" in frame.iloc[0]["note"]
    assert any(n.startswith("obs_cell:") and "failed to parse grid file" in n for n in notes)


def test_a_run_that_never_recorded_a_placement_says_so(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)
    manifest = Manifest.load(_layout(client))
    del manifest.artifacts["obs_cell"]
    manifest.save(_layout(client))

    frame, notes, _ = _sites(client, "gw_icpl")

    assert set(frame["xy_source"]) == {"none"}
    assert any(n.startswith("obs_cell: no observation placement was ingested") for n in notes)


def test_an_unreadable_mesh_leaves_placed_sites_without_a_position_and_says_why(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)
    (_layout(client).grid / "positions.f32").unlink()

    frame, notes, _ = _sites(client, "gw_xy")

    row = frame.iloc[0]
    assert row["xy_source"] == "none"
    assert np.isnan(row["x"]) and np.isnan(row["y"])
    assert int(row["cell"]) == 1
    assert "the grid could not be read" in row["note"]
    assert any(n.startswith("grid:") for n in notes)


def test_two_sites_in_one_cell_both_come_back_with_the_same_centre_and_their_own_rows(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, grid=True, sites=SHARED_SITES, iterations=(0,), n_real=4)

    frame, _notes, _ = _sites(client, "g_cell")

    assert len(frame) == 2
    assert frame["site_id"].nunique() == 2
    assert list(frame["site"]) == ["oname:hds_otype:lst_usecol:cell-p", "oname:hds_otype:lst_usecol:cell-q"]
    assert set(frame["xy_source"]) == {"cell_centre"}
    assert frame["x"].nunique() == 1 and frame["y"].nunique() == 1


def test_two_sites_with_the_same_coordinates_are_both_returned_not_merged(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, grid=True, sites=SHARED_SITES, iterations=(0,), n_real=4)

    frame, _notes, _ = _sites(client, "g_pt")

    assert len(frame) == 2
    assert frame["site_id"].nunique() == 2
    assert set(frame["xy_source"]) == {"own"}
    assert frame["x"].nunique() == 1 and frame["y"].nunique() == 1


def test_a_group_over_the_site_limit_is_a_409_naming_obs_index_and_both_counts(tmp_path, in_process, monkeypatch):
    client, _run = open_obs_run(tmp_path, grid=True, sites=SHARED_SITES, iterations=(0,), n_real=4)
    monkeypatch.setattr(obsmap, "MAX_SITES_PER_GROUP", 1)

    for route in ("sites", "times"):
        response = client.get(f"/api/run/obs/{route}", params={"group": "g_cell"})
        assert response.status_code == 409
        body = response.json()
        assert body["artifact"] == "obs_index"
        assert "2 sites" in body["detail"] and "1 the map serves" in body["detail"]
    assert _frame(client, "g_cell", 0, 0.0, "mean").status_code == 409


def test_the_limit_is_one_hundred_thousand_sites():
    assert obsmap.MAX_SITES_PER_GROUP == 100_000
