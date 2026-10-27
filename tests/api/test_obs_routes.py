"""The observation routes: one site's series and one site's observed values, read
back through a real app from a cache made by ingesting a generated run."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.ingest.obsindex import load_obs_index

from .obs_helpers import HEAD_SITE, BASE_URL, open_obs_run, series_meta, site_id


def _root(client):
    return client.pesto_app.state.cache_root


def _cached_rows(client, iteration: int, site: int) -> np.ndarray:
    layout = CacheLayout(root=Path(_root(client)))
    index = load_obs_index(layout)
    row = index.sites.loc[index.sites["site_id"] == site].iloc[0]
    start, count = int(row["start"]), int(row["count"])
    shape = (index.n_obs, -1)
    values = np.fromfile(layout.obs_ens(iteration), dtype="<f4").reshape(shape)
    return values[start : start + count]


# ---------------------------------------------------------------------------
# the tracer: /obs/series
# ---------------------------------------------------------------------------


def test_series_serves_the_cached_rows_of_one_site_for_one_iteration(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    site = site_id(_root(client), HEAD_SITE)

    response = client.get("/api/run/obs/series", params={"site": site, "iteration": 1})

    assert response.status_code == 200, response.text
    meta = series_meta(response)
    assert meta["shape"] == [3, 4]
    assert meta["dtype"] == "<f4"
    served = np.frombuffer(response.content, dtype="<f4").reshape(3, 4)
    assert served.tobytes() == _cached_rows(client, 1, site).tobytes()


def test_series_rows_come_in_time_order_matching_the_index(tmp_path, in_process):  # noqa: F811
    client, run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    layout = CacheLayout(root=Path(_root(client)))
    index = load_obs_index(layout)
    site = site_id(_root(client), HEAD_SITE)
    row = index.sites.loc[index.sites["site_id"] == site].iloc[0]
    start, count = int(row["start"]), int(row["count"])
    assert list(index.time[start : start + count]) == [1.0, 9.0, 10.0]

    response = client.get("/api/run/obs/series", params={"site": site, "iteration": 0})

    # Control order lists this site as 10, 1, 9, so row 0 of the answer must be the t=1 observation.
    served = np.frombuffer(response.content, dtype="<f4").reshape(3, 4)
    generated = run.values[0]
    by_name = {name: j for j, name in enumerate(run.obs_names)}
    for k, t in enumerate((1.0, 9.0, 10.0)):
        column = by_name[f"{HEAD_SITE}_time:{t}"]
        assert served[k].tobytes() == generated[:, column].astype("<f4").tobytes()


def test_series_reports_the_iterations_own_realization_count_and_no_base(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=3)
    site = site_id(_root(client), HEAD_SITE)

    meta = series_meta(client.get("/api/run/obs/series", params={"site": site, "iteration": 1}))

    assert meta["n_real"] == 3
    assert meta["base_index"] == []
    assert meta["base_note"] is None
    assert meta["site_id"] == site
    assert meta["iteration"] == 1
    assert meta["n_nan"] == 0


def test_series_site_is_matched_by_id_not_taken_as_a_row_position(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    for unknown in (99, -1):
        response = client.get("/api/run/obs/series", params={"site": unknown, "iteration": 1})
        assert response.status_code == 404
        assert response.json()["artifact"] == "obs_index"


def test_series_for_an_iteration_with_no_observation_ensemble_is_a_404_naming_it(
    tmp_path, in_process  # noqa: F811
):
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    site = site_id(_root(client), HEAD_SITE)

    response = client.get("/api/run/obs/series", params={"site": site, "iteration": 7})

    assert response.status_code == 404
    body = response.json()
    assert body["artifact"] == "obs_ens/7"
    assert "iteration 7" in body["detail"]


def test_series_with_no_run_open_is_409():
    app, token = create_app()
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token

    response = client.get("/api/run/obs/series", params={"site": 0, "iteration": 0})

    assert response.status_code == 409
    assert response.json()["title"] == "no run is open"


def test_series_refuses_a_query_field_it_does_not_know(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    response = client.get("/api/run/obs/series", params={"site": 0, "iteration": 0, "extra": 1})

    assert response.status_code == 422
