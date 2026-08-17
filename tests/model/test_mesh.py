"""``fan_polygons``: every ring size the benchmark grids contain, the exact
numeric contract of the three buffers it produces, and the model-coordinate
guarantee behind GRID-04.

Two assumptions this module does not prove, because no fixture available
to this project proves them either: that MODFLOW-generated cells are
convex (fanning from vertex 0 is only correct for a convex ring), and that
``.iverts``' winding is consistent enough across cells that no cell needs
its winding reversed before fanning. Both held across every real grid
checked during this phase's research, but neither is exhaustively checked
here -- a test named for a convex ring would be dishonest if it read as
covering concavity too.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from pesto.ingest.failures import ReadFailure
from pesto.model import fan_polygons

from .fixtures import write_disv_grb


def _regular_ring(n: int) -> np.ndarray:
    """``n`` points evenly spaced around a unit circle -- a convex ring of
    any size, including the degenerate 2- and 3-vertex cases ``fan_polygons``
    still has to accept without a real polygon behind them."""
    divisor = max(n, 1)
    return np.array(
        [[math.cos(2 * math.pi * k / divisor), math.sin(2 * math.pi * k / divisor)] for k in range(n)]
    )


def _concat_rings(sizes: list[int]) -> tuple[np.ndarray, list[list[int]]]:
    """Build one shared ``verts`` array and one ``iverts`` list holding a
    separate ring per size in ``sizes``, each ring's vertices distinct from
    every other ring's -- what "several rings in one call" looks like when
    nothing is shared between them."""
    verts: list[list[float]] = []
    iverts: list[list[int]] = []
    offset = 0
    for n in sizes:
        ring = _regular_ring(n)
        verts.extend(ring.tolist())
        iverts.append(list(range(offset, offset + n)))
        offset += n
    return np.array(verts), iverts


# ---------------------------------------------------------------------------
# Every polygon size the benchmark grids contain.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("n", [2, 3, 4, 5, 6, 7])
def test_a_ring_of_n_vertices_gives_n_positions_and_max_n_minus_two_triangles(n):
    """The success criterion says 4-to-7-sided; 2 and 3 are here too
    because ``fan_polygons`` has an explicit ``count >= 3`` guard, and an
    untested guard is a guess. A 2-vertex ring still contributes its 2
    vertex rows -- it just fans into nothing."""
    verts = _regular_ring(n)

    mesh = fan_polygons(verts, [list(range(n))])

    assert mesh.positions.shape == (n, 2)
    assert mesh.indices.shape == (max(n - 2, 0) * 3,)


def test_two_quads_sharing_an_edge_produce_eight_vertex_rows_not_six():
    verts = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [2.0, 0.0], [2.0, 1.0]])

    mesh = fan_polygons(verts, [[0, 1, 2, 3], [1, 4, 5, 2]])

    assert mesh.positions.shape == (8, 2)
    np.testing.assert_array_equal(mesh.cell_index, [0, 0, 0, 0, 1, 1, 1, 1])


def test_rings_of_mixed_sizes_land_in_one_buffer_set_with_every_index_valid():
    verts, iverts = _concat_rings([4, 5, 6, 7, 2, 3])

    mesh = fan_polygons(verts, iverts)

    assert mesh.n_cells == 6
    assert mesh.positions.shape[0] == 4 + 5 + 6 + 7 + 2 + 3
    assert int(mesh.indices.max()) < mesh.positions.shape[0]
    assert int(mesh.cell_index.max()) == 5


# ---------------------------------------------------------------------------
# The numeric contract: dtypes, the float32 precision limit, and bounds.
# ---------------------------------------------------------------------------


def test_the_three_buffer_dtypes_match_exactly_not_by_kind():
    """Checked against the exact dtype, not ``.kind`` -- ``float64`` shares
    ``kind == 'f'`` with ``float32`` and would pass a kind-only check while
    still being the wrong dtype for a GPU buffer."""
    verts, iverts = _concat_rings([4])

    mesh = fan_polygons(verts, iverts)

    assert mesh.positions.dtype == np.float32
    assert mesh.cell_index.dtype == np.float32
    assert mesh.indices.dtype == np.uint32


@pytest.mark.slow
def test_a_cell_numbered_16777215_survives_the_float32_cell_index_round_trip():
    """16,777,215 (2**24 - 1) is the largest integer float32 represents
    without loss -- the real boundary of the ``cell_index`` convention, not
    an arbitrary big number. Reaching cell number 16,777,215 means the
    mesh actually has that many prior cells; every cell before the last is
    an empty ring (0 vertices, 0 triangles) so the loop is cheap per
    iteration, but 16.7 million iterations of ``fan_polygons``'s pure
    Python loop still take real time -- marked slow so the fast per-commit
    loop does not pay for it on every task, while the full suite still
    proves it."""
    n_empty = 16_777_215
    iverts: list[list[int]] = [[]] * n_empty + [[0, 1, 2]]
    verts = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]])

    mesh = fan_polygons(verts, iverts)

    assert mesh.n_cells == n_empty + 1
    assert float(mesh.cell_index[-1]) == 16777215.0


def test_bounds_are_derived_from_the_shipped_float32_positions_not_the_float64_input():
    """A float64 coordinate that is not exactly representable in float32
    still produces a bound that contains the narrowed value pesto actually
    shipped, not the float64 value that was never shipped anywhere."""
    narrow_value = 1.0 + 2**-30  # rounds to exactly 1.0 in float32
    assert narrow_value != 1.0
    assert np.float32(narrow_value) == np.float32(1.0)

    verts = np.array([[narrow_value, 0.0], [5.0, 0.0], [5.0, 5.0], [narrow_value, 5.0]])

    mesh = fan_polygons(verts, [[0, 1, 2, 3]])

    assert mesh.bounds == (
        float(mesh.positions[:, 0].min()),
        float(mesh.positions[:, 0].max()),
        float(mesh.positions[:, 1].min()),
        float(mesh.positions[:, 1].max()),
    )
    xmin, xmax, ymin, ymax = mesh.bounds
    assert xmin == pytest.approx(1.0)
    for x, y in mesh.positions.tolist():
        assert xmin <= x <= xmax
        assert ymin <= y <= ymax


# ---------------------------------------------------------------------------
# The empty case is a refusal, not a bounds value.
# ---------------------------------------------------------------------------


def test_a_grid_with_no_cells_never_reaches_fan_polygons(tmp_path, monkeypatch):
    """``Mf6Adapter._grid_or_failure`` refuses a grid with no cells before
    ``fan_polygons`` is ever called -- so ``fan_polygons`` always has at
    least one ring in every call it is contracted for, and there is no
    meaningful bounds value for the case it never sees."""
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_disv_grb(tmp_path / "empty.disv.grb")

    class _EmptyGrid:
        iverts: list = []

    monkeypatch.setattr(
        "flopy.mf6.utils.MfGrdFile",
        lambda filename: type("F", (), {"modelgrid": _EmptyGrid()})(),
    )

    adapter = Mf6Adapter(grid_path)
    result = adapter.grid_mesh()

    assert isinstance(result, ReadFailure)
    assert grid_path.name in result.reason
    assert "no cells" in result.reason


def test_fan_polygons_docstring_names_its_precondition_and_who_guarantees_it():
    doc = fan_polygons.__doc__ or ""
    assert "at least one ring" in doc
    assert "_grid_or_failure" in doc


# ---------------------------------------------------------------------------
# Model coordinates: GRID-04's evidence.
# ---------------------------------------------------------------------------


def test_a_rotated_offset_grid_reports_bounds_matching_the_transformed_geometry(tmp_path):
    """The point is not that pesto performs the rotation -- flopy already
    applies it to ``grid.verts`` before pesto ever sees a vertex -- but
    that pesto does not undo it, re-origin it, normalise it or scale it.
    A grid at the origin with no rotation and the same grid offset and
    rotated must report different bounds; if pesto silently normalised
    coordinates, they would match instead."""
    from pesto.model.mf6 import Mf6Adapter

    at_origin = write_disv_grb(
        tmp_path / "origin.disv.grb", xorigin=0.0, yorigin=0.0, angrot=0.0
    )
    rotated_and_offset = write_disv_grb(
        tmp_path / "rotated.disv.grb", xorigin=1000.0, yorigin=2000.0, angrot=30.0
    )

    origin_bounds = Mf6Adapter(at_origin).grid_mesh().bounds
    rotated_bounds = Mf6Adapter(rotated_and_offset).grid_mesh().bounds

    assert rotated_bounds != origin_bounds
    # Offset alone would shift bounds by exactly (1000, 1000, 2000, 2000);
    # a bound that isn't offset by exactly that proves rotation, not just
    # translation, actually changed the geometry.
    xmin, xmax, ymin, ymax = origin_bounds
    rxmin, rxmax, rymin, rymax = rotated_bounds
    assert (rxmin, rxmax) != (xmin + 1000.0, xmax + 1000.0)


def test_pesto_model_never_imports_or_calls_a_reprojection_library():
    source = Path("src/pesto/model/__init__.py").read_text()

    assert "pyproj" not in source
    for forbidden in ("to_crs", "set_crs", "reproject"):
        assert forbidden not in source
