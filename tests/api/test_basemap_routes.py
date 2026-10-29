"""The basemap routes end to end: list, inspect, register, state and image,
with every image and world file written by the test into tmp_path (D-27)."""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from model.fixtures import _VERTICES, write_disv_grb
from pesto.api.app import create_app
from pesto.api.basemap import NO_OVERLAP_REASON
from pesto.api.fs import _issue_id
from pesto.basemap import imageinfo
from pesto.basemap.imageinfo import TIFF_REASON
from pesto.basemap.store import read_registration
from pesto.basemap.worldfile import ROTATED_REASON
from pesto.cache.layout import CacheLayout
from pesto.ingest.mesh import load_mesh_extent, write_grid_from_adapter
from pesto.model.mf6 import Mf6Adapter

from .basemap_images import exif_jpeg_header_bytes, jpeg_header_bytes, png_bytes, tiff_bytes, with_scan, world_file_text

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


def test_an_image_wider_than_the_requested_size_is_served_as_a_shrunk_copy(opened):
    put_png(opened.images, "wide.png", 2000, 10)
    put_world_file(opened.images, "wide.pgw", a=0.01, e=-0.01, c=1000.0, f=2001.0)
    file_id = opened.file_id("wide.png")
    stamp = opened.post("/api/run/basemap/inspect", json={"id": file_id}).json()["stamp"]
    assert opened.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"}).status_code == 200

    served = opened.get("/api/run/basemap/image", params={"max": 512})
    assert served.headers["content-type"] == "image/png"
    assert served.content[12:24] == b"IHDR" + (512).to_bytes(4, "big") + (3).to_bytes(4, "big")
    meta = json.loads(served.headers["x-pesto-meta"])
    assert meta["resize_to"] is None
    assert (meta["served_width"], meta["served_height"]) == (512, 3)
    assert "pesto shrank the image from 2000 × 10 to 512 × 3 pixels to fit the graphics card" in meta["notes"]
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


def test_every_basemap_route_refuses_a_request_without_the_session_token(opened):
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw")
    file_id = opened.file_id("map.png")
    stamp = opened.post("/api/run/basemap/inspect", json={"id": file_id}).json()["stamp"]
    assert opened.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"}).status_code == 200
    folder_id = opened.folder_id(opened.images)
    opened.client.headers.pop("x-pesto-token")

    client = opened.client
    responses = [
        client.get("/api/run/basemap/start"),
        client.get("/api/fs/images", params={"id": folder_id}),
        client.post("/api/run/basemap/inspect", json={"id": file_id}),
        client.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"}),
        client.post(
            "/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "numbers", "extent": [999, 1199, 1901, 2001]}
        ),
        client.get("/api/run/basemap"),
        client.get("/api/run/basemap/image"),
        client.post("/api/run/basemap/remove", json={}),
    ]
    for response in responses:
        assert response.status_code == 401, response.request.url
    assert read_registration(opened.run_dir)["placed_by"] == "world_file"


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


def test_a_misnamed_image_carries_a_note_in_the_listing_and_at_inspect(opened):
    put_png(opened.images, "photo.jpg", 4, 4)
    rows = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)}).json()["entries"]
    assert rows[0]["kind"] == "png"
    assert rows[0]["note"] == "named .jpg but the bytes are PNG"
    assert rows[0]["reason"] is None

    inspected = opened.post("/api/run/basemap/inspect", json={"id": rows[0]["id"]}).json()
    assert inspected["format"] == "png"
    assert inspected["notes"] == ["named .jpg but the bytes are PNG"]


def test_tiff_bytes_named_png_are_a_tiff_row_with_the_reason_and_the_note(opened):
    (opened.images / "scan.png").write_bytes(tiff_bytes("II"))
    rows = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)}).json()["entries"]
    assert [(r["kind"], r["reason"], r["note"]) for r in rows] == [
        ("tiff", TIFF_REASON, "named .png but the bytes are TIFF")
    ]


def test_a_rotated_jpeg_is_placed_as_stored_and_inspect_says_so(opened):
    (opened.images / "photo.jpg").write_bytes(with_scan(exif_jpeg_header_bytes(40, 20, 6, "MM")))
    put_world_file(opened.images, "photo.jgw", a=1.0, e=-1.0, c=1000.0, f=2000.0)
    file_id = opened.file_id("photo.jpg")

    body = opened.post("/api/run/basemap/inspect", json={"id": file_id}).json()

    assert (body["width"], body["height"]) == (40, 20)
    assert body["notes"] == [
        "the file's rotation flag (EXIF orientation 6) is ignored; "
        "the image is placed as stored, which is what the world file describes"
    ]
    assert body["placement"]["extent"] == [999.5, 1039.5, 1980.5, 2000.5]
    state = opened.post("/api/run/basemap", json={"id": file_id, "stamp": body["stamp"], "by": "world_file"}).json()
    assert state["notes"] == body["notes"]


