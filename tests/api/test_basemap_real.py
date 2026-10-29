"""The basemap routes checked against the real benchmark meshes (D-28).

The bench holds no images, so each test writes a synthetic PNG and world file
placed at the run's own mesh extent, in a folder under ``tmp_path``. Each run is
ingested once into a cache under ``tmp_path``, HOME points at a fresh scratch
folder in every test, and the run folder and the cache are compared before and
after, because a run folder is a scientist's finished output.

Every check is a relationship that holds for any run; nothing asserts what a
local folder happens to hold.
"""

from __future__ import annotations

import json
import struct
import time
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.api.basemap import NO_OVERLAP_REASON
from pesto.api.fs import _issue_id
from pesto.basemap.imageinfo import TEXTURE_CAP
from pesto.cache.layout import CacheLayout, run_id_for
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import load_mesh_extent
from pesto.ingest.runner import ingest_run

from .basemap_images import png_bytes, world_file_text

pytestmark = pytest.mark.slow

RUNS = [
    pytest.param("hm_run", id="hm_20250406221554"),
    pytest.param("pl253_run", id="hm_20251104154614"),
    pytest.param("forecast_run", id="forecast_20250618105403"),
    pytest.param("restarted_run", id="hm_20250406221554_restarted"),
]

BASE_URL = "http://127.0.0.1"
SMALL = (64, 32)
WIDE = (9000, 4)
WIDE_MAX = 4096


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Every entry under ``root``, folders included, by relative name, size and modified time."""
    out = {}
    for path in sorted(root.rglob("*")):
        st = path.lstat()
        out[str(path.relative_to(root))] = (st.st_size, st.st_mtime_ns)
    return out


@dataclass(frozen=True)
class Ingested:
    run_dir: Path
    cache_root: Path
    extent: tuple[float, float, float, float]
    before: dict[str, tuple[int, int]]


_INGESTED: dict[str, Ingested | str] = {}


@pytest.fixture
def ingested(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory, run_fixture: str) -> Ingested:
    """The run ingested once for the module into a cache under tmp_path, with
    the run folder's snapshot taken before the ingest."""
    if run_fixture not in _INGESTED:
        run_dir = request.getfixturevalue(run_fixture)
        cache_root = tmp_path_factory.mktemp(f"basemap-real-{run_fixture}") / "cache"
        assert not cache_root.resolve().is_relative_to(run_dir.resolve())
        before = _snapshot(run_dir)
        started = time.perf_counter()
        manifest = ingest_run(run_dir, cache_root=cache_root)
        print(f"\n{run_dir.name}: ingest took {time.perf_counter() - started:.1f} s")
        grid = manifest.artifacts.get("grid")
        if grid is None or grid.state != "ok":
            said = "was not planned" if grid is None else f"is {grid.state}: {grid.reason}"
            _INGESTED[run_fixture] = f"the grid {said}, so there is no mesh to place an image on"
        else:
            extent = load_mesh_extent(CacheLayout(root=cache_root))
            assert not isinstance(extent, ReadFailure), f"the grid ingested but its extent cannot be read: {extent}"
            _INGESTED[run_fixture] = Ingested(run_dir, cache_root, tuple(float(v) for v in extent), before)
    found = _INGESTED[run_fixture]
    if isinstance(found, str):
        pytest.skip(found)
    return found


@dataclass
class Session:
    ing: Ingested
    client: TestClient
    home: Path
    images: Path
    run_before: dict[str, tuple[int, int]]
    cache_before: dict[str, tuple[int, int]]

    def post(self, url: str, **kw):
        return self.client.post(url, **kw)

    def get(self, url: str, **kw):
        return self.client.get(url, **kw)

    def store_relative(self) -> str:
        return f".cache/pesto/basemap/{run_id_for(self.ing.run_dir)}"

    def check_untouched(self) -> None:
        assert _snapshot(self.ing.run_dir) == self.ing.before, "the run folder changed since before the ingest"
        assert _snapshot(self.ing.run_dir) == self.run_before, "the basemap calls changed the run folder"
        assert _snapshot(self.ing.cache_root) == self.cache_before, "the basemap calls changed the scratch cache"
        store = self.store_relative()
        for name in _snapshot(self.home):
            inside_store = name == store or name.startswith(store + "/")
            above_store = store.startswith(name + "/")
            assert inside_store or above_store, f"{name} was written under HOME outside {store}"


