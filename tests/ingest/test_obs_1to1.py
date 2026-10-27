"""obs_1to1: every observation group's simulated values counted against the
observed value on one square grid, per iteration, on one shared range.

Each test ingests a generated run whose values the test knows, then compares
what the cache holds with numpy on those values.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from pesto.cache.layout import CacheLayout
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obs1to1 import (
    OBS_1TO1_BINS,
    RANKING_RULE,
    RMSE_RULE,
    bin_pairs,
    load_obs_1to1,
    one_to_one_range,
    rank_outlying,
    rms_of_mean_residual,
    write_obs_1to1,
)
from pesto.ingest.obsagg import OBS_STATS, load_obs_agg
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.parhist import identical_values_reason
from pesto.ingest.runner import ingest_run, plan_artifacts

from .fixtures import _ENSEMBLE_WRITERS
from .obs_fixtures import DEFAULT_SITES, SiteSpec, make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run = make_obs_run(tmp_path / "run", **kwargs)
    cache = tmp_path / "cache"
    manifest = ingest_run(run.root, cache_root=cache)
    return run, CacheLayout(root=cache), manifest


def _grids(layout):
    loaded = load_obs_1to1(layout)
    assert not isinstance(loaded, ReadFailure), loaded
    return loaded


def _entry(meta, group):
    return next(g for g in meta["groups"] if g["group"] == group)


def _dense(frame, group, iteration, n_bins=OBS_1TO1_BINS):
    """One grid as ``[ix, iy]`` counts from the stored rows."""
    rows = frame[(frame["group"] == group) & (frame["iteration"] == iteration)]
    grid = np.zeros((n_bins, n_bins), dtype=np.int64)
    grid[rows["ix"].to_numpy(), rows["iy"].to_numpy()] = rows["count"].to_numpy()
    return grid


def _group_columns(run, group):
    return [i for i, row in enumerate(run.rows) if row["obgnme"] == group]


# ---------------------------------------------------------------------------
# The tracer: an ingested observation run gets obs_1to1
# ---------------------------------------------------------------------------


def test_obs_1to1_is_ok_after_an_ingest(tmp_path, in_process):  # noqa: F811
    _run, _layout, manifest = _ingest(tmp_path)

    assert manifest.artifacts["obs_1to1"].state == "ok", manifest.artifacts["obs_1to1"].reason


def test_obs_1to1_is_planned_after_the_observation_iterations_and_before_config(tmp_path):
    made = make_obs_run(tmp_path / "run", grid=True, with_noise=True)
    run = discover(made.root)
    planned = plan_artifacts(run, CacheLayout(root=tmp_path / "cache"))
    names = [a.name for a in planned]

    assert names[-2:] == ["obs_1to1", "config"]
    assert names.index("obs_1to1") > names.index("obs_agg/1")
    one = next(a for a in planned if a.name == "obs_1to1")
    assert one.needs == ("obs_index", "obs_ens/0", "obs_agg/0", "obs_ens/1", "obs_agg/1")
    assert one.sources[:2] == (str(made.obs_ens[0]), str(made.obs_ens[1]))
    assert len(set(one.sources)) == len(one.sources)
    assert one.kind == "obs_1to1"


def test_a_run_with_no_observation_ensemble_plans_no_obs_1to1(tmp_path):
    made = make_obs_run(tmp_path / "run", iterations=(), par_iterations=(0, 1))
    run = discover(made.root)

    names = [a.name for a in plan_artifacts(run, CacheLayout(root=tmp_path / "cache"))]

    assert not any(n.startswith("obs_ens/") for n in names)
    assert "obs_1to1" not in names


@pytest.mark.parametrize("iteration", [0, 1])
def test_a_group_grid_equals_numpy_histogram2d_on_the_stored_range(tmp_path, in_process, iteration):  # noqa: F811
    run, layout, _ = _ingest(tmp_path)
    frame, meta = _grids(layout)
    entry = _entry(meta, "gw_head")
    columns = _group_columns(run, "gw_head")

    sim = run.values[iteration][:, columns].astype(np.float32).astype(np.float64)
    obsval = np.array([float(run.rows[c]["obsval"]) for c in columns])
    edges = np.linspace(entry["lo"], entry["hi"], OBS_1TO1_BINS + 1)
    expected, _, _ = np.histogram2d(
        np.tile(obsval, (sim.shape[0], 1)).ravel(), sim.ravel(), bins=[edges, edges]
    )

    assert np.array_equal(_dense(frame, "gw_head", iteration), expected.astype(np.int64))


def test_every_finite_simulated_value_is_counted_or_counted_as_outside(tmp_path, in_process):  # noqa: F811
    run, layout, _ = _ingest(tmp_path)
    frame, meta = _grids(layout)

    for group in ("gw_head", "gw_date"):
        columns = _group_columns(run, group)
        for item in _entry(meta, group)["iterations"]:
            sim = run.values[item["iteration"]][:, columns]
            in_grid = int(_dense(frame, group, item["iteration"]).sum())
            assert in_grid + item["n_outside"] == int(np.isfinite(sim).sum())
            assert item["n_points"] == int(np.isfinite(sim).sum())


def test_the_sidecar_names_the_iterations_the_digest_and_both_rules(tmp_path, in_process):  # noqa: F811
    _run, layout, _ = _ingest(tmp_path)
    _frame, meta = _grids(layout)
    index = load_obs_index(layout)

    assert (meta["first_iteration"], meta["last_iteration"]) == (0, 1)
    assert meta["single_iteration"] is False
    assert meta["n_bins"] == OBS_1TO1_BINS
    assert meta["order_digest"] == index.order_digest
    assert meta["rmse_rule"] == RMSE_RULE
    assert meta["ranking_rule"] == RANKING_RULE
    assert [g["group"] for g in meta["groups"]] == ["gw_head", "gw_date", "gw_none"]


# ---------------------------------------------------------------------------
# Range, binning and edges
# ---------------------------------------------------------------------------


def test_the_range_is_the_pooled_1_to_99_percentile_widened_by_5_percent():
    obsval = np.linspace(0.0, 10.0, 101)
    q_low = np.array([2.0, 3.0])
    q_high = np.array([7.0, 8.0])
    pool = np.concatenate([obsval, q_low, q_high])
    low, high = np.percentile(pool, [1, 99])

    lo, hi = one_to_one_range(obsval, q_low, q_high)

    assert lo == pytest.approx(low - 0.05 * (high - low))
    assert hi == pytest.approx(high + 0.05 * (high - low))


def test_one_range_serves_both_axes_and_both_iterations(tmp_path, in_process):  # noqa: F811
    _run, layout, _ = _ingest(tmp_path)
    _frame, meta = _grids(layout)
    entry = _entry(meta, "gw_head")

    assert entry["lo"] < entry["hi"]
    assert [i["iteration"] for i in entry["iterations"]] == [0, 1]
    assert max(_frame["ix"].max(), _frame["iy"].max()) < OBS_1TO1_BINS


def test_a_pair_on_an_inner_edge_counts_to_its_right_and_the_upper_end_counts_in_the_last_bin():
    n = 4
    edges = np.linspace(0.0, 4.0, n + 1)
    obsval = np.array([1.0, 4.0, 2.0, 2.0])
    block = np.array([[2.0], [4.0], [4.0 + 1e-9], [3.999999]])

    counts, n_points, n_outside, n_no_valid, n_nonfinite = bin_pairs(obsval, block, 0.0, 4.0, n)

    inside = [0, 1, 3]
    expected, _, _ = np.histogram2d(obsval[inside], block[inside, 0], bins=[edges, edges])
    assert counts[1, 2] == 1
    assert counts[3, 3] == 1
    assert counts[2, 3] == 1
    assert np.array_equal(counts, expected.astype(np.int64))
    assert (n_points, n_outside, n_no_valid, n_nonfinite) == (4, 1, 0, 0)


def test_an_observed_value_outside_the_range_counts_all_its_values_as_outside():
    counts, n_points, n_outside, _, _ = bin_pairs(
        np.array([9.0]), np.array([[1.0, 2.0, 3.0]]), 0.0, 4.0, 4
    )

    assert counts.sum() == 0
    assert (n_points, n_outside) == (3, 3)


def test_an_observation_with_only_missing_values_is_counted_and_a_gap_is_counted():
    block = np.array([[np.nan, np.nan], [1.0, np.nan], [1.0, 2.0]])

    counts, n_points, n_outside, n_no_valid, n_nonfinite = bin_pairs(
        np.array([1.0, 1.0, 1.0]), block, 0.0, 4.0, 4
    )

    assert n_no_valid == 1
    assert n_nonfinite == 1
    assert n_points == 3
    assert counts.sum() + n_outside == 3


def test_a_group_with_a_missing_value_in_the_ensemble_counts_it_and_still_draws_the_rest(
    tmp_path, in_process  # noqa: F811
):
    run = make_obs_run(tmp_path / "run")
    array = np.array(run.values[1], dtype=np.float64)
    columns = _group_columns(run, "gw_head")
    array[0, columns[0]] = np.nan
    array[:, columns[1]] = np.nan
    _ENSEMBLE_WRITERS["jcb"][0](run.obs_ens[1], array, run.real_names, run.obs_names)
    cache = tmp_path / "cache"
    ingest_run(run.root, cache_root=cache)
    frame, meta = _grids(CacheLayout(root=cache))

    item = _entry(meta, "gw_head")["iterations"][1]

    assert item["n_no_valid"] == 1
    assert item["n_nonfinite"] == 1
    assert item["n_points"] == 2 * array.shape[0] - 1
    assert int(_dense(frame, "gw_head", 1).sum()) + item["n_outside"] == item["n_points"]


# ---------------------------------------------------------------------------
# Groups that cannot be drawn, left-out counts, zero weights
# ---------------------------------------------------------------------------


def test_a_group_with_no_target_is_refused_with_the_sentinel_count_and_has_no_rows(
    tmp_path, in_process  # noqa: F811
):
    _run, layout, _ = _ingest(tmp_path)
    frame, meta = _grids(layout)
    entry = _entry(meta, "gw_none")

    assert entry["refused"] == "no observation in this group has a measured value (1 sentinel)"
    assert entry["left_out"] == {"no_value": 0, "sentinel": 1}
    assert entry["lo"] is None and entry["hi"] is None
    assert entry["iterations"] == [] and entry["outlying"] == []
    assert "gw_none" not in set(frame["group"])


def test_a_group_whose_pooled_values_are_all_equal_is_refused():
    reason = one_to_one_range(np.full(5, 2.0), np.full(5, 2.0), np.full(5, 2.0))

    assert reason == identical_values_reason("group")
    assert reason == "every value in this group is the same, so there is no spread to draw"


def test_a_group_with_equal_values_is_refused_and_costs_no_other_group_its_grid(
    tmp_path, in_process  # noqa: F811
):
    run = make_obs_run(tmp_path / "run")
    array = np.array(run.values[0], dtype=np.float64)
    other = np.array(run.values[1], dtype=np.float64)
    columns = _group_columns(run, "gw_head")
    for a in (array, other):
        a[:, columns] = 1.5
    for iteration, a in ((0, array), (1, other)):
        _ENSEMBLE_WRITERS["jcb"][0](run.obs_ens[iteration], a, run.real_names, run.obs_names)
    cache = tmp_path / "cache"
    manifest = ingest_run(run.root, cache_root=cache)
    frame, meta = _grids(CacheLayout(root=cache))

    assert manifest.artifacts["obs_1to1"].state == "ok"
    assert _entry(meta, "gw_head")["refused"] == identical_values_reason("group")
    assert "gw_head" not in set(frame["group"])
    assert _entry(meta, "gw_date")["refused"] is None
    assert "gw_date" in set(frame["group"])


def test_zero_weight_observations_with_a_real_obsval_are_binned_and_counted(tmp_path, in_process):  # noqa: F811
    _run, layout, _ = _ingest(tmp_path)
    frame, meta = _grids(layout)
    entry = _entry(meta, "gw_date")

    assert entry["n_zero_weight"] == 3
    assert entry["n_with_target"] == 3
    assert entry["refused"] is None
    assert int(_dense(frame, "gw_date", 0).sum()) > 0
    assert _entry(meta, "gw_head")["n_zero_weight"] == 0


def test_observations_without_a_numeric_value_are_counted_as_left_out(tmp_path, in_process):  # noqa: F811
    sites = (
        *DEFAULT_SITES,
        SiteSpec("gw_extra", "oname:x_otype:lst_usecol:a", (None,), "none", obsval=2.0),
        SiteSpec("gw_extra", "oname:x_otype:lst_usecol:b", (None,), "none", obsval=1e30),
    )
    _run, layout, _ = _ingest(tmp_path, sites=sites)
    _frame, meta = _grids(layout)
    entry = _entry(meta, "gw_extra")

    assert entry["n_obs"] == 2
    assert entry["n_with_target"] == 1
    assert entry["left_out"]["sentinel"] == 1
    assert entry["left_out"]["no_value"] == 0


# ---------------------------------------------------------------------------
# One iteration
# ---------------------------------------------------------------------------


def test_one_observation_iteration_gives_one_grid_and_a_note_naming_it(tmp_path, in_process):  # noqa: F811
    run, layout, manifest = _ingest(tmp_path, iterations=(0,))
    frame, meta = _grids(layout)

    assert manifest.artifacts["obs_1to1"].state == "ok"
    assert meta["single_iteration"] is True
    assert meta["first_iteration"] == meta["last_iteration"] == 0
    assert set(frame["iteration"]) == {0}
    assert len(_entry(meta, "gw_head")["iterations"]) == 1
    assert (
        "only iteration 0 has an observation ensemble, so the 1:1 plot has one panel"
        in meta["notes"]
    )
    assert run.obs_ens.keys() == {0}


def test_the_plan_uses_the_iterations_that_have_an_observation_file_not_the_ones_asked_for(tmp_path):
    made = make_obs_run(tmp_path / "run")
    run = discover(made.root)

    planned = plan_artifacts(run, CacheLayout(root=tmp_path / "cache"), iterations=[0, 1, 5])
    one = next(a for a in planned if a.name == "obs_1to1")

    assert one.needs == ("obs_index", "obs_ens/0", "obs_agg/0", "obs_ens/1", "obs_agg/1")


# ---------------------------------------------------------------------------
# Order of what is stored
# ---------------------------------------------------------------------------


def test_bins_are_stored_by_group_then_iteration_then_iy_then_ix(tmp_path, in_process):  # noqa: F811
    _run, layout, _ = _ingest(tmp_path)
    frame, meta = _grids(layout)

    groups = [g["group"] for g in meta["groups"] if g["refused"] is None]
    keys = list(zip(frame["group"].map(groups.index), frame["iteration"], frame["iy"], frame["ix"]))

    assert keys == sorted(keys)
    assert len(set(keys)) == len(keys)
    assert (frame["count"] > 0).all()


def test_the_first_iteration_comes_first(tmp_path, in_process):  # noqa: F811
    _run, layout, _ = _ingest(tmp_path)
    frame, meta = _grids(layout)

    rows = frame[frame["group"] == "gw_head"]

    assert rows["iteration"].iloc[0] == meta["first_iteration"]
    assert rows["iteration"].iloc[-1] == meta["last_iteration"]


# ---------------------------------------------------------------------------
# RMSE and the ranking
# ---------------------------------------------------------------------------


def test_rms_of_the_mean_residual_ignores_missing_values():
    assert rms_of_mean_residual(np.array([1.0, -1.0, np.nan])) == (1.0, 2)
    assert rms_of_mean_residual(np.array([np.nan, np.nan])) == (None, 0)


def test_the_ranking_goes_by_rmse_descending_and_ties_to_the_lower_site_id():
    ranked = rank_outlying(
        np.array([7, 2, 9, 4]),
        np.array([0, 1, 2, 3]),
        np.array([1, 1, 1, 1]),
        np.array([3.0, 5.0, 5.0, 1.0]),
    )

    assert ranked == [2, 9, 7, 4]


def test_a_site_with_no_finite_residual_is_not_ranked_and_at_most_ten_come_back():
    ranked = rank_outlying(
        np.array([5, 6]), np.array([0, 2]), np.array([2, 1]), np.array([np.nan, np.nan, 1.0])
    )
    many = rank_outlying(
        np.arange(30), np.arange(30), np.ones(30, dtype=np.int64), np.arange(30, dtype=float)
    )

    assert ranked == [6]
    assert len(many) == 10
    assert many == list(range(29, 19, -1))


def test_a_site_is_ranked_over_all_of_its_observations():
    ranked = rank_outlying(
        np.array([1, 2]), np.array([0, 3]), np.array([3, 1]), np.array([3.0, 0.0, 0.0, 2.0])
    )

    assert ranked == [2, 1]  # site 1 is sqrt(9 / 3) = 1.73, site 2 is 2


def test_the_stored_outlying_sites_follow_the_rmse_of_the_last_iterations_mean_residual(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path)
    _frame, meta = _grids(layout)
    index = load_obs_index(layout)
    agg = load_obs_agg(1, layout)
    resid = np.asarray(agg.values[OBS_STATS.index("resid_mean")], dtype=np.float64)

    sites = index.sites[index.sites["group"].astype(str) == "gw_head"]
    rmse = {
        int(s.site_id): rms_of_mean_residual(resid[s.start : s.start + s.count])[0]
        for s in sites.itertuples()
    }
    expected = sorted(rmse, key=lambda k: (-rmse[k], k))[:10]

    assert _entry(meta, "gw_head")["outlying"] == expected


def test_the_sidecar_is_plain_json_with_the_keys_the_reader_expects(tmp_path, in_process):  # noqa: F811
    _run, layout, _ = _ingest(tmp_path)

    meta = json.loads(layout.obs_1to1_meta.read_text())

    for key in ("cache_version", "n_bins", "order_digest", "groups", "notes"):
        assert key in meta
    for key in ("n_obs", "n_with_target", "n_zero_weight", "lo", "hi", "left_out", "refused"):
        assert key in meta["groups"][0]


def test_a_sidecar_of_the_wrong_shape_is_refused_with_a_reason(tmp_path, in_process):  # noqa: F811
    _run, layout, _ = _ingest(tmp_path)
    meta = json.loads(layout.obs_1to1_meta.read_text())
    del meta["groups"][0]["outlying"]
    layout.obs_1to1_meta.write_text(json.dumps(meta))

    loaded = load_obs_1to1(layout)

    assert isinstance(loaded, ReadFailure)
    assert "obs_1to1" in loaded.reason


def test_nothing_is_left_behind_when_the_cache_cannot_be_read(tmp_path):
    layout = CacheLayout(root=tmp_path / "cache")
    layout.ensure()

    result = write_obs_1to1(0, 1, layout)

    assert isinstance(result, ReadFailure)
    assert not layout.obs_1to1.exists() and not layout.obs_1to1_meta.exists()
