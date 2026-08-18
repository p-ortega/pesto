"""Cells beside the map block, and the per-iteration realization index.

Covers the behaviour Task 2 adds on top of the tracer: a placed group's
cell and layer land beside the map block in map-block order (including any
row that came back ``-1``), a run with no grid file or an unreadable one
ingests normally with an empty map block and a note saying why, and the
realization index is written in file order with duplicates kept and noted.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.control import ControlTables, read_control
from pesto.ingest.ensembles import (
    RealAlignment,
    StoredEnsemble,
    align_realizations,
    load_stored,
    read_map_row,
    read_par_across_reals,
    read_realization_field,
    write_par_ensemble,
    write_par_reals,
)
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.failures import ReadFailure
from pesto.ingest.runner import _resolve_cells, ingest_run
from pesto.model import GroupResolution, ParCells

from .fixtures import make_run, sample_values


def _control_tables(control_names: list[str], groups: list[str]) -> ControlTables:
    return ControlTables(
        par=pd.DataFrame({"parnme": control_names, "pargp": groups}),
        obs=pd.DataFrame({"obsnme": [], "obgnme": [], "weight": []}),
        par_groups=tuple(dict.fromkeys(groups)),
        obs_groups=(),
        source_path=Path("case.pst"),
        notes=(),
        ambiguities=(),
    )


def _ensemble_data(values, real_names, entity_names, permutation, notes=()) -> EnsembleData:
    return EnsembleData(
        values=np.asarray(values, dtype=np.float32),
        real_names=tuple(real_names),
        entity_names=tuple(entity_names),
        source_path=Path("case.0.par.jcb"),
        on_disk_format="dense",
        orientation="realization_major",
        orientation_decided_by="dimensions",
        contiguous=True,
        permutation=permutation,
        hash_ordered=False,
        notes=tuple(notes),
    )


def _write_sample_ensemble(
    tmp_path,
    control_names=("par0", "par1", "par2"),
    groups=("G1", "G1", "G2"),
    mappable=frozenset({"G1"}),
    real_names=("base", "34"),
    values=None,
    iteration=0,
    cells=None,
):
    """Write a small ensemble through ``write_par_ensemble`` and return the
    layout plus the source values, so a reader test proves itself against
    the writer rather than a hand-written fixture."""
    entity_names = tuple(control_names)
    permutation = tuple(range(len(control_names)))
    if values is None:
        values = [
            [float(10 * r + p) for p in range(len(control_names))] for r in range(len(real_names))
        ]
    values = np.asarray(values, dtype=np.float32)
    data = _ensemble_data(values, real_names, entity_names, permutation)
    tables = _control_tables(list(control_names), list(groups))
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    result = write_par_ensemble(
        data, tables, mappable=mappable, iteration=iteration, layout=layout, cells=cells
    )
    assert isinstance(result, WrittenArtifact)
    return layout, values


def _fake_cells() -> ParCells:
    """What a fake adapter's ``locate_par`` would return: three parameters
    in control-file order, one group (``G1``) placed with one row that
    fell outside the grid (``-1``), one group (``G2``) placed too."""
    return ParCells(
        cell=np.array([5, -1, 9], dtype=np.int32),
        layer=np.array([0, 0, 1], dtype=np.int32),
        parnme=("par0", "par1", "par2"),
        groups=(
            GroupResolution(group="G1", rule="fake", mapped=1, total=2),
            GroupResolution(group="G2", rule="fake", mapped=1, total=1),
        ),
        summary="fake adapter placed G1 and G2",
        notes=(),
    )


# ---------------------------------------------------------------------------
# Cells and layers land beside the map block, in map-block order
# ---------------------------------------------------------------------------


def test_write_par_ensemble_writes_cell_and_layer_in_map_block_order(tmp_path):
    control_names = ["par0", "par1", "par2"]
    entity_names = ("par0", "par1", "par2")
    permutation = (0, 1, 2)
    values = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float32)
    data = _ensemble_data(values, ("r0", "r1"), entity_names, permutation)
    tables = _control_tables(control_names, ["G1", "G1", "G2"])
    cells = _fake_cells()

    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(
        data, tables, mappable=frozenset({"G1"}), iteration=0, layout=layout, cells=cells
    )

    assert isinstance(result, WrittenArtifact)
    cell_path = layout.ens / "par_0.cell.i32"
    layer_path = layout.ens / "par_0.layer.i32"
    assert cell_path.exists()
    assert layer_path.exists()

    n_map_par = 2
    assert cell_path.stat().st_size == 4 * n_map_par
    cell_values = np.frombuffer(cell_path.read_bytes(), dtype="<i4")
    layer_values = np.frombuffer(layer_path.read_bytes(), dtype="<i4")
    # par0, par1 (control order, group G1) -- par1's row came back -1.
    assert list(cell_values) == [5, -1]
    assert list(layer_values) == [0, 0]

    sidecar = json.loads((layout.ens / "par_0.json").read_text())
    assert sidecar["cell_file"] == "par_0.cell.i32"
    assert sidecar["layer_file"] == "par_0.layer.i32"

    cache_files_by_path = {f.path for f in result.files}
    assert str(cell_path.relative_to(layout.root)) in cache_files_by_path
    assert str(layer_path.relative_to(layout.root)) in cache_files_by_path


def test_write_par_ensemble_writes_no_cell_files_when_map_block_is_empty(tmp_path):
    control_names = ["par0", "par1"]
    entity_names = ("par0", "par1")
    permutation = (0, 1)
    values = np.array([[1.0, 2.0]], dtype=np.float32)
    data = _ensemble_data(values, ("r0",), entity_names, permutation)
    tables = _control_tables(control_names, ["G1", "G1"])
    cells = _fake_cells()

    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(
        data, tables, mappable=frozenset(), iteration=0, layout=layout, cells=cells
    )

    assert isinstance(result, WrittenArtifact)
    assert not (layout.ens / "par_0.cell.i32").exists()
    assert not (layout.ens / "par_0.layer.i32").exists()
    sidecar = json.loads((layout.ens / "par_0.json").read_text())
    assert sidecar["cell_file"] is None
    assert sidecar["layer_file"] is None


# ---------------------------------------------------------------------------
# write_par_reals: file order kept, duplicates kept and noted
# ---------------------------------------------------------------------------


def test_write_par_reals_keeps_file_order(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_reals(["base", "34", "35", "176"], iteration=0, layout=layout)

    assert isinstance(result, CacheFile)
    payload = json.loads((layout.reals / "par_0.reals.json").read_text())
    assert payload["names"] == ["base", "34", "35", "176"]
    assert payload["n_real"] == 4
    assert payload["notes"] == []


def test_write_par_reals_keeps_and_notes_a_duplicate_name(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_reals(["r0", "r1", "r0"], iteration=0, layout=layout)

    assert isinstance(result, CacheFile)
    payload = json.loads((layout.reals / "par_0.reals.json").read_text())
    assert payload["names"] == ["r0", "r1", "r0"]
    assert any("r0" in n and "2" in n for n in payload["notes"])


# ---------------------------------------------------------------------------
# ingest_run: no grid file, and an unreadable one
# ---------------------------------------------------------------------------


def test_ingest_run_with_no_grid_file_notes_the_absence(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0,))
    # make_run always writes a placeholder grid file; this test is about a
    # run that genuinely has none, so remove it before ingesting.
    run.grid_path.unlink()

    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert manifest.artifacts["par_ens/0"].state == "ok"
    layout = CacheLayout(root=cache_root)
    sidecar = json.loads((layout.ens / "par_0.json").read_text())
    assert sidecar["blocks"][0]["n_par"] == 0
    assert any("no grid file" in n for n in sidecar["notes"])


def test_ingest_run_with_an_unreadable_grid_file_notes_the_reason(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    # make_run's own grid file is a placeholder, not a real .grb -- exactly
    # the "adapter cannot read it" case.
    make_run(run_dir, iterations=(0,))

    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert manifest.artifacts["par_ens/0"].state == "ok"
    layout = CacheLayout(root=cache_root)
    sidecar = json.loads((layout.ens / "par_0.json").read_text())
    assert sidecar["blocks"][0]["n_par"] == 0
    assert any("cell resolution failed" in n for n in sidecar["notes"])


def test_ingest_run_writes_the_realization_index_in_file_order(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0,))

    ingest_run(run_dir, cache_root=cache_root)

    layout = CacheLayout(root=cache_root)
    payload = json.loads((layout.reals / "par_0.reals.json").read_text())
    assert payload["names"] == run.real_names


# ---------------------------------------------------------------------------
# _resolve_cells directly
# ---------------------------------------------------------------------------


def test_resolve_cells_returns_none_with_no_grid_path():
    assert _resolve_cells("case.pst", None) is None


@pytest.mark.slow
def test_resolve_cells_against_a_real_run(pl253_run):
    from pesto.ingest.discover import discover

    layout = discover(pl253_run)
    assert layout.grid is not None
    tables = read_control(layout.pst_path)
    assert isinstance(tables, ControlTables)

    cells = _resolve_cells(str(layout.pst_path), str(layout.grid))

    assert isinstance(cells, ParCells)
    assert len(cells.placed_groups) > 0
    control_groups = set(tables.par["pargp"].astype(str))
    for group in cells.placed_groups:
        assert group in control_groups


# ---------------------------------------------------------------------------
# load_stored: opening a written ensemble through its own sidecar
# ---------------------------------------------------------------------------


def test_load_stored_returns_what_the_writer_put_in_the_sidecar(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)

    stored = load_stored(0, layout)

    assert isinstance(stored, StoredEnsemble)
    assert stored.n_real == 2
    assert stored.n_par == 3
    assert stored.real_names == ("base", "34")
    assert stored.par_names == ("par0", "par1", "par2")
    assert len(stored.blocks) == 2


def test_load_stored_par_names_are_control_order_and_block_to_control_maps_back(tmp_path):
    # par0 (G2, non-mappable), par1 and par2 (G1, mappable) -- control order
    # and block order deliberately disagree here.
    layout, _ = _write_sample_ensemble(
        tmp_path, groups=("G2", "G1", "G1"), mappable=frozenset({"G1"})
    )

    stored = load_stored(0, layout)

    assert stored.par_names == ("par0", "par1", "par2")
    # Block order is [par1, par2, par0] (map block first); block_to_control
    # names, for each block position, which control position it came from.
    assert list(stored.block_to_control) == [1, 2, 0]


def test_load_stored_cell_and_layer_are_none_without_cells(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)

    stored = load_stored(0, layout)

    assert stored.cell is None
    assert stored.layer is None


def test_load_stored_cell_and_layer_are_int32_arrays_with_cells(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path, cells=_fake_cells())

    stored = load_stored(0, layout)

    assert stored.cell is not None
    assert stored.cell.dtype == np.dtype("int32")
    assert stored.layer is not None
    assert stored.layer.dtype == np.dtype("int32")


def test_load_stored_missing_payload_file_is_a_read_failure(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    layout.par_ens(0).unlink()

    result = load_stored(0, layout)

    assert isinstance(result, ReadFailure)
    assert "par_0.f32" in result.reason


def test_load_stored_missing_sidecar_is_a_read_failure(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    (layout.ens / "par_0.json").unlink()

    result = load_stored(0, layout)

    assert isinstance(result, ReadFailure)
    assert "par_0.json" in result.reason


def test_load_stored_invalid_json_sidecar_is_a_read_failure(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    (layout.ens / "par_0.json").write_text("not valid json {")

    result = load_stored(0, layout)

    assert isinstance(result, ReadFailure)


def test_load_stored_null_sidecar_is_a_read_failure_not_an_attribute_error(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    (layout.ens / "par_0.json").write_text("null")

    result = load_stored(0, layout)

    assert isinstance(result, ReadFailure)


def test_load_stored_wrong_shape_sidecar_is_a_read_failure(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    (layout.ens / "par_0.json").write_text(json.dumps([1, 2, 3]))

    result = load_stored(0, layout)

    assert isinstance(result, ReadFailure)


def test_load_stored_different_cache_version_is_a_read_failure(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    sidecar_path = layout.ens / "par_0.json"
    sidecar = json.loads(sidecar_path.read_text())
    sidecar["cache_version"] = sidecar["cache_version"] + 1
    sidecar_path.write_text(json.dumps(sidecar))

    result = load_stored(0, layout)

    assert isinstance(result, ReadFailure)
    assert "cache_version" in result.reason


def test_load_stored_truncated_payload_is_a_read_failure_naming_the_size(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    payload_path = layout.par_ens(0)
    original = payload_path.read_bytes()
    payload_path.write_bytes(original[:-4])

    result = load_stored(0, layout)

    assert isinstance(result, ReadFailure)
    assert payload_path.name in result.reason
    assert "shorter" in result.reason


def test_load_stored_oversized_payload_is_a_read_failure_naming_the_size(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    payload_path = layout.par_ens(0)
    original = payload_path.read_bytes()
    payload_path.write_bytes(original + b"\x00\x00\x00\x00")

    result = load_stored(0, layout)

    assert isinstance(result, ReadFailure)
    assert "longer" in result.reason


# ---------------------------------------------------------------------------
# read_realization_field and read_map_row
# ---------------------------------------------------------------------------


def test_read_realization_field_returns_control_order_values(tmp_path):
    layout, values = _write_sample_ensemble(tmp_path)
    stored = load_stored(0, layout)

    field = read_realization_field(stored, "base")

    assert field.dtype == np.float32
    assert field.shape == (3,)
    np.testing.assert_array_equal(field, values[0])


def test_read_realization_field_accepts_an_int_index(tmp_path):
    layout, values = _write_sample_ensemble(tmp_path)
    stored = load_stored(0, layout)

    field = read_realization_field(stored, 1)

    np.testing.assert_array_equal(field, values[1])


def test_realization_lookup_never_confuses_an_int_index_with_a_name(tmp_path):
    layout, values = _write_sample_ensemble(tmp_path, real_names=("1", "0"))
    stored = load_stored(0, layout)

    # The string "1" is realization index 0; the int 1 is realization index 1.
    by_name = read_realization_field(stored, "1")
    by_index = read_realization_field(stored, 1)

    np.testing.assert_array_equal(by_name, values[0])
    np.testing.assert_array_equal(by_index, values[1])


def test_read_map_row_returns_the_map_blocks_row_in_block_order(tmp_path):
    layout, values = _write_sample_ensemble(tmp_path)
    stored = load_stored(0, layout)

    row = read_map_row(stored, "base")

    assert row.dtype == np.float32
    assert row.shape == (2,)  # par0, par1 are the mappable (G1) columns
    np.testing.assert_array_equal(row, values[0, :2])


def test_read_map_row_length_matches_cell_size_when_cells_present(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path, cells=_fake_cells())
    stored = load_stored(0, layout)

    row = read_map_row(stored, "base")

    assert row.shape[0] == stored.cell.size


def test_read_realization_field_unknown_name_names_the_name_looked_for(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    stored = load_stored(0, layout)

    result = read_realization_field(stored, "Base")

    assert isinstance(result, ReadFailure)
    assert "Base" in result.reason


def test_read_realization_field_unknown_int_index_is_a_read_failure(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    stored = load_stored(0, layout)

    result = read_realization_field(stored, 99)

    assert isinstance(result, ReadFailure)


# ---------------------------------------------------------------------------
# read_par_across_reals: one parameter, every realization
# ---------------------------------------------------------------------------


def test_read_par_across_reals_on_a_non_map_block_parameter_is_contiguous(tmp_path):
    real_names = ("base", "34", "35")
    layout, values = _write_sample_ensemble(tmp_path, real_names=real_names)
    stored = load_stored(0, layout)

    # par2 is the only non-mappable (G2) parameter.
    field = read_par_across_reals(stored, "par2")

    assert field.dtype == np.float32
    assert field.shape == (3,)
    np.testing.assert_array_equal(field, values[:, 2])


def test_read_par_across_reals_on_a_map_block_parameter_is_strided_but_equal(tmp_path):
    real_names = ("base", "34", "35")
    layout, values = _write_sample_ensemble(tmp_path, real_names=real_names)
    stored = load_stored(0, layout)

    field = read_par_across_reals(stored, "par0")

    np.testing.assert_array_equal(field, values[:, 0])


def test_read_par_across_reals_every_parameter_round_trips(tmp_path):
    real_names = ("base", "34", "35")
    layout, values = _write_sample_ensemble(
        tmp_path, groups=("G2", "G1", "G1"), mappable=frozenset({"G1"}), real_names=real_names
    )
    stored = load_stored(0, layout)

    for control_pos, parname in enumerate(stored.par_names):
        field = read_par_across_reals(stored, parname)
        np.testing.assert_array_equal(field, values[:, control_pos])


def test_read_par_across_reals_unknown_name_names_the_name_looked_for(tmp_path):
    layout, _ = _write_sample_ensemble(tmp_path)
    stored = load_stored(0, layout)

    result = read_par_across_reals(stored, "does-not-exist")

    assert isinstance(result, ReadFailure)
    assert "does-not-exist" in result.reason


# ---------------------------------------------------------------------------
# align_realizations: joining two iterations by realization name
# ---------------------------------------------------------------------------


def test_align_realizations_common_names_in_first_sequences_order():
    alignment = align_realizations(["base", "34", "35"], ["base", "35", "176"])

    assert isinstance(alignment, RealAlignment)
    assert alignment.names == ("base", "35")
    assert alignment.index_a == (0, 2)
    assert alignment.index_b == (0, 1)
    assert alignment.only_a == ("34",)
    assert alignment.only_b == ("176",)


def test_align_realizations_no_overlap_is_empty_not_an_exception():
    alignment = align_realizations(["a", "b"], ["c", "d"])

    assert alignment.names == ()
    assert alignment.index_a == ()
    assert alignment.index_b == ()
    assert alignment.only_a == ("a", "b")
    assert alignment.only_b == ("c", "d")
    assert len(alignment.notes) > 0
    assert any("no realization name is shared" in n for n in alignment.notes)


def test_align_realizations_a_repeated_name_joins_first_occurrence_and_notes_it():
    alignment = align_realizations(["base", "34", "base"], ["base", "34"])

    assert alignment.names == ("base", "34")
    assert alignment.index_a == (0, 1)
    assert alignment.index_b == (0, 1)
    assert any("base" in n and "2" in n for n in alignment.notes)


def test_align_realizations_matches_by_exact_string_equality_only():
    alignment = align_realizations(["base"], ["Base"])

    assert alignment.names == ()
    assert alignment.only_a == ("base",)
    assert alignment.only_b == ("Base",)


def test_align_realizations_leading_whitespace_does_not_join():
    alignment = align_realizations(["base"], [" base"])

    assert alignment.names == ()
    assert alignment.only_a == ("base",)
    assert alignment.only_b == (" base",)


@pytest.mark.slow
def test_align_realizations_against_a_real_run_reports_dropped_realizations(hm_run, tmp_path):
    from pesto.ingest.discover import discover

    cache_root = tmp_path / "cache"
    ingest_run(hm_run, cache_root=cache_root)

    run = discover(hm_run)
    numbered = sorted(k for k in run.par_ens if isinstance(k, int))
    first_iter, last_iter = numbered[0], numbered[-1]

    layout = CacheLayout(root=cache_root)
    first = load_stored(first_iter, layout)
    last = load_stored(last_iter, layout)
    assert isinstance(first, StoredEnsemble)
    assert isinstance(last, StoredEnsemble)

    alignment = align_realizations(first.real_names, last.real_names)

    last_names = set(last.real_names)
    expected_only_a = {name for name in first.real_names if name not in last_names}
    assert set(alignment.only_a) == expected_only_a


def test_align_realizations_one_entry_index_against_many_returns_the_shared_name():
    alignment = align_realizations(["base"], ["base", "34", "35"])

    assert alignment.names == ("base",)
    assert alignment.index_a == (0,)
    assert alignment.index_b == (0,)
    assert alignment.only_a == ()
    assert alignment.only_b == ("34", "35")


# ---------------------------------------------------------------------------
# The round-trip invariant: write_par_ensemble then read back equals source
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "groups,mappable",
    [
        (("G1", "G1", "G1", "G1"), frozenset()),
        (("G1", "G1", "G2", "G2"), frozenset({"G1"})),
        (("G1", "G1", "G1", "G1"), frozenset({"G1"})),
    ],
    ids=["map-block-empty", "both-blocks-non-empty", "nomap-block-empty"],
)
def test_round_trip_holds_for_every_block_configuration(tmp_path, groups, mappable):
    n_real, n_par = 5, 4
    control_names = [f"par{i}" for i in range(n_par)]
    real_names = [f"r{i}" for i in range(n_real)]
    values = sample_values(n_real, n_par, seed=42)

    data = _ensemble_data(values, real_names, control_names, tuple(range(n_par)))
    tables = _control_tables(control_names, list(groups))
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(data, tables, mappable=mappable, iteration=0, layout=layout)
    assert isinstance(result, WrittenArtifact)

    stored = load_stored(0, layout)
    assert isinstance(stored, StoredEnsemble)

    for r, real_name in enumerate(real_names):
        field = read_realization_field(stored, real_name)
        np.testing.assert_array_equal(field, values[r].astype(np.float32))

    for p, parname in enumerate(control_names):
        column = read_par_across_reals(stored, parname)
        np.testing.assert_array_equal(column, values[:, p].astype(np.float32))


def test_round_trip_holds_for_a_single_realization(tmp_path):
    control_names = ["par0", "par1"]
    real_names = ["only"]
    values = sample_values(1, 2, seed=7)
    data = _ensemble_data(values, real_names, control_names, (0, 1))
    tables = _control_tables(control_names, ["G1", "G2"])
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(
        data, tables, mappable=frozenset({"G1"}), iteration=0, layout=layout
    )
    assert isinstance(result, WrittenArtifact)

    payload = json.loads((layout.reals / "par_0.reals.json").read_text())
    assert payload["names"] == ["only"]
    assert payload["n_real"] == 1

    stored = load_stored(0, layout)
    field = read_realization_field(stored, "only")
    np.testing.assert_array_equal(field, values[0].astype(np.float32))


def test_round_trip_holds_for_a_single_parameter(tmp_path):
    control_names = ["par0"]
    real_names = ["r0", "r1", "r2"]
    values = sample_values(3, 1, seed=11)
    data = _ensemble_data(values, real_names, control_names, (0,))
    tables = _control_tables(control_names, ["G1"])
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(
        data, tables, mappable=frozenset({"G1"}), iteration=0, layout=layout
    )
    assert isinstance(result, WrittenArtifact)

    stored = load_stored(0, layout)
    column = read_par_across_reals(stored, "par0")
    np.testing.assert_array_equal(column, values[:, 0].astype(np.float32))


# ---------------------------------------------------------------------------
# Degenerate shapes: zero realizations, zero parameters
# ---------------------------------------------------------------------------


def test_write_par_ensemble_refuses_zero_realizations_and_writes_nothing(tmp_path):
    control_names = ["par0", "par1"]
    values = np.zeros((0, 2), dtype=np.float32)
    data = _ensemble_data(values, [], control_names, (0, 1))
    tables = _control_tables(control_names, ["G1", "G2"])
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(
        data, tables, mappable=frozenset({"G1"}), iteration=0, layout=layout
    )

    assert isinstance(result, ReadFailure)
    assert "realization" in result.reason
    assert not layout.par_ens(0).exists()


def test_write_par_ensemble_refuses_zero_parameters_and_leaves_no_file(tmp_path):
    control_names: list[str] = []
    values = np.zeros((2, 0), dtype=np.float32)
    data = _ensemble_data(values, ["r0", "r1"], control_names, ())
    tables = _control_tables(control_names, [])
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(data, tables, mappable=frozenset(), iteration=0, layout=layout)

    assert isinstance(result, ReadFailure)
    assert "parameter" in result.reason
    assert list(layout.ens.iterdir()) == []
