"""The whole phase, checked against runs nobody wrote for it.

Every test here is marked ``slow`` and drives the real route a caller takes:
``discover(run_dir)`` to a ``RunLayout``, ``RunLayout.grid`` to a grid file
path, ``Mf6Adapter(that path)``, and ``read_control(layout.pst_path)`` to a
parameter table. The synthetic fixtures in ``tests/model/fixtures.py``
remain the load-bearing coverage -- every rule and both discretisations are
already proven there, against no external data. What real runs add is real
column data and real grids, which is a different kind of evidence and worth
having, not a substitute.

Nothing here hard-codes a cell count, group count or parameter count taken
from one local directory -- a test asserting "this run has 785 groups"
breaks the moment someone copies the data properly and proves nothing about
whether the code works. Every assertion below is a relationship that holds
for any grid or any control table, checked against whichever real run
happens to be present.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from pesto.ingest.control import read_control
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.model import GridShape, MeshBuffers, ParCells
from pesto.model._parcells import resolve
from pesto.model.mf6 import Mf6Adapter

pytestmark = pytest.mark.slow

_GRID_RUN_FIXTURES = ("forecast_run", "hm_run", "pl253_run")


def _open_run(run_dir: Path):
    """The real route: discover the layout, then build the adapter from
    whichever grid file discovery resolved. Fails the test immediately,
    with the run directory named, if discovery found no grid at all -- a
    silent skip here would hide a real regression in ``discover()``."""
    layout = discover(run_dir)
    assert layout.grid is not None, f"discover() found no grid file in {run_dir}"
    return layout, Mf6Adapter(layout.grid)


def _snapshot(directory: Path) -> dict:
    return {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in directory.iterdir()
    }


def _dis_dimensions(dis_path: Path) -> tuple[int, int, int]:
    """``NLAY``/``NROW``/``NCOL`` read from a real MODFLOW 6 ASCII ``.dis``
    package's own ``Dimensions`` block -- not a number this test invents,
    since ``freyberg_ies`` ships no binary ``.grb`` to read them from any
    other way."""
    text = dis_path.read_text()
    block = re.search(r"BEGIN Dimensions(.*?)END Dimensions", text, re.IGNORECASE | re.DOTALL)
    assert block is not None, f"{dis_path} has no Dimensions block"
    body = block.group(1)

    def _find(key: str) -> int:
        match = re.search(rf"^\s*{key}\s+(\d+)", body, re.IGNORECASE | re.MULTILINE)
        assert match is not None, f"{dis_path} Dimensions block has no {key}"
        return int(match.group(1))

    return _find("NLAY"), _find("NROW"), _find("NCOL")


# ---------------------------------------------------------------------------
# Every real benchmark run: the grid opens, the mesh matches its own shape.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("run_fixture", _GRID_RUN_FIXTURES)
def test_a_real_grid_file_opens_and_the_mesh_matches_the_grids_own_cell_count(
    request: pytest.FixtureRequest, run_fixture: str
):
    run_dir = request.getfixturevalue(run_fixture)
    _, adapter = _open_run(run_dir)

    shape = adapter.grid_shape()
    assert isinstance(shape, GridShape), shape

    mesh = adapter.grid_mesh()
    assert isinstance(mesh, MeshBuffers)

    # n_cells is the grid's own cell count -- ncpl -- never a number this
    # test measured once and pinned.
    assert mesh.n_cells == shape.ncpl
    # positions has one row per vertex the grid's rings actually carry, and
    # cell_index has exactly one entry per vertex row -- that relationship
    # holds for any grid, unlike the exact vertex count.
    assert mesh.positions.shape[0] == mesh.cell_index.shape[0]
    assert mesh.positions.shape[0] > 0
    # indices is a flat triangle-index list: three entries per triangle.
    assert mesh.indices.shape[0] % 3 == 0
    # cell_index never names a cell beyond the grid's own last cell.
    assert int(mesh.cell_index.max()) == mesh.n_cells - 1
    assert mesh.positions.dtype.name == "float32"
    assert mesh.cell_index.dtype.name == "float32"
    assert mesh.indices.dtype.name == "uint32"


@pytest.mark.parametrize("run_fixture", _GRID_RUN_FIXTURES)
def test_crs_is_none_for_every_benchmark_run_which_is_the_normal_state_not_a_failure(
    request: pytest.FixtureRequest, run_fixture: str
):
    """``MfGrdFile`` never carries a projection field and ``pyproj`` is not
    a project dependency -- every run this phase can open reports no CRS,
    and that absence is the ordinary case, not something gone wrong."""
    run_dir = request.getfixturevalue(run_fixture)
    _, adapter = _open_run(run_dir)

    assert adapter.crs() is None


@pytest.mark.parametrize("run_fixture", _GRID_RUN_FIXTURES)
def test_locate_par_does_not_raise_against_a_real_control_table_and_covers_every_group(
    request: pytest.FixtureRequest, run_fixture: str
):
    run_dir = request.getfixturevalue(run_fixture)
    layout, adapter = _open_run(run_dir)

    control = read_control(layout.pst_path)
    assert not isinstance(control, ReadFailure), control

    result = adapter.locate_par(control.par)
    assert isinstance(result, ParCells)

    covered = {g.group for g in result.groups}
    assert covered == set(control.par_groups)
    assert len(result.parnme) == len(control.par)


def test_the_vertex_grid_run_built_by_pstfrom_places_some_groups_and_marks_most_unplaceable(
    pl253_run: Path,
):
    """``pl253_run`` is the real, ``PstFrom``-built DISV run this phase's
    research measured as 99% unplaceable -- not an edge case for a real
    vertex grid, the typical one. This asserts the shape of that outcome
    (some placed, most not, one sentence) rather than the exact ratio,
    which is specific to one local copy of the data."""
    layout, adapter = _open_run(pl253_run)
    control = read_control(layout.pst_path)
    assert not isinstance(control, ReadFailure)

    result = adapter.locate_par(control.par)
    assert isinstance(result, ParCells)

    assert result.placed_groups
    assert result.unplaced_groups
    assert len(result.unplaced_groups) > len(result.placed_groups)
    assert result.summary
    assert "\n" not in result.summary
    assert result.summary.count(".") == 1


@pytest.mark.parametrize("run_fixture", _GRID_RUN_FIXTURES)
def test_reading_a_real_run_directory_leaves_it_byte_and_mtime_identical(
    request: pytest.FixtureRequest, run_fixture: str
):
    """The most important test in this file: these directories are a
    scientist's finished output, often on read-only archive media, and
    nobody wrote this data for the test -- so proving nothing was written
    here is the strongest evidence this project's first hard rule holds."""
    run_dir = request.getfixturevalue(run_fixture)
    before = _snapshot(run_dir)

    layout, adapter = _open_run(run_dir)
    adapter.grid_mesh()
    adapter.grid_shape()
    adapter.idomain()
    adapter.crs()
    control = read_control(layout.pst_path)
    if not isinstance(control, ReadFailure):
        adapter.locate_par(control.par)
        adapter.locate_obs(control.obs)

    after = _snapshot(run_dir)
    assert after == before


