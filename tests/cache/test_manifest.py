"""Tests for checksummed source fingerprints and manifest staleness.

Covers D-06 (cheap size/mtime check first, whole-file checksum only when
those disagree) and D-07 (the checksum covers the whole file, never a
sample), plus per-artifact state and CACHE_VERSION invalidation (D-08).
"""

from __future__ import annotations

import builtins
import os

from pesto.cache.manifest import SourceFingerprint


# ---------------------------------------------------------------------------
# Task 1: SourceFingerprint and the cheap-then-expensive staleness check
# ---------------------------------------------------------------------------


def test_fingerprint_matches_an_unchanged_file(tmp_path):
    source = tmp_path / "par_0.f32"
    source.write_bytes(b"some ensemble bytes")

    fp = SourceFingerprint.of(source)

    assert fp.matches(tmp_path) is True


def test_fingerprint_notices_a_changed_file(tmp_path):
    source = tmp_path / "par_0.f32"
    source.write_bytes(b"original content")

    fp = SourceFingerprint.of(source)

    source.write_bytes(b"totally different content, longer even")

    assert fp.matches(tmp_path) is False


def test_fingerprint_notices_a_deleted_file(tmp_path):
    source = tmp_path / "par_0.f32"
    source.write_bytes(b"will be deleted")

    fp = SourceFingerprint.of(source)

    source.unlink()

    assert fp.matches(tmp_path) is False


def test_a_copied_file_with_a_new_mtime_is_still_fresh(tmp_path):
    source = tmp_path / "par_0.f32"
    content = b"identical bytes copied off a backup drive"
    source.write_bytes(content)

    fp = SourceFingerprint.of(source)

    # Simulate a copy: identical bytes, rewritten mtime.
    source.write_bytes(content)
    new_mtime_ns = fp.mtime_ns + 5_000_000_000
    os.utime(source, ns=(new_mtime_ns, new_mtime_ns))

    assert fp.matches(tmp_path) is True


def test_a_same_size_different_content_file_is_stale(tmp_path):
    source = tmp_path / "par_0.f32"
    original = b"AAAAAAAAAA"
    source.write_bytes(original)

    fp = SourceFingerprint.of(source)

    changed = b"BBBBBBBBBB"
    assert len(changed) == len(original)
    source.write_bytes(changed)
    new_mtime_ns = fp.mtime_ns + 1_000_000_000
    os.utime(source, ns=(new_mtime_ns, new_mtime_ns))

    assert fp.matches(tmp_path) is False


def test_the_cheap_path_does_not_read_the_file(tmp_path, monkeypatch):
    source = tmp_path / "par_0.f32"
    source.write_bytes(b"unchanged content")

    fp = SourceFingerprint.of(source)

    real_open = builtins.open

    def _raising_open(*args, **kwargs):
        raise AssertionError("the cheap path must not open the file")

    monkeypatch.setattr(builtins, "open", _raising_open)
    try:
        assert fp.matches(tmp_path) is True
    finally:
        monkeypatch.setattr(builtins, "open", real_open)


def test_the_checksum_covers_the_whole_file(tmp_path):
    head = b"H" * 4096
    tail = b"T" * 4096
    middle_original = b"M" * 4096
    source = tmp_path / "par_0.f32"
    source.write_bytes(head + middle_original + tail)

    fp = SourceFingerprint.of(source)

    middle_changed = b"X" * 4096
    source.write_bytes(head + middle_changed + tail)
    new_mtime_ns = fp.mtime_ns + 1_000_000_000
    os.utime(source, ns=(new_mtime_ns, new_mtime_ns))

    assert fp.matches(tmp_path) is False


def test_an_unreadable_source_file_is_stale_not_an_error(tmp_path, monkeypatch):
    source = tmp_path / "par_0.f32"
    source.write_bytes(b"content")

    fp = SourceFingerprint.of(source)

    # Force size/mtime to disagree so matches() takes the expensive path,
    # then make the digest helper raise OSError on that path.
    new_mtime_ns = fp.mtime_ns + 1_000_000_000
    os.utime(source, ns=(new_mtime_ns, new_mtime_ns))
    source.write_bytes(b"different content, different size")

    import pesto.cache.manifest as manifest_module

    def _raising_digest(path):
        raise OSError("simulated unreadable file")

    monkeypatch.setattr(manifest_module, "_digest_of", _raising_digest)

    assert fp.matches(tmp_path) is False


def test_fingerprinting_does_not_modify_the_source(tmp_path):
    source = tmp_path / "par_0.f32"
    source.write_bytes(b"leave me alone")

    before_stat = source.stat()
    before_bytes = source.read_bytes()

    SourceFingerprint.of(source)

    after_stat = source.stat()
    after_bytes = source.read_bytes()

    assert before_stat.st_mtime_ns == after_stat.st_mtime_ns
    assert before_stat.st_size == after_stat.st_size
    assert before_bytes == after_bytes
