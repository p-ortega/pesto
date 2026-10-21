"""The memory guard in ``pesto.ingest.obsread``: every dialect is sized from
its header, the budget is per machine, and an oversized file is refused
before pyemu is asked to read anything."""

from __future__ import annotations

import os
import tracemalloc

import numpy as np
import pytest

from pesto.ingest import obsread
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsread import (
    FALLBACK_BUDGET_BYTES,
    BUDGET_FRACTION,
    MemoryBudget,
    estimate_peak_bytes,
    memory_budget,
    read_obs_file,
)

from . import fixtures
from .obs_files import obs_names, short_obs_names, write_header_only_coo, write_obs_ensemble_file

GIB = 1024**3


def _filled_coo(tmp_path, n_real, n_obs):
    names = obs_names(n_obs)
    reals = [str(i) for i in range(n_real)]
    values = fixtures.sample_values(n_real, n_obs)
    path = write_obs_ensemble_file(tmp_path / "big.jcb", "jcb", values, reals, names)
    return path, names


def test_the_raw_estimate_is_within_ten_percent_of_the_measured_peak(tmp_path):
    # 500 x 4000 = 2,000,000 cells, all filled: the shape of a real obs file.
    path, names = _filled_coo(tmp_path, 500, 4000)
    estimate = estimate_peak_bytes(path)
    assert estimate.icount >= 1_990_000

    tracemalloc.start()
    try:
        record = read_obs_file(path, names, artifact="obs_ens/0")
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert not isinstance(record, ReadFailure), record
    assert abs(estimate.raw_bytes - peak) / peak <= 0.10
    assert estimate.guarded_bytes >= peak


def test_the_guarded_estimate_covers_a_mostly_empty_file_too(tmp_path):
    names = obs_names(2000)
    reals = [str(i) for i in range(500)]
    values = fixtures.sample_values(500, 2000)
    rng = np.random.default_rng(1)
    values[rng.random(values.shape) > 0.05] = 0.0
    path = write_obs_ensemble_file(tmp_path / "sparse.jcb", "jcb", values, reals, names)
    estimate = estimate_peak_bytes(path)

    tracemalloc.start()
    try:
        record = read_obs_file(path, names, artifact="obs_ens/0")
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert not isinstance(record, ReadFailure), record
    assert estimate.guarded_bytes >= peak


def test_a_dense_file_is_sized_by_its_real_row_and_column_counts(tmp_path):
    names = short_obs_names(7)
    reals = ["base", "34", "35", "176", "12"]  # name lengths differ row to row
    values = fixtures.sample_values(len(reals), len(names))
    path = write_obs_ensemble_file(tmp_path / "d.bin", "dense", values, reals, names)

    estimate = estimate_peak_bytes(path)

    assert estimate.dialect == "dense"
    assert estimate.ncol == 7
    assert estimate.nrow == 5
    assert estimate.raw_bytes == 16 * 5 * 7 + 300 * (5 + 7)


def test_a_csv_file_is_estimated_as_five_times_its_size(tmp_path):
    names = short_obs_names(6)
    values = fixtures.sample_values(4, 6)
    path = write_obs_ensemble_file(tmp_path / "c.csv", "csv", values, ["a", "b", "c", "d"], names)

    estimate = estimate_peak_bytes(path)

    assert estimate.dialect == "csv"
    assert estimate.raw_bytes == 5 * os.path.getsize(path)


def test_a_legacy_file_is_sized_with_its_own_name_widths(tmp_path):
    names = short_obs_names(6)
    reals = ["base", "34", "35"]
    values = fixtures.sample_values(len(reals), len(names))
    path = write_obs_ensemble_file(tmp_path / "l.jcb", "legacy_jcb", values, reals, names)

    estimate = estimate_peak_bytes(path)

    assert estimate.dialect == "legacy_coo"
    assert (estimate.nrow, estimate.ncol) == (3, 6)
    assert os.path.getsize(path) == 12 + 12 * estimate.icount + 12 * 6 + 20 * 3


def test_a_truncated_coo_file_is_refused_before_reading_with_both_sizes(tmp_path, monkeypatch):
    path, names = _filled_coo(tmp_path, 20, 50)
    size = os.path.getsize(path)
    with open(path, "r+b") as f:
        f.truncate(size - 100)
    _forbid_pyemu_reads(monkeypatch)

    result = read_obs_file(path, names, artifact="obs_ens/1")

    assert isinstance(result, ReadFailure)
    assert str(size) in result.reason
    assert str(size - 100) in result.reason


