"""Tests for checksummed source fingerprints and manifest staleness.

Covers D-06 (cheap size/mtime check first, whole-file checksum only when
those disagree) and D-07 (the checksum covers the whole file, never a
sample), plus per-artifact state and CACHE_VERSION invalidation (D-08).
"""

from __future__ import annotations

import builtins
import json
import os

from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import Manifest, SourceFingerprint


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


# ---------------------------------------------------------------------------
# Task 2: Artifact state, atomic manifest persistence, CACHE_VERSION reset
# ---------------------------------------------------------------------------


def test_unknown_artifact_is_stale(tmp_path):
    manifest = Manifest.empty(str(tmp_path))

    assert manifest.is_stale("par_0") is True


def test_ok_artifact_is_not_stale_until_its_source_changes(tmp_path):
    source = tmp_path / "par_0.f32"
    source.write_bytes(b"initial content")
    fp = SourceFingerprint.of(source)

    manifest = Manifest.empty(str(tmp_path))
    manifest.mark_ok("par_0", [fp])

    assert manifest.is_stale("par_0") is False

    source.write_bytes(b"changed content, different bytes")
    new_mtime_ns = fp.mtime_ns + 1_000_000_000
    os.utime(source, ns=(new_mtime_ns, new_mtime_ns))

    assert manifest.is_stale("par_0") is True


def test_failed_artifact_records_a_reason_and_stays_stale(tmp_path):
    manifest = Manifest.empty(str(tmp_path))

    manifest.mark_failed("par_2", "unexpected end of file")

    artifact = manifest.artifacts["par_2"]
    assert artifact.state == "failed"
    assert artifact.reason is not None
    assert "unexpected end of file" in artifact.reason
    assert manifest.is_stale("par_2") is True


def test_missing_artifact_records_a_reason_and_stays_stale(tmp_path):
    manifest = Manifest.empty(str(tmp_path))

    manifest.mark_missing("par_3", "source file not found")

    artifact = manifest.artifacts["par_3"]
    assert artifact.state == "missing"
    assert artifact.reason is not None
    assert "source file not found" in artifact.reason
    assert manifest.is_stale("par_3") is True


def test_only_the_affected_artifact_goes_stale(tmp_path):
    source_a = tmp_path / "par_0.f32"
    source_a.write_bytes(b"artifact a content")
    source_b = tmp_path / "par_1.f32"
    source_b.write_bytes(b"artifact b content")

    fp_a = SourceFingerprint.of(source_a)
    fp_b = SourceFingerprint.of(source_b)

    manifest = Manifest.empty(str(tmp_path))
    manifest.mark_ok("par_0", [fp_a])
    manifest.mark_ok("par_1", [fp_b])

    source_a.write_bytes(b"artifact a CHANGED content")
    new_mtime_ns = fp_a.mtime_ns + 1_000_000_000
    os.utime(source_a, ns=(new_mtime_ns, new_mtime_ns))

    assert manifest.is_stale("par_0") is True
    assert manifest.is_stale("par_1") is False


