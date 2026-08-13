"""Proof that a control file turns into typed parameter and observation
tables, including the ``PstFrom`` external-data case READ-03 names
explicitly.

Every test builds its control file with ``write_control_file`` from
``tests/ingest/fixtures.py`` under ``tmp_path``, so the suite is green on a
fresh clone with no benchmark data present.
"""

from __future__ import annotations

import pandas as pd

from pesto.ingest.control import (
    ControlTables,
    _note_missing_core_columns,
    read_control,
)
from pesto.ingest.failures import ReadFailure

from .fixtures import write_control_file

_PAR_NAMES = ["par0", "par1", "par2", "par3", "par4", "par5"]
_OBS_NAMES = ["obs0", "obs1", "obs2"]


def test_pstfrom_control_file_carries_core_and_spatial_metadata_columns(tmp_path):
    pst_path, _ = write_control_file(tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES)

    tables = read_control(pst_path)

    assert isinstance(tables, ControlTables)
    for column in ("parnme", "pargp", "parlbnd", "parubnd", "partrans", "i", "j", "idx0", "x", "y", "zone"):
        assert column in tables.par.columns
    for column in ("obsnme", "obgnme", "weight", "id", "standard_deviation"):
        assert column in tables.obs.columns


def test_leading_space_header_is_stripped_and_noted(tmp_path):
    pst_path, obs_data_path = write_control_file(
        tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES, standard_deviation_header=" "
    )
    assert obs_data_path.read_text().splitlines()[0].split(",")[-1] == " standard_deviation"

    tables = read_control(pst_path)

    assert isinstance(tables, ControlTables)
    assert "standard_deviation" in tables.obs.columns
    assert any("standard_deviation" in note for note in tables.notes)


def test_whitespace_duplicate_column_collision_keeps_correctly_named_column(tmp_path):
    pst_path, obs_data_path = write_control_file(tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES)
    df = pd.read_csv(obs_data_path)
    original_id_values = df["id"].tolist()
    df[" id"] = [-1] * len(df)
    df.to_csv(obs_data_path, index=False)

    tables = read_control(pst_path)

    assert isinstance(tables, ControlTables)
    id_columns = [c for c in tables.obs.columns if c == "id"]
    assert id_columns == ["id"]
    assert tables.obs["id"].tolist() == original_id_values
    assert any("'id'" in note and " id" in note for note in tables.notes)


def test_category_dtype_for_group_and_transform_columns(tmp_path):
    pst_path, _ = write_control_file(tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES)

    tables = read_control(pst_path)

    assert isinstance(tables, ControlTables)
    assert isinstance(tables.par["pargp"].dtype, pd.CategoricalDtype)
    assert isinstance(tables.par["partrans"].dtype, pd.CategoricalDtype)
    assert isinstance(tables.obs["obgnme"].dtype, pd.CategoricalDtype)


def test_float_dtype_for_bound_columns(tmp_path):
    pst_path, _ = write_control_file(tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES)

    tables = read_control(pst_path)

    assert isinstance(tables, ControlTables)
    assert pd.api.types.is_float_dtype(tables.par["parlbnd"].dtype)
    assert pd.api.types.is_float_dtype(tables.par["parubnd"].dtype)


def test_rows_and_groups_are_in_control_file_order_not_sorted(tmp_path):
    pst_path, _ = write_control_file(tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES)
    par_data_path = tmp_path / "case.par_data.csv"
    df = pd.read_csv(par_data_path)
    # Not alphabetical and not the reverse -- proves the returned order comes
    # from the file, not from a sort.
    df["pargp"] = ["groupB", "groupA", "groupB", "groupC", "groupA", "groupC"]
    df.to_csv(par_data_path, index=False)

    tables = read_control(pst_path)

    assert isinstance(tables, ControlTables)
    assert list(tables.par["parnme"]) == _PAR_NAMES
    assert tables.par_groups == ("groupb", "groupa", "groupc")


def test_missing_control_file_returns_read_failure(tmp_path):
    result = read_control(tmp_path / "does_not_exist.pst")

    assert isinstance(result, ReadFailure)
    assert result.reason
    assert "does_not_exist.pst" in result.name


def test_deleted_external_data_csv_returns_read_failure(tmp_path):
    pst_path, obs_data_path = write_control_file(tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES)
    obs_data_path.unlink()

    result = read_control(pst_path)

    assert isinstance(result, ReadFailure)
    assert result.name == pst_path.name
    assert result.reason


def test_note_missing_core_columns_notes_absence_rather_than_fabricating():
    """A defensive unit test of the absent-core-column path: a real
    ``pyemu.Pst`` always carries every core PEST field, so this behaviour
    cannot be exercised end to end through ``read_control`` -- it is tested
    directly against the frame-narrowing helper instead."""
    df = pd.DataFrame({"parnme": ["par0"], "pargp": ["group0"]})
    notes: list[str] = []

    _note_missing_core_columns(df, ("parnme", "pargp", "parlbnd", "parubnd", "partrans"), notes, "parameter")

    assert any("parlbnd" in note and "absent" in note for note in notes)
    assert any("parubnd" in note and "absent" in note for note in notes)
    assert any("partrans" in note and "absent" in note for note in notes)
    assert not any("parnme" in note for note in notes)
    assert not any("pargp" in note for note in notes)
    assert "parlbnd" not in df.columns
    assert "parubnd" not in df.columns
