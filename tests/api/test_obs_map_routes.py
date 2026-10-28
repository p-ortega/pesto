"""The map routes: a group's dots, its time axis with fixed colour limits, and one frame of
values at an exact time, read back through a real app from a cache made by ingesting a
generated run (real adapter, real vertex grid)."""

from __future__ import annotations

import io
import json
from time import perf_counter
from pathlib import Path

import numpy as np
import pytest

import pesto.ingest.obsagg as obsagg
import pesto.ingest.obsindex as obsindex
import pesto.ingest.runner as runner
from ingest.obs_fixtures import DEFAULT_SITES, GRID_SITES, SiteSpec
from pesto.api import obscache, obsmap
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


def _counted(monkeypatch, module, name):
    """Wrap ``module.name`` so every call is recorded; the real function still runs."""
    original = getattr(module, name)
    calls: list = []

    def wrapper(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(module, name, wrapper)
    return calls


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


def test_sites_times_and_frame_each_name_the_observation_table_they_were_cut_from(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **GRID_RUN)
    digest = load_obs_index(_layout(client)).order_digest

    _frame_rows, _notes, sites = _sites(client, "gw_head")
    times = _times(client, "gw_head")
    frame = _frame(client, "gw_head", 1, 9.0, "resid_mean")

    assert json.loads(sites.headers["x-pesto-meta"])["order_digest"] == digest
    assert times["order_digest"] == digest
    assert series_meta(frame)["order_digest"] == digest


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


# ---------------------------------------------------------------------------
# time kinds, colour limits, iterations, frames
# ---------------------------------------------------------------------------

SITE_A = "oname:hds_otype:lst_usecol:two-a"
SITE_B = "oname:hds_otype:lst_usecol:two-b"
TIME_SITES = (
    # Two sites whose time sets only overlap at 2.0; B sits on a different target.
    SiteSpec("g_two", SITE_A, (1.0, 2.0), "time-token", obsval=1.5),
    SiteSpec("g_two", SITE_B, (2.0, 3.0), "time-token", obsval=3.0),
    SiteSpec("g_ord", "oname:hds_otype:lst_usecol:ord-a", (None,), "none"),
    SiteSpec("g_ord", "oname:hds_otype:lst_usecol:ord-b", (None,), "none"),
    SiteSpec("g_ord", "oname:hds_otype:lst_usecol:ord-c", (None,), "none"),
    SiteSpec("g_one", "oname:hds_otype:lst_usecol:one-a", (5.0,), "time-token"),
    SiteSpec("g_mix", "oname:hds_otype:lst_usecol:mix-a", (1.0, 2.0), "time-token"),
    SiteSpec("g_mix", "oname:hds_otype:lst_usecol:mix-b", ("2020-01-01",), "datetime-token"),
    SiteSpec("g_date", "oname:hds_otype:lst_usecol:date-a", ("2020-03-01", "2020-01-15"), "datetime-token"),
    SiteSpec("g_sent", "oname:hds_otype:lst_usecol:sent-a", (1.0, 2.0), "time-token", obsval=1e30),
)
TIME_RUN = {"sites": TIME_SITES, "iterations": (0, 1), "n_real": 4}


def _resid(run, iteration: int, name: str, obsval: float) -> float:
    j = run.obs_names.index(name)
    return float(np.mean(run.values[iteration][:, j].astype(np.float64)) - obsval)


def _site_names(client, group: str) -> list[str]:
    return list(_sites(client, group)[0]["site"])


def test_a_datetime_group_returns_days_since_1970_in_ascending_order(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)

    body = _times(client, "g_date")

    days = [(np.datetime64(d) - np.datetime64("1970-01-01")) / np.timedelta64(1, "D") for d in ("2020-01-15", "2020-03-01")]
    assert body["times"] == [float(d) for d in days]
    assert body["time_kind"] == "datetime"
    assert body["steps_by"] == "time"
    assert _frame(client, "g_date", 1, body["times"][1], "mean").status_code == 200


def test_an_ordinal_group_steps_by_position_and_says_so(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)

    body = _times(client, "g_ord")

    assert body["steps_by"] == "position"
    assert body["times"] == [0.0]
    assert body["n_at_time"] == [3]
    assert "this group has no times, so the slider steps by position in site" in body["notes"]
    assert body["refused"] is None


def test_a_group_with_one_time_returns_one_time(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)

    body = _times(client, "g_one")

    assert body["times"] == [5.0]
    assert body["n_at_time"] == [1]
    assert _values(_frame(client, "g_one", 0, 5.0, "mean")).shape == (1,)


def test_a_group_that_mixes_time_kinds_is_refused_with_a_reason_and_no_times(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)

    body = _times(client, "g_mix")

    assert body["times"] == [] and body["n_at_time"] == []
    assert body["time_kind"] == "mixed"
    assert body["refused"] == (
        "this group mixes time kinds (datetime and numeric), so one time axis would mean two "
        "things; pesto shows no time slider for it"
    )
    assert all(v is None for v in body["limits"].values())
    refused = _frame(client, "g_mix", 1, 1.0, "mean")
    assert refused.status_code == 409
    assert refused.json()["artifact"] == "obs_index"
    assert "mixes time kinds" in refused.json()["detail"]
    assert len(_sites(client, "g_mix")[0]) == 2


def test_the_time_axis_is_the_union_of_exact_times_and_counts_sites_at_each(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)

    body = _times(client, "g_two")

    assert body["times"] == [1.0, 2.0, 3.0]
    assert body["n_at_time"] == [1, 2, 1]
    assert body["n_sites"] == 2


def test_a_site_without_an_observation_at_the_time_gets_nan_and_the_others_their_value(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **TIME_RUN)
    assert _site_names(client, "g_two") == [SITE_A, SITE_B]

    at_one = _frame(client, "g_two", 1, 1.0, "resid_mean")
    at_two = _frame(client, "g_two", 1, 2.0, "resid_mean")

    first = _values(at_one)
    assert first[0] == pytest.approx(_resid(run, 1, f"{SITE_A}_time:1.0", 1.5), abs=1e-5)
    assert np.isnan(first[1])
    assert series_meta(at_one)["n_at_time"] == 1 and series_meta(at_one)["n_finite"] == 1
    both = _values(at_two)
    assert both[0] == pytest.approx(_resid(run, 1, f"{SITE_A}_time:2.0", 1.5), abs=1e-5)
    assert both[1] == pytest.approx(_resid(run, 1, f"{SITE_B}_time:2.0", 3.0), abs=1e-5)
    assert series_meta(at_two)["n_at_time"] == 2 and series_meta(at_two)["n_finite"] == 2


def test_a_time_where_no_site_has_a_value_is_an_all_nan_frame(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)

    response = _frame(client, "g_sent", 1, 1.0, "resid_mean")

    assert np.isnan(_values(response)).all()
    meta = series_meta(response)
    assert meta["n_at_time"] == 1 and meta["n_finite"] == 0
    assert np.isfinite(_values(_frame(client, "g_sent", 1, 1.0, "mean"))).all()


def test_resid_mean_limits_are_symmetric_about_zero_over_every_row_of_both_iterations(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **TIME_RUN)
    wanted = [(SITE_A, 1.0, 1.5), (SITE_A, 2.0, 1.5), (SITE_B, 2.0, 3.0), (SITE_B, 3.0, 3.0)]
    resid = [_resid(run, k, f"{s}_time:{t}", o) for k in (0, 1) for s, t, o in wanted]
    rms = [
        float(np.sqrt(np.mean((run.values[k][:, run.obs_names.index(f"{s}_time:{t}")].astype(np.float64) - o) ** 2)))
        for k in (0, 1)
        for s, t, o in wanted
    ]

    limits = _times(client, "g_two")["limits"]

    m = float(np.percentile(np.abs(resid), 98))
    assert limits["resid_mean"][0] == -limits["resid_mean"][1]
    assert limits["resid_mean"][1] == pytest.approx(m, rel=1e-4)
    lo, hi = np.percentile(rms, [2, 98])
    assert limits["rmse"] == [pytest.approx(lo, rel=1e-4), pytest.approx(hi, rel=1e-4)]
    assert set(limits) == {"resid_mean", "rmse", "std", "mean"}
    assert _times(client, "g_two")["limits_rule"].startswith("2nd to 98th percentile over every time")


def test_limits_do_not_change_with_the_time_asked_for(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)

    before = _times(client, "g_two")["limits"]
    for time in (1.0, 2.0, 3.0):
        assert _frame(client, "g_two", 1, time, "resid_mean").status_code == 200
    assert _times(client, "g_two")["limits"] == before


def test_a_statistic_with_no_finite_value_has_null_limits(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)

    limits = _times(client, "g_sent")["limits"]

    assert limits["resid_mean"] is None and limits["rmse"] is None
    assert limits["mean"] is not None and limits["std"] is not None


def test_iterations_say_which_are_available_and_why_one_is_not(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)
    assert _times(client, "g_two")["iterations"] == [
        {"iteration": 0, "available": True, "reason": None},
        {"iteration": 1, "available": True, "reason": None},
    ]
    manifest = Manifest.load(_layout(client))
    manifest.mark_failed("obs_agg/1", "the statistics could not be written")
    manifest.save(_layout(client))

    body = _times(client, "g_two")

    assert body["iterations"][0] == {"iteration": 0, "available": True, "reason": None}
    assert body["iterations"][1] == {
        "iteration": 1,
        "available": False,
        "reason": "the statistics could not be written",
    }
    assert all(v is not None for v in (body["limits"]["mean"], body["limits"]["rmse"]))
    failed = _frame(client, "g_two", 1, 2.0, "mean")
    assert failed.status_code == 404
    assert failed.json()["artifact"] == "obs_agg/1"
    assert "could not be written" in failed.json()["detail"]
    assert _frame(client, "g_two", 7, 2.0, "mean").json()["artifact"] == "obs_agg/7"
    assert _frame(client, "g_two", 0, 2.0, "mean").status_code == 200


def test_limits_that_cannot_be_made_come_back_with_the_reason(tmp_path, in_process, monkeypatch):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)
    assert _times(client, "g_two")["limits_refused"] is None
    manifest = Manifest.load(_layout(client))
    for name in ("obs_agg/0", "obs_agg/1"):
        manifest.mark_failed(name, "the statistics could not be written")
    manifest.save(_layout(client))

    body = _times(client, "g_two")

    assert all(v is None for v in body["limits"].values())
    assert body["limits_refused"] == obsmap.NO_LIMITS_REASON


