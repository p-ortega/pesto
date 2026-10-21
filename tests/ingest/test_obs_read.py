"""Tests for ``src/pesto/ingest/obsread.py``: an observation ensemble file is
estimated from its header, read once, and matched to the control table by
name -- never by position."""

from __future__ import annotations

import numpy as np

from pesto.ingest import obsread
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.obsread import estimate_peak_bytes, read_obs_file

from . import fixtures
from .obs_files import hash_ordered, obs_names, write_obs_ensemble_file

REALS = ["34", "base", "35", "176"]


def _hash_ordered_case(tmp_path, n_obs=12):
    control = obs_names(n_obs)
    file_order = hash_ordered(control)
    assert file_order != control
    control_values = fixtures.sample_values(len(REALS), n_obs)
    index_in_control = {name: i for i, name in enumerate(control)}
    file_values = control_values[:, [index_in_control[name] for name in file_order]]
    path = write_obs_ensemble_file(tmp_path / "case.3.obs.jcb", "jcb", file_values, REALS, file_order)
    return path, control, file_order, control_values


def test_hash_ordered_jcb_is_read_once_and_matched_to_control_names(tmp_path):
    path, control, file_order, control_values = _hash_ordered_case(tmp_path)

    record = read_obs_file(path, control, artifact="obs_ens/3")

    assert isinstance(record, EnsembleData)
    assert record.real_names == tuple(REALS)
    assert record.real_names[1] == "base"
    assert record.entity_names == tuple(file_order)
    assert record.values.dtype == np.float32
    assert record.permutation is not None
    in_control_order = record.values[:, list(record.permutation)]
    assert np.array_equal(in_control_order, control_values.astype(np.float32))
    assert record.orientation == "realization_major"
    assert record.orientation_decided_by == "dimensions"
    assert record.hash_ordered is True


def test_estimate_for_a_coo_file_reads_the_header_and_gives_the_formula(tmp_path):
    path, control, _, _ = _hash_ordered_case(tmp_path)
    icount = int(np.fromfile(path, dtype="<i4", count=3)[2])

    estimate = estimate_peak_bytes(path)

    nrow, ncol = len(REALS), len(control)
    assert estimate.dialect == "coo"
    assert (estimate.nrow, estimate.ncol, estimate.icount) == (nrow, ncol, icount)
    assert estimate.raw_bytes == 16 * icount + 8 * nrow * ncol + 300 * (nrow + ncol)
    assert estimate.guarded_bytes >= estimate.raw_bytes


def test_the_estimate_is_made_before_pyemu_is_called(tmp_path, monkeypatch):
    path, control, _, _ = _hash_ordered_case(tmp_path)
    calls: list[str] = []
    real_estimate = obsread.estimate_peak_bytes
    real_sniff = obsread.sniff

    def spy_estimate(p):
        calls.append("estimate")
        return real_estimate(p)

    def spy_sniff(p):
        calls.append("sniff")
        return real_sniff(p)

    monkeypatch.setattr(obsread, "estimate_peak_bytes", spy_estimate)
    monkeypatch.setattr(obsread, "sniff", spy_sniff)

    record = read_obs_file(path, control, artifact="obs_ens/3")

    assert isinstance(record, EnsembleData)
    assert calls[0] == "estimate"
    assert calls.index("estimate") < calls.index("sniff")
