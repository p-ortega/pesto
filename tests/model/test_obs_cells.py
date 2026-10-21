"""Observation sites placed on a cell and layer through ``Mf6Adapter.locate_obs``.

A site table is one row per site, indexed by site name, with an ``obgnme``
column and whatever placement columns the control file carried, as text.
"""

from __future__ import annotations

import re
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pesto.ingest.control import read_control
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.model import GridShape, ObsCells, SpatialAdapter
from pesto.model._parcells import RULE_NAMES, resolve
from pesto.model.mf6 import Mf6Adapter

from .fixtures import write_dis_grb, write_disv_grb


def _sites(rows: dict[str, dict]) -> pd.DataFrame:
    frame = pd.DataFrame.from_dict(rows, orient="index")
    frame.index.name = "obsnme"
    return frame


def _adapter(tmp_path, **kwargs) -> Mf6Adapter:
    return Mf6Adapter(write_disv_grb(tmp_path / "test.disv.grb", **kwargs))


def test_a_site_with_icpl_and_layer_is_placed_zero_based(tmp_path):
    sites = _sites({"s1": {"obgnme": "g1", "icpl": "0", "layer": "0"}})

    result = _adapter(tmp_path).locate_obs(sites)

    assert isinstance(result, ObsCells)
    assert result.cell.tolist() == [0]
    assert result.layer.tolist() == [0]
    assert result.site == ("s1",)
    assert len(result.groups) == 1
    group = result.groups[0]
    assert (group.group, group.rule, group.mapped, group.total) == ("g1", "icpl-layer", 1, 1)
    assert result.placed_sites == 1
    assert result.layer_unknown == 0


def test_icpl_and_layer_are_read_as_numbers_from_text(tmp_path):
    sites = _sites(
        {
            "s1": {"obgnme": "g1", "icpl": "2", "layer": "1"},
            "s2": {"obgnme": "g1", "icpl": "1.0", "layer": "0.0"},
        }
    )

    result = _adapter(tmp_path).locate_obs(sites)

    assert result.cell.tolist() == [2, 1]
    assert result.layer.tolist() == [1, 0]


def test_a_blank_layer_gives_the_cell_and_layer_minus_one_never_layer_zero(tmp_path):
    sites = _sites({"s1": {"obgnme": "g1", "icpl": "0", "layer": None}})

    result = _adapter(tmp_path).locate_obs(sites)

    assert isinstance(result, ObsCells)
    assert result.cell.tolist() == [0]
    assert result.layer.tolist() == [-1]
    assert result.placed_sites == 1
    assert result.layer_unknown == 1
    assert any("layer unknown" in note and "1" in note for note in result.notes)


def test_an_empty_text_layer_is_blank_not_layer_zero(tmp_path):
    sites = _sites({"s1": {"obgnme": "g1", "icpl": "1", "layer": ""}})

    result = _adapter(tmp_path).locate_obs(sites)

    assert result.cell.tolist() == [1]
    assert result.layer.tolist() == [-1]


def test_a_layer_outside_the_grid_leaves_the_site_unplaced(tmp_path):
    sites = _sites({"s1": {"obgnme": "g1", "icpl": "0", "layer": "7"}})

    result = _adapter(tmp_path).locate_obs(sites)

    assert result.cell.tolist() == [-1]
    assert result.layer.tolist() == [-1]
    assert result.placed_sites == 0


def test_a_site_table_without_obgnme_is_a_read_failure_naming_the_column(tmp_path):
    sites = _sites({"s1": {"icpl": "0", "layer": "0"}})

    result = _adapter(tmp_path).locate_obs(sites)

    assert isinstance(result, ReadFailure)
    assert "obgnme" in result.reason


def test_an_unreadable_grid_file_is_a_read_failure(tmp_path):
    grid_path = tmp_path / "corrupt.disv.grb"
    grid_path.write_bytes(b"junk bytes, not a grid" * 4)
    sites = _sites({"s1": {"obgnme": "g1", "icpl": "0", "layer": "0"}})

    result = Mf6Adapter(grid_path).locate_obs(sites)

    assert isinstance(result, ReadFailure)


def test_the_adapter_still_satisfies_the_protocol(tmp_path):
    assert isinstance(_adapter(tmp_path), SpatialAdapter)


