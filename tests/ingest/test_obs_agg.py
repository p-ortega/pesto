"""obs_agg/K: per-observation statistics and residuals from the cached ensemble.

The tracer ingests a generated run and checks every stored number against
numpy on the values the generator wrote for that observation name. The later
tests pin each edge of how targets, sentinels and gaps are treated.
"""

from __future__ import annotations

import inspect
import json

import numpy as np
import pandas as pd
import pytest

import pesto.ingest.obsagg as obsagg
import pesto.ingest.runner as runner
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsagg import OBS_STATS, load_obs_agg, write_obs_agg
from pesto.ingest.obsindex import build_obs_index, load_obs_index, write_obs_index
from pesto.ingest.runner import ingest_run

from .fixtures import _ENSEMBLE_WRITERS, sample_values
from .obs_fixtures import DEFAULT_SITES, SiteSpec, make_obs_run, obs_arrow, rows_for
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)

PERCENTILE_STATS = {"q05": 5, "q25": 25, "q50": 50, "q75": 75, "q95": 95}


def _ingest(tmp_path, *, sites=None, values=None, blank_obsval=(), **kwargs):
    """Ingest a generated run. ``values`` maps an iteration to the
    realization-major array (control order) to write over the generated
    observation file before the ingest. ``blank_obsval`` names observations
    whose obsval is made NaN in the cached control table afterwards (pyemu
    fills a blank obsval with 1e10, so a real NaN cannot come from a
    control file); obs_index and obs_agg/0 are then rebuilt."""
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, sites=sites, **kwargs)
    for iteration, array in (values or {}).items():
        writer = _ENSEMBLE_WRITERS["jcb"][0]
        writer(run.obs_ens[iteration], array, run.real_names, run.obs_names)
        run.values[iteration] = np.asarray(array, dtype=np.float64)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    if blank_obsval:
        obs_path = layout.control / "obs.parquet"
        frame = pd.read_parquet(obs_path)
        frame.loc[frame["obsnme"].isin(blank_obsval), "obsval"] = np.nan
        frame.to_parquet(obs_path)
        rebuilt = runner._write_obs_index_artifact(str(cache_root))
        assert not isinstance(rebuilt, ReadFailure), rebuilt
        rewritten = write_obs_agg(0, layout)
        assert not isinstance(rewritten, ReadFailure), rewritten
    return run, layout, manifest


def _by_name(run, layout, iteration=0):
    """``{observation name: {stat: stored value}}`` read back through the
    index, so a test never assumes the stored order."""
    index = load_obs_index(layout)
    assert not isinstance(index, ReadFailure), index
    stored = load_obs_agg(iteration, layout)
    assert not isinstance(stored, ReadFailure), stored
    out = {}
    for position, control_row in enumerate(index.order):
        out[run.obs_names[int(control_row)]] = {
            stat: float(stored.values[row, position]) for row, stat in enumerate(stored.stats)
        }
    return out


def _sidecar(layout, iteration=0):
    return json.loads(layout.obs_agg_meta(iteration).read_text())


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_an_ingested_run_has_obs_agg_for_each_iteration_with_the_stats_in_order(
    tmp_path, in_process
):
    run, layout, _ = _ingest(tmp_path)

    manifest = Manifest.load(layout)
    for iteration in (0, 1):
        assert manifest.artifacts[f"obs_agg/{iteration}"].state == "ok"
        stored = load_obs_agg(iteration, layout)
        assert not isinstance(stored, ReadFailure), stored
        assert stored.stats == OBS_STATS
        assert stored.values.shape == (len(OBS_STATS), len(run.obs_names))
        assert stored.values.dtype == np.float32


def test_every_observation_statistic_equals_numpy_on_the_generated_values(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)

    for iteration in (0, 1):
        stats = _by_name(run, layout, iteration)
        assert sorted(stats) == sorted(run.obs_names)
        for control_row, name in enumerate(run.obs_names):
            sim = run.values[iteration][:, control_row]
            got = stats[name]
            np.testing.assert_allclose(got["mean"], np.mean(sim), rtol=1e-6, atol=1e-6)
            np.testing.assert_allclose(got["std"], np.std(sim), rtol=1e-6, atol=1e-6)
            assert got["min"] == sim.min()
            assert got["max"] == sim.max()
            assert got["n_valid"] == len(sim)
            for stat, q in PERCENTILE_STATS.items():
                np.testing.assert_allclose(
                    got[stat], np.percentile(sim, q), rtol=1e-6, atol=1e-5, err_msg=f"{name} {stat}"
                )


