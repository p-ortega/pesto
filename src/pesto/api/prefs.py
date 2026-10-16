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

from pesto.cache._atomic import write_atomic_text

_STORE_VERSION = 2
_MAX_RECENT_RUNS = 5


def _store_path() -> Path:
    return Path.home() / ".cache" / "pesto" / "last_run.json"


def read_recent_runs() -> list[Path]:
    """Return the recent run folders, newest first, or an empty list for any
    reason at all. Old one-path files read as a one-entry list.
    """
    try:
        raw = _store_path().read_text(encoding="utf-8")
    except OSError:
        return []

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []

    if not isinstance(data, dict):
        return []

    version = data.get("version")
    if version == 1:
        entries = [data.get("path")]
    elif version == _STORE_VERSION:
        entries = data.get("paths")
        if not isinstance(entries, list):
            return []
    else:
        return []

    recent: list[Path] = []
    seen: set[Path] = set()
    for entry in entries:
        if not isinstance(entry, str):
            continue
        candidate = Path(entry)
        if not candidate.is_dir():
            continue
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        recent.append(candidate)
        if len(recent) == _MAX_RECENT_RUNS:
            break
    return recent


def read_last_run() -> Path | None:
    """Return the newest recent run, or ``None`` for any reason at all."""
    recent = read_recent_runs()
    return recent[0] if recent else None


def write_last_run(path: Path) -> None:
    """Move ``path`` to the front of the recent runs, keeping at most five.

    Never raises -- a failed write just means the next launch starts with
    fewer remembered runs, which is a worse first screen, not a broken one.
    """
    resolved = path.resolve()
    others = [p for p in read_recent_runs() if p.resolve() != resolved]
    runs = [resolved, *others][:_MAX_RECENT_RUNS]
    body = json.dumps({"version": _STORE_VERSION, "paths": [str(p) for p in runs]})
    store = _store_path()
    try:
        store.parent.mkdir(parents=True, exist_ok=True)
        write_atomic_text(store, body)
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
