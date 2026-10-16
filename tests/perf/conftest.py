"""Shared setup for the slow suite: each real benchmark run is ingested once, into a pytest tmp cache."""

from __future__ import annotations

import time

import pytest


@pytest.fixture(scope="session", params=["forecast_run", "hm_run", "pl253_run"])
def ingested_real_run(request, tmp_path_factory):
    """(run_dir, cache_dir) for one real run. The cache is never a benchmark `.pesto` folder."""
    from pesto.ingest.runner import ingest_run

    run_dir = request.getfixturevalue(request.param)
    cache_dir = tmp_path_factory.mktemp(f"cache-{request.param}")
    began = time.perf_counter()
    ingest_run(run_dir, cache_root=cache_dir)
    print(f"\n{request.param}: ingested in {time.perf_counter() - began:.1f} s")
    return run_dir, cache_dir