# ---------------------------------------------------------------------------
# The two public example runs -- real column data the benchmark set lacks.
# ---------------------------------------------------------------------------


def test_the_single_layer_structured_run_places_its_groups_via_ij_single_layer(
    single_layer_structured_run: Path,
):
    """``lheg_ies`` is the only real single-layer (``nlay == 1``) structured
    grid reachable anywhere -- the one real evidence for ``ij-single-layer``,
    which no benchmark run (all multi-layer) can exercise."""
    layout, adapter = _open_run(single_layer_structured_run)
    shape = adapter.grid_shape()
    assert isinstance(shape, GridShape)
    assert shape.nlay == 1
    assert shape.ncol is not None  # a structured grid, not a vertex grid

    control = read_control(layout.pst_path)
    assert not isinstance(control, ReadFailure)

    result = adapter.locate_par(control.par)
    assert isinstance(result, ParCells)

    rules_fired = {g.rule for g in result.groups}
    assert "ij-single-layer" in rules_fired


def test_the_multi_layer_structured_run_places_its_groups_via_idx_triple_and_ij_name_layer(
    multi_layer_structured_run: Path,
):
    """``freyberg_ies`` carries no binary ``.grb`` -- only the ASCII
    ``freyberg6.dis`` package -- so there is no ``Mf6Adapter`` to build from
    it. Its real control table is read the normal way; its grid shape comes
    from the ``.dis`` file's own ``Dimensions`` block, and ``resolve()`` is
    called directly with it. This is the one real evidence for
    ``idx-triple`` and ``ij-name-layer`` -- no benchmark run and no
    single-layer fixture reaches either."""
    dis_path = multi_layer_structured_run / "freyberg6.dis"
    pst_path = multi_layer_structured_run / "freyberg.pst"
    assert dis_path.is_file()
    assert pst_path.is_file()

    nlay, nrow, ncol = _dis_dimensions(dis_path)
    assert nlay > 1  # the multi-layer half of its name
    shape = GridShape(ncpl=nrow * ncol, nlay=nlay, nrow=nrow, ncol=ncol)

    control = read_control(pst_path)
    assert not isinstance(control, ReadFailure)

    result = resolve(control.par, shape)
    assert isinstance(result, ParCells)

    rules_fired = {g.rule for g in result.groups}
    assert "idx-triple" in rules_fired
    assert "ij-name-layer" in rules_fired
