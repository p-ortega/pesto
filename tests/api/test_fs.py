"""Tests for the directory picker: opaque ids only, a filename-only run
marker, and the last-opened-directory memory (Plan 05-03).

Follows tests/test_launch.py's shape: a local `_client(app)`, one behaviour
per test, exact status codes. Every tree lives under `tmp_path`, and `HOME`
is monkeypatched to `tmp_path` itself for any test that needs a directory
the picker's own "Home" root will resolve to -- this also keeps every
`~/.cache/pesto/last_run.json` read or write inside the test's own tmp
directory, never the developer's real home.
"""

from __future__ import annotations

import builtins
import json
import os
import secrets
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pesto.api import fs as fs_module
from pesto.api.app import create_app
from pesto.api.fs import is_run_directory
from pesto.api.prefs import read_last_run, write_last_run

BASE_URL = "http://127.0.0.1"

_IS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0


def _client(app) -> TestClient:
    return TestClient(app, base_url=BASE_URL)


def _get(client: TestClient, token: str, path: str, **params):
    params["token"] = token
    return client.get(path, params=params)


def _post(client: TestClient, token: str, path: str, body: dict):
    return client.post(path, params={"token": token}, json=body)


def _home_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    app, token = create_app()
    return _client(app), token


def _home_id(client: TestClient, token: str) -> str:
    roots = _get(client, token, "/api/fs/roots").json()
    for entry in roots:
        if entry["name"] == "Home":
            return entry["id"]
    raise AssertionError(f"no Home root in {roots!r}")


def _id_for(client: TestClient, token: str, parent_id: str, name: str) -> str:
    listing = _get(client, token, "/api/fs/list", id=parent_id).json()
    for entry in listing:
        if entry["name"] == name:
            return entry["id"]
    raise AssertionError(f"{name!r} not found in {listing!r}")


def _make_run(dir_path: Path, case: str = "case") -> None:
    dir_path.mkdir(parents=True, exist_ok=True)
    (dir_path / f"{case}.pst").write_text("pcf\n* control data\nnoptmax 0\n")
    (dir_path / f"{case}.0.par.jcb").write_bytes(b"")


# --- No response body ever carries a real path --------------------------


def test_roots_response_has_no_path_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, token = _home_app(tmp_path, monkeypatch)
    response = _get(client, token, "/api/fs/roots")
    assert response.status_code == 200
    body = response.json()
    assert body
    for entry in body:
        assert set(entry) == {"id", "name", "is_run", "reason"}
    assert str(tmp_path) not in response.text


def test_list_response_carries_no_absolute_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "some_folder").mkdir()
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)

    response = _get(client, token, "/api/fs/list", id=home_id)
    assert response.status_code == 200
    for entry in response.json():
        assert "path" not in entry
    assert str(tmp_path) not in response.text
    assert str(tmp_path.resolve()) not in response.text


# --- Forged and stale ids are refused, never resolved --------------------


def test_forged_id_returns_404_problem_naming_neither_id_nor_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, token = _home_app(tmp_path, monkeypatch)
    forged = secrets.token_urlsafe(16)

    response = _get(client, token, "/api/fs/list", id=forged)

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert forged not in response.text
    assert str(tmp_path) not in response.text


def test_an_id_from_one_process_is_refused_by_a_second_independent_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    app_a, token_a = create_app()
    app_b, token_b = create_app()
    client_a, client_b = _client(app_a), _client(app_b)

    home_id_a = _home_id(client_a, token_a)

    response = _get(client_b, token_b, "/api/fs/list", id=home_id_a)
    assert response.status_code == 404


def test_list_with_no_id_returns_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, token = _home_app(tmp_path, monkeypatch)
    response = client.get("/api/fs/list", params={"token": token})
    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"


# --- Directory names and shapes -------------------------------------------


def test_dotdot_prefixed_directory_name_is_listed_by_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "..hidden").mkdir()
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)

    listing = _get(client, token, "/api/fs/list", id=home_id).json()

    assert any(entry["name"] == "..hidden" for entry in listing)


def test_symlink_escaping_the_listed_directory_is_reported_and_not_enterable(
    tmp_path: Path, tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    outside = tmp_path_factory.mktemp("escape-target")
    (tmp_path / "escape").symlink_to(outside, target_is_directory=True)
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)

    listing = _get(client, token, "/api/fs/list", id=home_id).json()
    entry = next(e for e in listing if e["name"] == "escape")

    assert entry["is_run"] is False
    assert entry["reason"]
    assert str(outside) not in json.dumps(listing)

    # Not descended into: the id handed back for it was never recorded, so
    # trying to use it takes the same refusal path a forged id takes.
    response = _get(client, token, "/api/fs/list", id=entry["id"])
    assert response.status_code == 404


def test_ids_are_stable_across_two_listings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "child").mkdir()
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)

    first = _get(client, token, "/api/fs/list", id=home_id).json()
    second = _get(client, token, "/api/fs/list", id=home_id).json()

    assert {e["id"] for e in first} == {e["id"] for e in second}


