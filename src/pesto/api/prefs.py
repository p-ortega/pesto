"""Server-side memory of the last directory opened.

So a picker's first listing on the next launch can start where the user
left off, without the browser ever holding a real path. The store never
raises: a missing, unreadable, non-JSON, wrong-version or non-dict file,
and a recorded path that no longer exists, all read back as ``None``.
Forgetting where the user was is a convenience regression, not a reason to
fail an unrelated request, so a failed write is dropped the same quiet way.

The resolved path is written here, server-side only. It never reaches the
browser: every launch re-issues a fresh opaque id for whatever directory
this points to, so D-09's id vocabulary is unaffected.
"""

from __future__ import annotations

import json
from pathlib import Path

_STORE_VERSION = 1


def _store_path() -> Path:
    return Path.home() / ".cache" / "pesto" / "last_run.json"


def read_last_run() -> Path | None:
    """Return the last directory recorded, or ``None`` for any reason at all."""
    try:
        raw = _store_path().read_text(encoding="utf-8")
    except OSError:
        return None

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None

    if not isinstance(data, dict) or data.get("version") != _STORE_VERSION:
        return None

    recorded = data.get("path")
    if not isinstance(recorded, str):
        return None

    recorded_path = Path(recorded)
    return recorded_path if recorded_path.is_dir() else None


def write_last_run(path: Path) -> None:
    """Record ``path`` as the last directory opened.

    Never raises -- a failed write just means the next launch starts with
    no remembered directory, which is a worse first screen, not a broken one.
    """
    store = _store_path()
    body = json.dumps({"version": _STORE_VERSION, "path": str(path.resolve())})
    try:
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_text(body, encoding="utf-8")
    except OSError:
        return