def test_a_failed_read_of_the_statistics_for_the_limits_is_named_not_swallowed(tmp_path, in_process, monkeypatch):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)
    assert _frame(client, "g_two", 1, 2.0, "mean").status_code == 200
    state = client.pesto_app.state
    rows = next(v[1] for k, v in state.obs_memo.items() if k[1:] == ("frame_rows", "g_two"))
    state.obs_memo.clear()
    monkeypatch.setattr(
        obscache,
        "get_agg",
        lambda *_a, **_k: obsmap.ReadFailure(name="obs_agg/1", path="", reason="the file is short"),
    )

    limits, why, _n_sentinel = obsmap._limits(state, _root(client), rows, "g_two", [0, 1])

    assert all(v is None for v in limits.values())
    assert why == "the colour limits could not be made: the file is short"


def test_twenty_frames_open_the_index_and_the_statistics_once_each(tmp_path, in_process, monkeypatch):
    many = (SiteSpec("g_many", "oname:hds_otype:lst_usecol:many-a", tuple(float(t) for t in range(1, 21)), "time-token"),)
    client, _run = open_obs_run(tmp_path, sites=many, iterations=(0, 1), n_real=4)
    index_calls = _counted(monkeypatch, obsindex, "load_obs_index")
    agg_calls = _counted(monkeypatch, obsagg, "load_obs_agg")

    for t in range(1, 21):
        assert _frame(client, "g_many", 1, float(t), "rmse").status_code == 200

    assert len(index_calls) == 1
    assert len(agg_calls) == 1


