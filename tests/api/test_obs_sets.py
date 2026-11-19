"""Group sets: groups whose observations all hold one value in a text column of the file,
listed by /obs/group_sets and drawn as one by /obs/sites, /obs/times and /obs/frame, read
back through a real app from a cache made by ingesting a generated run."""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest

import pesto.ingest.runner as runner
from ingest.obs_fixtures import SiteSpec

from .obs_helpers import open_obs_run, series_meta

S1 = "site-1"
S2 = "site-2"
S3 = "site-3"
SET_SITES = (
    SiteSpec("g1", S1, (1.0, 2.0), "time-token", obsval=1.5, extras={"oname": "hds", "icpl": "0", "layer": "0"}),
    SiteSpec("g2", S2, (2.0, 3.0), "time-token", obsval=3.0, extras={"oname": "hds", "icpl": "2", "layer": "0"}),
    SiteSpec("g3", S3, (1.0,), "time-token", extras={"oname": "sfr", "x": "1.5", "y": "0.6"}),
)
SET_RUN = {"grid": True, "sites": SET_SITES, "iterations": (0, 1), "n_real": 4}
HDS = {"by": "oname", "value": "hds"}


@pytest.fixture
def in_process(monkeypatch):
    """Run every worker in this process, with the real adapter."""

    def _call(fn, *args):
        try:
            return True, fn(*args)
        except Exception as exc:
            return False, exc

    monkeypatch.setattr(runner, "_run_isolated", _call)


def _group_sets(client) -> dict:
    response = client.get("/api/run/obs/group_sets")
    assert response.status_code == 200, response.text
    return response.json()


def _sites(client, **params):
    """The /obs/sites answer as a pandas frame, its notes and the response."""
    import pyarrow as pa

    response = client.get("/api/run/obs/sites", params=params)
    assert response.status_code == 200, response.text
    frame = pa.ipc.open_stream(io.BytesIO(response.content)).read_all().to_pandas()
    return frame, json.loads(response.headers.get("x-pesto-notes", "[]")), response