@pytest.mark.skipif(_IS_ROOT, reason="chmod 0o000 has no effect for root")
def test_unreadable_child_directory_is_listed_with_a_reason(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o000)
    try:
        client, token = _home_app(tmp_path, monkeypatch)
        home_id = _home_id(client, token)

        listing = _get(client, token, "/api/fs/list", id=home_id).json()
        entry = next(e for e in listing if e["name"] == "locked")

        assert entry["is_run"] is False
        assert entry["reason"]
    finally:
        locked.chmod(0o755)


def test_macos_resource_fork_entries_are_absent_from_listing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "._Resource").mkdir()
    (tmp_path / "ordinary").mkdir()
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)

    listing = _get(client, token, "/api/fs/list", id=home_id).json()

    assert {e["name"] for e in listing} == {"ordinary"}


def test_files_are_never_listed_only_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "a_file.txt").write_text("hello")
    (tmp_path / "a_dir").mkdir()
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)

    listing = _get(client, token, "/api/fs/list", id=home_id).json()

    assert {e["name"] for e in listing} == {"a_dir"}


# --- The run marker: filenames only, run_marker in every test name --------


def test_run_marker_true_for_control_file_and_matching_ensemble(tmp_path: Path) -> None:
    _make_run(tmp_path)
    assert is_run_directory(tmp_path) == (True, None)


def test_run_marker_false_for_control_file_alone(tmp_path: Path) -> None:
    (tmp_path / "case.pst").write_text("noptmax 0\n")
    assert is_run_directory(tmp_path) == (False, None)


def test_run_marker_false_for_ensemble_alone(tmp_path: Path) -> None:
    (tmp_path / "other.0.par.jcb").write_bytes(b"")
    assert is_run_directory(tmp_path) == (False, None)


def test_run_marker_false_for_mismatched_stem(tmp_path: Path) -> None:
    (tmp_path / "case.pst").write_text("noptmax 0\n")
    (tmp_path / "unrelated.0.par.jcb").write_bytes(b"")
    assert is_run_directory(tmp_path) == (False, None)


def test_run_marker_true_with_two_control_files(tmp_path: Path) -> None:
    _make_run(tmp_path, case="case")
    (tmp_path / "tmp_d.pst").write_text("noptmax 0\n")
    assert is_run_directory(tmp_path) == (True, None)


def test_run_marker_opens_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _make_run(tmp_path)

    def _refuse_to_open(*_args, **_kwargs):
        raise AssertionError("is_run_directory must not open a file's contents")

    monkeypatch.setattr(builtins, "open", _refuse_to_open)
    assert is_run_directory(tmp_path) == (True, None)


@pytest.mark.skipif(_IS_ROOT, reason="chmod 0o000 has no effect for root")
def test_run_marker_reports_a_reason_for_an_unreadable_directory(tmp_path: Path) -> None:
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o000)
    try:
        is_run, reason = is_run_directory(locked)
        assert is_run is False
        assert reason
    finally:
        locked.chmod(0o755)


# --- Opening a directory ---------------------------------------------------


def test_open_on_non_run_directory_succeeds_with_is_run_false(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "plain").mkdir()
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)
    plain_id = _id_for(client, token, home_id, "plain")

    response = _post(client, token, "/api/fs/open", {"id": plain_id})

    assert response.status_code == 200
    assert response.json() == {"is_run": False, "case": None}


def test_open_on_run_directory_reports_the_case_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _make_run(tmp_path / "a_run", case="mycase")
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)
    run_id = _id_for(client, token, home_id, "a_run")

    response = _post(client, token, "/api/fs/open", {"id": run_id})

    assert response.status_code == 200
    assert response.json() == {"is_run": True, "case": "mycase"}


def test_open_sets_initial_run_dir_and_cache_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_dir = tmp_path / "a_run"
    run_dir.mkdir()
    monkeypatch.setenv("HOME", str(tmp_path))
    app, token = create_app()
    client = _client(app)
    home_id = _home_id(client, token)
    run_id = _id_for(client, token, home_id, "a_run")

    response = _post(client, token, "/api/fs/open", {"id": run_id})

    assert response.status_code == 200
    assert app.state.initial_run_dir == str(run_dir.resolve())
    assert app.state.cache_root == str(run_dir.resolve() / ".pesto")


def test_forged_open_id_returns_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, token = _home_app(tmp_path, monkeypatch)
    response = _post(client, token, "/api/fs/open", {"id": secrets.token_urlsafe(16)})
    assert response.status_code == 404


# --- Read-only: listing and opening never write into the listed directory -


