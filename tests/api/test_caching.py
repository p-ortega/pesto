"""Pin the raw-bytes contract and the caching contract that ``pesto.api.blob``
implements and every numeric route shares.

The first half tests ``blob_response``, ``cache_tag`` and ``cache_headers``
directly, against hand-built arrays and manifests. The second half tests
the whole tag lifecycle through the mesh routes, tested against a real
FastAPI app the same way ``tests/test_launch.py`` already does. Every
assertion here is on header values and body bytes -- no timing, nothing
flaky.
"""

from __future__ import annotations

import json

import numpy as np
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.api.blob import blob_response, cache_headers, cache_tag
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import CacheFile, Manifest
from pesto.ingest.mesh import write_mesh
from pesto.model import GridShape, fan_polygons

BASE_URL = "http://127.0.0.1"


def _client(app) -> TestClient:
    return TestClient(app, base_url=BASE_URL)


# ---------------------------------------------------------------------------
# blob_response, cache_tag, cache_headers -- direct unit tests
# ---------------------------------------------------------------------------


def test_blob_response_reports_shape_dtype_and_the_exact_body_length():
    response = blob_response(np.arange(6, dtype="<f4"))
    assert len(response.body) == 24
    assert response.media_type == "application/octet-stream"
    meta = json.loads(response.headers["x-pesto-meta"])
    assert meta == {"shape": [6], "dtype": "<f4"}


def test_blob_response_on_a_non_contiguous_array_still_returns_c_order_bytes():
    array = np.arange(6, dtype="<f4").reshape(2, 3)
    transposed = array.T
    assert not transposed.flags["C_CONTIGUOUS"]

    response = blob_response(transposed)
    assert response.body == np.ascontiguousarray(transposed).tobytes()
    meta = json.loads(response.headers["x-pesto-meta"])
    assert meta["shape"] == list(transposed.shape)


def test_cache_tag_is_stable_and_changes_when_a_recorded_file_size_changes():
    manifest = Manifest.empty("run")
    manifest.mark_ok("grid", sources=[], files=(CacheFile(path="grid/positions.f32", bytes=100),))

    first = cache_tag(manifest, "grid")
    second = cache_tag(manifest, "grid")
    assert first is not None
    assert first == second

    manifest.mark_ok("grid", sources=[], files=(CacheFile(path="grid/positions.f32", bytes=200),))
    assert cache_tag(manifest, "grid") != first


def test_cache_tag_changes_with_cache_version_and_is_none_for_an_unrecorded_artifact():
    manifest = Manifest.empty("run")
    manifest.mark_ok("grid", sources=[], files=(CacheFile(path="grid/positions.f32", bytes=100),))
    tag_v1 = cache_tag(manifest, "grid")

    manifest.cache_version += 1
    tag_v2 = cache_tag(manifest, "grid")
    assert tag_v2 != tag_v1

    assert cache_tag(manifest, "no-such-artifact") is None


def test_cache_tag_is_none_for_an_artifact_recorded_as_failed():
    manifest = Manifest.empty("run")
    manifest.mark_failed("grid", reason="corrupt")
    assert cache_tag(manifest, "grid") is None


def test_cache_headers_marks_a_matching_tag_immutable_and_anything_else_no_store():
    matching = cache_headers("abc123", "abc123")
    assert "immutable" in matching["Cache-Control"]
    assert matching["ETag"] == '"abc123"'

    stale = cache_headers("abc123", "a-different-tag")
    assert stale["Cache-Control"] == "no-store"
    assert stale["ETag"] == '"abc123"'

    no_tag = cache_headers(None, None)
    assert no_tag == {"Cache-Control": "no-store"}


# ---------------------------------------------------------------------------
# The tag lifecycle through the mesh routes
# ---------------------------------------------------------------------------


def _mesh(crs="EPSG:26910"):
    verts = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [2.0, 0.0], [2.0, 1.0]])
    return fan_polygons(verts, [[0, 1, 2, 3], [1, 4, 5, 2]], nlay=2, crs=crs)


def _mesh_v2():
    """A grid whose vertex and triangle counts differ from ``_mesh()``, so
    a rewrite with this shape changes every recorded file's byte count --
    the fact the cache tag is built from."""
    verts = np.array(
        [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [2.0, 0.0], [2.0, 1.0], [2.0, 2.0]]
    )
    return fan_polygons(verts, [[0, 1, 2, 3], [1, 4, 5, 2], [2, 5, 6]], nlay=2)


def _write_grid_cache(tmp_path, *, crs="EPSG:26910"):
    mesh = _mesh(crs=crs)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    written = write_mesh(mesh, GridShape(ncpl=2, nlay=2, nrow=None, ncol=None), layout)
    manifest = Manifest.empty(str(tmp_path))
    manifest.mark_ok("grid", sources=[], files=written.files)
    manifest.save(layout)
    return layout, mesh


def _opened_client(tmp_path):
    app, token = create_app()
    layout, mesh = _write_grid_cache(tmp_path)
    app.state.cache_root = str(layout.root)
    client = _client(app)
    client.headers["x-pesto-token"] = token
    return client, layout, mesh


def test_a_fetch_with_no_v_is_not_stored_and_carries_the_current_etag(tmp_path):
    client, _layout, _mesh = _opened_client(tmp_path)
    tag = client.get("/api/run/grid/mesh").json()["tag"]

    response = client.get("/api/run/grid/mesh/positions")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["etag"] == f'"{tag}"'


def test_a_fetch_with_the_current_tag_is_marked_permanently_cacheable(tmp_path):
    client, _layout, _mesh = _opened_client(tmp_path)
    tag = client.get("/api/run/grid/mesh").json()["tag"]

    response = client.get("/api/run/grid/mesh/positions", params={"v": tag})
    assert "immutable" in response.headers["cache-control"]
    assert response.headers["etag"] == f'"{tag}"'


def test_a_wrong_v_is_not_stored_but_still_returns_the_current_bytes(tmp_path):
    client, _layout, mesh = _opened_client(tmp_path)

    response = client.get("/api/run/grid/mesh/positions", params={"v": "not-the-tag"})
    assert response.headers["cache-control"] == "no-store"
    assert len(response.content) == 2 * mesh.positions.shape[0] * 4


def test_rewriting_the_grid_artifact_changes_the_tag_and_stales_the_old_one(tmp_path):
    client, layout, _mesh = _opened_client(tmp_path)
    old_tag = client.get("/api/run/grid/mesh").json()["tag"]

    written = write_mesh(_mesh_v2(), GridShape(ncpl=3, nlay=2, nrow=None, ncol=None), layout)
    manifest = Manifest.load(layout)
    manifest.mark_ok("grid", sources=[], files=written.files)
    manifest.save(layout)

    new_tag = client.get("/api/run/grid/mesh").json()["tag"]
    assert new_tag != old_tag

    stale = client.get("/api/run/grid/mesh/positions", params={"v": old_tag})
    assert stale.headers["cache-control"] == "no-store"


def test_a_failed_grid_artifact_has_no_tag_and_the_route_is_not_stored(tmp_path):
    layout, _mesh = _write_grid_cache(tmp_path)
    manifest = Manifest.load(layout)
    manifest.mark_failed("grid", reason="corrupt")
    manifest.save(layout)

    app, token = create_app()
    app.state.cache_root = str(layout.root)
    client = _client(app)
    client.headers["x-pesto-token"] = token

    assert client.get("/api/run/grid/mesh").json()["tag"] is None
    response = client.get("/api/run/grid/mesh/positions")
    assert response.headers["cache-control"] == "no-store"
