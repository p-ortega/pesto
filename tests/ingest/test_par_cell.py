"""The par_cell artifact: one row per parameter, named from the control
table, with the resolver's per-group facts and notes kept beside it."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pesto.cache.layout import CACHE_VERSION, CacheLayout, for_run
from pesto.cache.manifest import Manifest, WrittenArtifact
from pesto.ingest.control import ControlTables, read_control
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parcell import ParCellTable, load_par_cell, write_par_cell
from pesto.ingest.runner import _write_control_artifact, _write_par_cell_artifact
from pesto.ingest.tables import load_control_tables
from pesto.model import GroupResolution, ParCells
from fixtures.synthetic_run import (
    CELLS,
    CONTROL_NAMES,
    GROUPS,
    LAYERS,
    write_synthetic_run,
)

from .fixtures import make_run


def snapshot(folder: Path) -> dict[str, tuple[bool, int, int]]:
    """Every path under the folder with its size and modified time, folders included."""
    state = {}
    for path in sorted(folder.rglob("*")):
        stat = path.stat()
        state[str(path.relative_to(folder))] = (path.is_dir(), stat.st_size, stat.st_mtime_ns)
    root = folder.stat()
    state["."] = (True, root.st_size, root.st_mtime_ns)
    return state


def _par(names: tuple[str, ...], groups: tuple[str | None, ...]) -> pd.DataFrame:
    return pd.DataFrame({"parnme": list(names), "pargp": list(groups)})


def _cells(
    names: tuple[str, ...],
    cell: list[int],
    layer: list[int],
    groups: tuple[GroupResolution, ...],
    notes: tuple[str, ...] = (),
    point_xy: np.ndarray | None = None,
) -> ParCells:
    return ParCells(
        cell=np.array(cell, dtype=np.int32),
        layer=np.array(layer, dtype=np.int32),
        parnme=names,
        groups=groups,
        summary="a summary sentence",
        notes=notes,
        point_xy=point_xy,
    )


# ---------------------------------------------------------------------------
# a whole synthetic cache
# ---------------------------------------------------------------------------


def test_the_synthetic_cache_holds_par_cell_named_by_parameter_in_control_order(tmp_path):
    run_dir = write_synthetic_run(tmp_path / "run")
    layout = for_run(run_dir)

    frame = pd.read_parquet(layout.grid / "par_cell.parquet")
    control = load_control_tables(layout, obs="schema")
    assert isinstance(control, ControlTables)

    assert list(frame["parnme"]) == list(control.par["parnme"])
    assert not all(str(name).isdigit() for name in frame["parnme"])
    assert list(frame.columns) == ["parnme", "pargp", "cell", "layer", "x", "y", "rule"]
    assert list(frame["cell"]) == list(CELLS)
    assert list(frame["layer"]) == list(LAYERS)
    assert list(frame["pargp"]) == list(GROUPS)


def test_the_manifest_lists_the_grid_file_as_a_par_cell_source(tmp_path):
    run_dir = write_synthetic_run(tmp_path / "run")
    manifest = Manifest.load(for_run(run_dir))

    source_names = {s.path for s in manifest.artifacts["par_cell"].sources}

    assert "synthetic.grb" in source_names
    assert "synthetic.pst" in source_names


def test_an_unmapped_group_is_minus_one_minus_one_and_unmapped(tmp_path):
    names = ("a", "b", "c")
    cells = _cells(
        names,
        [4, -1, -1],
        [0, -1, -1],
        (
            GroupResolution(group="placed", rule="xyz-host-cell", mapped=1, total=1),
            GroupResolution(group="lost", rule="unmapped", mapped=0, total=2),
        ),
    )
    layout = CacheLayout(root=tmp_path / ".pesto")

    assert isinstance(
        write_par_cell(cells, _par(names, ("placed", "lost", "lost")), layout), WrittenArtifact
    )

    frame = pd.read_parquet(layout.grid / "par_cell.parquet")
    lost = frame[frame["pargp"] == "lost"]
    assert len(lost) == 2
    assert set(lost["cell"]) == {-1}
    assert set(lost["layer"]) == {-1}
    assert set(lost["rule"]) == {"unmapped"}
    assert list(frame[frame["pargp"] == "placed"]["rule"]) == ["xyz-host-cell"]


def test_point_positions_travel_into_x_and_y(tmp_path):
    run_dir = write_synthetic_run(tmp_path / "run")
    frame = pd.read_parquet(for_run(run_dir).grid / "par_cell.parquet").set_index("parnme")

    assert frame.loc["p10", "x"] == pytest.approx(2.25)
    assert frame.loc["p11", "y"] == pytest.approx(0.5)
    assert np.isnan(frame.loc["p1", "x"])


def test_load_par_cell_gives_back_names_and_every_group(tmp_path):
    run_dir = write_synthetic_run(tmp_path / "run")

    table = load_par_cell(for_run(run_dir))

    assert isinstance(table, ParCellTable)
    assert table.parnme == CONTROL_NAMES
    assert table.summary.startswith("synthetic fixture placed")
    assert {g["group"] for g in table.groups} == {"G1", "G2", "G3", "G4layer1", "G5"}
    unplaced = [g for g in table.groups if g["group"] == "G3"][0]
    assert (unplaced["mapped"], unplaced["total"]) == (0, 2)
    assert "G3" not in table.placed_groups
    assert "G1" in table.placed_groups
    assert table.cell.dtype == np.int32


def test_every_note_the_resolver_left_is_kept_in_the_sidecar_and_the_artifact(tmp_path):
    names = ("a", "b")
    cells = _cells(
        names,
        [-1, -1],
        [-1, -1],
        (GroupResolution(group="g", rule="unmapped", mapped=0, total=2),),
        notes=("group 'g': nothing placed", "a second note"),
    )
    layout = CacheLayout(root=tmp_path / ".pesto")

    written = write_par_cell(cells, _par(names, ("g", "g")), layout)

    assert isinstance(written, WrittenArtifact)
    assert written.notes == ("group 'g': nothing placed", "a second note")
    sidecar = json.loads((layout.grid / "par_cell.json").read_text())
    assert sidecar["notes"] == ["group 'g': nothing placed", "a second note"]
    assert sidecar["n_par"] == 2
    table = load_par_cell(layout)
    assert isinstance(table, ParCellTable)
    assert table.notes == ("group 'g': nothing placed", "a second note")


# ---------------------------------------------------------------------------
# identity by name, never by position
# ---------------------------------------------------------------------------


def test_write_par_cell_refuses_names_that_are_row_numbers(tmp_path):
    names = ("alpha", "beta", "gamma")
    cells = _cells(("0", "1", "2"), [0, 1, 2], [0, 0, 0], ())
    layout = CacheLayout(root=tmp_path / ".pesto")

    result = write_par_cell(cells, _par(names, ("g", "g", "g")), layout)

    assert isinstance(result, ReadFailure)
    assert "'alpha'" in result.reason
    assert "'0'" in result.reason
    assert "3 row(s) differ" in result.reason
    assert not (layout.grid / "par_cell.parquet").exists()


def test_write_par_cell_refuses_when_the_counts_differ(tmp_path):
    cells = _cells(("a",), [0], [0], ())
    layout = CacheLayout(root=tmp_path / ".pesto")

    result = write_par_cell(cells, _par(("a", "b"), ("g", "g")), layout)

    assert isinstance(result, ReadFailure)
    assert "'b'" in result.reason


def test_a_zero_row_parameter_table_writes_zero_rows_and_a_note(tmp_path):
    cells = _cells((), [], [], (), point_xy=np.empty((0, 2)))
    layout = CacheLayout(root=tmp_path / ".pesto")

    written = write_par_cell(cells, _par((), ()), layout)

    assert isinstance(written, WrittenArtifact)
    assert any("zero rows" in n for n in written.notes)
    assert len(pd.read_parquet(layout.grid / "par_cell.parquet")) == 0
    table = load_par_cell(layout)
    assert isinstance(table, ParCellTable)
    assert table.parnme == ()


def test_a_parameter_with_no_group_is_unmapped_with_a_null_pargp(tmp_path):
    names = ("a", "b")
    cells = _cells(
        names,
        [3, -1],
        [0, -1],
        (
            GroupResolution(group="g", rule="r", mapped=1, total=1),
            GroupResolution(group="(no pargp)", rule="unmapped", mapped=0, total=1),
        ),
    )
    layout = CacheLayout(root=tmp_path / ".pesto")

    assert isinstance(write_par_cell(cells, _par(names, ("g", None)), layout), WrittenArtifact)

    table = load_par_cell(layout)
    assert isinstance(table, ParCellTable)
    assert table.pargp == ("g", None)
    assert table.rule == ("r", "unmapped")


def test_load_par_cell_refuses_a_sidecar_from_another_cache_version(tmp_path):
    run_dir = write_synthetic_run(tmp_path / "run")
    layout = for_run(run_dir)
    sidecar_path = layout.grid / "par_cell.json"
    sidecar = json.loads(sidecar_path.read_text())
    sidecar["cache_version"] = CACHE_VERSION + 1
    sidecar_path.write_text(json.dumps(sidecar))

    result = load_par_cell(layout)

    assert isinstance(result, ReadFailure)
    assert "par_cell.json" in result.reason


def test_load_par_cell_names_a_missing_file(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = load_par_cell(layout)

    assert isinstance(result, ReadFailure)
    assert "par_cell.json" in result.reason


def test_a_failed_sidecar_write_leaves_no_parquet_under_its_final_name(tmp_path, monkeypatch):
    import pesto.ingest.parcell as parcell_module

    def _raise(target, payload):
        raise OSError("disk full")

    monkeypatch.setattr(parcell_module, "write_atomic_text", _raise)
    names = ("a",)
    cells = _cells(names, [0], [0], ())
    layout = CacheLayout(root=tmp_path / ".pesto")

    result = write_par_cell(cells, _par(names, ("g",)), layout)

    assert isinstance(result, ReadFailure)
    assert not (layout.grid / "par_cell.parquet").exists()
    assert not any(p.name.startswith(".ingest-") for p in layout.grid.iterdir())


# ---------------------------------------------------------------------------
# the worker: it reads the cached control table and joins by name
# ---------------------------------------------------------------------------


class _IndexReadingAdapter:
    """Stands in for Mf6Adapter: names each parameter from the index of the
    table it is handed, as the real resolver does."""

    def __init__(self, grid_path):
        self.grid_path = grid_path

    def locate_par(self, par):
        names = tuple(str(v) for v in par.index)
        n = len(names)
        return ParCells(
            cell=np.arange(n, dtype=np.int32),
            layer=np.zeros(n, dtype=np.int32),
            parnme=names,
            groups=(),
            summary="stub",
            notes=(),
            point_xy=None,
        )


def test_the_worker_names_every_parameter_from_the_cached_table_not_a_row_number(
    tmp_path, monkeypatch
):
    import pesto.model.mf6 as mf6_module

    monkeypatch.setattr(mf6_module, "Mf6Adapter", _IndexReadingAdapter)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    run = make_run(run_dir, iterations=(0,))
    cache_root = str(tmp_path / "cache")

    first = _write_control_artifact(str(run.pst_path), cache_root)
    assert isinstance(first, WrittenArtifact)
    result = _write_par_cell_artifact(str(run.grid_path), cache_root)

    assert isinstance(result, WrittenArtifact)
    frame = pd.read_parquet(Path(cache_root) / "grid" / "par_cell.parquet")
    control = read_control(run.pst_path)
    assert isinstance(control, ControlTables)
    assert list(frame["parnme"]) == list(control.par["parnme"])
    assert not all(str(name).isdigit() for name in frame["parnme"])


def test_the_worker_passes_a_failed_control_read_straight_back(tmp_path):
    layout = CacheLayout(root=tmp_path / "cache")
    layout.ensure()

    result = _write_par_cell_artifact(str(tmp_path / "x.grb"), str(layout.root))

    assert isinstance(result, ReadFailure)


# ---------------------------------------------------------------------------
# a real run
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_resolving_the_cached_table_equals_resolving_the_fresh_control_table(
    pl253_run, tmp_path
):
    from pesto.ingest.discover import discover
    from pesto.model.mf6 import Mf6Adapter

    layout = discover(pl253_run)
    assert layout.grid is not None
    cache_root = tmp_path / "cache"
    before = snapshot(pl253_run)

    written = _write_control_artifact(str(layout.pst_path), str(cache_root))
    assert isinstance(written, WrittenArtifact)
    result = _write_par_cell_artifact(str(layout.grid), str(cache_root))
    assert isinstance(result, WrittenArtifact)

    fresh = read_control(layout.pst_path)
    assert isinstance(fresh, ControlTables)
    expected = Mf6Adapter(layout.grid).locate_par(fresh.par)
    assert isinstance(expected, ParCells)

    table = load_par_cell(CacheLayout(root=cache_root))
    assert isinstance(table, ParCellTable)
    assert table.parnme == expected.parnme
    assert list(table.cell) == list(expected.cell)
    assert list(table.layer) == list(expected.layer)
    assert tuple(g["group"] for g in table.groups) == tuple(g.group for g in expected.groups)
    assert table.notes == expected.notes
    assert table.summary == expected.summary
    assert len(table.placed_groups) > 0
    control_groups = set(fresh.par["pargp"].astype(str))
    for group in table.placed_groups:
        assert group in control_groups

    assert snapshot(pl253_run) == before


# ---------------------------------------------------------------------------
# a grid edit makes par_cell and par_ens stale
# ---------------------------------------------------------------------------


def _planned_sources(run_dir: Path, layout: CacheLayout) -> dict[str, tuple[str, ...]]:
    from pesto.ingest.discover import discover
    from pesto.ingest.runner import plan_artifacts

    return {a.name: a.sources for a in plan_artifacts(discover(run_dir), layout)}


def test_the_ensemble_lists_the_grid_file_as_a_source_and_the_summary_does_not(tmp_path):
    run_dir = write_synthetic_run(tmp_path / "run")
    sources = _planned_sources(run_dir, for_run(run_dir))

    grid = str(run_dir / "synthetic.grb")
    assert grid in sources["par_ens/0"]
    assert grid in sources["par_cell"]
    assert grid not in sources["par_agg/0"]


def test_rewriting_the_grid_bytes_makes_par_cell_and_par_ens_stale(tmp_path):
    run_dir = write_synthetic_run(tmp_path / "run")
    layout = for_run(run_dir)
    sources = _planned_sources(run_dir, layout)
    manifest = Manifest.load(layout)
    assert manifest.is_stale("par_cell", layout, sources["par_cell"]) is False
    assert manifest.is_stale("par_ens/0", layout, sources["par_ens/0"]) is False

    (run_dir / "synthetic.grb").write_bytes(b"a different grid file\n")

    assert manifest.is_stale("par_cell", layout, sources["par_cell"]) is True
    assert manifest.is_stale("par_ens/0", layout, sources["par_ens/0"]) is True
    assert manifest.is_stale("par_agg/0", layout, sources["par_agg/0"]) is False


def test_touching_the_grid_file_keeps_par_cell_and_par_ens_fresh(tmp_path):
    import os

    run_dir = write_synthetic_run(tmp_path / "run")
    layout = for_run(run_dir)
    sources = _planned_sources(run_dir, layout)
    manifest = Manifest.load(layout)
    grid = run_dir / "synthetic.grb"

    stat = grid.stat()
    os.utime(grid, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))

    assert manifest.is_stale("par_cell", layout, sources["par_cell"]) is False
    assert manifest.is_stale("par_ens/0", layout, sources["par_ens/0"]) is False


def test_a_failed_par_cell_leaves_the_ensemble_ok_with_an_empty_map_block_and_a_note(tmp_path):
    from pesto.ingest.runner import ingest_run

    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    # make_run writes a placeholder grid file flopy cannot parse.
    make_run(run_dir, iterations=(0,))

    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert manifest.artifacts["par_cell"].state == "failed"
    assert manifest.artifacts["par_ens/0"].state == "ok"
    sidecar = json.loads((CacheLayout(root=cache_root).ens / "par_0.json").read_text())
    assert sidecar["blocks"][0]["n_par"] == 0
    assert any(
        n.startswith("cell resolution failed, so the map block is empty:")
        for n in sidecar["notes"]
    )
    assert not (cache_root / "grid" / "par_cell.parquet").exists()
