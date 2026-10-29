"""The float64 line walk, on rings small enough to check by hand."""

from __future__ import annotations

import ast
from pathlib import Path

import numpy as np
import pytest

from pesto.section.walk import LineTooShort, walk

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
