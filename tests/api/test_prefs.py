"""The recent-runs store never raises, even when a path cannot be resolved."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pesto.api.prefs import _VIEW_STATE_DEFAULTS, read_recent_runs, read_view_state, write_last_run


def _store(tmp_path: Path, paths: list[Path]) -> None:
    store = tmp_path / ".cache" / "pesto" / "last_run.json"
    store.parent.mkdir(parents=True)
    store.write_text(json.dumps({"version": 2, "paths": [str(p) for p in paths]}))


def _locked_resolve(monkeypatch: pytest.MonkeyPatch, locked: Path) -> None:
    real = Path.resolve

    def resolve(self: Path, *args: object, **kwargs: object) -> Path:
        if self.name == locked.name:
            raise PermissionError("not allowed")
        return real(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "resolve", resolve)


@pytest.fixture
def folders(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    monkeypatch.setenv("HOME", str(tmp_path))
    ok, locked = tmp_path / "ok-run", tmp_path / "locked-run"
    ok.mkdir()
    locked.mkdir()
    return ok, locked


def test_an_entry_that_cannot_be_resolved_is_skipped_and_the_rest_are_read(
    tmp_path: Path, folders: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    ok, locked = folders
    _store(tmp_path, [locked, ok])
    _locked_resolve(monkeypatch, locked)

    assert read_recent_runs() == [ok]


def test_writing_a_run_does_not_raise_when_an_old_entry_cannot_be_resolved(
    tmp_path: Path, folders: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    ok, locked = folders
    _store(tmp_path, [locked])
    _locked_resolve(monkeypatch, locked)

    write_last_run(ok)

    assert read_recent_runs() == [ok.resolve()]


def test_writing_a_run_that_cannot_be_resolved_does_not_raise(
    tmp_path: Path, folders: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    _ok, locked = folders
    _locked_resolve(monkeypatch, locked)

    write_last_run(locked)

    assert not (tmp_path / ".cache" / "pesto" / "last_run.json").exists()


def test_a_view_state_with_a_tab_that_is_not_a_string_reads_back_on_params(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "run" / ".pesto"
    store = tmp_path / ".cache" / "pesto" / "view_state.json"
    store.parent.mkdir(parents=True)
    entry = {**_VIEW_STATE_DEFAULTS, "tab": {"nested": "obs"}}
    store.write_text(json.dumps({"version": 1, "roots": {str(cache_root.resolve()): entry}}))

    assert read_view_state(cache_root)["tab"] == "params"
