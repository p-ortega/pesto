"""Tests for probe-based cache root resolution and the on-disk cache layout.

The fallback-forcing tests monkeypatch the probe write itself rather than
relying on ``chmod`` -- ``chmod`` does not reliably make a directory
unwritable on Windows, so a chmod-only test would be green here and blind in
the field (RESEARCH.md Pitfall 2).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pesto.cache.layout import CACHE_VERSION, CacheLayout, for_run, resolve_cache_root


def test_cache_sits_beside_the_run_when_writable(tmp_path):
    run = tmp_path / "run"
    run.mkdir()

    root = resolve_cache_root(run)

    assert root == run / ".pesto"


def test_cache_falls_back_when_the_probe_write_fails(tmp_path, monkeypatch):
    run = tmp_path / "run"
    run.mkdir()
    fake_cache_home = tmp_path / "xdg-cache"
    monkeypatch.setenv("XDG_CACHE_HOME", str(fake_cache_home))

    def _raise(self, *args, **kwargs):
        raise OSError("simulated probe write failure")

    monkeypatch.setattr(Path, "write_bytes", _raise)

    root = resolve_cache_root(run)

    assert str(root).startswith(str(fake_cache_home))
    assert root.name != ".pesto"


def test_fallback_is_stable_for_the_same_directory(tmp_path, monkeypatch):
    run = tmp_path / "run"
    run.mkdir()
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))

    def _raise(self, *args, **kwargs):
        raise OSError("simulated probe write failure")

    monkeypatch.setattr(Path, "write_bytes", _raise)

    first = resolve_cache_root(run)
    second = resolve_cache_root(run)

    assert first == second


def test_fallback_paths_do_not_collide_for_different_directories(tmp_path, monkeypatch):
    run_a = tmp_path / "run-a"
    run_b = tmp_path / "run-b"
    run_a.mkdir()
    run_b.mkdir()
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))

    def _raise(self, *args, **kwargs):
        raise OSError("simulated probe write failure")

    monkeypatch.setattr(Path, "write_bytes", _raise)

    root_a = resolve_cache_root(run_a)
    root_b = resolve_cache_root(run_b)

    assert root_a != root_b


def test_equivalent_spellings_of_one_directory_share_a_fallback(tmp_path, monkeypatch):
    run = tmp_path / "run"
    run.mkdir()
    link = tmp_path / "run-link"
    link.symlink_to(run)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg-cache"))

    def _raise(self, *args, **kwargs):
        raise OSError("simulated probe write failure")

    monkeypatch.setattr(Path, "write_bytes", _raise)

    plain = resolve_cache_root(run)
    trailing_slash = resolve_cache_root(Path(str(run) + "/"))
    dot_segment = resolve_cache_root(run / ".")
    via_symlink = resolve_cache_root(link)

    assert plain == trailing_slash == dot_segment == via_symlink


def test_override_wins_and_is_never_probed(tmp_path, monkeypatch):
    run = tmp_path / "run"
    run.mkdir()
    elsewhere = tmp_path / "not-created-yet" / "cache"

    def _raise(self, *args, **kwargs):
        raise AssertionError("override must never be probed")

    monkeypatch.setattr(Path, "write_bytes", _raise)

    root = resolve_cache_root(run, override=elsewhere)

    assert root == elsewhere
    assert not elsewhere.exists()


def test_a_missing_run_directory_is_refused_not_created(tmp_path):
    missing = tmp_path / "nope"

    with pytest.raises(NotADirectoryError) as excinfo:
        resolve_cache_root(missing)

    assert str(missing) in str(excinfo.value)
    assert not missing.exists()


def test_a_file_where_a_run_directory_was_expected_is_refused(tmp_path):
    not_a_dir = tmp_path / "im-a-file"
    not_a_dir.write_text("hello")

    with pytest.raises(NotADirectoryError) as excinfo:
        resolve_cache_root(not_a_dir)

    assert str(not_a_dir) in str(excinfo.value)


def test_the_probe_file_does_not_survive(tmp_path):
    run = tmp_path / "run"
    run.mkdir()

    root = resolve_cache_root(run)

    assert list(root.iterdir()) == []


def test_layout_exposes_named_directories_and_per_iteration_files(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    for name in ("control", "phi", "ens", "reals", "agg", "grid", "time"):
        assert getattr(layout, name).is_dir()

    assert layout.manifest.name == "manifest.json"
    assert layout.config.name == "config.json"
    assert layout.par_ens(3).name == "par_3.f32"
    assert layout.par_reals(3).name == "par_3.reals.json"
    assert layout.par_agg(0).name == "par_0.parquet"
    assert layout.par_agg_notes(0).name == "par_0.notes.json"


def test_ensure_is_idempotent(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")

    layout.ensure()
    layout.ensure()

    assert layout.ens.is_dir()


def test_for_run_makes_a_usable_layout(tmp_path):
    run = tmp_path / "run"
    run.mkdir()

    layout = for_run(run)
    layout.ensure()

    assert layout.root == run / ".pesto"
    assert layout.ens.is_dir()


def test_cache_version_is_an_integer():
    assert isinstance(CACHE_VERSION, int)