def test_an_upright_jpeg_has_no_notes(opened):
    (opened.images / "photo.jpg").write_bytes(with_scan(exif_jpeg_header_bytes(40, 20, 1)))
    body = opened.post("/api/run/basemap/inspect", json={"id": opened.file_id("photo.jpg")}).json()
    assert body["notes"] == []


def _six_pngs(folder: Path) -> None:
    for i in range(6):
        put_png(folder, f"map{i}.png", 2, 2)
    (folder / "sub").mkdir()


def test_the_listing_stops_sniffing_at_the_cap_and_counts_the_rest(opened, monkeypatch):
    _six_pngs(opened.images)
    monkeypatch.setattr(imageinfo, "SNIFF_CAP", 3)

    listing = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)}).json()

    assert [r["name"] for r in listing["entries"]] == ["sub", "map0.png", "map1.png", "map2.png"]
    assert listing["skipped"] == {"other_files": 0, "not_checked": 3, "unreadable": 0}


def test_under_the_real_cap_every_file_is_checked(opened):
    _six_pngs(opened.images)
    listing = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)}).json()
    assert len([r for r in listing["entries"] if r["kind"] == "png"]) == 6
    assert listing["skipped"]["not_checked"] == 0


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root bypasses permission bits")
def test_a_file_that_cannot_be_opened_is_counted_unreadable_and_gets_no_id(opened):
    put_png(opened.images, "fine.png", 2, 2)
    locked = put_png(opened.images, "locked.png", 2, 2)
    locked.chmod(0o000)
    try:
        listing = opened.get("/api/fs/images", params={"id": opened.folder_id(opened.images)}).json()
    finally:
        locked.chmod(0o600)
    assert [r["name"] for r in listing["entries"]] == ["fine.png"]
    assert listing["skipped"]["unreadable"] == 1
    assert locked.resolve() not in opened.client.app.state.fs_ids.values()


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


@pytest.mark.parametrize("scale", [1e308, 1e300])
def test_a_world_file_with_a_huge_scale_offers_the_numbers_form_with_a_reason(opened, scale):
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw", a=scale)
    response = _inspect(opened, "map.png")
    assert response.status_code == 200
    placement = response.json()["placement"]
    assert placement["by"] == "numbers"
    assert placement["world_files"] == ["map.pgw"]
    assert "outside the range pesto can draw" in placement["reason"]


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


# ---------------------------------------------------------------------------
# Placement by four typed numbers (D-21, D-30)
# ---------------------------------------------------------------------------


@pytest.fixture
def at_zero(tmp_path, monkeypatch) -> Opened:
    """A run whose mesh sits near (0, 0), so [0, 1000, 0, 500] covers it."""
    return open_run(tmp_path, monkeypatch, xorigin=0.0, yorigin=0.0)


def _inspected(opened: Opened, name: str) -> tuple[str, str]:
    file_id = opened.file_id(name)
    response = opened.post("/api/run/basemap/inspect", json={"id": file_id})
    assert response.status_code == 200, response.text
    return file_id, response.json()["stamp"]


def _by_numbers(opened: Opened, file_id: str, stamp: str, extent):
    return opened.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "numbers", "extent": extent})


def test_an_image_placed_by_four_numbers_is_ready_with_exactly_those_numbers(at_zero):
    put_png(at_zero.images, "map.png", 100, 50)
    file_id, stamp = _inspected(at_zero, "map.png")

    response = _by_numbers(at_zero, file_id, stamp, [0, 1000, 0, 500])

    assert response.status_code == 200, response.text
    state = response.json()
    assert state["status"] == "ready"
    assert state["placed_by"] == "numbers"
    assert state["world_file"] is None
    assert state["extent"] == [0.0, 1000.0, 0.0, 500.0]
    assert at_zero.get("/api/run/basemap").json() == state
    assert at_zero.get("/api/run/basemap/image").status_code == 200
    record = read_registration(at_zero.run_dir)
    assert (record["world_file"], record["world_file_size"], record["world_file_mtime_ns"]) == (None, None, None)
    assert_no_path_leaked(at_zero)


def test_numbers_that_miss_the_model_are_refused_like_a_world_file(at_zero):
    put_png(at_zero.images, "map.png", 100, 50)
    file_id, stamp = _inspected(at_zero, "map.png")

    response = _by_numbers(at_zero, file_id, stamp, [5000, 6000, 5000, 6000])

    assert response.status_code == 422
    assert response.json()["code"] == "no_overlap"
    assert response.json()["title"] == NO_OVERLAP_REASON
    assert at_zero.get("/api/run/basemap").json() == {"status": "none"}


