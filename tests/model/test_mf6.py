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
import threading
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.ingest.failures import ReadFailure
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


# ---------------------------------------------------------------------------
# Task 3: every way a grid file can be unreadable costs one named failure.
# ---------------------------------------------------------------------------


def test_a_path_that_does_not_exist_returns_a_read_failure_not_an_exception(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    grid_path = tmp_path / "absent.grb"
    adapter = Mf6Adapter(grid_path)

    result = adapter.grid_mesh()

    assert isinstance(result, ReadFailure)
    assert result.name == "absent.grb"
    assert "absent.grb" in result.reason


def test_a_grid_file_truncated_to_half_its_bytes_costs_one_read_failure_from_every_method(
    tmp_path,
):
    from pesto.model.mf6 import Mf6Adapter

    good = write_disv_grb(tmp_path / "good.disv.grb")
    truncated = tmp_path / "truncated.disv.grb"
    original = good.read_bytes()
    truncated.write_bytes(original[: len(original) // 2])

    adapter = Mf6Adapter(truncated)

    par = pd.DataFrame({"pargp": ["g"], "idx0": [0], "idx1": [0]})
    obs = pd.DataFrame({"obsnme": ["obs:a"]})

    for result in (
        adapter.grid_mesh(),
        adapter.grid_shape(),
        adapter.idomain(),
        adapter.crs(),
        adapter.locate_par(par),
        adapter.locate_obs(obs),
    ):
        assert isinstance(result, ReadFailure)


def test_a_grid_file_of_unrelated_bytes_costs_one_read_failure_not_an_exception(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    garbage = tmp_path / "garbage.disv.grb"
    garbage.write_bytes(b"not a grid file, just unrelated bytes filling up space here" * 20)

    adapter = Mf6Adapter(garbage)

    result = adapter.grid_mesh()

    assert isinstance(result, ReadFailure)
    assert result.name == "garbage.disv.grb"


def test_a_grid_file_flopy_parses_but_cannot_turn_into_a_model_grid_returns_a_read_failure_not_an_empty_mesh(
    tmp_path,
):
    """Every individual record here is well formed -- ``BOTM`` is declared
    with length ``ncpl`` instead of ``nlay * ncpl`` (``write_disv_grb``'s
    ``inconsistent_botm=True``), the one malformation this session
    confirmed reaches flopy's own "no model grid" path rather than raising.
    ``MfGrdFile._set_modelgrid`` catches the resulting reshape failure
    internally, prints a line, and leaves the model grid unset -- pesto
    receives ``None`` with no exception raised at all, which is exactly
    the case ``Mf6Adapter`` must turn into a named failure rather than an
    empty mesh."""
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_disv_grb(tmp_path / "inconsistent.disv.grb", inconsistent_botm=True)

    adapter = Mf6Adapter(grid_path)
    result = adapter.grid_mesh()

    assert isinstance(result, ReadFailure)
    assert grid_path.name in result.reason
    assert "no model grid" in result.reason


def test_a_bad_file_is_parsed_once_no_matter_how_many_methods_are_called(tmp_path, monkeypatch):
    from pesto.model.mf6 import Mf6Adapter

    garbage = tmp_path / "garbage.disv.grb"
    garbage.write_bytes(b"garbage bytes, not a real grid file at all" * 10)

    calls: list[int] = []

    def _counting_load_flopy():
        calls.append(1)

    monkeypatch.setattr("pesto.warm.load_flopy", _counting_load_flopy)

    adapter = Mf6Adapter(garbage)
    par = pd.DataFrame({"pargp": ["g"], "idx0": [0], "idx1": [0]})
    obs = pd.DataFrame({"obsnme": ["obs:a"]})

    adapter.grid_mesh()
    adapter.grid_shape()
    adapter.idomain()
    adapter.crs()
    adapter.locate_par(par)
    adapter.locate_obs(obs)

    assert len(calls) == 1


def test_two_successive_reads_of_a_good_file_return_equal_buffers(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_disv_grb(tmp_path / "good.disv.grb")
    adapter = Mf6Adapter(grid_path)

    first = adapter.grid_mesh()
    second = adapter.grid_mesh()

    assert np.array_equal(first.positions, second.positions)
    assert np.array_equal(first.cell_index, second.cell_index)
    assert np.array_equal(first.indices, second.indices)


def test_two_threads_making_the_first_call_concurrently_both_succeed_and_agree(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_disv_grb(tmp_path / "good.disv.grb")
    adapter = Mf6Adapter(grid_path)

    results: list = [None, None]
    errors: list = []

    def _call(index: int) -> None:
        try:
            results[index] = adapter.grid_mesh()
        except Exception as exc:  # pragma: no cover - failure path only
            errors.append(exc)

    threads = [threading.Thread(target=_call, args=(i,)) for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    first, second = results
    assert not isinstance(first, ReadFailure)
    assert not isinstance(second, ReadFailure)
    assert np.array_equal(first.positions, second.positions)
    assert np.array_equal(first.cell_index, second.cell_index)
    assert np.array_equal(first.indices, second.indices)


def test_a_read_failure_converts_to_a_failed_artifact_carrying_the_same_reason(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    adapter = Mf6Adapter(tmp_path / "absent.grb")

    result = adapter.grid_mesh()
    artifact = result.to_artifact()

    assert artifact.state == "failed"
    assert artifact.reason == result.reason


def _directory_snapshot(directory) -> dict:
    return {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in directory.iterdir()
    }


def test_reading_a_good_and_a_corrupt_grid_file_never_writes_to_their_directory(tmp_path):
    from pesto.model.mf6 import Mf6Adapter

    good = write_disv_grb(tmp_path / "good.disv.grb")
    corrupt = tmp_path / "corrupt.disv.grb"
    corrupt.write_bytes(b"junk bytes, not a real grid file" * 5)

    before = _directory_snapshot(tmp_path)

    par = pd.DataFrame({"pargp": ["g"], "idx0": [0], "idx1": [0]})
    obs = pd.DataFrame({"obsnme": ["obs:a"]})

    for path in (good, corrupt):
        adapter = Mf6Adapter(path)
        adapter.grid_mesh()
        adapter.grid_shape()
        adapter.idomain()
        adapter.crs()
        adapter.locate_par(par)
        adapter.locate_obs(obs)

    after = _directory_snapshot(tmp_path)
    assert after == before


def test_locate_par_on_a_table_with_no_pargp_column_returns_a_read_failure_not_a_keyerror(
    tmp_path,
):
    from pesto.model.mf6 import Mf6Adapter

    grid_path = write_disv_grb(tmp_path / "t.disv.grb")
    adapter = Mf6Adapter(grid_path)

    par = pd.DataFrame(
        {"idx0": [0], "idx1": [0]}, index=pd.Index(["par:a"], name="parnme")
    )

    result = adapter.locate_par(par)

    assert isinstance(result, ReadFailure)
    assert "pargp" in result.reason
    assert result.name == "parameter table"


def test_a_grid_with_no_cells_names_the_path_it_could_not_read(tmp_path, monkeypatch):
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
