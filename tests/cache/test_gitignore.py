"""Tests for the idempotent ``.pesto/`` gitignore mutation (D-05) and for
opening a run directory from the command line end to end.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time

import pytest

from pesto.cache.gitignore import ensure_gitignored

_IS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0


def test_a_git_repository_gets_the_ignore_line(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / ".git").mkdir()

    ensure_gitignored(run)

    lines = (run / ".gitignore").read_text().splitlines()
    assert ".pesto/" in lines


def test_a_successful_write_reports_no_failure(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / ".git").mkdir()

    assert ensure_gitignored(run) is None


@pytest.mark.skipif(_IS_ROOT, reason="chmod 0o000 has no effect for root")
def test_a_read_only_run_directory_does_not_raise_and_reports_why(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / ".git").mkdir()
    run.chmod(0o555)
    try:
        reason = ensure_gitignored(run)
    finally:
        run.chmod(0o755)

    assert reason is not None
    assert not (run / ".gitignore").exists()


def test_a_worktree_pointer_file_counts_as_a_repository(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / ".git").write_text("gitdir: ../.git/worktrees/run\n")

    ensure_gitignored(run)

    lines = (run / ".gitignore").read_text().splitlines()
    assert ".pesto/" in lines


def test_a_plain_directory_is_left_alone(tmp_path):
    run = tmp_path / "run"
    run.mkdir()

    ensure_gitignored(run)

    assert not (run / ".gitignore").exists()


def test_calling_it_twice_leaves_one_line(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / ".git").mkdir()

    ensure_gitignored(run)
    ensure_gitignored(run)

    lines = (run / ".gitignore").read_text().splitlines()
    assert lines.count(".pesto/") == 1


def test_an_existing_entry_is_recognised_without_the_slash(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / ".git").mkdir()
    (run / ".gitignore").write_text(".pesto\n")

    ensure_gitignored(run)

    content = (run / ".gitignore").read_text()
    assert content == ".pesto\n"


def test_existing_content_is_preserved_byte_for_byte(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / ".git").mkdir()
    original = "*.pyc\n__pycache__/\n.DS_Store\n"
    (run / ".gitignore").write_text(original)

    ensure_gitignored(run)

    content = (run / ".gitignore").read_text()
    assert content == original + ".pesto/\n"


def test_a_file_with_no_trailing_newline_is_not_corrupted(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / ".git").mkdir()
    (run / ".gitignore").write_text("*.pyc")

    ensure_gitignored(run)

    content = (run / ".gitignore").read_text()
    assert content == "*.pyc\n.pesto/\n"


def test_opening_a_run_from_the_cli_creates_its_cache_and_reports_where(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / ".git").mkdir()

    code = f"from pesto.cli import main\nmain(['--no-browser', {str(run)!r}])\n"
    proc = subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        cache_line = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    break
                continue
            if re.search(r"cache", line, re.IGNORECASE):
                cache_line = line
                break
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

    assert cache_line is not None, "launcher never printed the resolved cache root"
    assert str(run / ".pesto") in cache_line
    assert (run / ".pesto" / "ens").is_dir()
    assert ".pesto/" in (run / ".gitignore").read_text().splitlines()


def test_a_missing_run_directory_exits_cleanly(tmp_path):
    missing = tmp_path / "definitely-not-here"

    code = f"from pesto.cli import main\nimport sys\nsys.exit(main(['--no-browser', {str(missing)!r}]))\n"
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=15,
    )

    assert result.returncode != 0
    assert str(missing) in (result.stdout + result.stderr)
    assert not missing.exists()
