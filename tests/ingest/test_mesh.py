"""Round-trip proof for the mesh buffers and the no-grid state.

Every fast test builds its input with ``pesto.model.fan_polygons`` over a
small hand-written vertex list, so the suite needs no benchmark data. One
``@pytest.mark.slow`` test additionally proves ``write_grid_from_adapter``
against a real ``Mf6Adapter``.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import WrittenArtifact
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import load_mesh, write_grid_from_adapter, write_mesh
from pesto.model import GridShape, MeshBuffers, fan_polygons


def _mesh():
    verts = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [2.0, 0.0], [2.0, 1.0]])
    return fan_polygons(verts, [[0, 1, 2, 3], [1, 4, 5, 2]], nlay=2)


def _shape():
    return GridShape(ncpl=2, nlay=2, nrow=None, ncol=None)


class _FakeAdapter:
    """A minimal stand-in for ``SpatialAdapter`` -- ``write_grid_from_adapter``
    only ever calls ``grid_mesh`` and ``grid_shape``, so this is all it
    needs to provide."""

    def __init__(self, mesh_result, shape_result=None):
        self._mesh_result = mesh_result
        self._shape_result = shape_result

    def grid_mesh(self):
        return self._mesh_result

    def grid_shape(self):
        return self._shape_result


def _snapshot(root):
    return {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns) for entry in root.iterdir()
    }


def test_write_mesh_writes_the_three_binaries_at_their_exact_byte_lengths(tmp_path):
    mesh = _mesh()
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_mesh(mesh, _shape(), layout)

    assert isinstance(result, WrittenArtifact)
    assert result.name == "grid"
    n_vert = mesh.positions.shape[0]
    n_tri = mesh.indices.shape[0] // 3
    assert (layout.grid / "positions.f32").stat().st_size == 8 * n_vert
    assert (layout.grid / "cell_index.f32").stat().st_size == 4 * n_vert
    assert (layout.grid / "indices.u32").stat().st_size == 4 * 3 * n_tri


def test_mesh_json_records_the_counts_bounds_crs_and_file_names(tmp_path):
    mesh = _mesh()
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    write_mesh(mesh, _shape(), layout)

    payload = json.loads((layout.grid / "mesh.json").read_text())
    assert payload["n_vert"] == mesh.positions.shape[0]
    assert payload["n_tri"] == mesh.indices.shape[0] // 3
    assert payload["n_cells"] == mesh.n_cells
    assert payload["nlay"] == mesh.nlay
    assert payload["bounds"] == list(mesh.bounds)
    assert payload["crs"] is None
    assert payload["files"]["positions"]["name"] == "positions.f32"
    assert payload["files"]["cell_index"]["name"] == "cell_index.f32"
    assert payload["files"]["indices"]["name"] == "indices.u32"


def test_a_none_crs_is_written_as_null_with_a_note_explaining_the_absence(tmp_path):
    mesh = _mesh()
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_mesh(mesh, _shape(), layout)

    payload = json.loads((layout.grid / "mesh.json").read_text())
    assert payload["crs"] is None
    assert any("projection" in note for note in result.notes)
    assert any("projection" in note for note in payload["notes"])


def test_load_mesh_returns_an_equal_mesh_buffers_with_the_contracted_dtypes(tmp_path):
    mesh = _mesh()
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    write_mesh(mesh, _shape(), layout)

    loaded = load_mesh(layout)

    assert isinstance(loaded, MeshBuffers)
    assert loaded.positions.dtype == np.float32
    assert loaded.cell_index.dtype == np.float32
    assert loaded.indices.dtype == np.uint32
    np.testing.assert_array_equal(loaded.positions, mesh.positions)
    np.testing.assert_array_equal(loaded.cell_index, mesh.cell_index)
    np.testing.assert_array_equal(loaded.indices, mesh.indices)
    assert loaded.n_cells == mesh.n_cells
    assert loaded.nlay == mesh.nlay
    assert loaded.bounds == mesh.bounds
    assert loaded.crs == mesh.crs


def test_load_mesh_on_mesh_json_at_a_different_version_returns_a_read_failure_naming_the_mismatch_not_the_missing_binary(
    tmp_path,
):
    mesh = _mesh()
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    write_mesh(mesh, _shape(), layout)
    mesh_json_path = layout.grid / "mesh.json"

    payload = json.loads(mesh_json_path.read_text())
    payload["cache_version"] = CACHE_VERSION + 1
    mesh_json_path.write_text(json.dumps(payload))
    (layout.grid / "positions.f32").unlink()

    result = load_mesh(layout)

    assert isinstance(result, ReadFailure)
    assert "mesh.json" in result.reason
    assert str(CACHE_VERSION + 1) in result.reason
    assert str(CACHE_VERSION) in result.reason


def test_load_mesh_on_mesh_json_with_no_cache_version_key_returns_a_read_failure(tmp_path):
    mesh = _mesh()
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    write_mesh(mesh, _shape(), layout)
    mesh_json_path = layout.grid / "mesh.json"

    payload = json.loads(mesh_json_path.read_text())
    del payload["cache_version"]
    mesh_json_path.write_text(json.dumps(payload))

    result = load_mesh(layout)

    assert isinstance(result, ReadFailure)


def test_write_grid_from_adapter_with_no_adapter_returns_none_and_writes_nothing(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_grid_from_adapter(None, layout)

    assert result is None
    assert list(layout.grid.iterdir()) == []


def test_write_grid_from_adapter_passes_a_grid_mesh_read_failure_through_unchanged(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    failure = ReadFailure(name="t.grb", path="t.grb", reason="failed to parse grid file t.grb: boom")
    adapter = _FakeAdapter(mesh_result=failure)

    result = write_grid_from_adapter(adapter, layout)

    assert result is failure
    assert list(layout.grid.iterdir()) == []


def test_write_grid_from_adapter_with_a_real_mesh_writes_the_grid_artifact(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    adapter = _FakeAdapter(mesh_result=_mesh(), shape_result=_shape())

    result = write_grid_from_adapter(adapter, layout)

    assert isinstance(result, WrittenArtifact)
    assert (layout.grid / "mesh.json").exists()


def test_a_binary_write_failure_leaves_no_file_at_a_final_name_and_no_temp_file(
    tmp_path, monkeypatch
):
    mesh = _mesh()
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    def _raise_fsync(fd):
        raise OSError("disk full")

    monkeypatch.setattr("pesto.cache._atomic.os.fsync", _raise_fsync)

    result = write_mesh(mesh, _shape(), layout)

    assert isinstance(result, ReadFailure)
    assert not (layout.grid / "positions.f32").exists()
    assert not (layout.grid / "cell_index.f32").exists()
    assert not (layout.grid / "indices.u32").exists()
    assert not (layout.grid / "mesh.json").exists()
    assert list(layout.grid.glob(".ingest-*")) == []


def test_load_mesh_on_a_positions_file_truncated_by_one_element_returns_a_read_failure_naming_it(
    tmp_path,
):
    mesh = _mesh()
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    write_mesh(mesh, _shape(), layout)

    positions_path = layout.grid / "positions.f32"
    truncated = positions_path.read_bytes()[:-4]
    positions_path.write_bytes(truncated)

    result = load_mesh(layout)

    assert isinstance(result, ReadFailure)
    assert "positions.f32" in result.reason


def test_write_grid_from_adapter_never_touches_the_run_directory(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    grid_path = run_dir / "model.disv.grb"
    grid_path.write_bytes(b"not a real grid file")

    before = _snapshot(run_dir)
    layout = CacheLayout(root=tmp_path / "cache")
    layout.ensure()
    adapter = _FakeAdapter(mesh_result=_mesh(), shape_result=_shape())
    write_grid_from_adapter(adapter, layout)
    after = _snapshot(run_dir)

    assert after == before


@pytest.mark.slow
def test_write_grid_from_adapter_against_a_real_mf6_adapter_matches_the_grid_shape(
    tmp_path, pl253_run
):
    from pesto.model.mf6 import Mf6Adapter

    grb_path = sorted(pl253_run.glob("*.grb"))[0]
    adapter = Mf6Adapter(grb_path)
    expected_shape = adapter.grid_shape()
    assert not isinstance(expected_shape, ReadFailure)

    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_grid_from_adapter(adapter, layout)
    assert isinstance(result, WrittenArtifact)

    loaded = load_mesh(layout)
    assert isinstance(loaded, MeshBuffers)
    assert loaded.n_cells == expected_shape.ncpl
