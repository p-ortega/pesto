"""The section route, end to end on a synthetic DISV grid: the grid file goes
through the grid and elev artifacts into a cache, and the route answers from
that cache alone."""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from model.fixtures import write_dis_grb, write_disv_grb
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.elev import ELEV_PREDATES, write_elev_from_adapter
from pesto.ingest.mesh import write_grid_from_adapter
from pesto.model.mf6 import Mf6Adapter

BASE_URL = "http://127.0.0.1"
# Starts left of cell 0 and ends inside cell 2, along y = 0.5 in grid coordinates.
LINE = {"ax": 999.5, "ay": 2000.5, "bx": 1003.0, "by": 2000.5}


def _snapshot(folder: Path) -> dict[str, tuple[int, int]]:
    return {
        str(p.relative_to(folder)): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(folder.rglob("*"))
    }


def _build_cache(
    run_dir: Path,
    cache_dir: Path,
    *,
    with_elev: bool = True,
    grid_file: str = "model.disv.grb",
) -> CacheLayout:
    layout = CacheLayout(root=cache_dir)
    layout.ensure()
    adapter = Mf6Adapter(run_dir / grid_file)
    grid = write_grid_from_adapter(adapter, layout)
    manifest = Manifest.empty(str(run_dir))
    manifest.mark_ok("grid", sources=[], files=grid.files)
    if with_elev:
        elev = write_elev_from_adapter(adapter, layout)
        assert not hasattr(elev, "reason"), elev
        manifest.mark_ok("elev", sources=[], files=elev.files)
    manifest.save(layout)
    return layout


def _client(layout: CacheLayout) -> TestClient:
    app, token = create_app()
    app.state.cache_root = str(layout.root)
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    return client


@pytest.fixture
def run_dir(tmp_path):
    folder = tmp_path / "run"
    folder.mkdir()
    write_disv_grb(folder / "model.disv.grb")
    return folder


def _assert_three_pieces(body):
    assert body["cell"] == [0, 1, 2]
    assert body["n_pieces"] == 3
    assert body["s0"] == pytest.approx([0.5, 1.5, 3.0], abs=1e-9)
    assert body["s1"] == pytest.approx([1.5, 2.5, 3.5], abs=1e-9)


def test_a_line_across_the_disv_grid_answers_its_pieces_elevations_and_statuses(
    tmp_path, run_dir
):
    before = _snapshot(run_dir)
    layout = _build_cache(run_dir, tmp_path / "cache")
    client = _client(layout)

    response = client.get("/api/run/grid/section", params=LINE)

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    _assert_three_pieces(body)
    assert body["line"] == {"a": [999.5, 2000.5], "b": [1003.0, 2000.5], "length": 3.5}
    assert body["nlay"] == 2
    assert body["z"] == [10, 5, 0, 10, 5, 0, 10, 5, 0]
    # Cell 1 of layer 1 is the fixture's one inactive cell.
    assert body["status"] == [0, 0, 0, 1, 0, 0]
    assert body["has_idomain"] is True
    assert body["grid_type"] == "vertex"
    assert body["length_units"] is None
    assert body["status_text"]["1"] == "inactive (idomain 0)"
    assert set(body["status_text"]) == {"0", "1", "2", "3", "4", "5"}
    assert set(body["counts"]) == {
        "candidates",
        "zero_length_dropped",
        "ties_resolved",
        "bottom_above_top",
        "pinched",
        "idomain_below_minus_1",
        "non_finite",
    }
    assert isinstance(body["notes"], list)
    assert body["tag"] is not None

    assert _snapshot(run_dir) == before


def test_the_section_still_answers_after_the_grid_file_is_gone(tmp_path, run_dir):
    layout = _build_cache(run_dir, tmp_path / "cache")
    (run_dir / "model.disv.grb").unlink()
    client = _client(layout)

    response = client.get("/api/run/grid/section", params=LINE)

    assert response.status_code == 200, response.text
    _assert_three_pieces(response.json())


def test_a_cache_with_no_elev_entry_is_told_it_predates_the_section_view(tmp_path, run_dir):
    layout = _build_cache(run_dir, tmp_path / "cache", with_elev=False)
    client = _client(layout)

    response = client.get("/api/run/grid/section", params=LINE)

    assert response.status_code == 409
    body = response.json()
    assert body["artifact"] == "elev"
    assert body["detail"] == ELEV_PREDATES


