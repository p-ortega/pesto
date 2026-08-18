"""Round-trip and note-preservation proof for the control tables cache
artifact.

Every test builds its input by running ``read_control`` over a control file
written by ``tests/ingest/fixtures.py::write_control_file`` under
``tmp_path``, so it exercises the real reader's output, not a hand-built
frame.
"""

from __future__ import annotations

import json

import pandas as pd

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import WrittenArtifact
from pesto.ingest.control import ControlTables, read_control
from pesto.ingest.failures import ReadFailure
from pesto.ingest.tables import load_control_tables, write_control

from .fixtures import write_control_file

_PAR_NAMES = ["par0", "par1", "par2", "par3", "par4", "par5"]
_OBS_NAMES = ["obs0", "obs1", "obs2"]


def _control_tables(tmp_path) -> ControlTables:
    pst_path, _ = write_control_file(tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES)
    tables = read_control(pst_path)
    assert isinstance(tables, ControlTables)
    return tables


def _snapshot(root):
    return {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns) for entry in root.iterdir()
    }


def test_write_control_writes_both_tables_and_returns_one_cache_file_per_file(tmp_path):
    tables = _control_tables(tmp_path)
    layout = CacheLayout(root=tmp_path / ".pesto")

    result = write_control(tables, layout)

    assert isinstance(result, WrittenArtifact)
    assert result.name == "control"
    assert (layout.control / "par.parquet").exists()
    assert (layout.control / "obs.parquet").exists()
    assert (layout.control / "notes.json").exists()
    assert len(result.files) == 3
    for cache_file in result.files:
        actual_size = (layout.root / cache_file.path).stat().st_size
        assert cache_file.bytes == actual_size


def test_row_order_in_the_parquet_files_matches_control_file_order(tmp_path):
    tables = _control_tables(tmp_path)
    layout = CacheLayout(root=tmp_path / ".pesto")
    write_control(tables, layout)

    par = pd.read_parquet(layout.control / "par.parquet")

    assert list(par["parnme"]) == _PAR_NAMES


def test_reading_the_parquet_back_reproduces_columns_and_the_category_dtype(tmp_path):
    tables = _control_tables(tmp_path)
    layout = CacheLayout(root=tmp_path / ".pesto")
    write_control(tables, layout)

    par = pd.read_parquet(layout.control / "par.parquet")

    assert list(par.columns) == list(tables.par.columns)
    assert "__index_level_0__" not in par.columns
    assert isinstance(par["pargp"].dtype, pd.CategoricalDtype)


def test_notes_and_ambiguities_survive_into_notes_json(tmp_path):
    pst_path, obs_data_path = write_control_file(tmp_path / "case.pst", _PAR_NAMES, _OBS_NAMES)
    df = pd.read_csv(obs_data_path)
    df[" id"] = [-1] * len(df)
    df.to_csv(obs_data_path, index=False)
    tables = read_control(pst_path)
    assert isinstance(tables, ControlTables)
    assert tables.notes
    assert tables.ambiguities

    layout = CacheLayout(root=tmp_path / ".pesto")
    write_control(tables, layout)

    notes_payload = json.loads((layout.control / "notes.json").read_text())

    for note in tables.notes:
        assert note in notes_payload["notes"]
    assert len(notes_payload["ambiguities"]) == len(tables.ambiguities)


def test_a_zero_row_table_writes_a_parquet_file_and_a_note_not_a_missing_file(tmp_path):
    pst_path, _ = write_control_file(tmp_path / "case.pst", _PAR_NAMES, obs_names=[])
    tables = read_control(pst_path)
    assert isinstance(tables, ControlTables)
    assert len(tables.obs) == 0

    layout = CacheLayout(root=tmp_path / ".pesto")
    result = write_control(tables, layout)

    assert isinstance(result, WrittenArtifact)
    obs_path = layout.control / "obs.parquet"
    assert obs_path.exists()
    obs = pd.read_parquet(obs_path)
    assert len(obs) == 0
    assert any("zero rows" in note for note in result.notes)


def test_a_parquet_write_failure_leaves_no_file_at_either_final_path_or_a_temp_file(
    tmp_path, monkeypatch
):
    tables = _control_tables(tmp_path)
    layout = CacheLayout(root=tmp_path / ".pesto")

    def _raise(self, *args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(pd.DataFrame, "to_parquet", _raise)

    result = write_control(tables, layout)

    assert isinstance(result, ReadFailure)
    assert not (layout.control / "par.parquet").exists()
    assert not (layout.control / "obs.parquet").exists()
    assert list(layout.control.glob(".ingest-*")) == []


def test_load_control_tables_on_an_absent_file_returns_a_read_failure(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")

    result = load_control_tables(layout)

    assert isinstance(result, ReadFailure)
    assert result.reason


def test_load_control_tables_on_an_unreadable_notes_json_returns_a_read_failure(tmp_path):
    tables = _control_tables(tmp_path)
    layout = CacheLayout(root=tmp_path / ".pesto")
    write_control(tables, layout)
    (layout.control / "notes.json").write_text("not json{{{")

    result = load_control_tables(layout)

    assert isinstance(result, ReadFailure)
    assert "notes.json" in result.reason


def test_write_control_round_trips_through_load_control_tables(tmp_path):
    tables = _control_tables(tmp_path)
    layout = CacheLayout(root=tmp_path / ".pesto")
    write_control(tables, layout)

    loaded = load_control_tables(layout)

    assert isinstance(loaded, ControlTables)
    # write_control writes with index=False (no row numbers to mistake for
    # identity), so the round trip drops the frame's own index -- reset
    # both sides before comparing so only the columns and values are held
    # to equality.
    pd.testing.assert_frame_equal(
        loaded.par.reset_index(drop=True), tables.par.reset_index(drop=True)
    )
    pd.testing.assert_frame_equal(
        loaded.obs.reset_index(drop=True), tables.obs.reset_index(drop=True)
    )
    assert loaded.par_groups == tables.par_groups
    assert loaded.obs_groups == tables.obs_groups
    assert loaded.notes == tables.notes
    assert loaded.ambiguities == tables.ambiguities


def test_write_control_never_touches_the_run_directory(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    pst_path, _ = write_control_file(run_dir / "case.pst", _PAR_NAMES, _OBS_NAMES)
    tables = read_control(pst_path)
    assert isinstance(tables, ControlTables)

    before = _snapshot(run_dir)
    layout = CacheLayout(root=tmp_path / "cache")
    write_control(tables, layout)
    after = _snapshot(run_dir)

    assert after == before
