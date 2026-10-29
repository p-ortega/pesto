"""The float64 line walk, on rings small enough to check by hand."""

from __future__ import annotations

import ast
from pathlib import Path

import numpy as np
import pytest

from pesto.section.walk import LineTooLong, LineTooShort, walk

SECTION_PACKAGE = Path(__file__).resolve().parents[2] / "src" / "pesto" / "section"


def _two_unit_squares():
    # Cell 0 is [0, 1] x [0, 1], cell 1 is [1, 2] x [0, 1], each its own ring.
    ring = np.array(
        [[0, 0], [1, 0], [1, 1], [0, 1], [1, 0], [2, 0], [2, 1], [1, 1]], dtype=np.float64
    )
    start = np.array([0, 4, 8], dtype=np.int64)
    return ring[:, 0], ring[:, 1], start


def test_a_line_across_two_squares_gives_two_pieces_in_order_along_the_line():
    vx, vy, start = _two_unit_squares()

    cell, s0, s1, counts = walk(vx, vy, start, (2.5, 0.5), (-0.5, 0.5), 1e-9)

    # Walked from the right, cell 1 comes first.
    assert cell.tolist() == [1, 0]
    np.testing.assert_allclose(s0, [0.5, 1.5], atol=1e-12)
    np.testing.assert_allclose(s1, [1.5, 2.5], atol=1e-12)
    assert counts["candidates"] == 2
    assert counts["zero_length_dropped"] == 0
    assert counts["ties_resolved"] == 0


def test_a_line_along_a_shared_edge_goes_to_the_lower_cell_and_is_counted():
    vx, vy, start = _two_unit_squares()

    cell, s0, s1, counts = walk(vx, vy, start, (1.0, -0.5), (1.0, 1.5), 1e-9)

    assert cell.tolist() == [0]
    np.testing.assert_allclose([s0[0], s1[0]], [0.5, 1.5], atol=1e-12)
    assert counts["ties_resolved"] == 1


def test_a_line_shorter_than_the_tolerance_is_refused():
    vx, vy, start = _two_unit_squares()

    with pytest.raises(LineTooShort):
        walk(vx, vy, start, (0.5, 0.5), (0.5, 0.5 + 1e-12), 1e-9)
    assert issubclass(LineTooShort, ValueError)


ROOT2 = np.sqrt(2.0)


def _pack(rings):
    """Turn a list of rings into the flat ``vx, vy, start`` the walk takes."""
    start = np.concatenate([[0], np.cumsum([len(r) for r in rings])]).astype(np.int64)
    pts = np.array([p for r in rings for p in r], dtype=np.float64)
    return pts[:, 0].copy(), pts[:, 1].copy(), start


def _square(x, y):
    return [(x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1)]


def _four_squares():
    # A 2 x 2 grid of unit squares: cells 0, 1 on the bottom row, 2, 3 on the top.
    return [_square(0, 0), _square(1, 0), _square(0, 1), _square(1, 1)]


def _three_squares():
    return [_square(0, 0), _square(1, 0), _square(2, 0)]


# A concave U, three wide and three tall, with a one-wide notch open at the top.
_U = [(0, 0), (3, 0), (3, 3), (2, 3), (2, 1), (1, 1), (1, 3), (0, 3)]


def _mixed_polygons():
    """A DISV-shaped grid: the U (cell 0), a square filling its notch (cell 1),
    a triangle (cell 2) and a pentagon (cell 3) to its right."""
    return [
        _U,
        [(1, 1), (2, 1), (2, 3), (1, 3)],
        [(3, 0), (4, 0), (3, 3)],
        [(4, 0), (5, 0), (5, 3), (4, 3), (3, 3)],
    ]


def _tol(rings):
    vx, vy, _ = _pack(rings)
    return 1e-9 * max(vx.max() - vx.min(), vy.max() - vy.min())


