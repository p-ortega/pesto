"""The freshness check, the byte estimate, the start, the stream and the
cancel (Plan 05-07): Phase 4's ``ingest_run`` put behind HTTP.

Every route resolves the active run from ``request.app.state.initial_run_dir``
and the cache from ``request.app.state.cache_root``, refusing with
``problem(409, ...)`` when either is unset -- there is no run open, not a
missing resource. ``discover``, ``plan_artifacts``, the byte-estimate
function and ``ingest_run`` are all imported inside the function bodies
that use them, never at module scope: ``ingest_run`` defers its own heavy
science-stack imports, and this module must not undo that by importing the
runner at import time.

D-12 made concrete: a partial ingest proceeds with what worked, and the
``capabilities`` object in ``/state`` names, for anything not yet usable,
the artifact that blocks it and the manifest's own recorded reason for that
artifact -- never an empty flag (CLAUDE.md's fourth rule).
"""

from __future__ import annotations

import asyncio
import json
import shutil
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse
from starlette.responses import StreamingResponse as _EventStreamResponse

from pesto.api.problem import problem, redact_paths
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest

router = APIRouter(prefix="/api/run/ingest")


@dataclass
class _IngestState:
    """The one ingest this process may run at a time: the cancel signal the
    start route hands to ``ingest_run``, the queue the progress callback
    feeds, every row produced so far in order, and the manifest once the
    background task has one. A start request finds this record already
    present and not done, and refuses a second ingest rather than letting a
    process run two at once. ``error`` is set instead of ``manifest`` when
    ``ingest_run`` itself raises -- either way ``done`` becomes true, so a
    later start is never refused because of a run that failed rather than
    finished."""

    cancel: threading.Event
    queue: "asyncio.Queue[Any]"
    rows: list[Any] = field(default_factory=list)
    done: bool = False
    manifest: Manifest | None = None
    task: "asyncio.Task[None] | None" = None
    error: BaseException | None = None


def _resolve(request: Request):
    """Resolve the active run into every fact a route needs: the run
    directory, its cache layout, the discovered run, its planned artifacts
    and the current manifest -- or a problem response naming why there is
    nothing to resolve.
    """
    from pesto.ingest.discover import discover
    from pesto.ingest.runner import plan_artifacts

    run_dir = getattr(request.app.state, "initial_run_dir", None)
    cache_root = getattr(request.app.state, "cache_root", None)
    if run_dir is None or cache_root is None:
        return problem(409, "no run is open")

    run_path = Path(run_dir)
    if not run_path.is_dir():
        return problem(410, "that run directory is no longer there")

    layout = CacheLayout(root=Path(cache_root))
    run = discover(run_path)
    planned = plan_artifacts(run, layout)
    manifest = Manifest.load(layout)
    return run_path, layout, run, planned, manifest


def _artifact_fact(manifest: Manifest, name: str) -> dict[str, Any]:
    """The one fact a disabled control shows about the artifact it rests
    on: its name and the manifest's own recorded reason, or "not yet
    ingested" for an artifact the manifest holds no record of at all."""
    artifact = manifest.artifacts.get(name)
    if artifact is None:
        return {"artifact": name, "reason": "not yet ingested"}
    return {"artifact": name, "reason": artifact.reason}


def _capability(manifest: Manifest, required: list[str], any_of: list[str]) -> dict[str, Any]:
    """One capability's shape: ``{available, blocked_by}``. ``required``
    must all be recorded successful; when ``any_of`` is given, at least one
    of them must be too. Every unavailable capability's ``blocked_by``
    names the artifact that blocks it and the manifest's own recorded
    reason -- never an empty flag.
    """

    def is_ok(name: str) -> bool:
        artifact = manifest.artifacts.get(name)
        return artifact is not None and artifact.state == "ok"

    required_failing = [name for name in required if not is_ok(name)]
    any_ok = not any_of or any(is_ok(name) for name in any_of)
    any_failing = [] if any_ok else [name for name in any_of if not is_ok(name)]
    available = not required_failing and any_ok

    blocked_by = (
        [] if available else [_artifact_fact(manifest, name) for name in required_failing + any_failing]
    )
    return {"available": available, "blocked_by": blocked_by}


