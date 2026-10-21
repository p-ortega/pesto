"""Observation sites placed on a cell and layer through ``Mf6Adapter.locate_obs``.

A site table is one row per site, indexed by site name, with an ``obgnme``
column and whatever placement columns the control file carried, as text.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from pesto.ingest.failures import ReadFailure
from pesto.model import ObsCells, SpatialAdapter
from pesto.model.mf6 import Mf6Adapter

from .fixtures import write_disv_grb


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