def test_the_same_frame_twice_is_the_same_bytes_and_leaves_the_memo_alone(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **TIME_RUN)
    first = _frame(client, "g_two", 1, 2.0, "std")
    held = {k: id(v[1]) for k, v in client.pesto_app.state.obs_memo.items()}

    second = _frame(client, "g_two", 1, 2.0, "std")

    assert first.content == second.content
    assert first.headers["x-pesto-meta"] == second.headers["x-pesto-meta"]
    assert {k: id(v[1]) for k, v in client.pesto_app.state.obs_memo.items()} == held
    assert _times(client, "g_two") == _times(client, "g_two")


def test_a_warm_frame_is_built_well_under_a_millisecond(tmp_path, in_process):
    many = (SiteSpec("g_many", "oname:hds_otype:lst_usecol:many-a", tuple(float(t) for t in range(1, 21)), "time-token"),)
    client, _run = open_obs_run(tmp_path, sites=many, iterations=(0, 1), n_real=4)
    assert _frame(client, "g_many", 1, 3.0, "rmse").status_code == 200
    state = client.pesto_app.state
    root = _root(client)
    rows = next(v[1] for k, v in state.obs_memo.items() if k[1:] == ("frame_rows", "g_many"))
    agg = obscache.get_agg(state, root, 1)
    stat = agg.values[agg.stats.index("rmse")]

    started = perf_counter()
    for _ in range(200):
        built = obsmap.build_frame(rows, stat, 3.0)
    per_frame = (perf_counter() - started) / 200

    assert built is not None
    assert per_frame < 0.001