def _walk(rings, a, b):
    vx, vy, start = _pack(rings)
    return walk(vx, vy, start, a, b, _tol(rings))


def test_a_diagonal_through_a_vertex_keeps_the_two_cells_it_crosses_and_counts_the_corners():
    cell, s0, s1, counts = _walk(_four_squares(), (-0.5, -0.5), (2.5, 2.5))

    assert cell.tolist() == [0, 3]
    np.testing.assert_allclose(s0, [0.5 * ROOT2, 1.5 * ROOT2], atol=1e-12)
    np.testing.assert_allclose(s1, [1.5 * ROOT2, 2.5 * ROOT2], atol=1e-12)
    # Cells 1 and 2 only touch the line at the corner (1, 1).
    assert counts["zero_length_dropped"] == 2
    assert counts["ties_resolved"] == 0


def test_a_line_touching_only_a_corner_gives_no_piece_and_counts_the_drop():
    cell, s0, s1, counts = _walk(_four_squares(), (-1.0, 1.0), (1.0, -1.0))

    assert cell.size == 0 and s0.size == 0 and s1.size == 0
    assert counts["zero_length_dropped"] == 1


def test_line_along_a_shared_edge_goes_to_the_lower_index():
    cell, s0, s1, counts = _walk(_four_squares(), (-0.5, 1.0), (2.5, 1.0))

    # The bottom row holds the lower indices, so it wins the edge y = 1.
    assert cell.tolist() == [0, 1]
    np.testing.assert_allclose(s0, [0.5, 1.5], atol=1e-12)
    np.testing.assert_allclose(s1, [1.5, 2.5], atol=1e-12)
    assert counts["ties_resolved"] == 2


def test_numbering_the_top_row_first_flips_the_shared_edge_winner_so_the_rule_follows_the_index():
    top_first = [_square(0, 1), _square(1, 1), _square(0, 0), _square(1, 0)]
    vx, vy, start = _pack(top_first)

    cell, s0, s1, counts = walk(vx, vy, start, (-0.5, 1.0), (2.5, 1.0), _tol(top_first))

    assert cell.tolist() == [0, 1]
    # The winners are now the top-row squares, whose rings sit above y = 1.
    for c in cell:
        assert vy[start[c] : start[c + 1]].min() == 1.0
    np.testing.assert_allclose(s0, [0.5, 1.5], atol=1e-12)
    np.testing.assert_allclose(s1, [1.5, 2.5], atol=1e-12)
    assert counts["ties_resolved"] == 2


def test_reversing_the_cell_order_keeps_the_lowest_index_winning_a_shared_edge():
    reversed_order = list(reversed(_four_squares()))
    vx, vy, start = _pack(reversed_order)

    cell, _, _, counts = walk(vx, vy, start, (-0.5, 1.0), (2.5, 1.0), _tol(reversed_order))

    # Reversed, cells 0, 1 are the top-right and top-left squares; along the line left to right
    # that is cell 1 then cell 0.
    assert cell.tolist() == [1, 0]
    assert counts["ties_resolved"] == 2


def test_a_concave_cell_crossed_twice_gives_two_pieces_with_the_same_id_in_order():
    cell, s0, s1, counts = _walk([_U], (-1.0, 2.0), (4.0, 2.0))

    assert cell.tolist() == [0, 0]
    np.testing.assert_allclose(s0, [1.0, 3.0], atol=1e-12)
    np.testing.assert_allclose(s1, [2.0, 4.0], atol=1e-12)
    assert counts["zero_length_dropped"] == 0


def test_a_concave_cell_crossed_twice_among_mixed_polygons_keeps_its_neighbour_between_the_arms():
    cell, s0, s1, _ = _walk(_mixed_polygons(), (-1.0, 2.0), (6.0, 2.0))

    # Left arm, notch filler, right arm, triangle, pentagon.
    assert cell.tolist() == [0, 1, 0, 2, 3]
    np.testing.assert_allclose(s0, [1.0, 2.0, 3.0, 4.0, 4.0 + 1.0 / 3.0], atol=1e-12)
    np.testing.assert_allclose(s1, [2.0, 3.0, 4.0, 4.0 + 1.0 / 3.0, 6.0], atol=1e-12)