def test_the_site_order_is_the_input_order(tmp_path):
    sites = _sites(
        {
            "b": {"obgnme": "g2", "icpl": "2", "layer": "0"},
            "a": {"obgnme": "g1", "icpl": "0", "layer": "1"},
        }
    )

    result = _adapter(tmp_path).locate_obs(sites)

    assert result.site == ("b", "a")
    assert result.cell.tolist() == [2, 0]
    assert result.layer.tolist() == [0, 1]
    assert result.cell.dtype == np.int32
    assert result.layer.dtype == np.int32


# ---------------------------------------------------------------------------
# Evidence notes, the other rules for sites, the short-circuit.
# ---------------------------------------------------------------------------


def _note(result: ObsCells, start: str) -> str:
    matches = [note for note in result.notes if note.startswith(start)]
    assert len(matches) == 1, result.notes
    return matches[0]


def test_the_layer_base_note_gives_the_active_counts_both_ways(tmp_path):
    # The fixture's one inactive cell is layer 1, cell 1.
    sites = _sites(
        {
            "active": {"obgnme": "g1", "icpl": "0", "layer": "0"},
            "inactive": {"obgnme": "g1", "icpl": "1", "layer": "1"},
        }
    )

    result = _adapter(tmp_path).locate_obs(sites)

    note = _note(result, "layer base")
    assert re.search(r"1 of 2 .*active cells read as zero-based; 1 of 2 .*read as one-based", note)


def test_the_layer_base_note_counts_a_layer_zero_site_as_not_active_one_based(tmp_path):
    sites = _sites({"s1": {"obgnme": "g1", "icpl": "0", "layer": "0"}})

    result = _adapter(tmp_path).locate_obs(sites)

    note = _note(result, "layer base")
    assert re.search(r"1 of 1 .*read as zero-based; 0 of 1 .*read as one-based", note)


def test_the_layer_base_note_says_so_when_the_grid_has_no_idomain(tmp_path, monkeypatch):
    monkeypatch.setattr(Mf6Adapter, "idomain", lambda self: None)
    sites = _sites({"s1": {"obgnme": "g1", "icpl": "0", "layer": "0"}})

    result = _adapter(tmp_path).locate_obs(sites)

    assert "could not be checked against active cells" in _note(result, "layer base")


def test_no_layer_base_note_when_no_site_has_both_icpl_and_layer(tmp_path):
    sites = _sites({"s1": {"obgnme": "g1", "icpl": "0", "layer": None}})

    result = _adapter(tmp_path).locate_obs(sites)

    assert not any(note.startswith("layer base") for note in result.notes)


def test_the_xy_note_counts_agreement_with_the_cell_holding_x_y(tmp_path):
    sites = _sites(
        {
            "a": {"obgnme": "g1", "icpl": "0", "layer": "0", "x": "0.5", "y": "0.5"},
            "b": {"obgnme": "g1", "icpl": "1", "layer": "0", "x": "1.5", "y": "0.5"},
        }
    )

    result = _adapter(tmp_path).locate_obs(sites)

    assert "2 of 2" in _note(result, "icpl and x, y")
    assert "do not" not in _note(result, "icpl and x, y")


def test_the_xy_note_names_a_disagreement_and_icpl_keeps_the_cell(tmp_path):
    sites = _sites(
        {
            "a": {"obgnme": "g1", "icpl": "0", "layer": "0", "x": "0.5", "y": "0.5"},
            "wrong": {"obgnme": "g1", "icpl": "2", "layer": "0", "x": "0.5", "y": "0.5"},
        }
    )

    result = _adapter(tmp_path).locate_obs(sites)

    note = _note(result, "icpl and x, y")
    assert "1 of 2" in note
    assert "1 do not" in note and "'wrong'" in note
    assert result.cell.tolist() == [0, 2]


def test_a_site_with_only_x_and_y_is_placed_by_the_host_cell_rule(tmp_path):
    sites = _sites({"s1": {"obgnme": "g1", "x": "0.5", "y": "0.5", "z": "7.0"}})

    result = _adapter(tmp_path).locate_obs(sites)

    assert result.cell.tolist() == [0]
    assert result.layer.tolist() == [0]
    assert result.groups[0].rule == "xyz-host-cell"
    # The fixture grid has an offset of (1000, 2000); point_xy is in the real-world frame.
    assert result.point_xy is not None and result.point_xy[0].tolist() == [1000.5, 2000.5]


def test_a_site_with_only_a_layer_stays_unplaced_and_is_named_in_a_note(tmp_path):
    sites = _sites(
        {
            "s1": {"obgnme": "g1", "icpl": "0", "layer": "0"},
            "s2": {"obgnme": "g2", "icpl": None, "layer": "1"},
        }
    )

    result = _adapter(tmp_path).locate_obs(sites)

    assert result.cell.tolist() == [0, -1]
    assert result.layer.tolist() == [0, -1]
    assert any("'g2'" in note and "'layer'" in note for note in result.notes)


