"""The basemap home store: what the record holds, how a broken one is
reported, and proof that the run folder, its cache root and the image's
folder are never written (D-23)."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.basemap.store import (
    StoreFailure,
    basemap_dir,
    check_source,
    read_registration,
    remove_registration,
    store_inside,
)
from pesto.cache.layout import run_id_for

from .basemap_images import png_bytes
from .test_basemap_routes import Opened, assert_no_path_leaked, open_run, put_png, put_world_file


def snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Every entry under ``root``, folders included, by relative name, size and modified time."""
    out = {}
    for path in root.rglob("*"):
        st = path.lstat()
        out[str(path.relative_to(root))] = (st.st_size, st.st_mtime_ns)
    return out


def _register(opened: Opened, name: str, folder: Path | None = None):
    file_id = opened.file_id(name, folder)
    stamp = opened.post("/api/run/basemap/inspect", json={"id": file_id}).json()["stamp"]
    return opened.post("/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "world_file"})


def _every_call(opened: Opened, name: str, folder: Path | None = None) -> None:
    opened.get("/api/run/basemap/start")
    assert _register(opened, name, folder).status_code == 200
    assert opened.get("/api/run/basemap").json()["status"] == "ready"
    assert opened.get("/api/run/basemap/image", params={"max": 1024}).status_code == 200


def test_no_call_writes_to_the_run_folder_the_cache_root_or_the_image_folder(tmp_path, monkeypatch):
    opened = open_run(tmp_path, monkeypatch)
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw")
    home = tmp_path / "home"
    folders = (opened.run_dir, opened.cache_root, opened.images)
    before = [snapshot(f) for f in folders]
    home_before = snapshot(home)

    _every_call(opened, "map.png")

    assert [snapshot(f) for f in folders] == before
    new_in_home = set(snapshot(home)) - set(home_before)
    store = Path(".cache") / "pesto" / "basemap" / run_id_for(opened.run_dir)
    assert new_in_home, "the registration was not written at all"
    for name in new_in_home:
        new = Path(name)
        # The store folder, what is in it, or the folders created on the way to it.
        assert new == store or store in new.parents or new in store.parents, name
    assert_no_path_leaked(opened)


def test_the_default_cache_root_inside_the_run_folder_and_an_image_inside_it_stay_untouched(
    tmp_path, monkeypatch
):
    opened = open_run(tmp_path, monkeypatch, cache_root=tmp_path / "run" / ".pesto")
    maps = opened.run_dir / "maps"
    maps.mkdir()
    put_png(maps, "map.png", 100, 50)
    put_world_file(maps, "map.pgw")
    before = snapshot(opened.run_dir)

    _every_call(opened, "map.png", maps)

    assert snapshot(opened.run_dir) == before
    assert_no_path_leaked(opened)


def test_the_record_holds_the_source_and_both_files_but_the_state_holds_no_path(tmp_path, monkeypatch):
    opened = open_run(tmp_path, monkeypatch)
    image = put_png(opened.images, "map.png", 100, 50)
    world = put_world_file(opened.images, "map.pgw")
    assert _register(opened, "map.png").status_code == 200

    record = read_registration(opened.run_dir)
    assert record["version"] == 1
    assert record["source"] == str(image.resolve())
    assert (record["size"], record["mtime_ns"]) == (image.stat().st_size, image.stat().st_mtime_ns)
    assert (record["format"], record["width"], record["height"]) == ("png", 100, 50)
    assert record["extent"] == [999.0, 1199.0, 1901.0, 2001.0]
    assert record["placed_by"] == "world_file"
    assert record["world_file"] == "map.pgw"
    assert (record["world_file_size"], record["world_file_mtime_ns"]) == (
        world.stat().st_size,
        world.stat().st_mtime_ns,
    )
    assert record["notes"] == []
    assert len(record["tag"]) == 16

    state = opened.get("/api/run/basemap").json()
    assert "source" not in state
    assert_no_path_leaked(opened)


def test_a_store_that_would_sit_inside_the_run_folder_is_refused_and_writes_nothing(tmp_path, monkeypatch):
    opened = open_run(tmp_path, monkeypatch)
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw")
    monkeypatch.setenv("HOME", str(opened.run_dir))
    assert store_inside(opened.run_dir, opened.cache_root)
    before = snapshot(opened.run_dir)

    response = _register(opened, "map.png")

    assert response.status_code == 409
    assert response.json()["code"] == "store_inside_run"
    assert snapshot(opened.run_dir) == before
    assert_no_path_leaked(opened)


def test_a_store_inside_the_cache_root_is_caught(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "cache"))
    assert store_inside(tmp_path / "run", tmp_path / "cache")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert not store_inside(tmp_path / "run", tmp_path / "cache")