def _times(client, **params) -> dict:
    response = client.get("/api/run/obs/times", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _frame(client, iteration: int, time: float, stat: str, **target):
    return client.get(
        "/api/run/obs/frame",
        params={**target, "iteration": iteration, "time": time, "stat": stat},
    )


def _values(response) -> np.ndarray:
    assert response.status_code == 200, response.text
    return np.frombuffer(response.content, dtype="<f4")


def _resid(run, iteration: int, name: str, obsval: float) -> float:
    j = run.obs_names.index(name)
    return float(np.mean(run.values[iteration][:, j].astype(np.float64)) - obsval)


# ---------------------------------------------------------------------------
# the tracer: one set from the cached table to the /obs/sites answer
# ---------------------------------------------------------------------------


def test_group_sets_lists_the_groups_that_share_one_value_of_a_text_column(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)

    body = _group_sets(client)

    assert body["sets"] == [
        {"by": "oname", "value": "hds", "groups": ["g1", "g2"], "n_groups": 2, "n_sites": 2}
    ]
    assert "a value held by only one group makes no set" in body["rule"]


def test_group_sets_name_the_observation_table_they_were_cut_from(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)
    _frame_rows, _notes, sites = _sites(client, group="g1")

    body = _group_sets(client)

    assert body["order_digest"] == json.loads(sites.headers["x-pesto-meta"])["order_digest"]
    assert client.get("/api/run/obs/group_sets").headers["cache-control"] == "no-store"


def test_a_set_returns_every_site_of_its_groups_in_index_order_with_each_sites_group(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)
    one, _n, _r = _sites(client, group="g1")
    two, _n, _r = _sites(client, group="g2")

    frame, _notes, response = _sites(client, **HDS)

    assert list(frame["site"]) == [S1, S2]
    assert list(frame["group"]) == ["g1", "g2"]
    columns = ["site_id", "site", "n_obs", "x", "y", "xy_source", "layer", "cell", "rule"]
    for i, alone in enumerate((one, two)):
        assert frame[columns].iloc[i].to_dict() == alone[columns].iloc[0].to_dict()
    meta = json.loads(response.headers["x-pesto-meta"])
    assert meta["set"] == {"by": "oname", "value": "hds"} and meta["group"] is None


def test_a_group_answer_carries_the_group_column_and_no_set(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)

    frame, _notes, response = _sites(client, group="g1")

    assert list(frame["site"]) == [S1]
    assert list(frame["group"]) == ["g1"]
    meta = json.loads(response.headers["x-pesto-meta"])
    assert meta["set"] is None and meta["group"] == "g1"


# ---------------------------------------------------------------------------
# times and frames for a set
# ---------------------------------------------------------------------------

MIX_SITES = (
    SiteSpec("g_num", "site-num", (1.0, 2.0), "time-token", extras={"oname": "mix"}),
    SiteSpec("g_date", "site-date", ("2020-01-01",), "datetime-token", extras={"oname": "mix"}),
)


def test_a_sets_times_are_the_union_of_its_groups_exact_times(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)

    body = _times(client, **HDS)

    assert body["times"] == [1.0, 2.0, 3.0]
    assert body["n_at_time"] == [1, 2, 1]
    assert body["n_sites"] == 2
    assert body["group"] is None and body["set"] == {"by": "oname", "value": "hds"}
    assert body["refused"] is None and body["time_kind"] == "numeric"
    assert _times(client, group="g1")["set"] is None


def test_a_sets_limits_are_pooled_over_every_row_of_its_groups_at_both_ends(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **SET_RUN)
    wanted = [(S1, 1.0, 1.5), (S1, 2.0, 1.5), (S2, 2.0, 3.0), (S2, 3.0, 3.0)]
    resid = [_resid(run, k, f"{s}_time:{t}", o) for k in (0, 1) for s, t, o in wanted]
    means = [
        float(np.mean(run.values[k][:, run.obs_names.index(f"{s}_time:{t}")].astype(np.float64)))
        for k in (0, 1)
        for s, t, _o in wanted
    ]

    limits = _times(client, **HDS)["limits"]

    m = float(np.percentile(np.abs(resid), 98))
    assert limits["resid_mean"][0] == -limits["resid_mean"][1]
    assert limits["resid_mean"][1] == pytest.approx(m, rel=1e-4)
    lo, hi = np.percentile(means, [2, 98])
    assert limits["mean"] == [pytest.approx(lo, rel=1e-4), pytest.approx(hi, rel=1e-4)]
    assert limits != _times(client, group="g1")["limits"]


def test_a_sets_frame_holds_one_value_per_site_in_the_sites_order(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **SET_RUN)
    j = run.obs_names.index(f"{S1}_time:1.0")
    expected = float(np.mean(run.values[0][:, j].astype(np.float64)))

    response = _frame(client, 0, 1.0, "mean", **HDS)

    values = _values(response)
    assert values.shape == (2,)
    assert values[0] == pytest.approx(expected, abs=1e-5)
    assert np.isnan(values[1])
    meta = series_meta(response)
    assert meta["group"] is None and meta["set"] == {"by": "oname", "value": "hds"}
    assert meta["n_sites"] == 2 and meta["n_at_time"] == 1
    assert series_meta(_frame(client, 0, 1.0, "mean", group="g1"))["set"] is None


def test_a_sets_frame_at_a_shared_time_holds_both_sites(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **SET_RUN)

    values = _values(_frame(client, 1, 2.0, "resid_mean", **HDS))

    assert values[0] == pytest.approx(_resid(run, 1, f"{S1}_time:2.0", 1.5), abs=1e-5)
    assert values[1] == pytest.approx(_resid(run, 1, f"{S2}_time:2.0", 3.0), abs=1e-5)


def test_a_time_no_group_of_the_set_has_is_a_404_and_never_the_nearest(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)

    for time in (1.5, 4.0):
        response = _frame(client, 1, time, "mean", **HDS)
        assert response.status_code == 404, time
        assert "never uses the nearest time" in response.json()["detail"]


def test_a_set_whose_groups_count_time_in_different_ways_is_refused(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, sites=MIX_SITES, iterations=(0,), n_real=4)

    body = _times(client, by="oname", value="mix")

    assert body["times"] == [] and body["n_at_time"] == []
    assert body["time_kind"] == "mixed"
    assert body["refused"] == (
        "the groups of this set mix time kinds (datetime and numeric), so one time axis would "
        "mean two things; pesto shows no time slider for it"
    )
    assert all(v is None for v in body["limits"].values())
    refused = _frame(client, 0, 1.0, "mean", by="oname", value="mix")
    assert refused.status_code == 409
    assert "mix time kinds" in refused.json()["detail"]


def test_a_set_over_the_site_limit_is_a_409_naming_both_counts(tmp_path, in_process, monkeypatch):
    from pesto.api import obsmap

    client, _run = open_obs_run(tmp_path, **SET_RUN)
    monkeypatch.setattr(obsmap, "MAX_SITES_PER_GROUP", 1)

    for route in ("sites", "times"):
        response = client.get(f"/api/run/obs/{route}", params=HDS)
        assert response.status_code == 409
        body = response.json()
        assert body["title"] == "the set has too many sites for the map"
        assert "2 sites" in body["detail"] and "1 the map serves" in body["detail"]
        assert "'oname'" in body["detail"] and "'hds'" in body["detail"]
    assert _frame(client, 0, 1.0, "mean", **HDS).status_code == 409


# ---------------------------------------------------------------------------
# refusals and notes: nothing is left out of a set without a trace
# ---------------------------------------------------------------------------


def _spec(group: str, site: str, **extras) -> SiteSpec:
    return SiteSpec(group, site, (1.0,), "time-token", extras=extras)


NOTE_SITES = (
    _spec("g1", "n-1", oname="hds", usecol="u1"),
    _spec("g2", "n-2", oname="hds", usecol="u2"),
    # Two sites of one group holding two values.
    _spec("g4", "n-4a", oname="hds", usecol="u4"),
    _spec("g4", "n-4b", oname="sfr", usecol="u4"),
    # A value on one site and a blank on the other.
    _spec("g5", "n-5a", oname="hds", usecol="u5"),
    _spec("g5", "n-5b", oname=None, usecol="u5"),
    # No value at all.
    _spec("g6", "n-6", oname=None, usecol="u6"),
    # A leading space is part of the value.
    _spec("g7", "n-7", oname=" hds", usecol="u7"),
    _spec("g8", "n-8", oname=" hds", usecol="u8"),
)
NOTE_RUN = {"sites": NOTE_SITES, "iterations": (0,), "n_real": 4}


def test_a_group_holding_two_values_is_in_no_set_and_a_note_names_it(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **NOTE_RUN)

    body = _group_sets(client)

    hds = next(s for s in body["sets"] if s["by"] == "oname" and s["value"] == "hds")
    assert hds["groups"] == ["g1", "g2"]
    assert (
        "column 'oname': 1 group holds more than one value, so it is in no oname set; "
        "first: 'g4' ('hds', 'sfr')"
    ) in body["notes"]


def test_a_group_with_a_value_on_some_rows_and_a_blank_on_others_is_in_no_set(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **NOTE_RUN)

    notes = _group_sets(client)["notes"]

    assert (
        "column 'oname': 1 group has a value on some rows and a blank on others, so it is in "
        "no oname set; first: 'g5' ('hds' and a blank)"
    ) in notes


def test_a_group_with_no_value_in_a_column_that_makes_sets_is_counted(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **NOTE_RUN)

    notes = _group_sets(client)["notes"]

    assert "column 'oname': 1 group has no oname value, so it is in no oname set; 'g6'" in notes


def test_one_note_names_the_text_columns_that_make_no_set(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **NOTE_RUN)

    body = _group_sets(client)

    assert not any(s["by"] == "usecol" for s in body["sets"])
    made_none = [t for t in body["notes"] if "no set" in t and t.startswith("text column")]
    assert made_none == [
        "text column 'usecol' gives no set of groups: no value in it is shared by more than one "
        "whole group"
    ]
    assert "obsnme, obgnme, the time columns (datetime, time)" in body["rule"]
    assert "(id, x, y, z, icpl, layer, k, i, j)" in body["rule"]
    assert not any("obsnme" in t or "'datetime'" in t for t in body["notes"])


def test_a_value_with_a_leading_space_is_its_own_set(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **NOTE_RUN)

    sets = {(s["by"], s["value"]): s["groups"] for s in _group_sets(client)["sets"]}

    assert sets[("oname", " hds")] == ["g7", "g8"]
    assert sets[("oname", "hds")] == ["g1", "g2"]
    assert len(_sites(client, by="oname", value=" hds")[0]) == 2


def test_naming_a_group_and_a_set_or_half_a_set_is_a_422(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)

    for route in ("sites", "times"):
        for params in ({"group": "g1", **HDS}, {"by": "oname"}, {"value": "hds"}, {}):
            response = client.get(f"/api/run/obs/{route}", params=params)
            assert response.status_code == 422, (route, params)
    both = _frame(client, 0, 1.0, "mean", group="g1", **HDS)
    assert both.status_code == 422
    assert _frame(client, 0, 1.0, "mean", by="oname").status_code == 422


def test_a_pair_the_run_has_no_set_for_is_a_404_naming_the_column_and_value(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)

    for route in ("sites", "times"):
        response = client.get(f"/api/run/obs/{route}", params={"by": "oname", "value": "nope"})
        assert response.status_code == 404
        detail = response.json()["detail"]
        assert "'oname'" in detail and "'nope'" in detail
    # One group's value makes no set, so it is not found either.
    assert client.get("/api/run/obs/sites", params={"by": "oname", "value": "sfr"}).status_code == 404
    assert _frame(client, 0, 1.0, "mean", by="oname", value="nope").status_code == 404


def test_a_sets_placement_notes_are_summed_per_rule_over_its_groups(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)
    _one, single, _r = _sites(client, group="g1")

    _frame_rows, notes, _response = _sites(client, **HDS)

    rule_lines = [t for t in notes if t.startswith("placement rule")]
    rule = next(t for t in single if t.startswith("placement rule")).split(":")[0]
    assert rule_lines == [f"{rule}: 2 of 2 sites placed"]


def test_a_set_keeps_its_groups_own_placement_notes_up_to_twenty_and_counts_the_rest():
    from pesto.api import obsmap, obssets

    members = tuple(f"m{i}" for i in range(25))
    table_notes = ["about the whole run", "group 'other': not a member"] + [
        f"group '{g}': its own note" for g in members
    ]
    target = obsmap.Target(group=None, set=obssets.GroupSet("oname", "hds", members, 25))

    notes = obsmap._member_notes(table_notes, target)

    assert notes[0] == "about the whole run"
    assert "group 'other': not a member" not in notes
    assert notes[1:21] == [f"group 'm{i}': its own note" for i in range(20)]
    assert notes[21] == (
        "5 more placement note(s) of the groups of this set are left out; choosing one group "
        "shows them"
    )
    assert len(notes) == 22


def test_with_no_run_open_every_set_form_is_a_409(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)
    client.pesto_app.state.cache_root = None

    assert client.get("/api/run/obs/group_sets").status_code == 409
    for route in ("sites", "times"):
        assert client.get(f"/api/run/obs/{route}", params=HDS).status_code == 409
    assert _frame(client, 0, 1.0, "mean", **HDS).status_code == 409


def test_an_unreadable_observation_table_is_a_404_naming_control(tmp_path, in_process):
    client, _run = open_obs_run(tmp_path, **SET_RUN)
    layout_root = client.pesto_app.state.cache_root
    (Path(layout_root) / "control" / "obs.parquet").write_bytes(b"not parquet")

    response = client.get("/api/run/obs/group_sets")

    assert response.status_code == 404
    body = response.json()
    assert body["artifact"] == "control"
    assert layout_root not in body["detail"]