def test_a_structured_grid_places_a_site_by_k_i_j(tmp_path):
    adapter = Mf6Adapter(write_dis_grb(tmp_path / "g.grb", nlay=2, nrow=3, ncol=4))
    sites = _sites({"s1": {"obgnme": "g1", "k": "1", "i": "2", "j": "3"}})

    result = adapter.locate_obs(sites)

    assert result.cell.tolist() == [2 * 4 + 3]
    assert result.layer.tolist() == [1]
    assert result.groups[0].rule == "kij"


def test_a_site_table_with_no_placement_column_is_unplaced_with_one_note_and_fast(tmp_path):
    n_groups = 10_000
    names = [f"obs_{i}" for i in range(n_groups)]
    sites = pd.DataFrame(
        {"obsnme": names, "obgnme": [f"grp_{i}" for i in range(n_groups)], "weight": 1.0},
        index=pd.Index(names, name="obsnme"),
    )
    adapter = _adapter(tmp_path)
    adapter.grid_shape()

    started = time.perf_counter()
    result = adapter.locate_obs(sites)
    elapsed = time.perf_counter() - started

    assert isinstance(result, ObsCells)
    assert elapsed < 1.0
    assert (result.cell == -1).all() and (result.layer == -1).all()
    assert len(result.groups) == n_groups
    assert all(g.mapped == 0 and g.total == 1 for g in result.groups)
    assert len(result.notes) == 1
    assert "obsnme, obgnme, weight" in result.notes[0]
    assert result.site == tuple(names)


def test_the_short_circuit_still_counts_sites_with_no_group(tmp_path):
    sites = pd.DataFrame(
        {"obgnme": ["g1", None], "weight": [1.0, 1.0]},
        index=pd.Index(["a", "b"], name="obsnme"),
    )

    result = _adapter(tmp_path).locate_obs(sites)

    assert [(g.group, g.total) for g in result.groups] == [("g1", 1), ("(no obgnme)", 1)]
    assert len(result.notes) == 2


def test_parameters_keep_the_six_rules_and_icpl_layer_stays_off_for_them():
    shape = GridShape(ncpl=3, nlay=2, nrow=None, ncol=None)
    par = pd.DataFrame(
        {"pargp": ["g", "g"], "icpl": ["0", "1"], "layer": ["0", "1"]},
        index=pd.Index(["p1", "p2"], name="parnme"),
    )

    result = resolve(par, shape)

    assert len(RULE_NAMES) == 6 and "icpl-layer" not in RULE_NAMES
    assert result.groups[0].rule == "unmapped" and result.groups[0].mapped == 0
    assert result.cell.tolist() == [-1, -1]
    assert any("'layer', 'icpl'" in note for note in result.notes)
    assert "parameter" in result.summary


# ---------------------------------------------------------------------------
# A real run: blank layers stay unknown, and reading it writes nothing.
# ---------------------------------------------------------------------------


def _snapshot(directory: Path) -> dict:
    return {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in directory.iterdir()
    }


@pytest.mark.slow
def test_a_real_run_keeps_blank_layers_unknown_and_writes_nothing(pl253_run: Path):
    before = _snapshot(pl253_run)
    layout = discover(pl253_run)
    assert layout.grid is not None
    control = read_control(layout.pst_path)
    assert not isinstance(control, ReadFailure)
    adapter = Mf6Adapter(layout.grid)
    shape = adapter.grid_shape()
    assert not isinstance(shape, ReadFailure)

    result = adapter.locate_obs(control.obs)

    assert isinstance(result, ObsCells)
    assert result.site == tuple(str(name) for name in control.obs.index)
    icpl = pd.to_numeric(control.obs["icpl"], errors="coerce")
    layer_text = control.obs["layer"]
    blank_layer = layer_text.isna() | layer_text.astype(str).str.strip().eq("")
    readable = icpl.notna() & (icpl % 1 == 0) & (icpl >= 0) & (icpl < shape.ncpl)
    expected = (readable & blank_layer).to_numpy()
    assert (result.cell[expected] >= 0).all()
    assert (result.layer[expected] == -1).all()
    assert (result.layer[result.cell == -1] == -1).all()
    assert not ((result.cell >= 0) & (result.layer == 0) & blank_layer.to_numpy()).any()
    assert _snapshot(pl253_run) == before
