"""Point-in-cell and z-to-layer lookups on a mesh built the way fan_polygons
builds one: unshared vertices, cells fanned into triangles."""

from __future__ import annotations

import numpy as np

from pesto.model import Geometry, fan_polygons
from pesto.model._points import layer_from_z, locate_points


def _row_of_unit_squares(n: int, nlay: int = 2) -> Geometry:
    verts = np.array([[float(i), y] for i in range(n + 1) for y in (0.0, 1.0)])
    iverts = []
    for i in range(n):
        bl, tl = 2 * i, 2 * i + 1
        br, tr = 2 * (i + 1), 2 * (i + 1) + 1
        iverts.append([bl, br, tr, tl])
    mesh = fan_polygons(verts, iverts, nlay=nlay)
    top = np.full(n, 10.0)
    botm = np.array([[10.0 - 5.0 * (k + 1)] * n for k in range(nlay)])
    return Geometry(
        positions=mesh.positions,
        cell_index=mesh.cell_index,
        indices=mesh.indices,
        top=top,
        botm=botm,
    )


def test_points_inside_cells_find_their_cell_and_outside_points_find_none():
    geom = _row_of_unit_squares(3)
    x = np.array([0.5, 1.2, 2.9, 3.5, -0.1, 1.5])
    y = np.array([0.5, 0.1, 0.9, 0.5, 0.5, 1.5])
    assert locate_points(geom, x, y).tolist() == [0, 1, 2, -1, -1, -1]


def test_a_point_on_a_shared_edge_lands_on_exactly_one_cell():
    geom = _row_of_unit_squares(3)
    cells = locate_points(geom, np.array([1.0, 2.0]), np.array([0.5, 0.5]))
    assert all(c in (0, 1, 2) for c in cells)
    assert cells[0] in (0, 1) and cells[1] in (1, 2)


def test_non_finite_coordinates_find_no_cell():
    geom = _row_of_unit_squares(3)
    assert locate_points(geom, np.array([np.nan, 0.5]), np.array([0.5, np.inf])).tolist() == [-1, -1]


def test_z_picks_the_layer_and_a_boundary_z_belongs_to_the_layer_above():
    geom = _row_of_unit_squares(3)
    cell = np.array([0, 0, 0, 0, 0, -1])
    z = np.array([9.0, 5.0, 2.0, 11.0, -1.0, 5.0])
    assert layer_from_z(geom, cell, z).tolist() == [0, 0, 1, -1, -1, -1]


def test_a_mesh_without_elevations_places_nothing_by_z():
    geom = _row_of_unit_squares(3)
    bare = Geometry(geom.positions, geom.cell_index, geom.indices, top=None, botm=None)
    assert layer_from_z(bare, np.array([0]), np.array([5.0])).tolist() == [-1]


def test_many_points_locate_in_bounded_time():
    geom = _row_of_unit_squares(200)
    rng = np.random.default_rng(0)
    x = rng.uniform(0, 200, 20_000)
    y = rng.uniform(0, 1, 20_000)
    cells = locate_points(geom, x, y)
    assert (cells == np.floor(x).astype(int)).all()