def test_residuals_are_simulated_minus_observed_for_weighted_and_zero_weight_observations(
    tmp_path, in_process
):
    run, layout, _ = _ingest(tmp_path)
    stats = _by_name(run, layout)

    checked = 0
    for control_row, row in enumerate(run.rows):
        if row["obsval"] >= 1e20:
            continue
        sim = run.values[0][:, control_row]
        resid = sim - float(row["obsval"])
        got = stats[row["obsnme"]]
        np.testing.assert_allclose(got["resid_mean"], resid.mean(), rtol=1e-6, atol=1e-6)
        np.testing.assert_allclose(
            got["rmse"], np.sqrt((resid**2).mean()), rtol=1e-6, atol=1e-6
        )
        checked += 1
    weights = {row["weight"] for row in run.rows if row["obsval"] < 1e20}
    assert weights == {0.0, 1.0}  # the check covers both kinds
    assert checked == 6


def test_the_sidecar_names_the_stats_the_residual_sign_and_the_index_digest(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)

    sidecar = _sidecar(layout)
    index = load_obs_index(layout)

    assert sidecar["stats"] == list(OBS_STATS)
    assert sidecar["order_digest"] == index.order_digest
    assert sidecar["residual"] == "simulated minus observed"
    assert sidecar["shape"] == [len(OBS_STATS), len(run.obs_names)]
    assert sidecar["dtype"] == "<f4"


def test_obs_agg_is_planned_right_after_its_obs_ens_and_needs_both_inputs(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)

    from pesto.ingest.discover import discover

    planned = runner.plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "cache"))
    names = [a.name for a in planned]

    for iteration in (0, 1):
        assert names.index(f"obs_agg/{iteration}") == names.index(f"obs_ens/{iteration}") + 1
    agg = next(a for a in planned if a.name == "obs_agg/0")
    ens = next(a for a in planned if a.name == "obs_ens/0")
    assert agg.needs == ("obs_index", "obs_ens/0")
    assert agg.sources == ens.sources


def test_the_summary_comes_from_the_shared_routine_and_no_second_percentile_is_written(
    tmp_path, in_process, monkeypatch
):
    calls = []
    real = obsagg.summarise

    def _spy(values, names, noun="parameter"):
        calls.append((values.shape, noun))
        return real(values, names, noun=noun)

    monkeypatch.setattr(obsagg, "summarise", _spy)
    run, layout, _ = _ingest(tmp_path)

    assert calls, "obs_agg never called summarise"
    assert {noun for _shape, noun in calls} == {"observation"}
    source = inspect.getsource(obsagg)
    for banned in ("np.percentile", "np.quantile", "nanpercentile", "np.partition"):
        assert banned not in source


def test_blocks_of_rows_give_the_same_numbers_as_one_block(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)
    whole = np.array(load_obs_agg(0, layout).values)

    result = write_obs_agg(0, layout, block_rows=2)

    assert not isinstance(result, ReadFailure), result
    np.testing.assert_array_equal(np.array(load_obs_agg(0, layout).values), whole)


def test_obs_agg_reads_the_cached_ensemble_not_the_source_file(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)
    before = np.array(load_obs_agg(0, layout).values)
    run.obs_ens[0].write_bytes(b"gone")

    result = write_obs_agg(0, layout)

    assert not isinstance(result, ReadFailure), result
    np.testing.assert_array_equal(np.array(load_obs_agg(0, layout).values), before)


def test_a_rewrite_that_fails_leaves_no_old_sidecar_beside_a_missing_payload(
    tmp_path, in_process, monkeypatch
):
    run, layout, _ = _ingest(tmp_path)
    assert layout.obs_agg_meta(0).exists()

    def _boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(obsagg, "summarise", _boom)
    result = write_obs_agg(0, layout)

    assert isinstance(result, ReadFailure)
    assert "disk full" in result.reason
    assert result.reason.startswith("obs_agg/0:")
    assert not layout.obs_agg_meta(0).exists()


def test_load_obs_agg_refuses_a_statistics_file_built_against_another_obs_index(
    tmp_path, in_process
):
    run, layout, _ = _ingest(tmp_path)
    # The same observations listed in the opposite control order.
    other = build_obs_index(obs_arrow(list(reversed(run.rows))))
    assert other.order_digest != load_obs_index(layout).order_digest
    written = write_obs_index(other, layout)
    assert not isinstance(written, ReadFailure), written

    result = load_obs_agg(0, layout)

    assert isinstance(result, ReadFailure)
    assert "different obs_index" in result.reason
    assert result.reason.startswith("obs_agg/0:")


