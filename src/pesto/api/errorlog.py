"""The last few server-side errors, kept in memory for the problem report.

Nothing here is written to disk and nothing leaves the process. Messages
are stored as they were raised; the report scrubs them before showing them.
Tracebacks hold only file names relative to their package, line numbers and
function names, never a folder from this machine.
"""

from __future__ import annotations

import contextvars
import time
import traceback
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_ERRORS = 20
MAX_FRAMES = 8
MAX_MESSAGE_CHARS = 600

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class ErrorEntry:
    at: float
    where: str
    status: int | None = None
    title: str | None = None
    artifact: str | None = None
    detail: str | None = None
    exc_type: str | None = None
    trace: tuple[str, ...] = ()
    # The run that was open when this happened, so a later run's report can leave the message out.
    run_dir: str | None = None


def _frame_file(filename: str) -> str:
    """A traceback file name with every folder of this machine removed."""
    path = Path(filename)
    try:
        return "pesto/" + path.resolve().relative_to(_PACKAGE_ROOT).as_posix()
    except (ValueError, OSError):
        pass
    parts = path.parts
    for marker in ("site-packages", "dist-packages"):
        if marker in parts:
            return "/".join(parts[parts.index(marker) + 1 :])
    return path.name


def short_traceback(exc: BaseException) -> tuple[str, ...]:
    """The innermost frames of ``exc`` as ``file:line in function``."""
    frames = traceback.extract_tb(exc.__traceback__)[-MAX_FRAMES:]
    return tuple(f"{_frame_file(f.filename)}:{f.lineno} in {f.name}" for f in frames)


class ErrorLog:
    """A ring buffer: the newest ``MAX_ERRORS`` entries, oldest dropped first."""

    def __init__(self) -> None:
        self._entries: deque[ErrorEntry] = deque(maxlen=MAX_ERRORS)

    def add(self, entry: ErrorEntry) -> None:
        self._entries.append(entry)

    def entries(self) -> list[ErrorEntry]:
        return list(self._entries)


def error_log(state: Any) -> ErrorLog:
    log = getattr(state, "error_log", None)
    if log is None:
        log = ErrorLog()
        state.error_log = log
    return log


def _clip(text: str | None) -> str | None:
    if text is None or len(text) <= MAX_MESSAGE_CHARS:
        return text
    return text[:MAX_MESSAGE_CHARS] + " (cut short)"


def _open_run(state: Any) -> str | None:
    run_dir = getattr(state, "initial_run_dir", None)
    return None if run_dir is None else str(run_dir)


def record_exception(state: Any, where: str, exc: BaseException, status: int | None = None) -> None:
    error_log(state).add(
        ErrorEntry(
            at=time.time(),
            where=where,
            status=status,
            detail=_clip(str(exc)),
            exc_type=type(exc).__name__,
            trace=short_traceback(exc),
            run_dir=_open_run(state),
        )
    )


def record_failure(state: Any, where: str, artifact: str, reason: str | None) -> None:
    error_log(state).add(
        ErrorEntry(
            at=time.time(),
            where=where,
            artifact=artifact,
            detail=_clip(reason),
            run_dir=_open_run(state),
        )
    )


# Problem responses of status 500 and up built while one request is handled.
_request_problems: contextvars.ContextVar[list[dict[str, Any]] | None] = contextvars.ContextVar(
    "pesto_request_problems", default=None
)


def begin_request() -> contextvars.Token:
    return _request_problems.set([])


def note_problem(status: int, title: str, artifact: str | None, detail: str | None) -> None:
    """Called by ``problem()``; a no-op outside a request."""
    pending = _request_problems.get()
    if pending is not None and status >= 500:
        pending.append({"status": status, "title": title, "artifact": artifact, "detail": detail})


def end_request(state: Any, token: contextvars.Token, where: str) -> None:
    pending = _request_problems.get() or []
    _request_problems.reset(token)
    for item in pending:
        error_log(state).add(
            ErrorEntry(
                at=time.time(),
                where=where,
                status=item["status"],
                title=item["title"],
                artifact=item["artifact"],
                detail=_clip(item["detail"]),
                run_dir=_open_run(state),
            )
        )


def route_name(scope: Any) -> str:
    """The matched route's template, such as ``/api/run/config``, never the
    address as typed: a query string can hold a realization name."""
    route = scope.get("route") if hasattr(scope, "get") else None
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else "a route that was not matched"
