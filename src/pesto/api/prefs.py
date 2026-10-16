"""Server-side memory of the last directory opened, and of how each run's
map was left (D-11).

So a picker's first listing on the next launch can start where the user
left off, without the browser ever holding a real path. The store never
raises: a missing, unreadable, non-JSON, wrong-version or non-dict file,
and a recorded path that no longer exists, all read back as ``None``.
Forgetting where the user was is a convenience regression, not a reason to
fail an unrelated request, so a failed write is dropped the same quiet way.

The resolved path is written here, server-side only. It never reaches the
browser: every launch re-issues a fresh opaque id for whatever directory
this points to, so D-09's id vocabulary is unaffected.

``read_view_state``/``write_view_state`` follow the exact same never-raise
shape, keyed by cache root rather than by nothing: the store path always
comes from ``Path.home()``, never from ``cache_root`` itself, so a run
directory used as its own cache root is still never written to (CLAUDE.md's
first hard rule). A failed view-state write means the run reopens with the
default map, which is a worse first screen, not a broken one.
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


_VIEW_STORE_VERSION = 1

_VIEW_STATE_DEFAULTS: dict = {
    "divider": 0.72,
    "colormap": "viridis",
    "reverse": False,
    "scale": "linear",
    "limits_mode": "robust",
    "group": None,
    "stat": "value",
    "layer": None,
}


def _view_store_path() -> Path:
    return Path.home() / ".cache" / "pesto" / "view_state.json"


def _default_view_state() -> dict:
    return dict(_VIEW_STATE_DEFAULTS)


def read_view_state(cache_root: Path | str) -> dict:
    """Return the view state recorded for ``cache_root``, or the default
    state for any reason at all -- a missing, unreadable, non-JSON,
    wrong-version or non-dict store, or no entry for this root yet.

    An unknown key in a stored payload is dropped; a missing key takes its
    default. Never raises.
    """
    try:
        raw = _view_store_path().read_text(encoding="utf-8")
    except OSError:
        return _default_view_state()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return _default_view_state()

    if not isinstance(data, dict) or data.get("version") != _VIEW_STORE_VERSION:
        return _default_view_state()

    roots = data.get("roots")
    if not isinstance(roots, dict):
        return _default_view_state()

    stored = roots.get(str(Path(cache_root).resolve()))
    if not isinstance(stored, dict):
        return _default_view_state()

    return {key: stored.get(key, default) for key, default in _VIEW_STATE_DEFAULTS.items()}


def write_view_state(cache_root: Path | str, state: dict) -> None:
    """Record ``state`` for ``cache_root``, keeping every other root's state
    untouched.

    Never raises -- a failed write means the run reopens with the default
    map, which is a worse first screen, not a broken one.
    """
    store = _view_store_path()
    try:
        raw = store.read_text(encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("version") != _VIEW_STORE_VERSION:
            data = {"version": _VIEW_STORE_VERSION, "roots": {}}
    except (OSError, json.JSONDecodeError):
        data = {"version": _VIEW_STORE_VERSION, "roots": {}}

    roots = data.get("roots")
    if not isinstance(roots, dict):
        roots = {}

    key = str(Path(cache_root).resolve())
    roots[key] = {field: state.get(field, default) for field, default in _VIEW_STATE_DEFAULTS.items()}
    data["roots"] = roots

    body = json.dumps(data)
    try:
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_text(body, encoding="utf-8")
    except OSError:
        return