# ---------------------------------------------------------------------------
# sentinels, gaps, ties and precision
# ---------------------------------------------------------------------------


def _single(group, name, obsval, weight=1.0):
    return SiteSpec(group, name, (None,), "none", weight=weight, obsval=obsval)


EDGE_SITES = (
    _single("grp_a", "s_big", 1e30),
    _single("grp_a", "s_limit", 1e20),
    _single("grp_a", "s_under", 9.99e19),
    _single("grp_a", "s_blank", 0.5),
    _single("grp_a", "s_zero", 3.0, weight=0.0),
    _single("grp_a", "s_equal", 2.0),
    _single("grp_b", "s_allnan", 1.0),
    _single("grp_b", "s_one", 1.0),
    _single("less_x", "s_less", 3.0),
)


def _edge_values(n_real=4):
    values = sample_values(n_real, len(EDGE_SITES), seed=7)
    names = [site.site for site in EDGE_SITES]
    values[:, names.index("s_equal")] = 2.0
    values[:, names.index("s_allnan")] = np.nan
    values[:, names.index("s_one")] = np.nan
    values[0, names.index("s_one")] = 5.0
    return values


@pytest.fixture
def edge(tmp_path, in_process):
    run, layout, manifest = _ingest(
        tmp_path, sites=EDGE_SITES, values={0: _edge_values(), 1: _edge_values()}, blank_obsval=("s_blank",)
    )
    assert manifest.artifacts["obs_agg/0"].state == "ok", manifest.artifacts["obs_agg/0"].reason
    return run, layout, _by_name(run, layout), _sidecar(layout)


def test_a_sentinel_obsval_keeps_its_statistics_and_has_no_residual(edge):
    run, layout, stats, _sidecar_ = edge
    sim = run.values[0][:, run.obs_names.index("s_big")]

    got = stats["s_big"]

    np.testing.assert_allclose(got["mean"], sim.mean(), rtol=1e-6)
    assert got["n_valid"] == 4
    assert np.isnan(got["resid_mean"]) and np.isnan(got["rmse"])


def test_exactly_1e20_is_a_sentinel_and_9_99e19_gets_a_residual(edge):
    run, layout, stats, _sidecar_ = edge

    assert np.isnan(stats["s_limit"]["resid_mean"])
    assert np.isnan(stats["s_limit"]["rmse"])
    sim = run.values[0][:, run.obs_names.index("s_under")]
    assert np.isfinite(stats["s_under"]["resid_mean"])
    np.testing.assert_allclose(stats["s_under"]["resid_mean"], (sim - 9.99e19).mean(), rtol=1e-6)


def test_the_stored_array_holds_no_infinity_when_a_sentinel_is_present(edge):
    _run, layout, _stats, _sidecar_ = edge

    stored = load_obs_agg(0, layout)

    assert np.isinf(np.asarray(stored.values)).sum() == 0


def test_sentinels_are_counted_in_one_note_naming_at_most_three_of_them(edge):
    _run, _layout, _stats, sidecar = edge

    notes = [n for n in sidecar["notes"] if "placeholder" in n]

    assert len(notes) == 1
    assert notes[0].startswith("2 observation(s) have an obsval of 1e+20 or more")
    assert "s_big" in notes[0] and "s_limit" in notes[0]
    assert sidecar["counts"]["n_sentinel"] == 2


def test_more_than_three_sentinels_name_only_three_but_count_them_all(tmp_path, in_process):
    sites = tuple(_single("g", f"big{i}", 1e30) for i in range(5)) + (_single("g", "ok", 1.0),)
    run, layout, _ = _ingest(tmp_path, sites=sites)

    notes = [n for n in _sidecar(layout)["notes"] if "placeholder" in n]

    assert len(notes) == 1
    assert notes[0].startswith("5 observation(s)")
    assert sum(f"big{i}" in notes[0] for i in range(5)) == 3


def test_a_blank_obsval_gets_no_residual_and_its_own_note_not_the_sentinel_count(edge):
    _run, _layout, stats, sidecar = edge

    assert np.isfinite(stats["s_blank"]["mean"])
    assert np.isnan(stats["s_blank"]["resid_mean"]) and np.isnan(stats["s_blank"]["rmse"])
    blank_notes = [n for n in sidecar["notes"] if "no numeric obsval" in n]
    assert len(blank_notes) == 1 and "s_blank" in blank_notes[0]
    assert blank_notes[0].startswith("1 observation(s)")
    assert sidecar["counts"]["n_no_value"] == 1
    assert sidecar["counts"]["n_sentinel"] == 2


