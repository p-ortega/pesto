"""Tests for ``src/pesto/ingest/obsread.py``: an observation ensemble file is
estimated from its header, read once, and matched to the control table by
name -- never by position."""

from __future__ import annotations

import warnings

import numpy as np
import pytest

from pesto.ingest import obsread
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsread import estimate_peak_bytes, read_obs_file

from . import fixtures
from .obs_files import DIALECTS, hash_ordered, obs_names, short_obs_names, write_obs_ensemble_file

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


# ---------------------------------------------------------------------------
# Every dialect gives the same answer
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("dialect", DIALECTS)
def test_every_dialect_gives_the_same_control_order_values_and_realization_names(
    tmp_path, dialect
):
    control = short_obs_names(12)
    file_order = hash_ordered(control)
    control_values = fixtures.sample_values(len(REALS), len(control))
    where = {name: i for i, name in enumerate(control)}
    file_values = control_values[:, [where[name] for name in file_order]]
    suffix = "csv" if "csv" in dialect else "jcb"
    path = write_obs_ensemble_file(tmp_path / f"case.0.obs.{suffix}", dialect, file_values, REALS, file_order)

    record = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(record, EnsembleData), getattr(record, "reason", None)
    assert record.real_names == tuple(REALS)
    assert record.permutation is not None
    assert np.array_equal(
        np.asarray(record.values)[:, list(record.permutation)], control_values.astype(np.float32)
    )
    assert record.orientation == ("variable_major" if dialect == "variable_major_csv" else "realization_major")


def test_a_partial_match_is_refused_with_counts_and_examples(tmp_path):
    control = short_obs_names(5)
    values = fixtures.sample_values(len(REALS), 4)
    path = write_obs_ensemble_file(tmp_path / "case.0.obs.jcb", "jcb", values, REALS, control[:4])

    result = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(result, ReadFailure)
    assert result.reason.startswith("obs_ens/0:")
    assert "matched 4 of 5 control observations" in result.reason
    assert "1 control name" in result.reason
    assert repr(control[4]) in result.reason


def test_an_extra_file_name_is_refused_and_counted(tmp_path):
    control = short_obs_names(5)
    file_names = [*control, "extra0"]
    values = fixtures.sample_values(len(REALS), 6)
    path = write_obs_ensemble_file(tmp_path / "case.0.obs.jcb", "jcb", values, REALS, file_names)

    result = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(result, ReadFailure)
    assert "1 file name" in result.reason
    assert "'extra0'" in result.reason


def test_a_name_that_appears_twice_is_refused(tmp_path):
    control = short_obs_names(5)
    file_names = [*control, control[1]]
    values = fixtures.sample_values(len(REALS), 6)
    path = write_obs_ensemble_file(tmp_path / "case.0.obs.csv", "csv", values, REALS, file_names)

    result = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(result, ReadFailure)
    assert "more than once" in result.reason
    assert repr(control[1]) in result.reason


def test_same_size_but_different_names_is_refused_never_read_by_position(tmp_path):
    control = short_obs_names(5)
    stranger_names = [f"zz{i}" for i in range(5)]
    values = fixtures.sample_values(len(REALS), 5)
    path = write_obs_ensemble_file(tmp_path / "case.0.obs.jcb", "jcb", values, REALS, stranger_names)

    result = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(result, ReadFailure)
    assert "matched 0 of 5 control observations" in result.reason


def test_neither_axis_matching_refuses_with_the_counts_compared(tmp_path):
    control = short_obs_names(5)
    values = fixtures.sample_values(4, 7)
    path = write_obs_ensemble_file(
        tmp_path / "case.0.obs.jcb", "jcb", values, REALS, [f"zz{i}" for i in range(7)]
    )

    result = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(result, ReadFailure)
    assert "ncol=7, nrow=4" in result.reason
    assert "5 observations" in result.reason


def test_a_legacy_file_with_truncated_long_names_is_refused_not_read_by_position(tmp_path):
    from pesto.warm import load_pyemu

    pyemu = load_pyemu()
    control = [f"o{i:02d}_" + "x" * 12 for i in range(5)]
    values = fixtures.sample_values(len(REALS), 5)
    path = tmp_path / "case.0.obs.jcb"
    matrix = pyemu.Matrix(x=values, row_names=REALS, col_names=control)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        matrix.to_binary(str(path))

    result = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(result, ReadFailure)
    assert "matched 0 of 5 control observations" in result.reason


def test_a_name_matching_only_after_trim_and_lower_case_is_read_with_one_note(tmp_path):
    control = ["OBS_A", "OBS_B"]
    values = fixtures.sample_values(len(REALS), 2)
    path = write_obs_ensemble_file(tmp_path / "case.0.obs.csv", "csv", values, REALS, ["obs_a", "obs_b"])

    record = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(record, EnsembleData)
    notes = [n for n in record.notes if "only after trimming spaces and lower-casing" in n]
    assert len(notes) == 1
    assert notes[0].startswith("2 observation names")
    assert "'obs_a' for 'OBS_A'" in notes[0]


def test_exact_names_leave_no_repair_note(tmp_path):
    path, control, _, _ = _hash_ordered_case(tmp_path)

    record = read_obs_file(path, control, artifact="obs_ens/3")

    assert isinstance(record, EnsembleData)
    assert not [n for n in record.notes if "trimming" in n]


@pytest.mark.parametrize("dialect", ["dense", "jcb", "csv"])
def test_a_file_with_no_realizations_is_refused_naming_the_file(tmp_path, dialect):
    control = short_obs_names(4)
    suffix = "csv" if dialect == "csv" else "jcb"
    path = write_obs_ensemble_file(
        tmp_path / f"case.0.obs.{suffix}", dialect, fixtures.sample_values(0, 4), [], control
    )

    result = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(result, ReadFailure)
    assert "holds no realizations" in result.reason
    assert path.name in result.reason


def test_a_file_with_one_realization_is_read(tmp_path):
    control = short_obs_names(4)
    values = fixtures.sample_values(1, 4)
    path = write_obs_ensemble_file(tmp_path / "case.0.obs.bin", "dense", values, ["base"], control)

    record = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(record, EnsembleData)
    assert record.real_names == ("base",)
    assert record.values.shape == (1, 4)


def test_a_nan_value_leaves_the_existing_note(tmp_path):
    control = short_obs_names(4)
    values = fixtures.sample_values(len(REALS), 4)
    values[1, 2] = np.nan
    path = write_obs_ensemble_file(tmp_path / "case.0.obs.bin", "dense", values, REALS, control)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        record = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(record, EnsembleData)
    assert any("contains at least one NaN value" in n for n in record.notes)


def test_a_missing_file_is_refused_as_not_on_disk(tmp_path):
    result = read_obs_file(tmp_path / "nope.jcb", ["a"], artifact="obs_ens/0")

    assert isinstance(result, ReadFailure)
    assert "is not on disk" in result.reason


def test_realization_names_are_kept_in_file_order_with_base_wherever_it_sits(tmp_path):
    control = short_obs_names(4)
    reals = ["12", "7", "base", "3"]
    values = fixtures.sample_values(4, 4)
    path = write_obs_ensemble_file(tmp_path / "case.0.obs.bin", "dense", values, reals, control)

    record = read_obs_file(path, control, artifact="obs_ens/0")

    assert isinstance(record, EnsembleData)
    assert record.real_names == tuple(reals)
