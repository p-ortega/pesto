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