def test_list_and_open_leave_the_listed_directory_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `home_dir` (where `~/.cache/pesto/last_run.json` lives) must be a
    # different directory from the one under test here, or writing that
    # preference file would itself add an entry to the directory this test
    # is trying to prove stays untouched.
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    listed_dir = tmp_path / "browsed"
    (listed_dir / "a_run").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home_dir))

    write_last_run(listed_dir)
    app, token = create_app()
    client = _client(app)
    roots = _get(client, token, "/api/fs/roots").json()
    listed_id = next(e["id"] for e in roots if e["name"] == "browsed")

    before_mtime = listed_dir.stat().st_mtime
    before_entries = sorted(os.listdir(listed_dir))

    run_id = _id_for(client, token, listed_id, "a_run")
    open_response = _post(client, token, "/api/fs/open", {"id": run_id})
    assert open_response.status_code == 200

    after_mtime = listed_dir.stat().st_mtime
    after_entries = sorted(os.listdir(listed_dir))

    assert after_mtime == before_mtime
    assert after_entries == before_entries


@pytest.mark.skipif(_IS_ROOT, reason="chmod 0o000 has no effect for root")
def test_opening_a_read_only_git_run_directory_succeeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Plan 05-10's own read-only test never exercises this path -- its
    # synthetic run has no `.git`, so `ensure_gitignored` returns before
    # ever touching the filesystem. This one is a real git repository, so
    # the write is actually attempted and actually refused.
    run_dir = tmp_path / "a_run"
    run_dir.mkdir()
    (run_dir / ".git").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)
    run_id = _id_for(client, token, home_id, "a_run")

    run_dir.chmod(0o555)
    try:
        response = _post(client, token, "/api/fs/open", {"id": run_id})
    finally:
        run_dir.chmod(0o755)

    assert response.status_code == 200
    assert response.json() == {"is_run": False, "case": None}
    assert not (run_dir / ".gitignore").exists()


def test_opening_a_writable_git_run_directory_still_appends_the_gitignore_line_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_dir = tmp_path / "a_run"
    run_dir.mkdir()
    (run_dir / ".git").mkdir()
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)
    run_id = _id_for(client, token, home_id, "a_run")

    first = _post(client, token, "/api/fs/open", {"id": run_id})
    second = _post(client, token, "/api/fs/open", {"id": run_id})

    assert first.status_code == 200
    assert second.status_code == 200
    lines = (run_dir / ".gitignore").read_text().splitlines()
    assert lines.count(".pesto/") == 1


def test_open_answers_problem_json_when_for_run_raises_permission_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_dir = tmp_path / "a_run"
    run_dir.mkdir()
    client, token = _home_app(tmp_path, monkeypatch)
    home_id = _home_id(client, token)
    run_id = _id_for(client, token, home_id, "a_run")

    def _raise(*_args, **_kwargs):
        raise PermissionError("simulated: could not resolve the cache root")

    monkeypatch.setattr(fs_module, "for_run", _raise)

    response = _post(client, token, "/api/fs/open", {"id": run_id})

    assert response.status_code == 403
    assert response.headers["content-type"] == "application/problem+json"


# --- Last-opened-directory memory ------------------------------------------


def test_read_last_run_missing_file_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    assert read_last_run() is None


def test_read_last_run_non_json_file_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    store = tmp_path / ".cache" / "pesto" / "last_run.json"
    store.parent.mkdir(parents=True)
    store.write_text("not json at all")
    assert read_last_run() is None


def test_read_last_run_wrong_version_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    store = tmp_path / ".cache" / "pesto" / "last_run.json"
    store.parent.mkdir(parents=True)
    store.write_text(json.dumps({"version": 99, "path": str(tmp_path)}))
    assert read_last_run() is None


def test_read_last_run_missing_recorded_directory_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    store = tmp_path / ".cache" / "pesto" / "last_run.json"
    store.parent.mkdir(parents=True)
    store.write_text(json.dumps({"version": 1, "path": str(tmp_path / "gone")}))
    assert read_last_run() is None


def test_write_then_read_last_run_round_trips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    run_dir = tmp_path / "a_run"
    run_dir.mkdir()

    write_last_run(run_dir)

    assert read_last_run() == run_dir.resolve()


def test_write_last_run_against_an_unwritable_home_does_not_raise(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    if _IS_ROOT:
        pytest.skip("chmod 0o000 has no effect for root")
    unwritable_home = tmp_path / "home"
    unwritable_home.mkdir()
    run_dir = tmp_path / "a_run"
    run_dir.mkdir()
    monkeypatch.setenv("HOME", str(unwritable_home))
    unwritable_home.chmod(0o500)
    try:
        write_last_run(run_dir)
        assert read_last_run() is None
    finally:
        unwritable_home.chmod(0o755)


def test_roots_prepends_the_last_opened_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    last_dir = tmp_path / "somewhere" / "deep"
    last_dir.mkdir(parents=True)
    write_last_run(last_dir)

    app, token = create_app()
    roots = _get(_client(app), token, "/api/fs/roots").json()

    assert roots[0]["name"] == "deep"


# --- The one real-benchmark case ------------------------------------------


@pytest.mark.slow
def test_a_real_benchmark_parent_lists_the_run_as_a_run(
    forecast_run: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(forecast_run.parent))
    app, token = create_app()
    client = _client(app)
    home_id = _home_id(client, token)

    listing = _get(client, token, "/api/fs/list", id=home_id).json()
    entry = next(e for e in listing if e["name"] == forecast_run.name)

    assert entry["is_run"] is True