def test_a_zero_weight_observation_with_a_real_obsval_has_residuals(edge):
    run, _layout, stats, _sidecar_ = edge
    sim = run.values[0][:, run.obs_names.index("s_zero")]

    np.testing.assert_allclose(stats["s_zero"]["resid_mean"], (sim - 3.0).mean(), rtol=1e-6)
    np.testing.assert_allclose(
        stats["s_zero"]["rmse"], np.sqrt(((sim - 3.0) ** 2).mean()), rtol=1e-6
    )
    assert stats["s_zero"]["n_valid"] == 4


def test_a_simulated_value_equal_to_obsval_gives_a_residual_of_zero_not_a_gap(edge):
    _run, _layout, stats, _sidecar_ = edge

    assert stats["s_equal"]["resid_mean"] == 0.0
    assert stats["s_equal"]["rmse"] == 0.0
    assert stats["s_equal"]["std"] == 0.0


def test_an_observation_with_no_valid_realization_has_nan_statistics_and_one_note(edge):
    _run, _layout, stats, sidecar = edge

    got = stats["s_allnan"]

    assert got["n_valid"] == 0
    for stat in OBS_STATS:
        if stat != "n_valid":
            assert np.isnan(got[stat]), stat
    notes = [n for n in sidecar["notes"] if "has no valid realizations" in n]
    assert len(notes) == 1
    assert notes[0].startswith("observation 's_allnan' has no valid realizations")
    assert sidecar["counts"]["n_no_valid_realizations"] == 1


def test_one_valid_realization_gives_that_value_everywhere_and_nan_for_std(edge):
    _run, _layout, stats, _sidecar_ = edge

    got = stats["s_one"]

    assert got["n_valid"] == 1
    for stat in ("mean", "min", "max", *PERCENTILE_STATS):
        assert got[stat] == 5.0, stat
    assert np.isnan(got["std"])
    assert got["resid_mean"] == 4.0 and got["rmse"] == 4.0


def test_an_inequality_observation_stores_the_plain_residual_and_a_note_says_phi_is_one_sided(edge):
    run, _layout, stats, sidecar = edge
    sim = run.values[0][:, run.obs_names.index("s_less")]

    np.testing.assert_allclose(stats["s_less"]["resid_mean"], (sim - 3.0).mean(), rtol=1e-6)
    notes = [n for n in sidecar["notes"] if "inequality" in n]
    assert len(notes) == 1
    assert notes[0].startswith("1 observation(s) are in inequality groups")
    assert "one-sided" in notes[0]


def test_no_inequality_note_when_no_group_is_an_inequality(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)

    assert not [n for n in _sidecar(layout)["notes"] if "inequality" in n]


def test_means_and_spreads_are_accumulated_in_float64(tmp_path, in_process):
    n_real = 500
    sites = (_single("g", "big_values", 1.0e7 + 0.1),)
    rng = np.random.default_rng(3)
    values = (1.0e7 + rng.integers(-60, 61, size=(n_real, 1))).astype(np.float64)
    run, layout, _ = _ingest(tmp_path, sites=sites, values={0: values, 1: values}, n_real=n_real)

    got = _by_name(run, layout)["big_values"]

    stored = values.astype(np.float32).astype(np.float64)[:, 0]
    np.testing.assert_allclose(got["mean"], stored.mean(), rtol=1e-6)
    np.testing.assert_allclose(got["std"], stored.std(), rtol=1e-6)
    # The residual is formed from the float64 obsval; a float32 obsval would be off by up to 0.5.
    np.testing.assert_allclose(got["resid_mean"], (stored - (1.0e7 + 0.1)).mean(), rtol=1e-6)
    np.testing.assert_allclose(
        got["rmse"], np.sqrt(((stored - (1.0e7 + 0.1)) ** 2).mean()), rtol=1e-6
    )


def test_the_statistics_file_lists_the_same_order_as_the_obs_index(edge):
    run, layout, stats, sidecar = edge
    index = load_obs_index(layout)

    assert sidecar["order_digest"] == index.order_digest
    stored = load_obs_agg(0, layout)
    row = list(OBS_STATS).index("mean")
    for position, control_row in enumerate(index.order):
        sim = run.values[0][:, int(control_row)]
        if np.isnan(sim).all():
            assert np.isnan(stored.values[row, position])
        else:
            np.testing.assert_allclose(
                stored.values[row, position], np.nanmean(sim), rtol=1e-6, atol=1e-6
            )