def test_no_route_serves_the_elevation_arrays(tmp_path, run_dir):
    layout = _build_cache(run_dir, tmp_path / "cache")
    client = _client(layout)

    assert client.get("/api/run/grid/elev").status_code == 404


def test_importing_the_section_route_loads_neither_flopy_nor_the_model_package():
    code = (
        "import sys, pesto.api.section; "
        "print(sorted(m for m in ('flopy', 'pyemu', 'pesto.model') if m in sys.modules))"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)

    assert out.stdout.strip() == "[]"


def test_two_ends_on_the_same_spot_are_refused(tmp_path, run_dir):
    layout = _build_cache(run_dir, tmp_path / "cache")
    client = _client(layout)

    response = client.get(
        "/api/run/grid/section", params={"ax": 1000.5, "ay": 2000.5, "bx": 1000.5, "by": 2000.5}
    )

    assert response.status_code == 422
    assert response.json()["title"] == "the two ends are on the same spot"


def test_a_coordinate_that_is_not_a_finite_number_is_refused(tmp_path, run_dir):
    layout = _build_cache(run_dir, tmp_path / "cache")
    client = _client(layout)

    response = client.get("/api/run/grid/section", params={**LINE, "bx": "nan"})

    assert response.status_code == 422


def test_the_synthetic_run_carries_an_elev_artifact_the_section_route_reads(tmp_path):
    from fixtures.synthetic_run import write_synthetic_run
    from pesto.cache.layout import for_run

    dest = write_synthetic_run(tmp_path / "run")
    layout = for_run(dest)
    assert Manifest.load(layout).artifacts["elev"].state == "ok"
    client = _client(layout)
    origin = client.get("/api/run/grid/mesh").json()["origin"]

    # Along the middle of the row of six unit squares, end to end.
    response = client.get(
        "/api/run/grid/section",
        params={"ax": origin[0] - 3.5, "ay": origin[1], "bx": origin[0] + 3.5, "by": origin[1]},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["cell"] == [0, 1, 2, 3, 4, 5]
    assert body["s0"] == pytest.approx([0.5, 1.5, 2.5, 3.5, 4.5, 5.5], abs=1e-9)
    assert body["has_idomain"] is False


# --- refusals and the cap -------------------------------------------------


def test_a_line_wholly_outside_the_mesh_is_refused_rather_than_drawn_empty(tmp_path, run_dir):
    layout = _build_cache(run_dir, tmp_path / "cache")
    client = _client(layout)

    response = client.get(
        "/api/run/grid/section", params={"ax": 990.0, "ay": 1990.0, "bx": 991.0, "by": 1990.0}
    )

    assert response.status_code == 422
    assert response.json()["title"] == "the line crosses no model cell"


def test_a_line_with_both_ends_off_the_mesh_keeps_the_part_over_cells(tmp_path, run_dir):
    layout = _build_cache(run_dir, tmp_path / "cache")
    client = _client(layout)

    response = client.get("/api/run/grid/section", params={**LINE, "bx": 1004.5})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["line"]["length"] == pytest.approx(5.0, abs=1e-12)
    assert body["s0"][0] > 0
    assert body["s0"][0] == pytest.approx(0.5, abs=1e-9)
    assert body["s1"][-1] < body["line"]["length"]
    assert body["s1"][-1] == pytest.approx(4.0, abs=1e-9)


@pytest.mark.parametrize(
    ("params", "field"),
    [
        ({**LINE, "ax": "nan"}, "ax"),
        ({**LINE, "ay": "inf"}, "ay"),
        ({k: v for k, v in LINE.items() if k != "by"}, "by"),
        ({**LINE, "cx": 1.0}, "cx"),
    ],
)
def test_a_bad_query_is_refused_naming_the_field_and_not_the_value(
    tmp_path, run_dir, params, field
):
    layout = _build_cache(run_dir, tmp_path / "cache")
    client = _client(layout)

    response = client.get("/api/run/grid/section", params=params)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert f"query.{field}" in detail
    assert "nan" not in detail and "inf" not in detail


def test_an_answer_over_the_quad_cap_is_refused_naming_its_size(tmp_path, run_dir, monkeypatch):
    import pesto.api.section as section_route

    monkeypatch.setattr(section_route, "MAX_SECTION_QUADS", 4)
    layout = _build_cache(run_dir, tmp_path / "cache")
    client = _client(layout)

    response = client.get("/api/run/grid/section", params=LINE)

    assert response.status_code == 422
    body = response.json()
    assert body["title"] == "the section would hold too many cells"
    assert "3 pieces over 2 layers" in body["detail"]
    assert "6 section cells" in body["detail"]


def test_the_quad_cap_is_four_hundred_thousand():
    import pesto.api.section as section_route

    assert section_route.MAX_SECTION_QUADS == 400_000


def test_an_elev_artifact_recorded_failed_is_refused_with_its_reason(tmp_path, run_dir):
    layout = _build_cache(run_dir, tmp_path / "cache", with_elev=False)
    manifest = Manifest.load(layout)
    manifest.mark_failed("elev", "the grid file records no layer bottoms")
    manifest.save(layout)
    client = _client(layout)

    response = client.get("/api/run/grid/section", params=LINE)

    assert response.status_code == 409
    body = response.json()
    assert body["artifact"] == "elev"
    assert body["detail"] == "the grid file records no layer bottoms"


def test_no_open_run_is_refused():
    app, token = create_app()
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token

    response = client.get("/api/run/grid/section", params=LINE)

    assert response.status_code == 409
    assert response.json()["title"] == "no run is open"


# --- DIS and DISV grid files end to end -----------------------------------

DIS_NROW, DIS_NCOL, DIS_DELR = 3, 4, 10.0
TIES_NOTE = "lies on an edge shared by two cells; it went to the lower cell index"
TIES_NOTE_MANY = "lie on an edge shared by two cells; they went to the lower cell index"


def _section(client: TestClient, a, b) -> dict:
    response = client.get(
        "/api/run/grid/section", params={"ax": a[0], "ay": a[1], "bx": b[0], "by": b[1]}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _centres(grid_path: Path) -> np.ndarray:
    """Each cell's centre from the adapter's own float64 rings, by the adapter's own cell id."""
    geometry = Mf6Adapter(grid_path).geometry()
    assert not hasattr(geometry, "reason"), geometry
    ncpl = int(np.asarray(geometry.top).reshape(-1).shape[0])
    cell = np.asarray(geometry.cell_index).astype(np.int64)
    pos = np.asarray(geometry.positions, dtype=np.float64)
    total = np.zeros((ncpl, 2))
    np.add.at(total, cell, pos)
    return total / np.bincount(cell, minlength=ncpl)[:, None]


def _rotated_dis(tmp_path, **kwargs) -> tuple[Path, np.ndarray]:
    folder = tmp_path / "run"
    folder.mkdir()
    grid = write_dis_grb(
        folder / "model.dis.grb",
        nrow=DIS_NROW,
        ncol=DIS_NCOL,
        delr=DIS_DELR,
        delc=20.0,
        angrot=30,
        **kwargs,
    )
    return folder, _centres(grid)


def _row_ids(row: int) -> list[int]:
    return [row * DIS_NCOL + col for col in range(DIS_NCOL)]


def _extended(first: np.ndarray, last: np.ndarray, by: float):
    """The line from ``first`` to ``last``, lengthened by ``by`` at both ends."""
    u = (last - first) / np.hypot(*(last - first))
    return tuple(first - by * u), tuple(last + by * u)


def test_a_rotated_dis_line_along_a_rows_centres_returns_that_row_in_column_order(tmp_path):
    run, centres = _rotated_dis(tmp_path)
    row = _row_ids(1)
    # The adapter's own ids are row-major: the row's centres sit on one straight line.
    first, last = centres[row[0]], centres[row[-1]]
    for c in row[1:-1]:
        offset = centres[c] - first
        direction = last - first
        assert abs(offset[0] * direction[1] - offset[1] * direction[0]) < 1e-6
    # The centres of the end cells are half a cell in; a cell more puts the ends half a cell out.
    a, b = _extended(first, last, DIS_DELR)
    client = _client(_build_cache(run, tmp_path / "cache", grid_file="model.dis.grb"))

    body = _section(client, a, b)

    assert body["cell"] == row
    assert body["grid_type"] == "structured"
    assert body["s0"][0] == pytest.approx(DIS_DELR / 2, abs=1e-6)
    assert body["s1"][-1] == pytest.approx(body["line"]["length"] - DIS_DELR / 2, abs=1e-6)
    assert body["status"] == [0] * (len(row) * 2)


def test_a_rotated_dis_line_along_a_row_boundary_goes_to_the_lower_row_and_says_so(tmp_path):
    run, centres = _rotated_dis(tmp_path)
    upper, lower = _row_ids(0), _row_ids(1)
    first = 0.5 * (centres[upper[0]] + centres[lower[0]])
    last = 0.5 * (centres[upper[-1]] + centres[lower[-1]])
    a, b = _extended(first, last, DIS_DELR)
    client = _client(_build_cache(run, tmp_path / "cache", grid_file="model.dis.grb"))

    body = _section(client, a, b)

    assert body["cell"] == upper
    assert body["counts"]["ties_resolved"] > 0
    assert any(TIES_NOTE in n or TIES_NOTE_MANY in n for n in body["notes"])


def test_a_dis_grid_with_no_idomain_reads_its_statuses_from_the_elevations_alone(tmp_path):
    run, centres = _rotated_dis(tmp_path, idomain=False)
    row = _row_ids(1)
    a, b = _extended(centres[row[0]], centres[row[-1]], DIS_DELR)
    client = _client(_build_cache(run, tmp_path / "cache", grid_file="model.dis.grb"))

    body = _section(client, a, b)

    assert body["has_idomain"] is False
    assert body["cell"] == row
    assert body["status"] == [0] * (len(row) * 2)


def test_a_dis_idomain_and_bad_elevations_reach_the_section_as_absence(tmp_path):
    nlay = 2
    idomain = np.ones((nlay, DIS_NROW, DIS_NCOL), dtype=np.int32)
    idomain[0, 1, 0] = 0
    idomain[1, 1, 1] = -2
    botm = np.empty((nlay, DIS_NROW, DIS_NCOL))
    botm[0], botm[1] = 5.0, 0.0
    botm[1, 1, 2] = 5.0
    botm[1, 1, 3] = 6.0
    run, centres = _rotated_dis(tmp_path, botm=botm, idomain_values=idomain)
    row = _row_ids(1)
    a, b = _extended(centres[row[0]], centres[row[-1]], DIS_DELR)
    client = _client(_build_cache(run, tmp_path / "cache", grid_file="model.dis.grb"))

    body = _section(client, a, b)

    assert body["cell"] == row
    assert body["status"] == [1, 0, 0, 2, 0, 3, 0, 4]
    assert body["z"][3 * 3 :] == [10, 5, 6]
    assert body["counts"]["idomain_below_minus_1"] == 1
    assert body["counts"]["pinched"] == 1
    assert body["counts"]["bottom_above_top"] == 1
    assert len(body["notes"]) == 3


# A U opening upwards, with a block under it: a line across both arms crosses the U twice.
U_VERTICES = [
    (0.0, 0.0), (0.0, 3.0), (1.0, 3.0), (1.0, 1.0),
    (2.0, 1.0), (2.0, 3.0), (3.0, 3.0), (3.0, 0.0),
    (0.0, -1.0), (3.0, -1.0),
]  # fmt: skip
U_RINGS = [(0, 1, 2, 3, 4, 5, 6, 7), (8, 0, 7, 9)]


def test_a_concave_disv_cell_crossed_twice_gives_two_pieces_with_one_id(tmp_path):
    folder = tmp_path / "run"
    folder.mkdir()
    write_disv_grb(
        folder / "model.disv.grb",
        vertices=U_VERTICES,
        rings=U_RINGS,
        idomain=np.ones((2, 2), dtype=np.int32),
    )
    client = _client(_build_cache(folder, tmp_path / "cache"))

    body = _section(client, (999.5, 2002.0), (1003.5, 2002.0))

    assert body["cell"] == [0, 0]
    assert body["s0"] == pytest.approx([0.5, 2.5], abs=1e-9)
    assert body["s1"] == pytest.approx([1.5, 3.5], abs=1e-9)


def test_a_disv_line_through_a_shared_vertex_drops_the_corner_cell_and_counts_it(
    tmp_path, run_dir
):
    client = _client(_build_cache(run_dir, tmp_path / "cache"))

    # Down and to the right through (1, 1), the corner cells 0 and 1 share.
    body = _section(client, (1000.5, 2001.5), (1001.5, 2000.5))

    assert body["cell"] == [1]
    assert body["counts"]["zero_length_dropped"] >= 1
    assert any("of zero length" in n for n in body["notes"])


def test_disv_pinched_inverted_and_pass_through_quads_say_why_they_are_absent(tmp_path):
    folder = tmp_path / "run"
    folder.mkdir()
    botm = np.array([[5.0, 5.0, 5.0], [5.0, 0.0, 7.0]])
    idomain = np.ones((2, 3), dtype=np.int32)
    idomain[0, 2] = -1
    write_disv_grb(folder / "model.disv.grb", botm=botm, idomain=idomain)
    client = _client(_build_cache(folder, tmp_path / "cache"))

    body = _section(client, (LINE["ax"], LINE["ay"]), (LINE["bx"], LINE["by"]))

    assert body["cell"] == [0, 1, 2]
    assert body["status"] == [0, 3, 0, 0, 2, 4]
    # The bottom above the top is kept as the grid file gave it, never swapped.
    assert body["z"][6:] == [10, 5, 7]
    assert body["counts"]["pinched"] == 1
    assert body["counts"]["bottom_above_top"] == 1
    assert "1 section cell is pinched out (zero thickness); drawn as absence" in body["notes"]
    assert "1 section cell has its bottom above its top; drawn as absence" in body["notes"]


def test_a_disv_idomain_below_minus_one_is_pass_through_with_a_note(tmp_path):
    folder = tmp_path / "run"
    folder.mkdir()
    idomain = np.ones((2, 3), dtype=np.int32)
    idomain[1, 0] = -3
    write_disv_grb(folder / "model.disv.grb", idomain=idomain)
    client = _client(_build_cache(folder, tmp_path / "cache"))

    body = _section(client, (LINE["ax"], LINE["ay"]), (LINE["bx"], LINE["by"]))

    assert body["status"][:2] == [0, 2]
    assert body["counts"]["idomain_below_minus_1"] == 1
    assert body["notes"] == [
        "1 section cell has an idomain below -1; read as vertical pass-through (idomain -1)"
    ]


def test_a_disv_line_at_a_real_northing_gives_the_same_cells_and_distances(tmp_path):
    answers = []
    for yorigin in (2000.0, 7.02e6):
        folder = tmp_path / f"run-{yorigin:.0f}"
        folder.mkdir()
        write_disv_grb(folder / "model.disv.grb", yorigin=yorigin)
        client = _client(_build_cache(folder, tmp_path / f"cache-{yorigin:.0f}"))
        shift = yorigin - 2000.0
        answers.append(
            _section(
                client, (LINE["ax"], LINE["ay"] + shift), (LINE["bx"], LINE["by"] + shift)
            )
        )

    near, far = answers
    assert far["cell"] == near["cell"] == [0, 1, 2]
    assert far["s0"] == pytest.approx(near["s0"], abs=1e-6)
    assert far["s1"] == pytest.approx(near["s1"], abs=1e-6)
    assert far["status"] == near["status"]


# The browser's half of the tracer was built on this file; the repository root is two up.
TRACER_ANSWER = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "tests"
    / "fixtures"
    / "section-tracer-answer.json"
)
# The answer's float fields. The browser's JSON writes 10.0 as 10, so here a number is
# compared as a float whatever its spelling; everywhere else the type must match too.
FLOAT_FIELDS = {"line", "s0", "s1", "z"}


def _assert_same(got, want, where: str, as_float: bool = False) -> None:
    if isinstance(want, dict):
        assert isinstance(got, dict), where
        assert set(got) == set(want), f"{where}: keys {sorted(got)} != {sorted(want)}"
        for key in want:
            _assert_same(got[key], want[key], f"{where}.{key}", as_float or key in FLOAT_FIELDS)
    elif isinstance(want, list):
        assert isinstance(got, list) and len(got) == len(want), where
        for i, (g, w) in enumerate(zip(got, want)):
            _assert_same(g, w, f"{where}[{i}]", as_float)
    elif as_float and isinstance(want, (int, float)) and not isinstance(want, bool):
        assert isinstance(got, (int, float)) and not isinstance(got, bool), where
        assert math.isclose(got, want, rel_tol=0, abs_tol=1e-9), f"{where}: {got!r} != {want!r}"
    else:
        assert type(got) is type(want) and got == want, f"{where}: {got!r} != {want!r}"


def test_the_route_answer_for_the_tracer_line_is_the_one_the_browser_was_built_on(
    tmp_path, run_dir
):
    want = json.loads(TRACER_ANSWER.read_text())
    client = _client(_build_cache(run_dir, tmp_path / "cache"))

    got = _section(client, (LINE["ax"], LINE["ay"]), (LINE["bx"], LINE["by"]))

    assert set(got) == set(want)
    got.pop("tag")
    want.pop("tag")
    _assert_same(got, want, "answer")
