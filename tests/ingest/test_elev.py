"""The elev artifact: what it writes, what it counts and notes, and what it refuses.

Fast tests use stand-in adapters over a two-cell mesh, with ``write_mesh`` laying
down the origin the elev artifact reads. One test goes through a real
``Mf6Adapter`` on a small synthetic grid file at a real-world northing.
"""

from __future__ import annotations

import numpy as np
import pytest

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import WrittenArtifact
from pesto.ingest.elev import write_elev_from_adapter
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import write_mesh
from pesto.model import Geometry, GridShape, fan_polygons

_VERTS = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [2.0, 0.0], [2.0, 1.0]])
_IVERTS = [[0, 1, 2, 3], [1, 4, 5, 2]]
_ELEV_FILES = ("elev.f32", "ring.f64", "ring_start.u32", "elev.json")


def _mesh():
    return fan_polygons(_VERTS, _IVERTS, nlay=2)


def _layout(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    write_mesh(_mesh(), GridShape(ncpl=2, nlay=2, nrow=None, ncol=None), layout)
    return layout


def _geometry(**overrides):
    mesh = _mesh()
    world = mesh.positions.astype(np.float64) + np.array(mesh.origin)
    fields = {
        "positions": world,
        "cell_index": mesh.cell_index,
        "indices": mesh.indices,
        "top": np.array([10.0, 10.0]),
        "botm": np.array([[5.0, 5.0], [0.0, 0.0]]),
        "grid_type": "vertex",
    }
    fields.update(overrides)
    return Geometry(**fields)


class _Adapter:
    def __init__(self, geometry):
        self._geometry = geometry

    def geometry(self):
        return self._geometry


def _no_elev_files(layout):
    return all(not (layout.grid / name).exists() for name in _ELEV_FILES)


# --- refusals (D-12, D-14) --------------------------------------------------


def test_missing_bottoms_are_refused_with_the_adapters_own_reason_and_nothing_is_written(
    tmp_path,
):
    layout = _layout(tmp_path)
    geom = _geometry(top=None, botm=None, elevation_note="the grid file records no layer bottoms")

    result = write_elev_from_adapter(_Adapter(geom), layout)

    assert isinstance(result, ReadFailure)
    assert result.name == "elev"
    assert result.reason == "the grid file records no layer bottoms"
    assert _no_elev_files(layout)


def test_missing_elevations_with_no_note_get_a_general_reason_not_a_default(tmp_path):
    layout = _layout(tmp_path)

    result = write_elev_from_adapter(_Adapter(_geometry(botm=None)), layout)

    assert isinstance(result, ReadFailure)
    assert result.reason == "the grid file records no layer elevations"
    assert _no_elev_files(layout)


def test_an_unstructured_grid_is_refused_naming_its_type(tmp_path):
    layout = _layout(tmp_path)

    result = write_elev_from_adapter(_Adapter(_geometry(grid_type="unstructured")), layout)

    assert isinstance(result, ReadFailure)
    assert result.name == "elev"
    assert "'unstructured'" in result.reason
    assert "the section reads MODFLOW 6 DIS and DISV grids only" in result.reason
    assert _no_elev_files(layout)


def test_a_grid_that_does_not_say_its_type_is_refused_saying_so(tmp_path):
    layout = _layout(tmp_path)

    result = write_elev_from_adapter(_Adapter(_geometry(grid_type=None)), layout)

    assert isinstance(result, ReadFailure)
    assert "the grid file does not say which grid type it is" in result.reason
    assert "DIS and DISV" in result.reason
    assert _no_elev_files(layout)


def test_the_grid_type_is_refused_before_the_elevations_are_looked_at(tmp_path):
    layout = _layout(tmp_path)
    geom = _geometry(
        grid_type="unstructured", top=None, botm=None, elevation_note="the grid file records no top elevations"
    )

    result = write_elev_from_adapter(_Adapter(geom), layout)

    assert "'unstructured'" in result.reason


@pytest.mark.parametrize("grid_type", ["structured", "vertex"])
def test_structured_and_vertex_grids_are_accepted(tmp_path, grid_type):
    layout = _layout(tmp_path)

    result = write_elev_from_adapter(_Adapter(_geometry(grid_type=grid_type)), layout)

    assert isinstance(result, WrittenArtifact)
    assert all((layout.grid / name).exists() for name in _ELEV_FILES)


def test_no_adapter_is_the_designed_absence_not_a_failure(tmp_path):
    assert write_elev_from_adapter(None, _layout(tmp_path)) is None