def test_a_line_ending_in_the_notch_of_a_concave_cell_gives_nothing_in_the_notch():
    cell, s0, s1, _ = _walk([_U], (-1.0, 2.0), (1.5, 2.0))

    assert cell.tolist() == [0]
    np.testing.assert_allclose([s0[0], s1[0]], [1.0, 2.0], atol=1e-12)


def test_a_line_down_through_the_notch_of_a_concave_cell_keeps_only_the_base():
    cell, s0, s1, _ = _walk([_U], (1.5, 4.0), (1.5, -1.0))

    assert cell.tolist() == [0]
    np.testing.assert_allclose([s0[0], s1[0]], [3.0, 4.0], atol=1e-12)


def test_a_line_ending_inside_cells_ends_its_pieces_at_the_line_ends():
    cell, s0, s1, _ = _walk(_three_squares(), (0.5, 0.5), (1.5, 0.5))

    assert cell.tolist() == [0, 1]
    np.testing.assert_allclose(s0, [0.0, 0.5], atol=1e-12)
    np.testing.assert_allclose(s1, [0.5, 1.0], atol=1e-12)


def test_both_ends_in_one_cell_give_one_piece_of_the_full_length():
    cell, s0, s1, counts = _walk(_three_squares(), (0.2, 0.2), (0.8, 0.8))

    assert cell.tolist() == [0]
    np.testing.assert_allclose([s0[0], s1[0]], [0.0, 0.6 * ROOT2], atol=1e-12)
    assert counts["zero_length_dropped"] == 0


def test_a_line_that_misses_every_cell_gives_no_piece_and_no_candidate():
    cell, s0, s1, counts = _walk(_three_squares(), (-1.0, 5.0), (4.0, 5.0))

    assert cell.size == 0 and s0.size == 0 and s1.size == 0
    assert counts == {"candidates": 0, "zero_length_dropped": 0, "ties_resolved": 0}


@pytest.mark.parametrize("far", [1e15, 1e16, 1e200])
def test_ends_far_from_the_mesh_give_the_same_pieces_measured_from_the_real_start(far):
    vx, vy, start = _two_unit_squares()

    cell, s0, s1, _ = walk(vx, vy, start, (-far, 0.5), (far, 0.5), 1e-9)

    assert cell.tolist() == [0, 1]
    # far + 0, far + 1 and far + 2 are what float64 holds for the distances from A.
    np.testing.assert_array_equal(s0, [far + 0.0, far + 1.0])
    np.testing.assert_array_equal(s1, [far + 1.0, far + 2.0])


def test_a_far_end_keeps_the_pieces_near_the_mesh_exact():
    vx, vy, start = _two_unit_squares()

    cell, s0, s1, _ = walk(vx, vy, start, (0.5, 0.5), (1e200, 0.5), 1e-9)

    assert cell.tolist() == [0, 1]
    np.testing.assert_allclose(s0, [0.0, 0.5], atol=1e-12)
    np.testing.assert_allclose(s1, [0.5, 1.5], atol=1e-12)


def test_a_line_too_long_to_measure_in_float64_is_refused_by_name():
    vx, vy, start = _two_unit_squares()

    with pytest.raises(LineTooLong, match="too far apart"):
        walk(vx, vy, start, (-1e308, 0.5), (1e308, 0.5), 1e-9)
    assert issubclass(LineTooLong, ValueError)


