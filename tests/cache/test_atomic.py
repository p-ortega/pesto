"""The atomic writers' own test file.

``write_atomic_text`` and ``write_atomic_bytes`` are exercised incidentally
from ``tests/cache/test_manifest.py`` and ``tests/ingest/test_mesh.py``, but
neither file proves the writers' own contract: a failed write closes its
temp file before it unlinks it, propagates the caller's own exception, and
leaves nothing behind.
"""

from __future__ import annotations

import tempfile

import pytest

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text


class _WriteBoom(Exception):
    """A distinctly named exception so a test can tell it apart from
    anything cleanup might raise."""


def _recording_named_temporary_file(monkeypatch, recorded: list):
    """Wrap ``tempfile.NamedTemporaryFile`` so the object it returns is
    captured, letting a test inspect ``closed`` after the writer's own
    reference to it goes out of scope."""
    real = tempfile.NamedTemporaryFile

    def _wrapper(*args, **kwargs):
        tmp = real(*args, **kwargs)
        recorded.append(tmp)
        return tmp

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", _wrapper)


def test_a_raising_write_fn_propagates_its_own_exception(tmp_path):
    target = tmp_path / "out.bin"

    def _write(fileobj):
        raise _WriteBoom("disk full")

    with pytest.raises(_WriteBoom):
        write_atomic_bytes(target, _write)


def test_a_raising_flush_propagates_its_own_exception(tmp_path):
    target = tmp_path / "out.bin"

    def _write(fileobj):
        written = fileobj.write(b"data")

        def _raising_flush():
            raise _WriteBoom("flush failed")

        fileobj.flush = _raising_flush
        return written

    with pytest.raises(_WriteBoom):
        write_atomic_bytes(target, _write)


def test_a_raising_fsync_propagates_its_own_exception_not_a_cleanup_error(
    tmp_path, monkeypatch
):
    target = tmp_path / "out.bin"

    def _raising_fsync(fd):
        raise _WriteBoom("fsync failed")

    monkeypatch.setattr("pesto.cache._atomic.os.fsync", _raising_fsync)

    with pytest.raises(_WriteBoom):
        write_atomic_bytes(target, lambda f: f.write(b"data"))


def test_the_recorded_temp_file_is_closed_after_a_failed_write(tmp_path, monkeypatch):
    target = tmp_path / "out.bin"
    recorded: list = []
    _recording_named_temporary_file(monkeypatch, recorded)

    def _write(fileobj):
        raise _WriteBoom("disk full")

    with pytest.raises(_WriteBoom):
        write_atomic_bytes(target, _write)

    assert len(recorded) == 1
    assert recorded[0].closed


def test_no_temp_prefixed_file_remains_after_a_failed_write(tmp_path):
    target = tmp_path / "out.bin"

    def _write(fileobj):
        raise _WriteBoom("disk full")

    with pytest.raises(_WriteBoom):
        write_atomic_bytes(target, _write)

    assert list(tmp_path.glob(".ingest-*")) == []


def test_a_failed_second_write_leaves_the_previously_finished_file_untouched(tmp_path):
    target = tmp_path / "out.bin"
    write_atomic_bytes(target, lambda f: f.write(b"first"))
    before_bytes = target.read_bytes()
    before_mtime = target.stat().st_mtime_ns

    def _write(fileobj):
        raise _WriteBoom("disk full")

    with pytest.raises(_WriteBoom):
        write_atomic_bytes(target, _write)

    assert target.read_bytes() == before_bytes
    assert target.stat().st_mtime_ns == before_mtime


def test_closing_a_file_the_success_path_already_closed_does_not_raise(tmp_path, monkeypatch):
    """os.replace can still fail after the temp file is already closed on
    the success path -- the finally block's own close call must be a no-op
    on an already-closed file, not a second error on top of the first."""
    target = tmp_path / "out.bin"

    def _raising_replace(src, dst):
        raise _WriteBoom("replace failed")

    monkeypatch.setattr("pesto.cache._atomic.os.replace", _raising_replace)

    with pytest.raises(_WriteBoom):
        write_atomic_bytes(target, lambda f: f.write(b"data"))

    assert not target.exists()
    assert list(tmp_path.glob(".ingest-*")) == []


def test_a_successful_write_atomic_bytes_returns_the_byte_count_and_the_target_holds_it(
    tmp_path,
):
    target = tmp_path / "out.bin"

    written = write_atomic_bytes(target, lambda f: f.write(b"hello"))

    assert written == 5
    assert target.read_bytes() == b"hello"


def test_a_successful_write_atomic_text_returns_the_character_count_and_the_target_holds_it(
    tmp_path,
):
    target = tmp_path / "out.txt"

    written = write_atomic_text(target, "hello world")

    assert written == len("hello world")
    assert target.read_text() == "hello world"
