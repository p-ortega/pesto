"""The section route, end to end on a synthetic DISV grid: the grid file goes
through the grid and elev artifacts into a cache, and the route answers from
that cache alone."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from model.fixtures import write_disv_grb
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


def _build_cache(run_dir: Path, cache_dir: Path, *, with_elev: bool = True) -> CacheLayout:
    layout = CacheLayout(root=cache_dir)
    layout.ensure()
    adapter = Mf6Adapter(run_dir / "model.disv.grb")
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
