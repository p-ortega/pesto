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
