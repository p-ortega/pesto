"""Temp-file-then-rename writers shared by every cache artifact.

Both writers create their temp file inside the target's own directory --
keeping the final swap on one filesystem -- flush, fsync, and swap into
place with ``os.replace``, atomic on POSIX and Windows alike. A reader
therefore never observes a half-written file: either the previous file is
still there, or the finished one is, never something in between. The temp
file is closed before it is unlinked in a ``finally`` when the replace did
not happen, so a failed write leaves no open descriptor and no litter under
the cache root, on POSIX where unlinking a still-open file would have
succeeded anyway and on Windows where it would not.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import BinaryIO, Callable


def write_atomic_text(target: Path, payload: str) -> int:
    """Write ``payload`` to ``target`` atomically. Returns the byte count
    written."""
    directory = target.parent
    tmp = tempfile.NamedTemporaryFile(
        mode="w", dir=directory, prefix=".ingest-", suffix=".tmp", delete=False
    )
    tmp_path = Path(tmp.name)
    replaced = False
    try:
        written = tmp.write(payload)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp_path, target)
        replaced = True
        return written
    finally:
        if not replaced:
            # This runs while the write's own exception is already in
            # flight. Closing can itself raise (e.g. a second flush error),
            # and letting that replace the real failure would tell the
            # caller about the cleanup instead of about the write.
            try:
                tmp.close()
            except Exception:
                pass
            if tmp_path.exists():
                tmp_path.unlink()


def write_atomic_bytes(target: Path, write_fn: Callable[[BinaryIO], int]) -> int:
    """Write to ``target`` atomically. ``write_fn`` receives the open temp
    file and returns the byte count it wrote. Returns that same count."""
    directory = target.parent
    tmp = tempfile.NamedTemporaryFile(
        mode="wb", dir=directory, prefix=".ingest-", suffix=".tmp", delete=False
    )
    tmp_path = Path(tmp.name)
    replaced = False
    try:
        written = write_fn(tmp)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp_path, target)
        replaced = True
        return written
    finally:
        if not replaced:
            # See write_atomic_text: a cleanup error must not replace the
            # in-flight exception from the write itself.
            try:
                tmp.close()
            except Exception:
                pass
            if tmp_path.exists():
                tmp_path.unlink()