# ---------------------------------------------------------------------------
# two observations of one site at one time
# ---------------------------------------------------------------------------

DUP_SITE = "oname:hds_otype:lst_usecol:dup-a"
DUP_RUN = {
    "sites": (SiteSpec("g_dup", DUP_SITE, (1.0, 1.0, 2.0), "time-column"),),
    "iterations": (0, 1),
    "n_real": 4,
}


def test_a_site_with_two_rows_at_one_time_shows_the_last_row_and_counts_the_hidden_one(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **DUP_RUN)
    index = load_obs_index(_layout(client))
    agg = load_obs_agg(1, _layout(client))
    stat = agg.stats.index("mean")
    at_one = [i for i in range(index.n_obs) if index.time[i] == 1.0]
    assert len(at_one) == 2

    response = _frame(client, "g_dup", 1, 1.0, "mean")

    assert _values(response)[0] == agg.values[stat, max(at_one)]
    meta = series_meta(response)
    assert meta["n_at_time"] == 1 and meta["n_rows_hidden"] == 1
    assert series_meta(_frame(client, "g_dup", 1, 2.0, "mean"))["n_rows_hidden"] == 0
    assert any("share a time" in note for note in _times(client, "g_dup")["notes"])


def test_build_frame_takes_the_last_row_of_a_site_whatever_the_assignment_order(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **DUP_RUN)
    assert _frame(client, "g_dup", 1, 1.0, "mean").status_code == 200
    state = client.pesto_app.state
    rows = next(v[1] for k, v in state.obs_memo.items() if k[1:] == ("frame_rows", "g_dup"))
    stat = np.arange(rows.stop, dtype=np.float64) * 10.0

    out, n_at_time, n_hidden, _n_sentinel = obsmap.build_frame(rows, stat, 1.0)

    assert n_at_time == 1 and n_hidden == 1
    assert out[0] == np.float32(10.0 * (rows.start + 1))
