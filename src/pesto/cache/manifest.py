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
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

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
