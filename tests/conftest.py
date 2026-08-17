"""Shared pytest fixtures for the pesto test suite.

Phase 1 reads no PEST file, so no benchmark or pypestvis fixtures lived here
at first. Phase 2 adds the real-benchmark-run fixtures below: each one skips
(never fails) when its directory is absent, so a fresh clone with no
benchmark data present still runs a green suite. ``PESTO_BENCH`` lets this
suite run against any developer's working copies rather than being wired to
one home directory.

Phase 3 adds two more fixtures, for two public example runs (fetchable with
``scripts/get_fixtures.sh``, never required) that reach rule-table paths no
real benchmark run does: a single-layer structured grid, and a multi-layer
structured grid whose parameter groups carry the triple-index and
layer-in-the-name shapes. Both follow the exact same skip-if-absent shape.
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


_FIXTURES_ROOT = Path("tests/fixtures")


@pytest.fixture(scope="session")
def single_layer_structured_run() -> Path:
    """``pypestvis``'s ``lheg_ies`` -- the only real single-layer structured
    (DIS) grid reachable anywhere, real ``.grb`` included. Fetch it with
    ``scripts/get_fixtures.sh``; this fixture skips, never fails, when it is
    not present."""
    run_dir = _FIXTURES_ROOT / "lheg_ies"
    if not run_dir.is_dir():
        pytest.skip(f"example run directory not found: {run_dir}")
    return run_dir


@pytest.fixture(scope="session")
def multi_layer_structured_run() -> Path:
    """``pypestvis``'s ``freyberg_ies`` -- a multi-layer structured (DIS)
    run whose parameter groups carry the triple-index (``idx0``/``idx1``/
    ``idx2``) and layer-in-the-name shapes. It ships no binary ``.grb`` file
    -- only the ASCII ``freyberg6.dis`` package -- so nothing here builds a
    ``Mf6Adapter`` from it; the grid shape is read from the same ``.dis``
    file's own ``Dimensions`` block instead. Fetch it with
    ``scripts/get_fixtures.sh``; this fixture skips, never fails, when it is
    not present."""
    run_dir = _FIXTURES_ROOT / "freyberg_ies"
    if not run_dir.is_dir():
        pytest.skip(f"example run directory not found: {run_dir}")
    return run_dir
