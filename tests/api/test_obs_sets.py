"""Group sets: groups whose observations all hold one value in a text column of the file,
listed by /obs/group_sets and drawn as one by /obs/sites, /obs/times and /obs/frame, read
back through a real app from a cache made by ingesting a generated run."""

from __future__ import annotations

import io
import json

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