def _record_file(opened: Opened) -> Path:
    path = basemap_dir(opened.run_dir) / "basemap.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


@pytest.mark.parametrize(
    "content, said",
    [
        ("not json", "not valid JSON"),
        (json.dumps([1, 2, 3]), "not a JSON object"),
        (json.dumps({"version": 2}), "version 2"),
        (json.dumps({"version": 1, "source": "x"}), "no 'size' field"),
    ],
)
def test_a_broken_record_is_unavailable_with_a_reason_and_kept(tmp_path, monkeypatch, content, said):
    opened = open_run(tmp_path, monkeypatch)
    path = _record_file(opened)
    path.write_text(content)

    state = opened.get("/api/run/basemap").json()
    assert state["status"] == "unavailable"
    assert state["reason"].startswith("the saved basemap record could not be read: ")
    assert said in state["reason"]
    image = opened.get("/api/run/basemap/image")
    assert image.status_code == 409
    assert image.json()["code"] == "unavailable"
    assert path.read_text() == content
    assert isinstance(read_registration(opened.run_dir), StoreFailure)
    assert_no_path_leaked(opened)


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root bypasses permission bits")
def test_an_unreadable_record_is_unavailable_not_none(tmp_path, monkeypatch):
    opened = open_run(tmp_path, monkeypatch)
    path = _record_file(opened)
    path.write_text("{}")
    path.chmod(0o000)
    try:
        state = opened.get("/api/run/basemap").json()
    finally:
        path.chmod(0o600)
    assert state["status"] == "unavailable"
    assert "cannot be read" in state["reason"]


def test_a_failed_write_answers_store_with_no_path(tmp_path, monkeypatch):
    opened = open_run(tmp_path, monkeypatch)
    put_png(opened.images, "map.png", 100, 50)
    put_world_file(opened.images, "map.pgw")
    blocker = basemap_dir(opened.run_dir)
    blocker.parent.mkdir(parents=True)
    blocker.write_text("a file where the store folder should be")

    response = _register(opened, "map.png")

    assert response.status_code == 500
    assert response.json()["code"] == "store"
    assert response.json()["title"] == "the basemap could not be saved"
    assert_no_path_leaked(opened)


# ---------------------------------------------------------------------------
# The stale check on every state and image call (D-24)
# ---------------------------------------------------------------------------

MISSING = "the basemap file map.png is missing; remove it or add it again"
CHANGED = "the basemap file map.png has changed since it was placed; remove it and add it again"


def _registered(tmp_path, monkeypatch) -> tuple[Opened, Path, Path]:
    opened = open_run(tmp_path, monkeypatch)
    image = put_png(opened.images, "map.png", 100, 50)
    world = put_world_file(opened.images, "map.pgw")
    assert _register(opened, "map.png").status_code == 200
    return opened, image, world


