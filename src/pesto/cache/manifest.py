"""Source fingerprints and the manifest that records a run's cache state.

Every independently readable piece of a run is an artifact with its own
state, so one corrupt ensemble file marks one artifact failed while
everything else still works, and staleness is per artifact so a changed
source file re-reads only what depended on it.

Freshness is a claim that must be provable, never assumed. A fingerprint
carries a whole-file sha256 alongside size and mtime so that a run copied
off a backup drive -- identical content, every mtime rewritten -- is not
mistaken for changed (D-06, D-07). Anything the code cannot prove fresh --
a missing file, an unreadable one, a corrupt or version-mismatched manifest
-- resolves to stale. Being wrong toward a needless re-read costs seconds;
being wrong the other way shows a scientist last week's numbers labelled as
this week's.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout

ArtifactState = Literal["ok", "missing", "failed", "not_ingested"]


def _digest_of(path: Path) -> str:
    """Return the whole-file sha256 hex digest of ``path``.

    Opens for reading only. This function must never write, truncate or
    re-timestamp the file it is pointed at -- some of pesto's source files
    are a scientist's finished calibration output living on read-only
    archive media, and pesto's only relationship with them is reading.
    """
    with open(path, "rb") as f:
        digest = hashlib.file_digest(f, "sha256")
    return digest.hexdigest()


@dataclass(frozen=True)
class SourceFingerprint:
    """What a manifest remembers about one source file.

    ``checksum`` is the field the M0 reference plan's version lacks: without
    a stored digest there is nothing to compare against when size and mtime
    disagree, forcing an all-or-nothing choice between always trusting mtime
    (wrongly stale after every copy) or never trusting it (throwing away the
    cheap path entirely).
    """

    path: str
    mtime_ns: int
    size: int
    checksum: str

    @classmethod
    def of(cls, path: Path) -> "SourceFingerprint":
        """Fingerprint ``path``. Always reads and hashes the whole file --
        this is the cost D-06 pays at ingest time so the read path can stay
        cheap later."""
        info = path.stat()
        checksum = _digest_of(path)
        return cls(
            path=path.name,
            mtime_ns=info.st_mtime_ns,
            size=info.st_size,
            checksum=checksum,
        )

    def matches(self, base: Path) -> bool:
        """Is the file this fingerprint describes still fresh, relative to
        ``base``?

        Cheap path: when the resolved file's ``st_mtime_ns`` and ``st_size``
        both equal the recorded values, it is fresh -- and the file is never
        opened to reach that answer.

        Expensive path: when either disagrees, the whole-file checksum is
        recomputed and compared to the one stored at fingerprint time. This
        is what lets a run copied off a backup drive (identical content,
        every mtime rewritten) stay fresh instead of re-ingesting gigabytes.

        Known, accepted gap (D-06): an edit that preserves both size and
        mtime goes unnoticed. Producing one takes deliberate effort.

        Every uncertainty resolves to False -- a missing file, and a source
        file that raises during hashing (unreadable, vanished mid-read) are
        both stale, never an exception.
        """
        target = Path(base) / self.path
        if not target.exists():
            return False
        info = target.stat()
        if info.st_mtime_ns == self.mtime_ns and info.st_size == self.size:
            return True
        try:
            digest = _digest_of(target)
        except OSError:
            return False
        return digest == self.checksum


@dataclass(frozen=True)
class CacheFile:
    """One finished file under the cache root. ``path`` is relative to the
    cache root; ``bytes`` is the size the file had right after the rename
    that published it."""

    path: str
    bytes: int


@dataclass(frozen=True)
class WrittenArtifact:
    """What one cache writer produced on success: every file it wrote and
    any notes worth carrying forward. This is the record every writer in
    the ingest layer returns."""

    name: str
    files: tuple[CacheFile, ...]
    notes: tuple[str, ...] = ()


@dataclass
class Artifact:
    """One independently readable piece of a run's cache.

    Keeping the failure reason is what lets a later phase report a failure
    by artifact name and cause instead of a silent absence.
    """

    name: str
    state: ArtifactState
    reason: str | None = None
    sources: list[SourceFingerprint] = field(default_factory=list)
    files: list[CacheFile] = field(default_factory=list)
    seconds: float | None = None


@dataclass
class Manifest:
    """A run's cache state: which artifacts exist, what sources they were
    built from, and whether each one is still fresh.

    A manifest that is absent, unreadable, not valid JSON, or built at a
    different ``CACHE_VERSION`` yields no artifacts at all -- so every
    artifact reports stale. Per D-08 a ``CACHE_VERSION`` bump is a hard
    reset that outranks size, mtime and checksum alike.
    """

    cache_version: int
    run_dir: str
    artifacts: dict[str, Artifact] = field(default_factory=dict)
    ingest_seconds: float | None = None
    cache_bytes: int | None = None

    @classmethod
    def empty(cls, run_dir: str) -> "Manifest":
        return cls(cache_version=CACHE_VERSION, run_dir=str(run_dir))

    def mark_ok(
        self,
        name: str,
        sources: list[SourceFingerprint],
        files: tuple[CacheFile, ...] = (),
        seconds: float | None = None,
    ) -> None:
        self.artifacts[name] = Artifact(
            name=name,
            state="ok",
            reason=None,
            sources=list(sources),
            files=list(files),
            seconds=seconds,
        )

    def mark_failed(
        self,
        name: str,
        reason: str,
        sources: list[SourceFingerprint] = (),
        seconds: float | None = None,
    ) -> None:
        # Recording sources on a failure is what lets a later plan decide
        # whether a failed artifact is worth retrying.
        self.artifacts[name] = Artifact(
            name=name, state="failed", reason=reason, sources=list(sources), seconds=seconds
        )

    def mark_missing(self, name: str, reason: str) -> None:
        self.artifacts[name] = Artifact(name=name, state="missing", reason=reason, sources=[])

    def is_stale(self, name: str) -> bool:
        """An artifact that was never ingested, or whose recorded state is
        anything other than ``ok``, reports stale. An ``ok`` artifact is
        stale only when at least one of its recorded sources no longer
        matches."""
        artifact = self.artifacts.get(name)
        if artifact is None or artifact.state != "ok":
            return True
        return not all(source.matches(Path(self.run_dir)) for source in artifact.sources)

    def save(self, layout: CacheLayout) -> None:
        layout.ensure()
        payload = json.dumps(
            {
                "cache_version": self.cache_version,
                "run_dir": self.run_dir,
                "artifacts": {
                    name: asdict(artifact) for name, artifact in self.artifacts.items()
                },
                "ingest_seconds": self.ingest_seconds,
                "cache_bytes": self.cache_bytes,
            },
            indent=2,
        )
        write_atomic_text(layout.manifest, payload)

    @classmethod
    def load(cls, layout: CacheLayout) -> "Manifest":
        """Load the manifest at ``layout.manifest``.

        Every failure mode -- absent, unreadable, not valid JSON, valid JSON
        of the wrong shape, an unexpected ``cache_version``, or an artifact
        entry missing a required field (e.g. ``checksum``, from a manifest
        written by an earlier build) -- resolves to an empty manifest rather
        than raising. A parse failure must never produce a partially
        populated manifest that reports something fresh.
        """
        try:
            data = json.loads(layout.manifest.read_text())
        except (OSError, json.JSONDecodeError):
            return cls(cache_version=CACHE_VERSION, run_dir="")

        # Valid JSON is not the same as a manifest. A truncated write or a
        # hand-edit can leave `null`, a list or a bare number here, all of
        # which parse cleanly and then have no `.get`. Shape is checked
        # before anything is read off it.
        if not isinstance(data, dict):
            return cls(cache_version=CACHE_VERSION, run_dir="")

        run_dir = data.get("run_dir", "")
        if not isinstance(run_dir, str):
            # A non-string run_dir would survive to Path() and raise there
            # instead, well away from this parse.
            return cls(cache_version=CACHE_VERSION, run_dir="")

        if data.get("cache_version") != CACHE_VERSION:
            # D-08: a version bump is a hard invalidation, outranking size,
            # mtime and checksum alike -- no artifacts survive it.
            return cls(cache_version=CACHE_VERSION, run_dir=run_dir)

        raw_artifacts = data.get("artifacts", {})
        if not isinstance(raw_artifacts, dict):
            return cls(cache_version=CACHE_VERSION, run_dir="")

        try:
            artifacts: dict[str, Artifact] = {}
            for name, artifact_data in raw_artifacts.items():
                fields_copy = dict(artifact_data)
                fields_copy["sources"] = [
                    SourceFingerprint(**s) for s in artifact_data.get("sources", [])
                ]
                fields_copy["files"] = [
                    CacheFile(**f) for f in artifact_data.get("files", [])
                ]
                artifacts[name] = Artifact(**fields_copy)
        except (KeyError, TypeError, ValueError, AttributeError):
            # A malformed or outdated entry (e.g. a fingerprint missing the
            # checksum key) is treated as unreadable: one re-ingest is the
            # cost, a crash on open is the alternative. ValueError and
            # AttributeError cover an entry that is not a mapping at all --
            # dict("ab") raises the former, [].get the latter.
            return cls(cache_version=CACHE_VERSION, run_dir="")

        ingest_seconds = data.get("ingest_seconds")
        if not isinstance(ingest_seconds, (int, float)) or isinstance(ingest_seconds, bool):
            ingest_seconds = None
        else:
            ingest_seconds = float(ingest_seconds)

        cache_bytes = data.get("cache_bytes")
        if not isinstance(cache_bytes, int) or isinstance(cache_bytes, bool):
            cache_bytes = None

        return cls(
            cache_version=CACHE_VERSION,
            run_dir=run_dir,
            artifacts=artifacts,
            ingest_seconds=ingest_seconds,
            cache_bytes=cache_bytes,
        )
