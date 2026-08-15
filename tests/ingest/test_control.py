"""Proof that a control file turns into typed parameter and observation
tables, including the ``PstFrom`` external-data case READ-03 names
explicitly.

Every test builds its control file with ``write_control_file`` from
``tests/ingest/fixtures.py`` under ``tmp_path``, so the suite is green on a
fresh clone with no benchmark data present. The two ``@pytest.mark.slow``
tests at the bottom additionally prove the reader against the developer's
real ``PstFrom`` control files.
"""

from __future__ import annotations

import pandas as pd
import pytest

from pesto.ingest.choices import Ambiguity
from pesto.ingest.control import (
    COLUMN_COLLISION_POLICY,
    ControlTables,
    _note_missing_core_columns,
    _tighten_dtypes,
    read_control,
)
from pesto.ingest.failures import ReadFailure

from .fixtures import make_run, write_control_file

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
    # A stripped-but-not-colliding column is a repair, not a choice among
    # candidates: it must produce a note and no Ambiguity.
    assert not any("standard_deviation" in a.slot for a in tables.ambiguities)


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

    id_ambiguities = [a for a in tables.ambiguities if a.slot == "observation column 'id'"]
    assert len(id_ambiguities) == 1
    ambiguity = id_ambiguities[0]
    assert {ambiguity.chosen, *ambiguity.rejected} == {"id", " id"}
    assert ambiguity.chosen == "id"
    assert ambiguity.policy == COLUMN_COLLISION_POLICY
    assert ambiguity.note() in tables.notes


def test_three_way_column_collision_is_one_ambiguity_naming_all_three(tmp_path):
    pst_path, obs_data_path = write_control_file(tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES)
    df = pd.read_csv(obs_data_path)
    original_id_values = df["id"].tolist()
    df[" id"] = [-1] * len(df)
    df["id "] = [-2] * len(df)
    df.to_csv(obs_data_path, index=False)

    tables = read_control(pst_path)

    assert isinstance(tables, ControlTables)
    assert [c for c in tables.obs.columns if c == "id"] == ["id"]
    assert tables.obs["id"].tolist() == original_id_values

    id_ambiguities = [a for a in tables.ambiguities if a.slot == "observation column 'id'"]
    # One Ambiguity for the whole three-way collision, not one per pair.
    assert len(id_ambiguities) == 1
    ambiguity = id_ambiguities[0]
    assert ambiguity.chosen == "id"
    assert set(ambiguity.rejected) == {" id", "id "}
    assert "3 candidates matched" in ambiguity.note()
    assert ambiguity.note() in tables.notes


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


def test_tighten_dtypes_reports_an_unparsable_bound_instead_of_blanking_it_silently():
    """A defensive unit test, called directly on the helper rather than
    through ``read_control``: the installed pyemu (1.7.0) raises before
    ``read_control`` ever reaches this line when ``parlbnd`` holds a
    non-numeric string (verified directly this session, both for ``parlbnd``
    and ``weight``), so the only honest way to prove this helper is safe
    when that upstream guarantee ever loosens is to call it directly
    (02-REVIEW.md WR-02)."""
    df = pd.DataFrame({"parlbnd": ["1.0", "nope", "3.0"]})
    notes: list[str] = []

    result = _tighten_dtypes(df, (), ("parlbnd",), notes, "parameter")

    assert pd.api.types.is_float_dtype(result["parlbnd"].dtype)
    assert int(result["parlbnd"].isna().sum()) == 1
    assert any("parlbnd" in note and "1" in note for note in notes)


def test_tighten_dtypes_coerces_every_unparsable_weight_and_counts_them_in_one_note():
    """The same helper, a different column and label, and more than one bad
    value -- proves the row count in the note is the count of values
    ``to_numeric`` actually had to coerce, not a fixed "one bad value"
    message."""
    df = pd.DataFrame({"weight": ["1.0", "nope", "also-not-a-number", "4.0"]})
    notes: list[str] = []

    result = _tighten_dtypes(df, (), ("weight",), notes, "observation")

    assert pd.api.types.is_float_dtype(result["weight"].dtype)
    assert int(result["weight"].isna().sum()) == 2
    assert any("weight" in note and "2" in note for note in notes)