def test_a_dense_file_cut_off_mid_row_is_refused_before_reading(tmp_path, monkeypatch):
    names = short_obs_names(5)
    values = fixtures.sample_values(3, 5)
    path = write_obs_ensemble_file(tmp_path / "d.bin", "dense", values, ["a", "b", "c"], names)
    with open(path, "r+b") as f:
        f.truncate(os.path.getsize(path) - 8)
    _forbid_pyemu_reads(monkeypatch)

    result = read_obs_file(path, names, artifact="obs_ens/1")

    assert isinstance(result, ReadFailure)
    assert "row 2" in result.reason


def _forbid_pyemu_reads(monkeypatch):
    from pesto.warm import load_pyemu

    pyemu = load_pyemu()

    def boom(*args, **kwargs):
        raise AssertionError("pyemu was asked to read a file the guard should have refused")

    monkeypatch.setattr(pyemu.Matrix, "from_binary", boom)


def test_an_oversized_claim_is_refused_before_pyemu_is_called(tmp_path, monkeypatch):
    path = write_header_only_coo(tmp_path / "case.3.obs.jcb", nrow=500, ncol=200_000)
    _forbid_pyemu_reads(monkeypatch)
    budget = MemoryBudget(bytes=100 * 1024**2, physical_bytes=16 * GIB, fraction=0.6, note="")

    result = read_obs_file(path, ["x"], artifact="obs_ens/3", budget=budget)

    assert isinstance(result, ReadFailure)
    assert result.reason.startswith("obs_ens/3:")
    assert "case.3.obs.jcb" in result.reason
    assert "GB" in result.reason
    assert "pesto allows 0.1 GB" in result.reason
    assert "16.0 GB" in result.reason
    assert "obs_ens/3 is not read" in result.reason


def test_a_refusal_with_the_fallback_budget_says_memory_could_not_be_read(tmp_path, monkeypatch):
    # 500 x 1,000,000 cells is about 4.4 GB, over the fixed 2 GiB allowance.
    path = write_header_only_coo(tmp_path / "case.3.obs.jcb", nrow=500, ncol=1_000_000)
    _forbid_pyemu_reads(monkeypatch)
    monkeypatch.setattr(obsread, "_physical_memory_bytes", lambda: None)

    result = read_obs_file(path, ["x"], artifact="obs_ens/3")

    assert isinstance(result, ReadFailure)
    assert "could not read this computer's memory" in result.reason
    assert "fixed 2.0 GB" in result.reason


def test_a_crafted_header_cannot_overflow_the_arithmetic(tmp_path, monkeypatch):
    path = tmp_path / "crafted.jcb"
    header = np.array([(2**31 - 1, 2**31 - 1, 0)], dtype="<i4,<i4,<i4")
    path.write_bytes(header.tobytes())
    _forbid_pyemu_reads(monkeypatch)

    result = read_obs_file(path, ["x"], artifact="obs_ens/9")

    assert isinstance(result, ReadFailure)
    assert "its header implies a file of" in result.reason


def test_memory_budget_is_sixty_percent_of_physical_memory():
    physical = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")

    budget = memory_budget()

    assert budget.physical_bytes == physical
    assert budget.fraction == BUDGET_FRACTION == 0.6
    assert budget.bytes == int(physical * 0.6)


def test_memory_budget_falls_back_to_two_gib_and_says_so(monkeypatch):
    monkeypatch.setattr(obsread, "_physical_memory_bytes", lambda: None)

    budget = memory_budget()

    assert budget.bytes == FALLBACK_BUDGET_BYTES == 2 * GIB
    assert budget.physical_bytes is None
    assert "could not read this computer's memory" in budget.note


def test_no_forbidden_reader_name_appears_in_the_source_tree():
    from pathlib import Path

    root = Path(obsread.__file__).resolve().parents[1]
    forbidden = ("read_dense", "ObservationEnsemble", "ParameterEnsemble", "to_dataframe")
    hits = [
        f"{path.name}: {word}"
        for path in root.rglob("*.py")
        for word in forbidden
        if word in path.read_text()
    ]
    assert hits == []


@pytest.mark.parametrize("nrow,ncol", [(3, 4), (10, 2)])
def test_header_only_file_is_sized_exactly_as_its_header_says(tmp_path, nrow, ncol):
    path = write_header_only_coo(tmp_path / "h.jcb", nrow=nrow, ncol=ncol)

    estimate = estimate_peak_bytes(path)

    assert (estimate.nrow, estimate.ncol, estimate.icount) == (nrow, ncol, 0)
