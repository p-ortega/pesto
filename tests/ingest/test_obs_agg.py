"""obs_agg/K: per-observation statistics and residuals from the cached ensemble.

The tracer ingests a generated run and checks every stored number against
numpy on the values the generator wrote for that observation name. The later
tests pin each edge of how targets, sentinels and gaps are treated.
"""

from __future__ import annotations

import inspect
import json

import numpy as np
import pytest

import pesto.ingest.obsagg as obsagg
import pesto.ingest.runner as runner
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsagg import OBS_STATS, load_obs_agg, write_obs_agg
from pesto.ingest.obsindex import build_obs_index, load_obs_index, write_obs_index
from pesto.ingest.runner import ingest_run

from .fixtures import _ENSEMBLE_WRITERS
from .obs_fixtures import DEFAULT_SITES, SiteSpec, make_obs_run, obs_arrow, rows_for
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)

PERCENTILE_STATS = {"q05": 5, "q25": 25, "q50": 50, "q75": 75, "q95": 95}


def _ingest(tmp_path, *, sites=None, values=None, **kwargs):
    """Ingest a generated run. ``values`` maps an iteration to the
    realization-major array (control order) to write over the generated
    observation file before the ingest."""
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, sites=sites, **kwargs)
    for iteration, array in (values or {}).items():
        writer = _ENSEMBLE_WRITERS["jcb"][0]
        writer(run.obs_ens[iteration], array, run.real_names, run.obs_names)
        run.values[iteration] = np.asarray(array, dtype=np.float64)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root), manifest


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
