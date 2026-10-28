"""The basemap routes end to end: list, inspect, register, state and image,
with every image and world file written by the test into tmp_path (D-27)."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from model.fixtures import _VERTICES, write_disv_grb
from pesto.api.app import create_app
from pesto.api.fs import _issue_id
from pesto.basemap.imageinfo import TIFF_REASON
from pesto.basemap.worldfile import ROTATED_REASON
from pesto.cache.layout import CacheLayout
from pesto.ingest.mesh import load_mesh_extent, write_grid_from_adapter
from pesto.model.mf6 import Mf6Adapter

from .basemap_images import jpeg_header_bytes, png_bytes, tiff_bytes, world_file_text

BASE_URL = "http://127.0.0.1"


@dataclass
class Opened:
    client: TestClient
    run_dir: Path
    cache_root: Path
    images: Path
    tmp_path: Path
    responses: list = field(default_factory=list)

    def get(self, url, **kw):
        response = self.client.get(url, **kw)
        self.responses.append(response)
        return response

    def post(self, url, **kw):
        response = self.client.post(url, **kw)
        self.responses.append(response)
        return response

    def folder_id(self, folder: Path) -> str:
        """The id the picker would hand out for ``folder`` after browsing to it."""
        return _issue_id(self.client.app.state.fs_ids, folder)

    def file_id(self, name: str, folder: Path | None = None) -> str:
        listing = self.get("/api/fs/images", params={"id": self.folder_id(folder or self.images)})
        assert listing.status_code == 200, listing.text
        return next(e["id"] for e in listing.json()["entries"] if e["name"] == name)


def open_run(tmp_path: Path, monkeypatch, *, xorigin=1000.0, yorigin=2000.0, angrot=0.0, cache_root=None) -> Opened:
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    run_dir = tmp_path / "run"
    run_dir.mkdir(exist_ok=True)
    (run_dir / "case.pst").write_text("pcf\n")
    grb = write_disv_grb(tmp_path / "model.disv.grb", xorigin=xorigin, yorigin=yorigin, angrot=angrot)
    layout = CacheLayout(root=cache_root if cache_root is not None else tmp_path / "cache")
    layout.ensure()
    write_grid_from_adapter(Mf6Adapter(grb), layout)
    images = tmp_path / "images"
    images.mkdir(exist_ok=True)

    app, token = create_app()
    app.state.cache_root = str(layout.root)
    app.state.initial_run_dir = str(run_dir.resolve())
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    return Opened(client=client, run_dir=run_dir, cache_root=layout.root, images=images, tmp_path=tmp_path)


def put_png(folder: Path, name: str, width: int, height: int) -> Path:
    path = folder / name
    path.write_bytes(png_bytes(width, height))
    return path


def put_world_file(folder: Path, name: str, a=2.0, d=0.0, b=0.0, e=-2.0, c=1000.0, f=2000.0) -> Path:
    path = folder / name
    path.write_text(world_file_text(a, d, b, e, c, f))
    return path


def assert_no_path_leaked(opened: Opened) -> None:
    needle = str(opened.tmp_path)
    resolved = str(opened.tmp_path.resolve())
    for response in opened.responses:
        text = response.content.decode("latin-1")
        headers = json.dumps(dict(response.headers))
        for leak in (needle, resolved):
            assert leak not in text, response.request.url
            assert leak not in headers, response.request.url


@pytest.fixture
def opened(tmp_path, monkeypatch) -> Opened:
    return open_run(tmp_path, monkeypatch)


# ---------------------------------------------------------------------------
# The happy path, one PNG with one world file
# ---------------------------------------------------------------------------


def test_a_png_with_a_world_file_goes_through_every_route(opened):
    image = put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw")

    start = opened.get("/api/run/basemap/start")
    assert start.status_code == 200
    assert start.json()["name"] == "run"

    listing = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)})
    assert listing.status_code == 200
    rows = listing.json()["entries"]
    assert [(r["name"], r["kind"]) for r in rows] == [("map.png", "png")]
    assert listing.json()["skipped"]["other_files"] == 1
    file_id = rows[0]["id"]

    inspected = opened.post("/api/run/basemap/inspect", json={"id": file_id})
    assert inspected.status_code == 200, inspected.text
    body = inspected.json()
    assert body["name"] == "map.png"
    assert body["format"] == "png"
    assert (body["width"], body["height"]) == (100, 50)
    assert body["placement"] == {"by": "world_file", "world_file": "map.pgw", "extent": [999.0, 1199.0, 1901.0, 2001.0]}
    assert len(body["model_extent"]) == 4

    registered = opened.post("/api/run/basemap", json={"id": file_id, "stamp": body["stamp"], "by": "world_file"})
    assert registered.status_code == 200, registered.text
    state = registered.json()
    assert state["status"] == "ready"
    assert state["placed_by"] == "world_file"
    assert state["world_file"] == "map.pgw"
    assert state["extent"] == [999.0, 1199.0, 1901.0, 2001.0]
    assert "source" not in state

    again = opened.get("/api/run/basemap")
    assert again.json() == state

    served = opened.get("/api/run/basemap/image", params={"max": 4096})
    assert served.status_code == 200
    assert served.content == image.read_bytes()
    assert served.headers["content-type"] == "image/png"
    assert served.headers["x-content-type-options"] == "nosniff"
    assert served.headers["cache-control"] == "no-store"
    meta = json.loads(served.headers["x-pesto-meta"])
    assert meta["resize_to"] is None
    assert (meta["width"], meta["height"]) == (100, 50)
    assert meta["tag"] == state["tag"]

    assert_no_path_leaked(opened)


def test_an_image_wider_than_the_requested_size_is_served_whole_with_a_resize_target(opened):
    image = put_png(opened.images, "wide.png", 2000, 10)
    put_world_file(opened.images, "wide.pgw", a=0.01, e=-0.01, c=1000.0, f=2001.0)
    file_id = opened.file_id("wide.png")
    stamp = opened.post("/api/run/basemap/inspect", json={"id": file_id}).json()["stamp"]
    assert opened.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"}).status_code == 200

    served = opened.get("/api/run/basemap/image", params={"max": 512})
    assert served.content == image.read_bytes()
    meta = json.loads(served.headers["x-pesto-meta"])
    assert meta["resize_to"] == [512, 3]
    assert (meta["served_width"], meta["served_height"]) == (2000, 10)
    assert any("2000 × 10" in n and "512 × 3" in n for n in meta["notes"])
    assert_no_path_leaked(opened)


def test_a_changed_image_is_refused_at_register(opened):
    image = put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw")
    file_id = opened.file_id("map.png")
    stamp = opened.post("/api/run/basemap/inspect", json={"id": file_id}).json()["stamp"]
    image.write_bytes(png_bytes(100, 51))

    response = opened.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"})
    assert response.status_code == 409
    assert response.json()["code"] == "changed"


def test_register_takes_no_numbers_from_the_browser(opened):
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw")
    file_id = opened.file_id("map.png")
    stamp = opened.post("/api/run/basemap/inspect", json={"id": file_id}).json()["stamp"]

    response = opened.post(
        "/api/run/basemap",
        json={"id": file_id, "stamp": stamp, "by": "world_file", "extent": [0, 1, 0, 1]},
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# No run, unknown ids, folders
# ---------------------------------------------------------------------------


def test_every_run_route_answers_no_run_when_nothing_is_open(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    app, token = create_app()
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token

    responses = [
        client.get("/api/run/basemap/start"),
        client.post("/api/run/basemap/inspect", json={"id": "x"}),
        client.post("/api/run/basemap", json={"id": "x", "stamp": "s", "by": "world_file"}),
        client.get("/api/run/basemap"),
        client.get("/api/run/basemap/image"),
    ]
    for response in responses:
        assert response.status_code == 409, response.request.url
        assert response.json()["code"] == "no_run"


def test_an_unknown_id_is_gone_and_a_folder_id_is_not_a_file(opened):
    unknown = opened.post("/api/run/basemap/inspect", json={"id": "forged"})
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "gone"

    folder = opened.post("/api/run/basemap/inspect", json={"id": opened.folder_id(opened.images)})
    assert folder.status_code == 409
    assert folder.json()["code"] == "not_file"


def test_inspect_refuses_an_extra_field(opened):
    response = opened.post("/api/run/basemap/inspect", json={"id": "x", "path": "/etc"})
    assert response.status_code == 422


def test_the_image_route_with_nothing_registered_answers_none(opened):
    response = opened.get("/api/run/basemap/image")
    assert response.status_code == 404
    assert response.json()["code"] == "none"
    assert opened.get("/api/run/basemap").json() == {"status": "none"}


def test_the_routes_refuse_a_request_without_the_session_token(opened):
    opened.client.headers.pop("x-pesto-token")
    assert opened.client.get("/api/run/basemap").status_code == 401
    assert opened.client.get("/api/run/basemap/image").status_code == 401
    assert opened.client.get("/api/fs/images", params={"id": "x"}).status_code == 401


def test_an_unknown_folder_id_in_the_listing_is_no_longer_available(opened):
    response = opened.get("/api/fs/images", params={"id": "forged"})
    assert response.status_code == 404


def test_the_listing_puts_folders_first_and_skips_resource_forks(opened):
    (opened.images / "Zeta").mkdir()
    (opened.images / "alpha").mkdir()
    put_png(opened.images, "b.png", 2, 2)
    put_png(opened.images, "A.png", 2, 2)
    (opened.images / "._b.png").write_bytes(png_bytes(2, 2))
    (opened.images / "notes.txt").write_text("hello")

    listing = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)}).json()
    assert [(r["name"], r["kind"]) for r in listing["entries"]] == [
        ("alpha", "folder"),
        ("Zeta", "folder"),
        ("A.png", "png"),
        ("b.png", "png"),
    ]
    assert listing["skipped"] == {"other_files": 1, "not_checked": 0, "unreadable": 0}
    assert_no_path_leaked(opened)


def test_a_link_that_resolves_outside_the_folder_is_listed_with_a_reason_and_an_id_that_misses(opened):
    outside = opened.tmp_path / "elsewhere"
    outside.mkdir()
    put_png(outside, "secret.png", 2, 2)
    (opened.images / "out.png").symlink_to(outside / "secret.png")

    rows = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)}).json()["entries"]
    assert len(rows) == 1
    assert rows[0]["kind"] == "link"
    assert "outside" in rows[0]["reason"]
    inspected = opened.post("/api/run/basemap/inspect", json={"id": rows[0]["id"]})
    assert inspected.json()["code"] == "gone"


def test_a_misnamed_image_carries_a_note(opened):
    put_png(opened.images, "photo.jpg", 4, 4)
    rows = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)}).json()["entries"]
    assert rows[0]["kind"] == "png"
    assert rows[0]["note"] == "the name ends in .jpg but the bytes are PNG"


def test_a_mesh_with_no_origin_is_a_read_failure_not_a_mesh_at_zero(opened):
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw")
    mesh_json = opened.cache_root / "grid" / "mesh.json"
    raw = json.loads(mesh_json.read_text())
    del raw["origin"]
    mesh_json.write_text(json.dumps(raw))

    response = opened.post("/api/run/basemap/inspect", json={"id": opened.file_id("map.png")})
    assert response.status_code == 502
    assert response.json()["artifact"] == "grid"
    assert_no_path_leaked(opened)


# ---------------------------------------------------------------------------
# Refusals and the four-number form
# ---------------------------------------------------------------------------


def _inspect(opened: Opened, name: str):
    return opened.post("/api/run/basemap/inspect", json={"id": opened.file_id(name)})


def test_a_tiff_is_listed_with_the_reason_and_refused_at_inspect(opened):
    (opened.images / "scan.tif").write_bytes(tiff_bytes("MM"))
    rows = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)}).json()["entries"]
    assert rows[0]["kind"] == "tiff"
    assert rows[0]["reason"] == TIFF_REASON

    response = _inspect(opened, "scan.tif")
    assert response.status_code == 422
    assert response.json()["title"] == TIFF_REASON
    assert response.json()["code"] == "tiff"


def test_a_gif_is_refused_naming_gif(opened):
    (opened.images / "anim.gif").write_bytes(b"GIF89a" + bytes(30))
    # A GIF is not listed, so this reaches inspect through an id the picker issued for it elsewhere.
    response = opened.post("/api/run/basemap/inspect", json={"id": opened.folder_id(opened.images / "anim.gif")})
    assert response.status_code == 422
    assert response.json()["code"] == "format"
    assert "GIF" in response.json()["title"]


def test_a_rotated_world_file_refuses_the_image(opened):
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw", d=0.5)
    response = _inspect(opened, "map.png")
    assert response.status_code == 422
    assert response.json()["code"] == "rotated"
    assert response.json()["title"] == ROTATED_REASON
    assert_no_path_leaked(opened)


def test_a_mirrored_world_file_refuses_the_image(opened):
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw", e=2.0)
    response = _inspect(opened, "map.png")
    assert response.status_code == 422
    assert response.json()["code"] == "mirrored"


def test_an_image_over_the_pixel_budget_is_refused(opened):
    (opened.images / "huge.jpg").write_bytes(jpeg_header_bytes(10000, 9000))
    response = _inspect(opened, "huge.jpg")
    assert response.status_code == 422
    assert response.json()["code"] == "too_large"
    assert "90,000,000 pixels" in response.json()["title"]


def test_a_truncated_header_is_refused(opened):
    (opened.images / "cut.png").write_bytes(png_bytes(4, 4)[:18])
    response = _inspect(opened, "cut.png")
    assert response.status_code == 422
    assert response.json()["code"] == "header"


def test_two_world_files_are_listed_and_neither_is_picked(opened):
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw")
    put_world_file(opened.images, "map.wld", c=1001.0)
    placement = _inspect(opened, "map.png").json()["placement"]
    assert placement["by"] == "numbers"
    assert placement["world_files"] == ["map.pgw", "map.wld"]
    assert "map.pgw" in placement["reason"] and "map.wld" in placement["reason"]


def test_registering_without_a_usable_world_file_is_refused(opened):
    put_png(opened.images, "map.png", 100, 50)
    file_id = opened.file_id("map.png")
    stamp = opened.post("/api/run/basemap/inspect", json={"id": file_id}).json()["stamp"]
    response = opened.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"})
    assert response.status_code == 409
    assert opened.get("/api/run/basemap").json() == {"status": "none"}


def test_no_world_file_offers_the_numbers_form(opened):
    put_png(opened.images, "map.png", 100, 50)
    placement = _inspect(opened, "map.png").json()["placement"]
    assert placement == {"by": "numbers", "reason": "no world file was found next to the image", "world_files": []}


def test_a_malformed_world_file_offers_the_numbers_form_naming_the_line(opened):
    put_png(opened.images, "map.png", 100, 50)
    (opened.images / "map.pgw").write_text("2\n0\n0\n-2,0\n1000\n2000\n")
    placement = _inspect(opened, "map.png").json()["placement"]
    assert placement["by"] == "numbers"
    assert placement["world_files"] == ["map.pgw"]
    assert "line 4 of map.pgw" in placement["reason"]


def test_a_world_file_far_from_the_mesh_offers_the_numbers_form(opened):
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw", c=500000.0, f=7000000.0)
    placement = _inspect(opened, "map.png").json()["placement"]
    assert placement["by"] == "numbers"
    assert placement["reason"] == "the image does not overlap the model; reprojection is not supported yet"


def test_a_rotated_grid_extent_is_its_rotated_world_bounds_and_a_north_up_image_there_is_placed(
    tmp_path, monkeypatch
):
    xorigin, yorigin, angrot = 1000.0, 2000.0, 30.0
    opened = open_run(tmp_path, monkeypatch, xorigin=xorigin, yorigin=yorigin, angrot=angrot)

    theta = math.radians(angrot)
    verts = np.array(_VERTICES, dtype=np.float64)
    x, y = verts[:, 0], verts[:, 1]
    wx = xorigin + x * math.cos(theta) - y * math.sin(theta)
    wy = yorigin + x * math.sin(theta) + y * math.cos(theta)
    expected = (wx.min(), wx.max(), wy.min(), wy.max())

    extent = load_mesh_extent(CacheLayout(root=opened.cache_root))
    for actual, want in zip(extent, expected):
        assert actual == pytest.approx(want, abs=1e-2)

    # A 10 x 10 image whose outer edge is those bounds.
    width = height = 10
    a = (expected[1] - expected[0]) / width
    e = -(expected[3] - expected[2]) / height
    put_png(opened.images, "map.png", width, height)
    put_world_file(opened.images, "map.pgw", a=a, e=e, c=expected[0] + a / 2, f=expected[3] + e / 2)

    body = _inspect(opened, "map.png").json()
    assert body["placement"]["by"] == "world_file"
    for actual, want in zip(body["placement"]["extent"], expected):
        assert actual == pytest.approx(want, abs=1e-6)
