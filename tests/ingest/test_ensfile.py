"""Tests for ``src/pesto/ingest/ensfile.py``.

Every on-disk ensemble shape pestpp-ies writes -- dense ``.bin``, modern and
legacy ``.jcb``, realization-major and variable-major CSV -- must read to
identical realization-major float32 values, with orientation decided
honestly (dimensions first, names second, refusal when neither decides) and
unreadable files failing named rather than raising. Every fixture comes from
``tests/ingest/fixtures.py``; nothing here reads data outside ``tmp_path``.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pesto.ingest.control import ControlTables
from pesto.ingest.ensfile import EnsembleData, read_ensemble, sniff
from pesto.ingest.failures import ReadFailure

from . import fixtures


def _control_tables(entity_names: list[str]) -> ControlTables:
    """A minimal ``ControlTables`` carrying only what ``read_ensemble``'s
    orientation decision needs: ``par["parnme"]`` in control-file order."""
    return ControlTables(
        par=pd.DataFrame({"parnme": list(entity_names)}),
        obs=pd.DataFrame({"obsnme": []}),
        source_path=Path("unused.pst"),
        notes=(),
    )


# ---------------------------------------------------------------------------
# Task 1: every on-disk shape reads to realization-major float32
# ---------------------------------------------------------------------------


def test_dense_ensemble_reads_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))
    assert record.real_names == tuple(real_names)
    assert record.entity_names == tuple(entity_names)


def test_modern_jcb_ensemble_reads_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_jcb_ensemble(
        tmp_path / "case.0.par.jcb", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))


def test_legacy_jcb_ensemble_reads_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_legacy_jcb_ensemble(
        tmp_path / "case.0.par.jcb", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))


def test_realization_major_csv_reads_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))
    assert record.real_names == tuple(real_names)
    assert record.entity_names == tuple(entity_names)


def test_variable_major_csv_normalises_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_variable_major_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.orientation == "variable_major"
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))
    assert record.real_names == tuple(real_names)
    assert record.entity_names == tuple(entity_names)


def test_csv_header_whitespace_is_stripped_and_noted(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names, header_prefix=" "
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.entity_names[0] == entity_names[0]
    assert any(entity_names[0] in note for note in record.notes)


def test_sniff_decides_binary_family_from_header_bytes_not_extension(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))

    dense_path = fixtures.write_dense_ensemble(
        tmp_path / "dense.bin", values, real_names, entity_names
    )
    jcb_path = fixtures.write_jcb_ensemble(
        tmp_path / "modern.jcb", values, real_names, entity_names
    )
    legacy_path = fixtures.write_legacy_jcb_ensemble(
        tmp_path / "legacy.jcb", values, real_names, entity_names
    )
    csv_path = fixtures.write_csv_ensemble(tmp_path / "reals.csv", values, real_names, entity_names)
    variable_csv_path = fixtures.write_variable_major_csv_ensemble(
        tmp_path / "vars.csv", values, real_names, entity_names
    )

    assert sniff(dense_path) == "dense"
    assert sniff(jcb_path) == "binary"
    assert sniff(legacy_path) == "binary"
    assert sniff(csv_path) == "csv"
    assert sniff(variable_csv_path) == "csv"

    # Deliberately misnamed: a dense file wearing a .jcb extension still
    # sniffs as dense, proving the decision comes from the header bytes,
    # not the extension.
    misnamed_dense = tmp_path / "actually_dense.jcb"
    misnamed_dense.write_bytes(dense_path.read_bytes())
    assert sniff(misnamed_dense) == "dense"


def test_ensemble_with_nan_reads_successfully_and_notes_it(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    values[0, 0] = np.nan
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert np.isnan(record.values[0, 0])
    assert any("nan" in note.lower() for note in record.notes)


def test_single_realization_ensemble_returns_two_dimensional_shape(tmp_path):
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(1, len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, ["base"], entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.real_names == ("base",)
    assert record.values.shape == (1, len(entity_names))


def test_zero_byte_file_returns_read_failure(tmp_path):
    path = tmp_path / "empty.bin"
    path.write_bytes(b"")

    result = read_ensemble(path)

    assert isinstance(result, ReadFailure)
    assert result.name == "empty.bin"
    assert result.reason


def test_arbitrary_bytes_file_returns_read_failure(tmp_path):
    path = tmp_path / "junk.bin"
    path.write_bytes(b"this is not a real pest ensemble file, just junk bytes here")

    result = read_ensemble(path)

    assert isinstance(result, ReadFailure)
    assert result.name == "junk.bin"
    assert result.reason


# ---------------------------------------------------------------------------
# Task 2: decide which axis is realizations, and refuse when it cannot be
# ---------------------------------------------------------------------------


def test_realization_major_decided_by_dimensions(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 6)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.orientation == "realization_major"
    assert record.orientation_decided_by == "dimensions"


def test_variable_major_decided_by_dimensions_is_a_transposed_view(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_variable_major_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.orientation == "variable_major"
    assert record.orientation_decided_by == "dimensions"
    assert record.contiguous is False
    assert record.values.base is not None
    assert np.array_equal(record.values, values.astype(np.float32))


def test_square_ensemble_is_decided_by_names_never_dimensions(tmp_path):
    entity_names = fixtures.control_ordered_names("par", 4)
    real_names = fixtures.survivor_names()  # also length 4 -- a square ensemble
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.orientation_decided_by == "names"
    assert record.orientation == "realization_major"
    assert record.real_names == tuple(real_names)
    assert record.entity_names == tuple(entity_names)


def test_names_matching_is_case_insensitive_after_stripping(tmp_path):
    # CSV, not binary: pyemu's own binary readers already lower-case names
    # as they read, so a binary fixture would not exercise this module's
    # own case-insensitive comparison. CSV headers are only stripped, never
    # lowered, by ``_read_csv_matrix``, so the upper-cased names on disk
    # here are exactly what the orientation decision has to compare.
    entity_names_control = fixtures.control_ordered_names("par", 4)
    entity_names_on_disk = [name.upper() for name in entity_names_control]
    real_names = fixtures.survivor_names()  # length 4 -- square, forces name matching
    values = fixtures.sample_values(len(real_names), len(entity_names_on_disk))
    path = fixtures.write_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names_on_disk
    )

    record = read_ensemble(path, _control_tables(entity_names_control))

    assert isinstance(record, EnsembleData)
    assert record.orientation_decided_by == "names"
    assert record.entity_names == tuple(entity_names_on_disk)


def test_ambiguous_counts_and_no_name_match_refuses_with_a_reason(tmp_path):
    entity_names_control = fixtures.control_ordered_names("par", 6)
    real_names = fixtures.control_ordered_names("real", 5)
    entity_names_on_disk = fixtures.control_ordered_names("unrelated", 7)
    values = fixtures.sample_values(len(real_names), len(entity_names_on_disk))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names_on_disk
    )

    result = read_ensemble(path, _control_tables(entity_names_control))

    assert isinstance(result, ReadFailure)
    assert "7" in result.reason
    assert "6" in result.reason


def test_permutation_maps_file_order_onto_control_file_order(tmp_path):
    entity_names_control = fixtures.control_ordered_names("par", 6)
    entity_names_on_disk = fixtures.hash_ordered_names("par", 6)
    real_names = fixtures.control_ordered_names("real", 4)
    values = fixtures.sample_values(len(real_names), len(entity_names_on_disk))
    path = fixtures.write_jcb_ensemble(
        tmp_path / "case.0.par.jcb", values, real_names, entity_names_on_disk
    )

    record = read_ensemble(path, _control_tables(entity_names_control))

    assert isinstance(record, EnsembleData)
    assert record.entity_names == tuple(entity_names_on_disk)
    assert record.permutation is not None
    reordered = np.array(record.entity_names)[list(record.permutation)]
    assert list(reordered) == entity_names_control


def test_read_ensemble_with_no_tables_assumes_realization_major(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 6)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path)

    assert isinstance(record, EnsembleData)
    assert record.orientation_decided_by == "assumed"
    assert record.permutation is None


def test_read_ensemble_never_writes_to_the_source_file(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 6)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )
    before = path.stat()

    tables = _control_tables(entity_names)
    first = read_ensemble(path, tables)
    second = read_ensemble(path, tables)

    after = path.stat()
    assert after.st_size == before.st_size
    assert after.st_mtime_ns == before.st_mtime_ns
    assert isinstance(first, EnsembleData)
    assert isinstance(second, EnsembleData)
    assert np.array_equal(first.values, second.values)
    assert first.real_names == second.real_names
    assert first.entity_names == second.entity_names
    assert first.orientation == second.orientation
    assert first.orientation_decided_by == second.orientation_decided_by


def test_read_ensemble_docstring_states_how_each_uncertainty_resolves():
    doc = (read_ensemble.__doc__ or "").lower()
    assert "dimensions" in doc
    assert "names" in doc
    assert "refus" in doc