def test_a_line_along_the_outer_boundary_gives_each_boundary_cell_once_with_no_gap():
    cell, s0, s1, counts = _walk(_three_squares(), (-1.0, 0.0), (4.0, 0.0))

    assert cell.tolist() == [0, 1, 2]
    np.testing.assert_allclose(s0, [1.0, 2.0, 3.0], atol=1e-12)
    np.testing.assert_allclose(s1, [2.0, 3.0, 4.0], atol=1e-12)
    np.testing.assert_array_equal(s0[1:], s1[:-1])
    assert counts["ties_resolved"] == 0


def test_a_vertex_hit_off_by_1e_12_gives_the_same_cells_as_the_exact_vertex_hit():
    exact, e0, e1, _ = _walk(_four_squares(), (-0.5, -0.5), (2.5, 2.5))
    nudged, n0, n1, counts = _walk(_four_squares(), (-0.5, -0.5 + 1e-12), (2.5, 2.5))

    assert nudged.tolist() == exact.tolist() == [0, 3]
    np.testing.assert_allclose(n0, e0, atol=1e-11)
    np.testing.assert_allclose(n1, e1, atol=1e-11)
    # The slivers of cells 1 or 2 the nudge cuts are no longer than tol, so they are dropped.
    assert counts["zero_length_dropped"] >= 1


def test_pieces_claimed_from_the_same_start_go_to_the_lower_index_in_either_order():
    # Two overlapping cells that start at the same distance along the line: the shared stretch
    # goes to the lower index and only the rest of the longer cell is left to the other.
    short, long = [(0, 0), (1, 0), (1, 1), (0, 1)], [(0, 0), (2, 0), (2, 1), (0, 1)]

    cell, s0, s1, counts = _walk([short, long], (-1.0, 0.5), (3.0, 0.5))
    assert cell.tolist() == [0, 1]
    np.testing.assert_allclose(s0, [1.0, 2.0], atol=1e-12)
    np.testing.assert_allclose(s1, [2.0, 3.0], atol=1e-12)
    assert counts["ties_resolved"] == 1

    cell, s0, s1, counts = _walk([long, short], (-1.0, 0.5), (3.0, 0.5))
    assert cell.tolist() == [0]
    np.testing.assert_allclose([s0[0], s1[0]], [1.0, 3.0], atol=1e-12)
    assert counts["ties_resolved"] == 1


@pytest.mark.parametrize("which", ["vx", "vy"])
def test_rings_rounded_to_float32_are_refused_by_name(which):
    vx, vy, start = _two_unit_squares()
    rings = {"vx": vx, "vy": vy}
    rings[which] = rings[which].astype(np.float32)

    with pytest.raises(TypeError, match="float32"):
        walk(rings["vx"], rings["vy"], start, (-0.5, 0.5), (2.5, 0.5), 1e-9)


def test_float64_rings_are_accepted():
    vx, vy, start = _two_unit_squares()
    assert vx.dtype == np.float64 and vy.dtype == np.float64

    cell, _, _, _ = walk(vx, vy, start, (-0.5, 0.5), (2.5, 0.5), 1e-9)

    assert cell.tolist() == [0, 1]


# --- seeded grids checked against a dense-sampling reference -------------------------------

N_SAMPLES = 8001
N_LINES = 40
HIGH_NORTHING = np.array([5.0e5, 7.02e6])


def _rotated_square_grid():
    """An 8 x 6 DIS-shaped grid of 50-unit squares, rotated 30 degrees about its corner."""
    ncol, nrow, size = 8, 6, 50.0
    theta = np.deg2rad(30.0)
    rot = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
    rings = []
    for r in range(nrow):
        for c in range(ncol):
            sq = np.array(_square(c, r), dtype=np.float64) * size
            rings.append([tuple(p) for p in sq @ rot.T])
    return rings


