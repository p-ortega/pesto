"""The basemap home store: what the record holds, how a broken one is
reported, and proof that the run folder, its cache root and the image's
folder are never written (D-23)."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from pesto.basemap.store import basemap_dir, read_registration, store_inside, StoreFailure
from pesto.cache.layout import run_id_for

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
