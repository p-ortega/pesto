"""Store and route coverage for the per-run view state (D-11): round trip,
every read failure mode collapsing to the default, a failed write staying
silent, and no write ever landing inside the run directory.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.api.prefs import read_view_state, write_view_state
from pesto.cache.layout import for_run

BASE_URL = "http://127.0.0.1"

DEFAULT_STATE = {
    "divider": 0.72,
    "colormap": "viridis",
    "reverse": False,
    "scale": "linear",
    "limits_mode": "robust",
    "group": None,
    "stat": "value",
    "layer": None,
}


def _client(app) -> TestClient:
    return TestClient(app, base_url=BASE_URL)


def _opened_client(cache_root: Path):
    app, token = create_app()
    app.state.cache_root = str(cache_root)
    client = _client(app)
    client.headers["x-pesto-token"] = token
    return client


# ---------------------------------------------------------------------------
# Store: round trip, independent roots
# ---------------------------------------------------------------------------


def test_write_then_read_view_state_round_trips(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "run" / ".pesto"

    state = {**DEFAULT_STATE, "divider": 0.5, "colormap": "magma", "group": "G1"}
    write_view_state(cache_root, state)

    assert read_view_state(cache_root) == state


def test_two_different_cache_roots_keep_independent_state(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    root_a = tmp_path / "run_a" / ".pesto"
    root_b = tmp_path / "run_b" / ".pesto"

    write_view_state(root_a, {**DEFAULT_STATE, "colormap": "magma"})
    write_view_state(root_b, {**DEFAULT_STATE, "colormap": "plasma"})

    assert read_view_state(root_a)["colormap"] == "magma"
    assert read_view_state(root_b)["colormap"] == "plasma"


# ---------------------------------------------------------------------------
# Read failure modes: every one collapses to the default, never an exception
# ---------------------------------------------------------------------------


def test_a_missing_store_reads_back_as_the_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert read_view_state(tmp_path / "run" / ".pesto") == DEFAULT_STATE


def test_a_non_json_store_reads_back_as_the_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    store = tmp_path / ".cache" / "pesto" / "view_state.json"
    store.parent.mkdir(parents=True)
    store.write_text("not json at all")
    assert read_view_state(tmp_path / "run" / ".pesto") == DEFAULT_STATE


def test_a_json_array_instead_of_an_object_reads_back_as_the_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    store = tmp_path / ".cache" / "pesto" / "view_state.json"
    store.parent.mkdir(parents=True)
    store.write_text(json.dumps([1, 2, 3]))
    assert read_view_state(tmp_path / "run" / ".pesto") == DEFAULT_STATE


def test_a_different_recorded_version_reads_back_as_the_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "run" / ".pesto"
    store = tmp_path / ".cache" / "pesto" / "view_state.json"
    store.parent.mkdir(parents=True)
    store.write_text(
        json.dumps({"version": 99, "roots": {str(cache_root.resolve()): DEFAULT_STATE}})
    )
    assert read_view_state(cache_root) == DEFAULT_STATE


# ---------------------------------------------------------------------------
# A failed write is a convenience regression, never a raised exception
# ---------------------------------------------------------------------------


@pytest.mark.skipif(os.geteuid() == 0 if hasattr(os, "geteuid") else False, reason="root bypasses permission bits")
def test_write_view_state_with_an_unwritable_store_directory_raises_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_dir = tmp_path / ".cache"
    cache_dir.mkdir()
    cache_dir.chmod(0o500)
    try:
        write_view_state(tmp_path / "run" / ".pesto", DEFAULT_STATE)
    finally:
        cache_dir.chmod(0o700)


# ---------------------------------------------------------------------------
# Never a byte written inside the run directory
# ---------------------------------------------------------------------------


def test_a_write_touches_nothing_inside_the_run_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    run_dir = tmp_path / "a_run"
    run_dir.mkdir()
    (run_dir / "case.pst").write_text("original run file")
    layout = for_run(run_dir)
    layout.ensure()

    before = {
        str(p.relative_to(run_dir)): p.stat().st_mtime_ns for p in run_dir.rglob("*") if p.is_file()
    }

    write_view_state(layout.root, {**DEFAULT_STATE, "divider": 0.3})

    after = {
        str(p.relative_to(run_dir)): p.stat().st_mtime_ns for p in run_dir.rglob("*") if p.is_file()
    }

    assert before == after


# ---------------------------------------------------------------------------
# Routes: GET returns the stored state, PUT stores it, no path field
# ---------------------------------------------------------------------------


def test_get_view_returns_the_stored_state_for_the_open_run(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "run" / ".pesto"
    write_view_state(cache_root, {**DEFAULT_STATE, "colormap": "magma"})
    client = _opened_client(cache_root)

    response = client.get("/api/run/view")

    assert response.status_code == 200
    assert response.json()["colormap"] == "magma"


def test_put_view_stores_the_body_and_a_later_get_returns_it(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "run" / ".pesto"
    client = _opened_client(cache_root)

    put_response = client.put("/api/run/view", json={**DEFAULT_STATE, "scale": "log10"})
    assert put_response.status_code == 200
    assert put_response.json()["scale"] == "log10"

    get_response = client.get("/api/run/view")
    assert get_response.json()["scale"] == "log10"


def test_a_store_written_before_the_layer_field_reads_back_with_no_layer(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "run" / ".pesto"
    old = {key: value for key, value in DEFAULT_STATE.items() if key != "layer"}
    write_view_state(cache_root, {**old, "group": "G1"})

    assert read_view_state(cache_root) == {**DEFAULT_STATE, "group": "G1"}


def test_put_view_keeps_the_layer_and_refuses_a_negative_one(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    client = _opened_client(tmp_path / "run" / ".pesto")

    assert client.put("/api/run/view", json={**DEFAULT_STATE, "layer": 2}).status_code == 200
    assert client.get("/api/run/view").json()["layer"] == 2
    assert client.put("/api/run/view", json={**DEFAULT_STATE, "layer": -1}).status_code == 422


def test_the_put_body_has_no_field_that_could_carry_a_filesystem_path():
    from pesto.api.runs import ViewState

    forbidden = {"path", "run_dir", "dir", "cache_root"}
    assert forbidden.isdisjoint(ViewState.model_fields.keys())


def test_put_view_with_no_run_open_returns_409(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    app, token = create_app()
    client = _client(app)
    client.headers["x-pesto-token"] = token

    response = client.put("/api/run/view", json=DEFAULT_STATE)

    assert response.status_code == 409


@pytest.mark.skipif(os.geteuid() == 0 if hasattr(os, "geteuid") else False, reason="root bypasses permission bits")
def test_put_view_whose_write_fails_still_returns_200(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "run" / ".pesto"
    client = _opened_client(cache_root)

    cache_dir = tmp_path / ".cache"
    cache_dir.mkdir()
    cache_dir.chmod(0o500)
    try:
        response = client.put("/api/run/view", json=DEFAULT_STATE)
        assert response.status_code == 200
    finally:
        cache_dir.chmod(0o700)