@pytest.fixture
def session(ingested: Ingested, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Session:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    images = tmp_path / "images"
    images.mkdir()
    run_before = _snapshot(ingested.run_dir)
    cache_before = _snapshot(ingested.cache_root)

    app, token = create_app()
    app.state.cache_root = str(ingested.cache_root)
    app.state.initial_run_dir = str(ingested.run_dir.resolve())
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    opened = Session(ingested, client, home, images, run_before, cache_before)
    yield opened
    opened.check_untouched()


def _world_file(extent, width: int, height: int) -> tuple[float, float, float, float]:
    """A, E, C, F for an image of ``width`` x ``height`` pixels whose outer edge is ``extent``."""
    xmin, xmax, ymin, ymax = extent
    a = (xmax - xmin) / width
    e = -(ymax - ymin) / height
    return a, e, xmin + a / 2, ymax + e / 2


def _put_image(s: Session, stem: str, size: tuple[int, int]) -> tuple[Path, tuple[float, float, float, float]]:
    width, height = size
    a, e, c, f = _world_file(s.ing.extent, width, height)
    image = s.images / f"{stem}.png"
    image.write_bytes(png_bytes(width, height))
    (s.images / f"{stem}.pgw").write_text(world_file_text(a, 0.0, 0.0, e, c, f))
    # The corners the world file itself states, worked out apart from the server.
    xmin = c - a / 2
    ymax = f - e / 2
    return image, (xmin, xmin + a * width, ymax + e * height, ymax)


def _file_id(s: Session, name: str) -> str:
    listing = s.get("/api/fs/images", params={"id": _issue_id(s.client.app.state.fs_ids, s.images)})
    assert listing.status_code == 200, listing.text
    rows = [r for r in listing.json()["entries"] if r["name"] == name]
    assert len(rows) == 1, f"{name} is listed {len(rows)} times"
    assert rows[0]["kind"] == "png" and rows[0]["reason"] is None, rows[0]
    return rows[0]["id"]


def _inspect(s: Session, name: str) -> tuple[str, dict]:
    file_id = _file_id(s, name)
    started = time.perf_counter()
    response = s.post("/api/run/basemap/inspect", json={"id": file_id})
    print(f"{s.ing.run_dir.name}: inspect of {name} took {(time.perf_counter() - started) * 1000:.0f} ms")
    assert response.status_code == 200, response.text
    return file_id, response.json()


def _register(s: Session, name: str) -> dict:
    file_id, body = _inspect(s, name)
    response = s.post("/api/run/basemap", json={"id": file_id, "stamp": body["stamp"], "by": "world_file"})
    assert response.status_code == 200, response.text
    return response.json()


def _close(actual, expected, label: str) -> None:
    xspan = expected[1] - expected[0]
    yspan = expected[3] - expected[2]
    for got, want, span in zip(actual, expected, (xspan, xspan, yspan, yspan)):
        assert abs(got - want) <= 1e-6 * span, f"{label}: {list(actual)} is not {list(expected)}"


@pytest.mark.parametrize("run_fixture", RUNS)
def test_a_png_at_the_mesh_extent_is_placed_by_its_world_file_and_served_unchanged(session: Session, run_fixture: str):
    image, corners = _put_image(session, "map", SMALL)
    _close(corners, session.ing.extent, "the world file's own corners against the mesh")

    _, body = _inspect(session, "map.png")
    assert (body["format"], body["width"], body["height"]) == ("png", *SMALL)
    assert body["model_extent"] == list(session.ing.extent)
    placement = body["placement"]
    assert (placement["by"], placement.get("world_file")) == ("world_file", "map.pgw"), placement
    _close(placement["extent"], corners, "the inspected corners against the world file's")

    state = _register(session, "map.png")
    assert state["status"] == "ready", state
    assert state["placed_by"] == "world_file"
    _close(state["extent"], corners, "the registered corners against the world file's")
    assert session.get("/api/run/basemap").json() == state

    started = time.perf_counter()
    served = session.get("/api/run/basemap/image", params={"max": 4096})
    print(f"{session.ing.run_dir.name}: image took {(time.perf_counter() - started) * 1000:.0f} ms")
    assert served.status_code == 200, served.text
    assert served.content == image.read_bytes()
    assert served.headers["content-type"] == "image/png"
    meta = json.loads(served.headers["x-pesto-meta"])
    assert meta["tag"] == state["tag"]
    session.check_untouched()

    removed = session.post("/api/run/basemap/remove", json={})
    assert removed.status_code == 200, removed.text
    assert removed.json() == {"status": "none"}
    assert session.get("/api/run/basemap").json() == {"status": "none"}
    assert session.get("/api/run/basemap/image").status_code == 404


@pytest.mark.parametrize("run_fixture", RUNS)
def test_a_wide_png_at_the_mesh_extent_is_served_no_longer_than_the_card_takes(session: Session, run_fixture: str):
    _image, corners = _put_image(session, "wide", WIDE)
    state = _register(session, "wide.png")
    assert state["status"] == "ready", state
    _close(state["extent"], corners, "the registered corners against the world file's")

    started = time.perf_counter()
    served = session.get("/api/run/basemap/image", params={"max": WIDE_MAX})
    print(f"{session.ing.run_dir.name}: wide image took {(time.perf_counter() - started) * 1000:.0f} ms")
    assert served.status_code == 200, served.text
    meta = json.loads(served.headers["x-pesto-meta"])
    limit = min(WIDE_MAX, TEXTURE_CAP)
    if meta["resize_to"] is not None:
        assert max(meta["resize_to"]) <= limit, meta
    else:
        assert max(meta["served_width"], meta["served_height"]) <= limit, meta
        assert served.content[12:16] == b"IHDR", "the shrunk copy is not a PNG"
        assert struct.unpack(">II", served.content[16:24]) == (meta["served_width"], meta["served_height"])
    assert (meta["width"], meta["height"]) == WIDE
    session.check_untouched()


@pytest.mark.parametrize("run_fixture", RUNS)
def test_four_numbers_shifted_wholly_off_the_mesh_are_refused_as_no_overlap(session: Session, run_fixture: str):
    _put_image(session, "map", SMALL)
    file_id, body = _inspect(session, "map.png")
    xmin, xmax, ymin, ymax = session.ing.extent
    dx, dy = 2 * (xmax - xmin), 2 * (ymax - ymin)

    for sign in (1, -1):
        extent = [xmin + sign * dx, xmax + sign * dx, ymin + sign * dy, ymax + sign * dy]
        response = session.post(
            "/api/run/basemap", json={"id": file_id, "stamp": body["stamp"], "by": "numbers", "extent": extent}
        )
        assert response.status_code == 422, response.text
        assert response.json()["code"] == "no_overlap"
        assert response.json()["title"] == NO_OVERLAP_REASON
    assert session.get("/api/run/basemap").json() == {"status": "none"}