def _assert_unavailable(opened: Opened, reason: str) -> None:
    record_before = (basemap_dir(opened.run_dir) / "basemap.json").read_bytes()
    state = opened.get("/api/run/basemap").json()
    assert state["status"] == "unavailable"
    assert state["reason"] == reason
    assert state["name"] == "map.png"
    assert state["placed_by"] in ("world_file", "numbers")
    assert len(state["extent"]) == 4
    image = opened.get("/api/run/basemap/image")
    assert image.status_code == 409
    assert image.json()["code"] == "unavailable"
    assert image.json()["title"] == reason
    assert (basemap_dir(opened.run_dir) / "basemap.json").read_bytes() == record_before
    assert_no_path_leaked(opened)


def test_a_deleted_image_is_unavailable_and_the_record_is_kept(tmp_path, monkeypatch):
    opened, image, _world = _registered(tmp_path, monkeypatch)
    image.unlink()
    _assert_unavailable(opened, MISSING)


def test_an_image_of_another_size_is_unavailable(tmp_path, monkeypatch):
    opened, image, _world = _registered(tmp_path, monkeypatch)
    image.write_bytes(png_bytes(100, 51))
    _assert_unavailable(opened, CHANGED)


def test_an_image_whose_modified_time_alone_moved_is_unavailable(tmp_path, monkeypatch):
    opened, image, _world = _registered(tmp_path, monkeypatch)
    st = image.stat()
    os.utime(image, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    _assert_unavailable(opened, CHANGED)


def test_a_changed_world_file_makes_its_basemap_unavailable_naming_it(tmp_path, monkeypatch):
    opened, _image, world = _registered(tmp_path, monkeypatch)
    put_world_file(opened.images, "map.pgw", c=1001.0)
    _assert_unavailable(
        opened, "the world file map.pgw has changed since the basemap was placed; remove it and add it again"
    )


def test_a_deleted_world_file_makes_its_basemap_unavailable_naming_it(tmp_path, monkeypatch):
    opened, _image, world = _registered(tmp_path, monkeypatch)
    world.unlink()
    _assert_unavailable(opened, "the world file map.pgw is missing; remove the basemap or add it again")


def test_a_numbers_placement_ignores_the_world_file(tmp_path, monkeypatch):
    opened = open_run(tmp_path, monkeypatch)
    put_png(opened.images, "map.png", 100, 50)
    world = put_world_file(opened.images, "map.pgw")
    file_id = opened.file_id("map.png")
    stamp = opened.post("/api/run/basemap/inspect", json={"id": file_id}).json()["stamp"]
    placed = opened.post(
        "/api/run/basemap", json={"id": file_id, "stamp": stamp, "by": "numbers", "extent": [999, 1199, 1901, 2001]}
    )
    assert placed.status_code == 200, placed.text

    world.unlink()

    assert opened.get("/api/run/basemap").json()["status"] == "ready"
    assert opened.get("/api/run/basemap/image").status_code == 200


def test_check_source_is_none_for_an_unchanged_file(tmp_path, monkeypatch):
    opened, _image, _world = _registered(tmp_path, monkeypatch)
    assert check_source(read_registration(opened.run_dir)) is None


# ---------------------------------------------------------------------------
# Remove (D-23, D-26)
# ---------------------------------------------------------------------------


def test_remove_deletes_only_this_runs_record_and_copies(tmp_path, monkeypatch):
    opened, image, world = _registered(tmp_path, monkeypatch)
    folder = basemap_dir(opened.run_dir)
    (folder / "image_1024.png").write_bytes(b"a downscaled copy")
    (folder / "keep.txt").write_text("not pesto's to delete")
    other_run = tmp_path / "other-run"
    other_run.mkdir()
    other = basemap_dir(other_run)
    other.mkdir(parents=True)
    (other / "basemap.json").write_text("{}")
    (other / "image_512.png").write_bytes(b"x")
    home = tmp_path / "home"
    cache_root = tmp_path / "cache"
    guarded = (opened.run_dir, cache_root, opened.images, other)
    before = [snapshot(f) for f in guarded]
    image_stat = (image.stat().st_size, image.stat().st_mtime_ns)
    world_stat = (world.stat().st_size, world.stat().st_mtime_ns)
    home_before = snapshot(home)

    response = opened.post("/api/run/basemap/remove", json={})

    assert response.status_code == 200
    assert response.json() == {"status": "none"}
    assert [snapshot(f) for f in guarded] == before
    assert (image.stat().st_size, image.stat().st_mtime_ns) == image_stat
    assert (world.stat().st_size, world.stat().st_mtime_ns) == world_stat
    gone = set(home_before) - set(snapshot(home))
    store = folder.relative_to(home)
    assert gone == {str(store / "basemap.json"), str(store / "image_1024.png")}
    assert (folder / "keep.txt").read_text() == "not pesto's to delete"
    assert opened.get("/api/run/basemap").json() == {"status": "none"}
    assert_no_path_leaked(opened)


def test_remove_clears_a_stale_or_broken_record(tmp_path, monkeypatch):
    opened, image, _world = _registered(tmp_path, monkeypatch)
    image.unlink()
    assert opened.get("/api/run/basemap").json()["status"] == "unavailable"
    assert opened.post("/api/run/basemap/remove", json={}).json() == {"status": "none"}

    _record_file(opened).write_text("not json")
    assert opened.post("/api/run/basemap/remove", json={}).json() == {"status": "none"}
    assert opened.get("/api/run/basemap").json() == {"status": "none"}


def test_remove_with_nothing_registered_is_none(tmp_path, monkeypatch):
    opened = open_run(tmp_path, monkeypatch)
    home_before = snapshot(tmp_path / "home")
    assert opened.post("/api/run/basemap/remove", json={}).json() == {"status": "none"}
    assert opened.post("/api/run/basemap/remove").json() == {"status": "none"}
    assert snapshot(tmp_path / "home") == home_before


def test_remove_leaves_a_link_target_alone(tmp_path, monkeypatch):
    opened, _image, _world = _registered(tmp_path, monkeypatch)
    folder = basemap_dir(opened.run_dir)
    outside = tmp_path / "precious.png"
    outside.write_bytes(b"the user's file")
    (folder / "image_2048.png").symlink_to(outside)

    assert opened.post("/api/run/basemap/remove", json={}).json() == {"status": "none"}

    assert outside.read_bytes() == b"the user's file"
    assert not (folder / "image_2048.png").is_symlink()


def test_remove_refuses_a_store_folder_that_is_a_link(tmp_path, monkeypatch):
    opened = open_run(tmp_path, monkeypatch)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "basemap.json").write_text("{}")
    folder = basemap_dir(opened.run_dir)
    folder.parent.mkdir(parents=True)
    folder.symlink_to(elsewhere, target_is_directory=True)

    response = opened.post("/api/run/basemap/remove", json={})

    assert response.status_code == 409
    assert response.json()["code"] == "store_link"
    assert (elsewhere / "basemap.json").read_text() == "{}"
    assert_no_path_leaked(opened)


def test_remove_refuses_a_store_inside_the_run_folder(tmp_path, monkeypatch):
    opened = open_run(tmp_path, monkeypatch)
    monkeypatch.setenv("HOME", str(opened.run_dir))
    before = snapshot(opened.run_dir)

    response = opened.post("/api/run/basemap/remove", json={})

    assert response.status_code == 409
    assert response.json()["code"] == "store_inside_run"
    assert snapshot(opened.run_dir) == before


def test_remove_with_no_run_open_is_no_run(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    app, token = create_app()
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers["x-pesto-token"] = token
    response = client.post("/api/run/basemap/remove", json={})
    assert response.status_code == 409
    assert response.json()["code"] == "no_run"


def test_remove_registration_never_deletes_outside_its_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    folder = basemap_dir(run_dir)
    folder.mkdir(parents=True)
    (folder / "basemap.json").write_text("{}")
    sibling = folder.parent / "basemap.json"
    sibling.write_text("a sibling with the same name")

    remove_registration(run_dir)

    assert not (folder / "basemap.json").exists()
    assert sibling.read_text() == "a sibling with the same name"