# ---------------------------------------------------------------------------
# Task 2: the read-only guarantee, the repeat-read guarantee, the empty
# observation section, and real PstFrom control files.
# ---------------------------------------------------------------------------


def _snapshot(root):
    return {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns) for entry in root.iterdir()
    }


def test_reading_never_writes_to_the_run_directory_including_external_csvs(tmp_path):
    run = make_run(tmp_path, n_par=6, n_obs=3)

    before = _snapshot(tmp_path)
    result = read_control(run.pst_path)
    after = _snapshot(tmp_path)

    assert isinstance(result, ControlTables)
    assert after == before


def test_two_successive_reads_return_equal_tables(tmp_path):
    run = make_run(tmp_path, n_par=6, n_obs=3)

    first = read_control(run.pst_path)
    second = read_control(run.pst_path)

    assert isinstance(first, ControlTables)
    assert isinstance(second, ControlTables)
    assert list(first.par.columns) == list(second.par.columns)
    assert list(first.obs.columns) == list(second.obs.columns)
    pd.testing.assert_frame_equal(first.par, second.par)
    pd.testing.assert_frame_equal(first.obs, second.obs)
    assert first.notes == second.notes
    assert first.ambiguities == second.ambiguities


def test_empty_observation_section_is_an_empty_typed_table_or_a_named_failure(tmp_path):
    """The installed pyemu (1.7.0) takes the empty-table branch: a control
    file with zero observations reloads as a ``ControlTables`` whose
    observation table has zero rows but still carries ``obsnme``,
    ``obgnme`` and ``weight`` -- confirmed directly against this project's
    installed pyemu during planning. Both outcomes are asserted here as the
    honest disjunction the plan requires, so a future pyemu upgrade that
    instead raises is still covered by this test rather than failing it
    with a confusing traceback."""
    pst_path, _ = write_control_file(tmp_path / "case.pst", _PAR_NAMES, obs_names=[])

    result = read_control(pst_path)

    if isinstance(result, ReadFailure):
        assert result.reason
    else:
        assert isinstance(result, ControlTables)
        assert len(result.obs) == 0
        for column in ("obsnme", "obgnme", "weight"):
            assert column in result.obs.columns
        assert isinstance(result.obs["obgnme"].dtype, pd.CategoricalDtype)
        assert pd.api.types.is_float_dtype(result.obs["weight"].dtype)


@pytest.mark.slow
def test_reads_a_real_forecast_run_pstfrom_control_file(forecast_run):
    pst_path = forecast_run / "escondida.pst"

    tables = read_control(pst_path)

    assert isinstance(tables, ControlTables)
    assert len(tables.par) > 0
    for column in ("pargp", "parlbnd", "parubnd", "partrans"):
        assert column in tables.par.columns
    assert len(tables.obs) > 0
    spatial_columns = {"i", "j", "x", "y", "zone", "idx0"}
    assert spatial_columns & set(tables.par.columns)
    assert len(tables.par_groups) > 0
    assert isinstance(tables.par["pargp"].dtype, pd.CategoricalDtype)
    assert isinstance(tables.par["partrans"].dtype, pd.CategoricalDtype)


@pytest.mark.slow
def test_reads_a_real_hm_run_control_file_and_leaves_it_untouched(hm_run):
    pst_path = hm_run / "escondida.pst"

    before = _snapshot(hm_run)
    tables = read_control(pst_path)
    after = _snapshot(hm_run)

    assert isinstance(tables, ControlTables)
    assert len(tables.par) > 0
    for column in ("pargp", "parlbnd", "parubnd", "partrans"):
        assert column in tables.par.columns
    assert len(tables.obs) > 0
    assert len(tables.par_groups) > 0
    assert isinstance(tables.par["pargp"].dtype, pd.CategoricalDtype)
    assert isinstance(tables.par["partrans"].dtype, pd.CategoricalDtype)
    assert after == before