def _mixed_polygon_grid(seed=11):
    """A DISV-shaped tiling of [0, 600] x [0, 400] with an L and a U (both concave), the square
    filling the U's notch, triangles and squares, on a 100-unit lattice jittered by a fixed seed.
    """
    rng = np.random.default_rng(seed)
    jitter = rng.uniform(-0.15, 0.15, size=(7, 5, 2))
    jitter[[0, -1], :, 0] = 0.0
    jitter[:, [0, -1], 1] = 0.0

    def pt(i, j):
        return (100.0 * (i + jitter[i, j, 0]), 100.0 * (j + jitter[i, j, 1]))

    lattice_rings = [
        [(0, 0), (2, 0), (2, 1), (1, 1), (1, 2), (0, 2)],  # L, concave at (1, 1)
        [(3, 0), (6, 0), (6, 2), (5, 2), (5, 1), (4, 1), (4, 2), (3, 2)],  # U, notch at x 4..5
        [(4, 1), (5, 1), (5, 2), (4, 2)],  # fills the U's notch
        [(2, 0), (3, 0), (3, 1), (2, 1)],
        [(1, 1), (2, 1), (2, 2), (1, 2)],
        [(2, 1), (3, 1), (3, 2), (2, 2)],
    ]
    for j in (2, 3):
        for i in range(6):
            if (i + j) % 2 == 0:
                lattice_rings.append([(i, j), (i + 1, j), (i + 1, j + 1)])
                lattice_rings.append([(i, j), (i + 1, j + 1), (i, j + 1)])
            else:
                lattice_rings.append([(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)])
    return [[pt(i, j) for i, j in ring] for ring in lattice_rings]


def _centred(rings, shift):
    """Move the rings by ``shift`` and take off their own bounds centre, in float64, the way
    fan_polygons builds the cache frame."""
    vx, vy, start = _pack(rings)
    wx, wy = vx + shift[0], vy + shift[1]
    centre = np.array([(wx.min() + wx.max()) / 2.0, (wy.min() + wy.max()) / 2.0])
    return wx - centre[0], wy - centre[1], start, centre


def _reference(vx, vy, start, a, b, tol):
    """Each sample's cell by an even-odd test (-1 for none), and whether it lies within
    2 * tol of any cell edge, where the walk's answer is allowed to differ."""
    ts = np.linspace(0.0, 1.0, N_SAMPLES)
    qx = a[0] + ts * (b[0] - a[0])
    qy = a[1] + ts * (b[1] - a[1])
    owner = np.full(N_SAMPLES, -1, dtype=np.int64)
    n_owners = np.zeros(N_SAMPLES, dtype=np.int64)
    near_edge = np.zeros(N_SAMPLES, dtype=bool)
    for c in range(start.size - 1):
        x, y = vx[start[c] : start[c + 1]], vy[start[c] : start[c + 1]]
        x1, y1 = np.roll(x, -1), np.roll(y, -1)
        crossings = np.zeros(N_SAMPLES, dtype=np.int64)
        for i in range(x.size):
            straddle = (y[i] > qy) != (y1[i] > qy)
            with np.errstate(divide="ignore", invalid="ignore"):
                xc = x[i] + (qy - y[i]) * (x1[i] - x[i]) / (y1[i] - y[i])
            crossings += straddle & (qx < xc)
            ex, ey = x1[i] - x[i], y1[i] - y[i]
            u = np.clip(((qx - x[i]) * ex + (qy - y[i]) * ey) / (ex * ex + ey * ey), 0.0, 1.0)
            near_edge |= np.hypot(qx - (x[i] + u * ex), qy - (y[i] + u * ey)) <= 2.0 * tol
        inside = crossings % 2 == 1
        owner[inside] = c
        n_owners += inside
    return ts * np.hypot(b[0] - a[0], b[1] - a[1]), owner, n_owners, near_edge


