"""Shared pytest fixtures for the pesto test suite.

Phase 1 reads no PEST file, so no benchmark or pypestvis fixtures lived here
at first. Phase 2 adds the real-benchmark-run fixtures below: each one skips
(never fails) when its directory is absent, so a fresh clone with no
benchmark data present still runs a green suite. ``PESTO_BENCH`` lets this
suite run against any developer's working copies rather than being wired to
one home directory.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def benchmark_root() -> Path:
    return Path(os.environ.get("PESTO_BENCH", Path.home() / "dev" / "data" / "pesto-bench"))


@pytest.fixture(scope="session")
def forecast_run(benchmark_root: Path) -> Path:
    run_dir = benchmark_root / "forecast_20250618105403"
    if not run_dir.is_dir():
        pytest.skip(f"benchmark run directory not found: {run_dir}")
    return run_dir


@pytest.fixture(scope="session")
def hm_run(benchmark_root: Path) -> Path:
    run_dir = benchmark_root / "hm_20250406221554"
    if not run_dir.is_dir():
        pytest.skip(f"benchmark run directory not found: {run_dir}")
    return run_dir


@pytest.fixture(scope="session")
def pl253_run(benchmark_root: Path) -> Path:
    """The only benchmark run holding two ``.grb`` files -- ``org.grb`` and
    ``pl253.disv.grb`` -- the real, unresolved grid-file ambiguity."""
    run_dir = benchmark_root / "hm_20251104154614"
    if not run_dir.is_dir():
        pytest.skip(f"benchmark run directory not found: {run_dir}")
    return run_dir


@pytest.fixture(scope="session")
def restarted_run(benchmark_root: Path) -> Path:
    """A restarted run whose control file names
    ``ies_restart_observation_ensemble``, a file genuinely absent from disk
    -- the real named-and-missing case for the restart option."""
    run_dir = benchmark_root / "hm_20250406221554_restarted"
    if not run_dir.is_dir():
        pytest.skip(f"benchmark run directory not found: {run_dir}")
    return run_dir
