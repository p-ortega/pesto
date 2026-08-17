"""End-to-end proof that a MODFLOW 6 grid file becomes GPU-ready mesh
buffers and honestly placed (or honestly unplaced) parameters, through one
adapter, following ``tests/ingest/test_tracer.py``'s shape.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pesto.ingest.failures import ReadFailure
from pesto.model import ParCells, SpatialAdapter
from pesto.model.mf6 import Mf6Adapter

from .fixtures import write_disv_grb


def _directory_snapshot(directory) -> dict:
    return {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in directory.iterdir()
    }


def test_a_grid_file_becomes_buffers_and_placed_parameters_end_to_end(tmp_path):
    grid_path = write_disv_grb(tmp_path / "test.disv.grb")
    before = _directory_snapshot(tmp_path)

    adapter = Mf6Adapter(grid_path)
    assert _directory_snapshot(tmp_path) == before  # construction opens nothing
    assert isinstance(adapter, SpatialAdapter)

    mesh = adapter.grid_mesh()
    assert mesh.positions.dtype == np.float32
    assert mesh.positions.shape == (4 + 5 + 6, 2)
    assert mesh.cell_index.dtype == np.float32
    assert mesh.indices.dtype == np.uint32
    assert mesh.indices.shape == (((4 - 2) + (5 - 2) + (6 - 2)) * 3,)
    assert mesh.n_cells == 3
    assert mesh.nlay == 2
    assert mesh.crs is None
    xmin, xmax, ymin, ymax = mesh.bounds
    # The fixture's non-zero XORIGIN/YORIGIN proves the mesh sits in model
    # coordinates rather than local, offset-free ones.
    assert xmin == pytest.approx(1000.0, abs=1e-2)
    assert xmax == pytest.approx(1003.6, abs=1e-2)
    assert ymin == pytest.approx(2000.0, abs=1e-2)
    assert ymax == pytest.approx(2002.0, abs=1e-2)

    shape = adapter.grid_shape()
    assert shape.ncpl == 3
    assert shape.nlay == 2
    assert shape.nrow is None
    assert shape.ncol is None

    idomain = adapter.idomain()
    assert idomain is not None
    assert idomain.tolist() == [1, 1, 1, 1, 0, 1]

    assert adapter.crs() is None

    # A non-monotonic parnme index -- the exact shape ControlTables.par
    # comes in, and the shape that breaks a resolver assuming row position
    # is row identity. Names are shuffled relative to creation order on
    # purpose.
    par = pd.DataFrame(
        {
            "pargp": pd.Categorical(["nothing", "placed", "nothing", "placed"]),
            "idx0": [None, 0, None, 1],
            "idx1": [None, 0, None, 2],
        },
        index=["par:c", "par:a", "par:d", "par:b"],
    )
    par.index.name = "parnme"
    original = par.copy(deep=True)

    result = adapter.locate_par(par)
    assert isinstance(result, ParCells)

    # locate_par must not mutate or reindex the caller's frame.
    pd.testing.assert_frame_equal(par, original)

    placements = dict(zip(result.parnme, zip(result.cell.tolist(), result.layer.tolist())))
    assert placements["par:a"] == (0, 0)  # idx1=0 -> cell 0, idx0=0 -> layer 0
    assert placements["par:b"] == (2, 1)  # idx1=2 -> cell 2, idx0=1 -> layer 1
    assert placements["par:c"] == (-1, -1)
    assert placements["par:d"] == (-1, -1)

    groups_by_name = {g.group: g for g in result.groups}
    assert groups_by_name["placed"].rule == "idx-pair"
    assert groups_by_name["placed"].mapped == 2
    assert groups_by_name["placed"].total == 2
    assert groups_by_name["nothing"].rule == "unmapped"
    assert groups_by_name["nothing"].mapped == 0
    assert result.placed_groups == ("placed",)
    assert result.unplaced_groups == ("nothing",)
    assert result.summary

    after = _directory_snapshot(tmp_path)
    assert after == before


def test_a_grid_with_no_cells_returns_a_read_failure_not_an_exception(tmp_path, monkeypatch):
    grid_path = write_disv_grb(tmp_path / "empty.disv.grb")

    class _EmptyGrid:
        iverts: list = []

    class _FakeMfGrdFile:
        def __init__(self, filename):
            self.filename = filename

        @property
        def modelgrid(self):
            return _EmptyGrid()

    monkeypatch.setattr("flopy.mf6.utils.MfGrdFile", _FakeMfGrdFile)

    adapter = Mf6Adapter(grid_path)
    result = adapter.grid_mesh()

    assert isinstance(result, ReadFailure)
    assert grid_path.name in result.reason
    assert "no cells" in result.reason


def test_a_corrupt_grid_file_costs_one_read_failure_not_an_exception(tmp_path):
    grid_path = tmp_path / "corrupt.disv.grb"
    grid_path.write_bytes(b"not a real grid file, just some junk bytes")

    adapter = Mf6Adapter(grid_path)
    result = adapter.grid_mesh()

    assert isinstance(result, ReadFailure)
    assert result.name == grid_path.name
    assert result.reason


def test_locate_obs_refuses_rather_than_raising_or_placing_silently(tmp_path):
    grid_path = write_disv_grb(tmp_path / "test.disv.grb")
    adapter = Mf6Adapter(grid_path)

    result = adapter.locate_obs(pd.DataFrame({"obsnme": ["obs:a"]}))

    assert isinstance(result, ReadFailure)
    assert result.reason
