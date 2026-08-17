"""``Mf6Adapter`` against both discretisations, and every way its grid file
can turn out to be unreadable.

Every real fixture reachable from this project is a DISV grid -- no
structured (DIS) grid file exists anywhere in this repository or in any
benchmark run -- so ``write_dis_grb`` (``tests/model/fixtures.py``) is the
only way this module can test the structured path at all. It is tested
side by side with the DISV path in this same module, on purpose: the two
discretisations are supposed to be the same path through ``mf6.py``, and a
reader should see that side by side rather than take it on faith.
"""

from __future__ import annotations

import re
from pathlib import Path

from pesto.model import GridShape

from .fixtures import write_dis_grb, write_disv_grb


# ---------------------------------------------------------------------------
# Task 1: a structured grid goes through the same path as a vertex grid.
# ---------------------------------------------------------------------------


def test_a_structured_grid_reports_its_own_shape(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_dis_grb(tmp_path / "t.dis.grb", nlay=2, nrow=3, ncol=4)
    adapter = Mf6Adapter(grid_path)

    shape = adapter.grid_shape()

    assert shape == GridShape(ncpl=12, nlay=2, nrow=3, ncol=4)


def test_a_vertex_grid_reports_no_row_or_column_count(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_disv_grb(tmp_path / "t.disv.grb")
    adapter = Mf6Adapter(grid_path)

    shape = adapter.grid_shape()

    assert shape.nrow is None
    assert shape.ncol is None


def test_a_structured_grid_of_twelve_quads_gives_forty_eight_unshared_vertex_rows_and_twenty_four_triangles(
    tmp_path,
):
    """12 quads, each contributing 4 unshared vertex rows and 2 triangles
    (6 indices): 12 * 4 == 48 positions, 12 * 2 * 3 == 72 indices. Spelled
    out explicitly because this is what "unshared vertices" means in
    numbers, not just in shape."""
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_dis_grb(tmp_path / "t.dis.grb", nlay=2, nrow=3, ncol=4)
    adapter = Mf6Adapter(grid_path)

    mesh = adapter.grid_mesh()

    assert mesh.n_cells == 12
    assert mesh.positions.shape == (48, 2)
    assert mesh.indices.shape == (72,)


def test_idomain_on_a_structured_grid_is_one_flat_array_of_length_nlay_times_nrow_times_ncol(
    tmp_path,
):
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_dis_grb(tmp_path / "t.dis.grb", nlay=2, nrow=3, ncol=4)
    adapter = Mf6Adapter(grid_path)

    idomain = adapter.idomain()

    assert idomain is not None
    assert idomain.shape == (24,)


def test_idomain_on_a_vertex_grid_is_one_flat_array_of_length_nlay_times_ncpl(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_disv_grb(tmp_path / "t.disv.grb", nlay=2)
    adapter = Mf6Adapter(grid_path)

    idomain = adapter.idomain()

    assert idomain is not None
    assert idomain.shape == (2 * 3,)  # nlay(2) * ncpl(3), the DISV fixture's shape


def test_a_structured_grid_file_with_no_idomain_record_returns_none_not_ones(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_dis_grb(tmp_path / "t.dis.grb", idomain=False)
    adapter = Mf6Adapter(grid_path)

    assert adapter.idomain() is None


def test_mf6_has_no_branch_on_discretisation():
    """Both discretisations reach ``MeshBuffers`` through the same
    ``fan_polygons`` call -- a comparison against a grid-type name, or a
    branch choosing a different mesh path for structured versus vertex
    grids, would be the first crack in GRID-05. Only the code is checked
    here, not the module's prose -- the docstring names both
    discretisations by design, to explain why one path serves both."""
    source = Path("src/pesto/model/mf6.py").read_text()
    code = re.sub(r'""".*?"""', "", source, flags=re.DOTALL)

    assert "grid_type" not in code
    assert "DISV" not in code
    assert "DIS " not in code
    assert not re.search(r"if\s+.*\bnrow\b", code)
    assert not re.search(r"if\s+.*\bncol\b", code)
