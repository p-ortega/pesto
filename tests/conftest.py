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
