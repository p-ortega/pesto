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
from pesto.ingest.ensembles import write_par_ensemble, write_par_reals
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.runner import _resolve_cells, ingest_run
from pesto.model import GroupResolution, ParCells

from .fixtures import make_run


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
