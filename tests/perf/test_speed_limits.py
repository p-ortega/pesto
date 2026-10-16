"""The speed limits as pass or fail. Every verdict comes from pesto.bench.limits.passes, so these tests
and `pesto bench` cannot disagree, and no limit value is typed in this file."""

from __future__ import annotations

import time

import pytest
from ingest.fixtures import make_run

from pesto.bench.limits import SPEED_LIMITS, passes

MIN_NET_SMALL_SECONDS = 2.0
GROWTH_REALIZATIONS = 100
GROWTH_SMALL_PARAMETERS = 50_000
GROWTH_FIXED_PARAMETERS = 20
VALUES_SAMPLES = 300


class CannotJudge(Exception):
    """The measurement is too small or too noisy to say whether the limit holds."""


def ingest_seconds(run_dir, cache_dir) -> float:
    """Wall time of the ingest call alone."""
    from pesto.ingest.runner import ingest_run

    began = time.perf_counter()
    ingest_run(run_dir, cache_root=cache_dir)
    return time.perf_counter() - began


def net_growth_ratio(fixed: float, small: float, large: float, min_net_small: float = MIN_NET_SMALL_SECONDS) -> float:
    """Growth of the time over the fixed start-up cost, large over small."""
    net_small = small - fixed
    if net_small < min_net_small:
        raise CannotJudge(
            f"cannot judge: the small case nets {net_small:.1f} s over the fixed cost, "
            f"under the {min_net_small:g} s floor needed to tell growth from noise"
        )
    return (large - fixed) / net_small


def test_net_growth_ratio_refuses_to_judge_a_small_case_too_quick_to_measure():
    with pytest.raises(CannotJudge, match=r"1\.0 s.*2 s floor"):
        net_growth_ratio(fixed=6.0, small=7.0, large=20.0)


def test_net_growth_ratio_arithmetic():
    assert net_growth_ratio(fixed=6.0, small=10.0, large=30.0) == 6.0


def _timed_synthetic_ingest(tmp_path, label, n_par):
    run_dir = tmp_path / label
    run_dir.mkdir()
    make_run(run_dir, n_real=GROWTH_REALIZATIONS, n_par=n_par, iterations=(0,), starting_par_en=None, extras=False)
    return ingest_seconds(run_dir, tmp_path / f"cache-{label}")


@pytest.mark.slow
def test_ingest_growth_4x_data_under_10x_time_net_of_fixed_cost(tmp_path):
    factor = int(SPEED_LIMITS.ingest_growth_data_factor)
    fixed = _timed_synthetic_ingest(tmp_path, "fixed", GROWTH_FIXED_PARAMETERS)
    small = _timed_synthetic_ingest(tmp_path, "small", GROWTH_SMALL_PARAMETERS)
    large = _timed_synthetic_ingest(tmp_path, "large", GROWTH_SMALL_PARAMETERS * factor)
    print(f"\ningest seconds: fixed {fixed:.1f}, small {small:.1f}, large {large:.1f}")
    try:
        ratio = net_growth_ratio(fixed, small, large)
    except CannotJudge as exc:
        pytest.fail(str(exc))
    print(f"net growth for {factor}x the parameters: {ratio:.2f}x")
    assert passes("ingest_growth_time_factor", ratio), f"{factor}x the parameters took {ratio:.2f}x the net time"


@pytest.mark.slow
def test_grid_values_p95_within_its_speed_limit_on_a_real_run(ingested_real_run):
    from pesto.bench.serve import BenchServer, measure_values, pick_browser_targets

    run_dir, cache_dir = ingested_real_run
    with BenchServer(cache_dir, run_dir) as server:
        iteration = pick_browser_targets(server).iteration
        latency = measure_values(server, iteration, VALUES_SAMPLES)

    for kind in ("realization", "statistic"):
        summary = getattr(latency, kind)
        print(f"\n{run_dir.name} {kind}: {summary}")
        if summary is None:
            pytest.fail(f"{kind} was not measured: {'; '.join(latency.notes)}")
        assert passes("values_p95_seconds", summary.p95_seconds), (
            f"{kind} p95 {summary.p95_seconds * 1000:.0f} ms is over the speed limit"
        )


@pytest.mark.slow
def test_cache_within_its_speed_limit_of_source_size_on_a_real_run(ingested_real_run):
    from pesto.bench.measure import cache_size

    run_dir, cache_dir = ingested_real_run
    size = cache_size(run_dir, cache_dir)
    print(f"\n{run_dir.name}: cache {size.cache_bytes} bytes, sources {size.source_bytes} bytes, ratio {size.ratio}")
    if size.ratio is None:
        pytest.fail("cannot judge: the run has no source bytes to compare the cache with")
    assert passes("cache_ratio", size.ratio), f"cache is {size.ratio:.2f}x the source size"