def test_round_trips_through_disk(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    source = tmp_path / "par_0.f32"
    source.write_bytes(b"ok artifact content")
    fp = SourceFingerprint.of(source)

    manifest = Manifest.empty(str(tmp_path))
    manifest.mark_ok("par_0", [fp])
    manifest.mark_missing("par_1", "not found")
    manifest.save(layout)

    reloaded = Manifest.load(layout)

    assert reloaded.cache_version == CACHE_VERSION
    assert reloaded.artifacts["par_0"].state == "ok"
    assert reloaded.artifacts["par_1"].state == "missing"
    assert reloaded.is_stale("par_0") is False


def test_the_checksum_survives_the_round_trip(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    source = tmp_path / "par_0.f32"
    content = b"content that will be copied"
    source.write_bytes(content)
    fp = SourceFingerprint.of(source)

    manifest = Manifest.empty(str(tmp_path))
    manifest.mark_ok("par_0", [fp])
    manifest.save(layout)

    reloaded = Manifest.load(layout)
    reloaded_fp = reloaded.artifacts["par_0"].sources[0]

    assert reloaded_fp.checksum == fp.checksum

    # Copy with a rewritten mtime, identical content: still fresh through the
    # reloaded manifest.
    source.write_bytes(content)
    new_mtime_ns = fp.mtime_ns + 5_000_000_000
    os.utime(source, ns=(new_mtime_ns, new_mtime_ns))

    assert reloaded.is_stale("par_0") is False


def test_a_version_bump_invalidates_everything(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    source = tmp_path / "par_0.f32"
    source.write_bytes(b"content")
    fp = SourceFingerprint.of(source)

    manifest = Manifest.empty(str(tmp_path))
    manifest.mark_ok("par_0", [fp])
    manifest.save(layout)

    payload = json.loads(layout.manifest.read_text())
    payload["cache_version"] = payload["cache_version"] + 1
    layout.manifest.write_text(json.dumps(payload))

    reloaded = Manifest.load(layout)

    assert reloaded.artifacts == {}
    assert reloaded.is_stale("par_0") is True


def test_loading_a_missing_or_corrupt_manifest_gives_an_empty_one(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    # No manifest.json written yet.
    reloaded = Manifest.load(layout)
    assert reloaded.artifacts == {}

    layout.manifest.write_text("{not json")
    reloaded_corrupt = Manifest.load(layout)
    assert reloaded_corrupt.artifacts == {}


def test_loading_valid_json_of_the_wrong_shape_gives_an_empty_one(tmp_path):
    # A truncated write or a hand-edit can leave JSON that parses cleanly but
    # is not a manifest. Every one of these reached an attribute access on the
    # wrong type and raised, against load()'s documented never-raises contract.
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    shapes = [
        "null",
        "[]",
        "42",
        '"a string"',
        '{"cache_version": %r, "run_dir": "/run", "artifacts": []}' % CACHE_VERSION,
        '{"cache_version": %r, "run_dir": "/run", "artifacts": "nope"}' % CACHE_VERSION,
        '{"cache_version": %r, "run_dir": 17, "artifacts": {}}' % CACHE_VERSION,
        '{"cache_version": %r, "run_dir": "/run", "artifacts": {"par_0": []}}'
        % CACHE_VERSION,
        '{"cache_version": %r, "run_dir": "/run", "artifacts": {"par_0": "ab"}}'
        % CACHE_VERSION,
    ]

    for shape in shapes:
        layout.manifest.write_text(shape)
        reloaded = Manifest.load(layout)
        assert reloaded.artifacts == {}, shape
        assert reloaded.cache_version == CACHE_VERSION, shape
        # Nothing may report fresh out of an unreadable manifest.
        assert reloaded.is_stale("par_0") is True, shape


def test_save_is_atomic(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    manifest = Manifest.empty(str(tmp_path))
    manifest.save(layout)

    entries = list(layout.root.iterdir())
    names = {p.name for p in entries}

    assert "manifest.json" in names
    leftover = [n for n in names if n != "manifest.json" and (".tmp" in n or n.startswith(".manifest"))]
    assert leftover == []


def test_a_torn_write_cannot_look_fresh(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    source = tmp_path / "par_0.f32"
    source.write_bytes(b"content")
    fp = SourceFingerprint.of(source)

    manifest = Manifest.empty(str(tmp_path))
    manifest.mark_ok("par_0", [fp])
    manifest.save(layout)

    full_bytes = layout.manifest.read_bytes()
    layout.manifest.write_bytes(full_bytes[: len(full_bytes) // 2])

    reloaded = Manifest.load(layout)

    assert reloaded.artifacts == {}
    assert reloaded.is_stale("par_0") is True


# ---------------------------------------------------------------------------
# ingest_seconds / cache_bytes -- ingest facts the manifest carries, D-07
# ---------------------------------------------------------------------------


def test_ingest_totals_default_to_none_and_round_trip_through_disk(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    manifest = Manifest.empty(str(tmp_path))
    assert manifest.ingest_seconds is None
    assert manifest.cache_bytes is None

    manifest.ingest_seconds = 12.5
    manifest.cache_bytes = 4096
    manifest.save(layout)

    reloaded = Manifest.load(layout)
    assert reloaded.ingest_seconds == 12.5
    assert reloaded.cache_bytes == 4096