@router.get("/state")
async def get_ingest_state(request: Request) -> JSONResponse:
    resolved = _resolve(request)
    if isinstance(resolved, JSONResponse):
        return resolved
    _run_path, layout, _run, planned, manifest = resolved

    artifacts_out: list[dict[str, Any]] = []
    fresh = True
    for planned_artifact in planned:
        artifact = manifest.artifacts.get(planned_artifact.name)
        stale = manifest.is_stale(planned_artifact.name, layout)
        if stale:
            fresh = False
        artifacts_out.append(
            {
                "name": planned_artifact.name,
                "kind": planned_artifact.kind,
                "state": artifact.state if artifact is not None else "absent",
                "reason": artifact.reason if artifact is not None else None,
                "stale": stale,
                "seconds": artifact.seconds if artifact is not None else None,
                "bytes": sum(f.bytes for f in artifact.files) if artifact is not None else 0,
            }
        )

    grid_names = [pa.name for pa in planned if pa.kind == "grid"]
    par_ens_names = [pa.name for pa in planned if pa.kind == "par_ens"]
    par_agg_names = [pa.name for pa in planned if pa.kind == "par_agg"]
    config_names = [pa.name for pa in planned if pa.kind == "config"]

    body = {
        "fresh": fresh,
        "artifacts": artifacts_out,
        "capabilities": {
            "map": _capability(manifest, required=grid_names, any_of=par_ens_names),
            "stats": _capability(manifest, required=[], any_of=par_agg_names),
            "chips": _capability(manifest, required=config_names, any_of=[]),
        },
        "ingest_seconds": manifest.ingest_seconds,
        "cache_bytes": manifest.cache_bytes,
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.get("/estimate")
async def get_ingest_estimate(request: Request) -> JSONResponse:
    resolved = _resolve(request)
    if isinstance(resolved, JSONResponse):
        return resolved
    _run_path, layout, run, _planned, _manifest = resolved

    from pesto.ingest.runner import estimate_bytes as _size_the_run

    estimate = _size_the_run(run)

    probe = layout.root
    while not probe.exists():
        probe = probe.parent
    free_bytes = shutil.disk_usage(probe).free

    body = {
        "total": estimate.total,
        "per_artifact": [{"name": name, "bytes": n} for name, n in estimate.per_artifact],
        "notes": list(estimate.notes),
        "free_bytes": free_bytes,
        "cache_root_exists": layout.root.exists(),
    }
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


@router.post("")
async def start_ingest(request: Request) -> JSONResponse:
    resolved = _resolve(request)
    if isinstance(resolved, JSONResponse):
        return resolved
    run_path, layout, _run, _planned, _manifest = resolved

    existing: _IngestState | None = getattr(request.app.state, "ingest", None)
    if existing is not None and not existing.done:
        return problem(409, "an ingest is already running for this run")

    try:
        from pesto.api.enscache import invalidate as _invalidate_enscache
    except ImportError:
        _invalidate_enscache = None

    state = _IngestState(cancel=threading.Event(), queue=asyncio.Queue())
    request.app.state.ingest = state
    loop = asyncio.get_running_loop()

    def on_progress(row: Any) -> None:
        state.rows.append(row)
        loop.call_soon_threadsafe(state.queue.put_nowait, row)

    async def run_in_background() -> None:
        from pesto.ingest.runner import ingest_run

        try:
            state.manifest = await asyncio.to_thread(
                ingest_run, run_path, layout.root, None, on_progress, state.cancel
            )
        except Exception as exc:  # noqa: BLE001 - reported to the stream, not swallowed
            state.error = exc
        finally:
            state.done = True
            await state.queue.put(None)
        if state.error is None and _invalidate_enscache is not None:
            _invalidate_enscache(request.app.state, str(layout.root))

    state.task = asyncio.create_task(run_in_background())
    return JSONResponse({"started": True}, status_code=202)


def _progress_frame(row: Any) -> str:
    payload = asdict(row)
    payload["notes"] = list(payload.get("notes", ()))
    return f"data: {json.dumps(payload)}\n\n"


def _done_frame(manifest: Manifest) -> str:
    final = {name: {"state": a.state, "reason": a.reason} for name, a in manifest.artifacts.items()}
    return f"event: done\ndata: {json.dumps(final)}\n\n"


def _error_frame(exc: BaseException) -> str:
    body = {"type": "about:blank", "title": "ingest failed", "status": 500, "detail": redact_paths(str(exc))}
    return f"event: error\ndata: {json.dumps(body)}\n\n"


@router.get("/events")
async def stream_ingest_events(request: Request):
    state: _IngestState | None = getattr(request.app.state, "ingest", None)
    if state is None:
        return problem(409, "no ingest is running")

    async def gen():
        # A snapshot taken once, up front: the queue holds these same rows
        # too (on_progress appends to both), so the loop below discards
        # exactly this many queue items rather than replaying them twice.
        snapshot = list(state.rows)
        to_skip = len(snapshot)
        for row in snapshot:
            yield _progress_frame(row)
        while True:
            if await request.is_disconnected():
                break
            row = await state.queue.get()
            if to_skip > 0:
                to_skip -= 1
                continue
            if row is None:
                break
            yield _progress_frame(row)
        if state.error is not None:
            yield _error_frame(state.error)
        elif state.manifest is not None:
            yield _done_frame(state.manifest)

    return _EventStreamResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.post("/cancel")
async def cancel_ingest(request: Request) -> JSONResponse:
    state: _IngestState | None = getattr(request.app.state, "ingest", None)
    if state is None or state.done:
        return problem(409, "no ingest is running")
    state.cancel.set()
    return JSONResponse({"cancelling": True}, status_code=202)
