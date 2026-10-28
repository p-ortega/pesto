"""A simulated 1e30 (MODFLOW's dry or no-flow placeholder) is never a value on any observation route.

Group ``gw_head`` has one site with observations at times 1, 9 and 10. In iteration 1 the one at
time 9 is 1e30 in every realization and the one at time 10 is 1e30 in a single realization.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from ingest.fixtures import survivor_names
from pesto.api import obsmap
from pesto.cache.layout import CacheLayout
from pesto.ingest.obsagg import load_obs_agg
from pesto.ingest.obsindex import SENTINEL_LIMIT

from .obs_helpers import open_cache, open_obs_run, series_meta, site_id
from .test_obs_fit_routes import _arrow
from .test_obs_map_routes import GRID_RUN, HEAD, _frame, _layout, _root, _times, _values, in_process  # noqa: F401

REALS = survivor_names()
DRY = {1: [(f"{HEAD}_time:9.0", r) for r in REALS] + [(f"{HEAD}_time:10.0", REALS[1])]}


@pytest.fixture
def dry_run(tmp_path, in_process):  # noqa: F811
    return open_obs_run(tmp_path, **GRID_RUN, sentinel_values=DRY)


def test_the_colour_limits_never_reach_the_sentinel(dry_run):
    client, _run = dry_run

    body = _times(client, "gw_head")

    for stat, limits in body["limits"].items():
        assert limits is not None, stat
        assert all(abs(v) < SENTINEL_LIMIT for v in limits), (stat, limits)


def _stale_client(dry_run):
    """A new app over the same cache whose statistics hold 1e30 where a cut before the fix kept it."""
    client, _run = dry_run
    layout = _layout(client)
    path = layout.obs_agg(1)
    stored = np.fromfile(path, dtype="<f4")
    stored[np.isnan(stored)] = 1e30
    stored.tofile(path)
    return open_cache(layout.root)


def test_the_times_leave_a_stale_sentinel_statistic_out_of_the_limits_and_say_so(dry_run):
    stale = _stale_client(dry_run)

    body = _times(stale, "gw_head")

    assert all(abs(v) < SENTINEL_LIMIT for limits in body["limits"].values() for v in limits)
    assert any("sentinel" in note and "colour limits" in note for note in body["notes"])


def test_a_frame_of_a_stale_sentinel_statistic_is_no_value_and_is_counted(dry_run):
    stale = _stale_client(dry_run)

    response = _frame(stale, "gw_head", 1, 9.0, "mean")

    assert np.isnan(_values(response)).all()
    meta = series_meta(response)
    assert meta["n_finite"] == 0 and meta["n_sentinel"] == 1


def test_the_statistics_of_a_row_that_is_all_sentinel_are_missing_not_1e30(dry_run):
    client, _run = dry_run
    layout = _layout(client)
    agg = load_obs_agg(1, layout)

    assert np.nanmax(np.abs(np.asarray(agg.values, dtype=np.float64))) < SENTINEL_LIMIT


def test_a_partly_sentinel_row_uses_only_its_real_realizations(dry_run):
    client, run = dry_run
    j = run.obs_names.index(f"{HEAD}_time:10.0")
    kept = np.delete(run.values[1][:, j].astype(np.float64), 1)  # REALS[1] is the sentinel
    response = _frame(client, "gw_head", 1, 10.0, "mean")

    assert _values(response)[0] == pytest.approx(kept.mean(), rel=1e-6)


def test_the_agg_sidecar_counts_the_simulated_sentinels(dry_run):
    client, _run = dry_run
    sidecar = json.loads(CacheLayout(root=_layout(client).root).obs_agg_meta(1).read_text())

    assert sidecar["counts"]["n_simulated_sentinel"] == len(REALS) + 1
    assert any("simulated value(s)" in note and "left out" in note for note in sidecar["notes"])


def test_the_series_blanks_a_sentinel_and_counts_it(dry_run):
    client, run = dry_run
    site = site_id(_root(client), HEAD)

    response = client.get("/api/run/obs/series", params={"site": site, "iteration": 1})

    served = np.frombuffer(response.content, dtype="<f4").reshape(3, 4)
    assert not (np.abs(np.nan_to_num(served, nan=0.0)) >= SENTINEL_LIMIT).any()
    meta = series_meta(response)
    assert meta["n_sentinel"] == len(REALS) + 1
    assert int(np.isnan(served).sum()) == len(REALS) + 1


def test_the_groups_rmse_and_the_points_exclude_the_sentinel(dry_run):
    client, _run = dry_run
    site = site_id(_root(client), HEAD)

    groups = _arrow(client.get("/api/run/obs/groups")).to_pandas().set_index("group")
    points = client.get("/api/run/obs/points", params={"group": "gw_head", "sites": str(site)}).json()

    assert groups.loc["gw_head", "rmse_last"] < SENTINEL_LIMIT
    last = points["sites"][0]["series"][-1]
    assert last["mean"][1] is None
    assert all(v is None or abs(v) < SENTINEL_LIMIT for v in last["q95"])
    assert points["sites"][0]["rmse_last"] < SENTINEL_LIMIT


def test_the_residual_histogram_counts_the_row_with_no_valid_realization(dry_run):
    client, _run = dry_run

    body = client.get("/api/run/obs/resid_hist", params={"group": "gw_head"}).json()

    assert body["refused"] is None
    assert all(abs(e) < SENTINEL_LIMIT for e in body["edges"])
    assert body["left_out"]["no_valid_realization"]["last"] == 1


def test_the_one_to_one_grid_leaves_the_sentinel_out_and_counts_it(dry_run):
    client, _run = dry_run

    body = client.get("/api/run/obs/1to1", params={"group": "gw_head"}).json()

    assert body["lo"] is not None and abs(body["lo"]) < SENTINEL_LIMIT and abs(body["hi"]) < SENTINEL_LIMIT
    last = body["grids"][-1]
    assert last["n_sentinel"] == len(REALS) + 1
    assert last["n_points"] == 3 * len(REALS) - last["n_sentinel"]
    assert sum(last["counts"]) + last["n_outside"] == last["n_points"]
    assert body["grids"][0]["n_sentinel"] == 0
    assert any("sentinel" in note for note in body["notes"])


def test_build_frame_blanks_a_stale_sentinel_and_counts_it(dry_run):
    client, _run = dry_run
    _times(client, "gw_head")
    state = client.pesto_app.state
    rows = next(v[1] for k, v in state.obs_memo.items() if k[1:] == ("frame_rows", "gw_head"))
    stat = np.arange(rows.stop, dtype=np.float64)
    stat[rows.start + 1] = 1e30

    out, _n_at, _hidden, n_sentinel = obsmap.build_frame(rows, stat, 9.0)

    assert np.isnan(out).all() and n_sentinel == 1
