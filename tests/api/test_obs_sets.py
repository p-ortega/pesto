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
