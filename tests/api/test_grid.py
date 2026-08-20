"""Route tests for the mesh: counts, bounds and CRS as JSON, geometry as raw
little-endian bytes under one shape/dtype contract, tested against a real
FastAPI app the same way ``tests/test_launch.py`` already does.

Every fast test writes its own small grid with ``write_mesh`` into a
``tmp_path`` cache, so nothing here depends on benchmark data. One
``@pytest.mark.slow`` test additionally proves the same contract against a
real ingested run.
"""

from __future__ import annotations

import json
import shutil

import numpy as np
import pytest
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.mesh import write_mesh
from pesto.model import GridShape, fan_polygons

BASE_URL = "http://127.0.0.1"


def _client(app) -> TestClient:
    return TestClient(app, base_url=BASE_URL)


def _mesh(crs="EPSG:26910"):
    verts = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [2.0, 0.0], [2.0, 1.0]])
    return fan_polygons(verts, [[0, 1, 2, 3], [1, 4, 5, 2]], nlay=2, crs=crs)


def _write_grid_cache(tmp_path, *, crs="EPSG:26910"):
    mesh = _mesh(crs=crs)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    written = write_mesh(mesh, GridShape(ncpl=2, nlay=2, nrow=None, ncol=None), layout)
    manifest = Manifest.empty(str(tmp_path))
    manifest.mark_ok("grid", sources=[], files=written.files)
    manifest.save(layout)
    return layout, mesh


def _opened_client(tmp_path, **kwargs) -> tuple[TestClient, "CacheLayout", object]:
    app, token = create_app()
    layout, mesh = _write_grid_cache(tmp_path, **kwargs)
    app.state.cache_root = str(layout.root)
    client = _client(app)
    client.headers["x-pesto-token"] = token
    return client, layout, mesh


def _meta(response) -> dict:
    return json.loads(response.headers["x-pesto-meta"])


def test_mesh_document_reports_the_counts_the_arrays_were_written_with(tmp_path):
    client, _layout, mesh = _opened_client(tmp_path)

    response = client.get("/api/run/grid/mesh")
    assert response.status_code == 200
    body = response.json()
    assert body["n_vert"] == mesh.positions.shape[0]
    assert body["n_tri"] == mesh.indices.shape[0] // 3
    assert body["n_cells"] == mesh.n_cells
    assert body["nlay"] == mesh.nlay
    assert body["bounds"] == list(mesh.bounds)
    assert body["crs"] == mesh.crs
    assert body["buffers"]["positions"]["count"] == 2 * mesh.positions.shape[0]


def test_buffer_dtype_strings_match_mesh_json_exactly(tmp_path):
    client, layout, _mesh = _opened_client(tmp_path)

    mesh_json = json.loads((layout.grid / "mesh.json").read_text())
    body = client.get("/api/run/grid/mesh").json()

    for name in ("positions", "cell_index", "indices"):
        assert body["buffers"][name]["dtype"] == mesh_json["files"][name]["dtype"]


def test_each_buffer_body_length_matches_its_declared_element_count(tmp_path):
    client, _layout, mesh = _opened_client(tmp_path)

    positions = client.get("/api/run/grid/mesh/positions")
    assert len(positions.content) == 2 * mesh.positions.shape[0] * 4

    cell_index = client.get("/api/run/grid/mesh/cell_index")
    assert len(cell_index.content) == mesh.positions.shape[0] * 4

    indices = client.get("/api/run/grid/mesh/indices")
    assert len(indices.content) == mesh.indices.shape[0] * 4


def test_positions_buffer_reports_a_two_dimensional_shape(tmp_path):
    client, _layout, mesh = _opened_client(tmp_path)

    response = client.get("/api/run/grid/mesh/positions")
    meta = _meta(response)
    assert meta["shape"] == [mesh.positions.shape[0], 2]


def test_each_buffer_round_trips_through_frombuffer_to_the_written_array(tmp_path):
    client, _layout, mesh = _opened_client(tmp_path)

    for name, expected in (
        ("positions", mesh.positions),
        ("cell_index", mesh.cell_index),
        ("indices", mesh.indices),
    ):
        response = client.get(f"/api/run/grid/mesh/{name}")
        meta = _meta(response)
        rebuilt = np.frombuffer(response.content, dtype=meta["dtype"]).reshape(meta["shape"])
        np.testing.assert_array_equal(rebuilt, expected)


def test_an_unknown_buffer_name_is_a_422_problem_body(tmp_path):
    client, _layout, _mesh = _opened_client(tmp_path)

    response = client.get("/api/run/grid/mesh/normals")
    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"


def test_a_grid_with_no_crs_reports_null_and_no_warning(tmp_path):
    client, _layout, _mesh = _opened_client(tmp_path, crs=None)

    body = client.get("/api/run/grid/mesh").json()
    assert body["crs"] is None
    assert not any("warn" in key.lower() for key in body)


def test_a_removed_grid_directory_returns_a_problem_naming_grid(tmp_path):
    client, layout, _mesh = _opened_client(tmp_path)
    shutil.rmtree(layout.grid)

    for path in ("/api/run/grid/mesh", "/api/run/grid/mesh/positions"):
        response = client.get(path)
        assert response.status_code == 502
        assert response.json()["artifact"] == "grid"


def test_no_active_run_is_a_409_on_both_routes():
    app, token = create_app()
    client = _client(app)
    client.headers["x-pesto-token"] = token

    for path in ("/api/run/grid/mesh", "/api/run/grid/mesh/positions"):
        response = client.get(path)
        assert response.status_code == 409


def test_a_matching_v_tag_marks_the_buffer_permanently_cacheable(tmp_path):
    client, _layout, _mesh = _opened_client(tmp_path)

    tag = client.get("/api/run/grid/mesh").json()["tag"]
    matching = client.get("/api/run/grid/mesh/positions", params={"v": tag})
    assert "immutable" in matching.headers["cache-control"]

    stale = client.get("/api/run/grid/mesh/positions", params={"v": "not-the-tag"})
    assert stale.headers["cache-control"] == "no-store"


@pytest.mark.slow
def test_real_ingested_grid_serves_every_buffer_at_its_declared_length(forecast_run, tmp_path):
    """A behaviour assertion, not a fact about this particular benchmark
    folder: whatever the grid's real counts turn out to be, each buffer's
    body must be exactly that many elements long."""
    from pesto.ingest.runner import ingest_run

    cache_root = tmp_path / "cache"
    manifest = ingest_run(forecast_run, cache_root=cache_root)
    assert manifest.artifacts["grid"].state == "ok", manifest.artifacts["grid"].reason

    app, token = create_app()
    app.state.cache_root = str(cache_root)
    client = _client(app)
    client.headers["x-pesto-token"] = token

    mesh_body = client.get("/api/run/grid/mesh").json()
    itemsize = {"positions": 4, "cell_index": 4, "indices": 4}
    for name, size in itemsize.items():
        response = client.get(f"/api/run/grid/mesh/{name}")
        assert len(response.content) == mesh_body["buffers"][name]["count"] * size
