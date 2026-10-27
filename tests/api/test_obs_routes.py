"""The observation routes: one site's series and one site's observed values, read
back through a real app from a cache made by ingesting a generated run."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.api.app import create_app
from pesto.api.ingest import NO_NOISE_REASON
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsagg import load_noise_agg
from pesto.ingest.obscell import load_obs_cell
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


# ---------------------------------------------------------------------------
# /obs/site
# ---------------------------------------------------------------------------

DATE_SITE = "oname:hds_otype:lst_usecol:trgw-0-2"
NONE_SITE = "oname:sfr_otype:lst_usecol:flow"


def _site(client, name: str) -> dict:
    response = client.get("/api/run/obs/site", params={"site": site_id(_root(client), name)})
    assert response.status_code == 200, response.text
    return response.json()


def test_a_zero_weight_datetime_site_is_served_with_its_times_and_flags(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    body = _site(client, DATE_SITE)

    assert body["site"] == DATE_SITE
    assert body["group"] == "gw_date"
    assert body["time_kind"] == "datetime"
    assert body["inequality"] == "none"
    assert body["n_obs"] == 3
    assert body["time"] == sorted(body["time"])
    assert body["weighted"] == [False, False, False]
    assert body["obsval"] == [1.5, 1.5, 1.5]
    assert body["no_value"] == [False, False, False]
    assert body["sentinel"] == [False, False, False]
    assert body["iterations"] == [0, 1]


def test_a_sentinel_obsval_is_served_as_null_with_the_sentinel_flag(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    body = _site(client, NONE_SITE)

    assert body["obsval"] == [None]
    assert body["sentinel"] == [True]
    assert body["no_value"] == [False]
    assert body["time_kind"].startswith("ordinal")


def test_the_noise_band_is_served_with_the_values_and_sidecar_facts_of_the_cache(
    tmp_path, in_process  # noqa: F811
):
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, with_noise=True)
    layout = CacheLayout(root=Path(_root(client)))
    stored = load_noise_agg(layout)
    index = load_obs_index(layout)
    site = site_id(_root(client), HEAD_SITE)
    row = index.sites.loc[index.sites["site_id"] == site].iloc[0]
    start, count = int(row["start"]), int(row["count"])

    noise = _site(client, HEAD_SITE)["noise"]

    assert noise["available"] is True
    lo, hi = stored.stats.index("q05"), stored.stats.index("q95")
    assert np.allclose(noise["q05"], stored.values[lo, start : start + count])
    assert np.allclose(noise["q95"], stored.values[hi, start : start + count])
    assert len(noise["q05"]) == len(noise["q95"]) == 3
    assert noise["source"] == stored.source
    assert noise["base"] == stored.base
    assert noise["n_real_used"] == stored.n_real_used


def test_a_run_with_no_noise_file_says_why_there_is_no_band(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    noise = _site(client, HEAD_SITE)["noise"]

    assert noise == {"available": False, "artifact": "noise_agg", "reason": NO_NOISE_REASON}


def test_a_failed_noise_band_gives_its_recorded_reason(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, with_noise=True)
    layout = CacheLayout(root=Path(_root(client)))
    manifest = Manifest.load(layout)
    manifest.mark_failed("noise_agg", "the noise file could not be matched to the control file")
    manifest.save(layout)

    noise = _site(client, HEAD_SITE)["noise"]

    assert noise["available"] is False
    assert noise["artifact"] == "noise_agg"
    assert "could not be matched" in noise["reason"]


def test_placement_gives_the_rule_layer_and_cell_the_cache_holds_for_that_site(
    tmp_path, in_process  # noqa: F811
):
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, grid=True)
    table = load_obs_cell(CacheLayout(root=Path(_root(client))))
    assert not isinstance(table, ReadFailure)

    for position, name in enumerate(table.site):
        placement = _site(client, name)["placement"]
        assert placement["available"] is True
        assert placement["rule"] == table.rule[position]
        assert placement["layer"] == int(table.layer[position])
        assert placement["cell"] == int(table.cell[position])


def test_placement_says_why_when_obs_cell_failed_or_was_never_recorded(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    layout = CacheLayout(root=Path(_root(client)))
    manifest = Manifest.load(layout)
    manifest.mark_failed("obs_cell", "the grid file could not be read")
    manifest.save(layout)

    failed = _site(client, HEAD_SITE)["placement"]

    assert failed == {
        "available": False,
        "artifact": "obs_cell",
        "reason": "the grid file could not be read",
    }

    del manifest.artifacts["obs_cell"]
    manifest.save(layout)
    absent = _site(client, HEAD_SITE)["placement"]
    assert absent["available"] is False
    assert absent["artifact"] == "obs_cell"
    assert absent["reason"]


def test_nan_count_is_per_iteration_and_counts_only_the_injected_cell(tmp_path, in_process):  # noqa: F811
    hit = f"{HEAD_SITE}_time:9.0"
    client, _run = open_obs_run(
        tmp_path, iterations=(0, 1), n_real=4, nan_values={1: [(hit, "34")]}
    )
    site = site_id(_root(client), HEAD_SITE)

    first = series_meta(client.get("/api/run/obs/series", params={"site": site, "iteration": 0}))
    last = client.get("/api/run/obs/series", params={"site": site, "iteration": 1})

    assert first["n_nan"] == 0
    assert series_meta(last)["n_nan"] == 1
    served = np.frombuffer(last.content, dtype="<f4").reshape(3, 4)
    assert int(np.isnan(served).sum()) == 1


def test_base_is_found_in_each_iterations_own_names_and_reported_by_position(tmp_path, in_process):  # noqa: F811
    with_base, _ = open_obs_run(tmp_path / "a", iterations=(0, 1), n_real=4)
    site = site_id(_root(with_base), HEAD_SITE)
    meta = series_meta(with_base.get("/api/run/obs/series", params={"site": site, "iteration": 1}))
    assert meta["base_index"] == [0]
    assert meta["base_note"] is None

    without, _ = open_obs_run(tmp_path / "b", iterations=(0, 1), n_real=3)
    site = site_id(_root(without), HEAD_SITE)
    meta = series_meta(without.get("/api/run/obs/series", params={"site": site, "iteration": 1}))
    assert meta["base_index"] == []

    folded, _ = open_obs_run(
        tmp_path / "c", iterations=(0, 1), n_real=4, real_names=["r1", " BASE ", "r2", "r3"]
    )
    site = site_id(_root(folded), HEAD_SITE)
    meta = series_meta(folded.get("/api/run/obs/series", params={"site": site, "iteration": 0}))
    assert meta["base_index"] == [1]


def test_site_refuses_an_unknown_id_and_an_unknown_query_field(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    missing = client.get("/api/run/obs/site", params={"site": 99})
    extra = client.get("/api/run/obs/site", params={"site": 0, "iteration": 1})

    assert missing.status_code == 404
    assert missing.json()["artifact"] == "obs_index"
    assert extra.status_code == 422
