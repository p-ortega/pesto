"""Tests for ``src/pesto/ingest/obsweights.py``: the adjusted weights pestpp
used are read by realization and observation name, through the memory guard,
and refused with counts when a column is not a control observation."""

from __future__ import annotations

import numpy as np

from pesto.ingest import obsweights
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsread import MemoryBudget
from pesto.ingest.obsweights import AdjustedWeights, read_adjusted_weights

from . import fixtures
from .obs_files import hash_ordered, obs_names, write_obs_ensemble_file

REALS = ["base", "r1"]
_ARTIFACT = "adjusted_weights"


def _subset_case(tmp_path, n_control=5, n_cols=3, dialect="jcb", suffix="jcb"):
    """A weights file with columns for ``n_cols`` of ``n_control`` control
    observations, written in hash order, with distinct values per cell."""
    control = obs_names(n_control)
    columns = hash_ordered(control[:n_cols])
    assert columns != control[:n_cols]
    values = np.arange(1, len(REALS) * n_cols + 1, dtype=np.float64).reshape(len(REALS), n_cols)
    path = write_obs_ensemble_file(
        tmp_path / f"case.adjusted.weights.{suffix}", dialect, values, REALS, columns
    )
    return path, control, columns, values


def test_a_hash_ordered_subset_reads_by_realization_and_observation_name(tmp_path):
    path, control, columns, values = _subset_case(tmp_path)

    record = read_adjusted_weights(path, control, artifact=_ARTIFACT)

    assert isinstance(record, AdjustedWeights)
    assert record.weights.shape == (2, 3)
    assert record.weights.dtype == np.float64
    assert record.real_names == tuple(REALS)
    assert record.obs_names == tuple(columns)
    assert record.n_unweighted == 2
    assert record.source == path
    for j, name in enumerate(columns):
        assert control[record.control_rows[j]] == name
    for r, real in enumerate(REALS):
        for j, name in enumerate(columns):
            assert record.weights[record.real_names.index(real), record.obs_names.index(name)] == values[r, j]


def test_the_weights_keep_the_float64_precision_the_file_holds(tmp_path):
    control = obs_names(2)
    exact = np.array([[0.1 + 1e-12, 1.0 / 3.0]])
    path = write_obs_ensemble_file(tmp_path / "case.adjusted.weights.jcb", "jcb", exact, ["base"], control)

    record = read_adjusted_weights(path, control, artifact=_ARTIFACT)

    assert isinstance(record, AdjustedWeights)
    assert np.array_equal(record.weights, exact)


def test_every_dialect_reads_the_same_weights_by_name(tmp_path):
    control = obs_names(4)
    columns = hash_ordered(control)
    values = fixtures.sample_values(2, 4)
    results = []
    for dialect, suffix in (("jcb", "jcb"), ("dense", "bin"), ("csv", "csv")):
        path = write_obs_ensemble_file(
            tmp_path / f"{dialect}.adjusted.weights.{suffix}", dialect, values, REALS, columns
        )
        record = read_adjusted_weights(path, control, artifact=_ARTIFACT)
        assert isinstance(record, AdjustedWeights), getattr(record, "reason", "")
        results.append(record)
    for record in results[1:]:
        assert record.real_names == results[0].real_names
        assert record.obs_names == results[0].obs_names
        assert np.allclose(record.weights, results[0].weights)
        assert np.array_equal(record.control_rows, results[0].control_rows)
    assert results[0].n_unweighted == 0


def test_a_variable_major_file_is_read_by_names(tmp_path):
    path, control, columns, values = _subset_case(tmp_path, dialect="variable_major_csv", suffix="csv")

    record = read_adjusted_weights(path, control, artifact=_ARTIFACT)

    assert isinstance(record, AdjustedWeights), getattr(record, "reason", "")
    assert record.real_names == tuple(REALS)
    assert record.obs_names == tuple(columns)
    assert np.allclose(record.weights, values)