def _check_against_reference(vx, vy, start, a, b, tol):
    cell, s0, s1, counts = walk(vx, vy, start, a, b, tol)
    s, owner, n_owners, near_edge = _reference(vx, vy, start, a, b, tol)
    assert (n_owners <= 1).all(), "the test grid has overlapping cells"

    mismatches = []
    for k in np.nonzero(~near_edge)[0]:
        covering = cell[(s0 - tol <= s[k]) & (s[k] <= s1 + tol)]
        expected = [] if owner[k] < 0 else [int(owner[k])]
        if covering.tolist() != expected:
            mismatches.append((float(s[k]), expected, covering.tolist()))
    assert mismatches == [], f"line {a} -> {b}: first mismatches {mismatches[:3]}"

    # Pieces are in order along the line and never overlap.
    assert (np.diff(s0) >= 0).all()
    assert (s0[1:] >= s1[:-1] - tol).all()
    assert ((s1 - s0) > tol).all()
    return cell, s0, s1, counts


def _random_lines(vx, vy, seed):
    rng = np.random.default_rng(seed)
    pad = 0.1 * max(vx.max() - vx.min(), vy.max() - vy.min())
    lo = np.array([vx.min() - pad, vy.min() - pad])
    hi = np.array([vx.max() + pad, vy.max() + pad])
    return [(rng.uniform(lo, hi), rng.uniform(lo, hi)) for _ in range(N_LINES)]


SEEDED_GRIDS = {
    "rotated_square_dis": (_rotated_square_grid, 3),
    "mixed_polygon_disv": (_mixed_polygon_grid, 5),
}


@pytest.mark.parametrize("name", sorted(SEEDED_GRIDS))
def test_random_lines_match_a_dense_sampling_reference(name):
    build, seed = SEEDED_GRIDS[name]
    rings = build()
    vx, vy, start = _pack(rings)
    tol = _tol(rings)

    for a, b in _random_lines(vx, vy, seed):
        _check_against_reference(vx, vy, start, a, b, tol)


def test_the_mixed_polygon_grid_has_at_least_two_concave_cells():
    vx, vy, start = _pack(_mixed_polygon_grid())
    concave = 0
    for c in range(start.size - 1):
        x, y = vx[start[c] : start[c + 1]], vy[start[c] : start[c + 1]]
        ex, ey = np.roll(x, -1) - x, np.roll(y, -1) - y
        turn = np.sign(ex * np.roll(ey, -1) - ey * np.roll(ex, -1))
        concave += int((turn > 0).any() and (turn < 0).any())
    assert concave >= 2


@pytest.mark.parametrize("name", sorted(SEEDED_GRIDS))
def test_a_grid_moved_to_a_northing_of_7_02e6_walks_the_same_as_at_the_origin(name):
    build, seed = SEEDED_GRIDS[name]
    rings = build()
    vx, vy, start = _pack(rings)
    tol = _tol(rings)
    mx, my, mstart, centre = _centred(rings, HIGH_NORTHING)
    assert centre[1] > 7.0e6

    for a, b in _random_lines(vx, vy, seed):
        cell, s0, s1, _ = walk(vx, vy, start, a, b, tol)
        # The ends go into the moved grid's frame in float64, as the route does.
        ma = (a + HIGH_NORTHING) - centre
        mb = (b + HIGH_NORTHING) - centre
        m_cell, m_s0, m_s1, _ = _check_against_reference(mx, my, mstart, ma, mb, tol)
        assert m_cell.tolist() == cell.tolist()
        # Within the walk's own tolerance, 1e-9 of the extent: a flat 1e-9 is finer than float64
        # can hold at 7.02e6, where one step is 9.3e-10. Float32 would be off by half a unit.
        np.testing.assert_allclose(m_s0, s0, rtol=0, atol=tol)
        np.testing.assert_allclose(m_s1, s1, rtol=0, atol=tol)


def test_nothing_under_pesto_section_names_pesto_model_or_a_heavy_library_at_module_scope():
    offenders = []
    for path in sorted(SECTION_PACKAGE.rglob("*.py")):
        tree = ast.parse(path.read_text())
        for node in tree.body:
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            for name in names:
                if name.startswith(("pesto.model", "flopy", "pyemu", "shapely")):
                    offenders.append(f"{path.name} imports {name}")
    assert offenders == []