@pytest.mark.parametrize(
    "extent, said",
    [
        ([1000, 1000, 0, 500], "x min must be less than x max"),
        ([1000, 0, 0, 500], "x min must be less than x max"),
        ([0, 1000, 500, 500], "y min must be less than y max"),
        ([0, 1000, 500, 0], "y min must be less than y max"),
        ([0, 1000, 0, 2e12], "each number must be within 1e12 of zero"),
        ([-2e12, 1000, 0, 500], "each number must be within 1e12 of zero"),
        ([0, 10**400, 0, 500], "each number must be within 1e12 of zero"),
        ([0, 1000, 0], "four numbers"),
        ([0, 1000, 0, 500, 7], "four numbers"),
        ([0, "1000", 0, 500], "must be a number"),
        ([0, True, 0, 500], "must be a number"),
        ([0, None, 0, 500], "must be a number"),
    ],
)
def test_numbers_out_of_order_too_big_or_not_numbers_are_refused_with_a_reason(at_zero, extent, said):
    put_png(at_zero.images, "map.png", 100, 50)
    file_id, stamp = _inspected(at_zero, "map.png")

    response = _by_numbers(at_zero, file_id, stamp, extent)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "numbers"
    assert said in response.json()["title"]
    assert at_zero.get("/api/run/basemap").json() == {"status": "none"}


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_a_number_that_is_not_finite_is_refused(at_zero, literal):
    put_png(at_zero.images, "map.png", 100, 50)
    file_id, stamp = _inspected(at_zero, "map.png")
    # The JSON standard has no NaN, but Python's parser takes these literals, so send them raw.
    raw = f'{{"id": "{file_id}", "stamp": "{stamp}", "by": "numbers", "extent": [0, {literal}, 0, 500]}}'

    response = at_zero.post("/api/run/basemap", content=raw, headers={"content-type": "application/json"})

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "numbers"
    assert "finite" in response.json()["title"]


def test_numbers_without_an_extent_and_a_world_file_with_one_are_both_refused(at_zero):
    put_png(at_zero.images, "map.png", 100, 50)
    put_world_file(at_zero.images, "map.pgw", c=0.0, f=10.0)
    file_id, stamp = _inspected(at_zero, "map.png")

    missing = at_zero.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "numbers"})
    extra = at_zero.post(
        "/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file", "extent": [0, 1000, 0, 500]}
    )
    unknown = at_zero.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "guess"})

    assert (missing.status_code, extra.status_code, unknown.status_code) == (422, 422, 422)
    assert at_zero.get("/api/run/basemap").json() == {"status": "none"}


def test_an_image_appended_to_after_inspect_is_refused_and_nothing_is_written(at_zero):
    image = put_png(at_zero.images, "map.png", 100, 50)
    file_id, stamp = _inspected(at_zero, "map.png")
    with open(image, "ab") as f:
        f.write(b"more")

    response = _by_numbers(at_zero, file_id, stamp, [0, 1000, 0, 500])

    assert response.status_code == 409
    assert response.json()["code"] == "changed"
    assert read_registration(at_zero.run_dir) is None


def test_a_world_file_moved_far_away_after_inspect_is_reread_and_refused(opened):
    put_png(opened.images, "map.png", 100, 50)
    world = put_world_file(opened.images, "map.pgw", c=1000.0, f=2000.0)
    file_id, stamp = _inspected(opened, "map.png")
    before = world.stat()
    # Same length and the same modified time, so only a fresh read of the file can tell.
    put_world_file(opened.images, "map.pgw", c=9000.0, f=9000.0)
    os.utime(world, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert world.stat().st_size == before.st_size

    response = opened.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"})

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "no_overlap"
    assert response.json()["title"] == NO_OVERLAP_REASON
    assert read_registration(opened.run_dir) is None


def test_a_numbers_registration_replaces_a_world_file_one_and_changes_the_tag(at_zero):
    put_png(at_zero.images, "map.png", 100, 50)
    put_world_file(at_zero.images, "map.pgw", a=0.1, e=-0.1, c=0.0, f=5.0)
    file_id, stamp = _inspected(at_zero, "map.png")
    first = at_zero.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"}).json()
    assert first["placed_by"] == "world_file"

    second = _by_numbers(at_zero, file_id, stamp, [0, 1000, 0, 500]).json()

    assert second["placed_by"] == "numbers"
    assert second["world_file"] is None
    assert second["tag"] != first["tag"]
    assert at_zero.get("/api/run/basemap").json() == second