def test_a_column_that_is_not_a_control_observation_is_refused_with_counts(tmp_path):
    control = obs_names(5)
    columns = [control[0], control[1], "not_an_obs"]
    path = write_obs_ensemble_file(
        tmp_path / "case.adjusted.weights.jcb", "jcb", np.ones((2, 3)), REALS, columns
    )

    record = read_adjusted_weights(path, control, artifact=_ARTIFACT)

    assert isinstance(record, ReadFailure)
    assert record.reason.startswith(f"{_ARTIFACT}: ")
    assert "1 file name(s) not in the control table" in record.reason
    assert "'not_an_obs'" in record.reason


def test_a_column_that_is_not_a_control_observation_is_refused_when_dimensions_decide(tmp_path):
    control = obs_names(3)
    columns = [control[0], control[1], "not_an_obs"]
    path = write_obs_ensemble_file(
        tmp_path / "case.adjusted.weights.jcb", "jcb", np.ones((2, 3)), REALS, columns
    )

    record = read_adjusted_weights(path, control, artifact=_ARTIFACT)

    assert isinstance(record, ReadFailure)
    assert "1 file name(s) not in the control table" in record.reason
    assert "'not_an_obs'" in record.reason


def test_a_column_twice_is_refused_with_the_duplicate_named(tmp_path):
    control = obs_names(5)
    columns = [control[0], control[1], control[1], control[2]]
    path = write_obs_ensemble_file(
        tmp_path / "case.adjusted.weights.csv", "csv", np.ones((2, 4)), REALS, columns
    )

    record = read_adjusted_weights(path, control, artifact=_ARTIFACT)

    assert isinstance(record, ReadFailure)
    assert "1 name(s) appear more than once" in record.reason
    assert repr(control[1]) in record.reason


def test_a_file_that_will_not_fit_is_refused_before_any_read(tmp_path, monkeypatch):
    path, control, _, _ = _subset_case(tmp_path)
    tiny = MemoryBudget(bytes=1, physical_bytes=1024**2, fraction=1.0, note="")

    def boom(*args, **kwargs):
        raise AssertionError("the matrix was read although it will not fit")

    monkeypatch.setattr(obsweights, "_read_binary_matrix", boom)
    monkeypatch.setattr(obsweights, "_read_csv_matrix", boom)

    record = read_adjusted_weights(path, control, artifact=_ARTIFACT, budget=tiny)

    assert isinstance(record, ReadFailure)
    assert record.reason.startswith(f"{_ARTIFACT}: ")
    assert "is not read" in record.reason


def test_an_upper_case_control_name_matches_a_lower_case_column_with_a_note(tmp_path):
    control_lower = obs_names(4)
    control = [name.upper() if i == 0 else name for i, name in enumerate(control_lower)]
    path = write_obs_ensemble_file(
        tmp_path / "case.adjusted.weights.jcb", "jcb", np.ones((2, 4)), REALS, control_lower
    )

    record = read_adjusted_weights(path, control, artifact=_ARTIFACT)

    assert isinstance(record, AdjustedWeights), getattr(record, "reason", "")
    assert record.obs_names == tuple(control_lower)
    assert control[record.control_rows[0]] == control[0]
    assert any("only after trimming spaces and lower-casing" in note for note in record.notes)


def test_a_weight_that_is_zero_in_some_realizations_only_is_counted_in_one_note(tmp_path):
    control = obs_names(3)
    values = np.array([[0.0, 1.0, 0.0], [2.0, 1.0, 0.0]])
    path = write_obs_ensemble_file(
        tmp_path / "case.adjusted.weights.jcb", "jcb", values, REALS, control
    )

    record = read_adjusted_weights(path, control, artifact=_ARTIFACT)

    assert isinstance(record, AdjustedWeights)
    mixed = [n for n in record.notes if "weight 0 in some realizations" in n]
    assert len(mixed) == 1
    assert mixed[0].startswith("1 observation(s)")


def test_a_missing_file_is_a_failure_not_an_exception(tmp_path):
    record = read_adjusted_weights(
        tmp_path / "case.adjusted.weights.jcb", obs_names(3), artifact=_ARTIFACT
    )

    assert isinstance(record, ReadFailure)
    assert "is not on disk" in record.reason
