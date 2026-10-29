"""The elev artifact: what it writes, what it counts and notes, and what it refuses.

Fast tests use stand-in adapters over a two-cell mesh, with ``write_mesh`` laying
down the origin the elev artifact reads. One test goes through a real
``Mf6Adapter`` on a small synthetic grid file at a real-world northing.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from pesto.cache.layout import CACHE_VERSION, CacheLayout
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


# --- counts, notes and storage (D-15, D-17, D-35) ---------------------------

_UNIT_NOTE = "the grid file records no length unit, so distances and elevations are in model units"


def _write(tmp_path, top, botm):
    layout = _layout(tmp_path)
    result = write_elev_from_adapter(
        _Adapter(_geometry(top=np.array(top, dtype=np.float64), botm=np.array(botm, dtype=np.float64))),
        layout,
    )
    assert isinstance(result, WrittenArtifact), result
    return layout, result, json.loads((layout.grid / "elev.json").read_text())


def test_bottoms_above_their_tops_are_counted_and_noted_not_swapped(tmp_path):
    # Layer 1's bottom (7) sits above layer 0's bottom (5) in both cells.
    layout, result, payload = _write(tmp_path, [10.0, 10.0], [[5.0, 5.0], [7.0, 7.0]])

    assert payload["counts"]["bottom_above_top"] == 2
    note = "2 cells have their bottom above their top; drawn as absence in the section"
    assert note in payload["notes"]
    assert note in result.notes
    elev = np.fromfile(layout.grid / "elev.f32", dtype="<f4").reshape(3, 2)
    assert elev[2].tolist() == [7.0, 7.0]


def test_one_bottom_above_its_top_reads_in_the_singular(tmp_path):
    _, _, payload = _write(tmp_path, [10.0, 10.0], [[5.0, 5.0], [7.0, 0.0]])
    assert payload["counts"]["bottom_above_top"] == 1
    assert "1 cell has its bottom above its top; drawn as absence in the section" in payload["notes"]


def test_equal_bottoms_are_counted_as_zero_thickness(tmp_path):
    _, _, payload = _write(tmp_path, [10.0, 10.0], [[5.0, 5.0], [5.0, 5.0]])
    assert payload["counts"]["zero_thickness"] == 2
    assert payload["counts"]["bottom_above_top"] == 0
    assert (
        "2 cells have zero thickness; drawn as absence (pinched out) in the section"
        in payload["notes"]
    )


def test_a_nan_bottom_is_counted_and_noted(tmp_path):
    layout, _, payload = _write(tmp_path, [10.0, 10.0], [[5.0, np.nan], [0.0, 0.0]])
    assert payload["counts"]["non_finite"] == 1
    assert (
        "1 elevation is not a finite number; the cells it bounds are drawn as absence in the section"
        in payload["notes"]
    )
    elev = np.fromfile(layout.grid / "elev.f32", dtype="<f4").reshape(3, 2)
    assert np.isnan(elev[1, 1])


def test_counts_come_from_the_float64_values_before_the_cast(tmp_path):
    # These two bottoms differ in float64 but are the same float32 number.
    a = 100.0
    b = 100.0 + 1e-9
    assert np.float32(a) == np.float32(b)
    _, _, payload = _write(tmp_path, [200.0, 200.0], [[a, a], [b, 0.0]])
    assert payload["counts"]["bottom_above_top"] == 1
    assert payload["counts"]["zero_thickness"] == 0


def test_a_clean_grid_has_zero_counts_and_only_the_length_unit_note(tmp_path):
    _, result, payload = _write(tmp_path, [10.0, 10.0], [[5.0, 5.0], [0.0, 0.0]])
    assert payload["counts"] == {"bottom_above_top": 0, "zero_thickness": 0, "non_finite": 0}
    assert payload["notes"] == [_UNIT_NOTE]
    assert result.notes == (_UNIT_NOTE,)
    assert payload["length_units"] is None


def test_elev_f32_is_the_top_then_each_layers_bottom_little_endian(tmp_path):
    layout, _, payload = _write(tmp_path, [10.0, 12.0], [[5.0, 6.0], [0.0, 1.0]])
    raw = (layout.grid / "elev.f32").read_bytes()
    assert len(raw) == 4 * (2 + 1) * 2
    elev = np.frombuffer(raw, dtype="<f4").reshape(3, 2)
    assert elev.tolist() == [[10.0, 12.0], [5.0, 6.0], [0.0, 1.0]]
    assert payload["files"]["elev"] == {"name": "elev.f32", "dtype": "<f4", "count": 6}


def _snapshot(root, *, dirs=True):
    # A folder's own mtime moves when a file is added to it, so the cache side compares files only.
    return {
        str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(root.rglob("*"))
        if dirs or p.is_file()
    }


def test_through_mf6_at_a_real_northing_the_rings_match_the_plan_mesh_and_only_the_cache_gains_files(
    tmp_path,
):
    from pesto.ingest.elev import load_elev
    from pesto.ingest.mesh import write_grid_from_adapter
    from model.fixtures import write_disv_grb
    from pesto.model.mf6 import Mf6Adapter

    run = tmp_path / "run"
    run.mkdir()
    grb = write_disv_grb(run / "model.disv.grb", yorigin=7.02e6)
    layout = CacheLayout(root=tmp_path / "cache" / ".pesto")
    layout.ensure()
    adapter = Mf6Adapter(grb, model_dir=run)
    assert isinstance(write_grid_from_adapter(adapter, layout), WrittenArtifact)

    run_before = _snapshot(run)
    cache_before = _snapshot(layout.root, dirs=False)
    result = write_elev_from_adapter(adapter, layout)

    assert isinstance(result, WrittenArtifact), result
    assert _snapshot(run) == run_before
    cache_after = _snapshot(layout.root, dirs=False)
    new = set(cache_after) - set(cache_before)
    assert new == {f"grid/{name}" for name in _ELEV_FILES}
    assert all(cache_after[k] == v for k, v in cache_before.items())

    ring = np.fromfile(layout.grid / "ring.f64", dtype="<f8").reshape(-1, 2)
    positions = np.fromfile(layout.grid / "positions.f32", dtype="<f4").reshape(-1, 2)
    assert np.array_equal(ring.astype(np.float32), positions)
    elev_json = json.loads((layout.grid / "elev.json").read_text())
    mesh_json = json.loads((layout.grid / "mesh.json").read_text())
    assert elev_json["origin"] == mesh_json["origin"]
    assert elev_json["grid_type"] == "vertex"
    assert elev_json["length_units"] is None
    assert _UNIT_NOTE in elev_json["notes"]
    assert not isinstance(load_elev(layout), ReadFailure)


# --- strict read-back -------------------------------------------------------


def test_load_elev_reads_back_what_was_written(tmp_path):
    from pesto.ingest.elev import load_elev

    layout, _, _ = _write(tmp_path, [10.0, 12.0], [[5.0, 6.0], [0.0, 1.0]])
    arrays = load_elev(layout)
    assert not isinstance(arrays, ReadFailure)
    assert arrays.nlay == 2 and arrays.ncpl == 2
    assert arrays.elev.tolist() == [[10.0, 12.0], [5.0, 6.0], [0.0, 1.0]]
    assert arrays.ring_start.tolist() == [0, 4, 8]
    assert arrays.notes == (_UNIT_NOTE,)


def test_load_elev_refuses_another_cache_version_naming_the_file(tmp_path):
    from pesto.ingest.elev import load_elev

    layout, _, payload = _write(tmp_path, [10.0, 10.0], [[5.0, 5.0], [0.0, 0.0]])
    payload["cache_version"] = 2
    (layout.grid / "elev.json").write_text(json.dumps(payload))

    result = load_elev(layout)
    assert isinstance(result, ReadFailure)
    assert "elev.json" in result.reason
    assert "cache_version 2" in result.reason
    assert f"expects {CACHE_VERSION}" in result.reason


def test_load_elev_refuses_a_ring_file_one_value_short_naming_the_file(tmp_path):
    from pesto.ingest.elev import load_elev

    layout, _, payload = _write(tmp_path, [10.0, 10.0], [[5.0, 5.0], [0.0, 0.0]])
    path = layout.grid / "ring.f64"
    path.write_bytes(path.read_bytes()[:-8])

    result = load_elev(layout)
    assert isinstance(result, ReadFailure)
    assert result.reason == (
        f"ring.f64 has {payload['files']['ring']['count'] - 1} elements, "
        f"expected {payload['files']['ring']['count']}"
    )


def test_load_elev_refuses_an_origin_that_is_not_the_meshs(tmp_path):
    from pesto.ingest.elev import load_elev

    layout, _, payload = _write(tmp_path, [10.0, 10.0], [[5.0, 5.0], [0.0, 0.0]])
    payload["origin"] = [payload["origin"][0] + 1.0, payload["origin"][1]]
    (layout.grid / "elev.json").write_text(json.dumps(payload))

    result = load_elev(layout)
    assert isinstance(result, ReadFailure)
    assert "elev.json's origin" in result.reason
    assert "mesh.json's" in result.reason


def test_load_elev_refuses_counts_that_disagree_with_the_shape_naming_both(tmp_path):
    from pesto.ingest.elev import load_elev

    layout, _, payload = _write(tmp_path, [10.0, 10.0], [[5.0, 5.0], [0.0, 0.0]])
    payload["nlay"] = 3
    (layout.grid / "elev.json").write_text(json.dumps(payload))

    result = load_elev(layout)
    assert isinstance(result, ReadFailure)
    assert "elev.f32 holds 6 values" in result.reason
    assert "(nlay + 1) * ncpl = 8" in result.reason
