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
from pesto.cache.layout import CACHE_VERSION, CacheLayout, probe_writable, run_id_for
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


def _display_folder(path: Path) -> str:
    """``path`` for the screen: the home directory shortened to ``~`` when the
    path sits under it. Anywhere else (an external disk, ``--cache-dir`` on
    another volume) only the last two parts are shown after ``…/``, and at
    least one leading part is always hidden, so a full path never reaches a
    response body (D-09)."""
    path = Path(path)
    try:
        home = Path.home()
    except RuntimeError:
        home = None
    if home is not None:
        for candidate, base in ((path, home), (path.resolve(), home.resolve())):
            try:
                relative = candidate.relative_to(base)
            except ValueError:
                continue
            return "~" if relative == Path(".") else f"~/{relative.as_posix()}"
    parts = path.parts[1:] if path.anchor else path.parts
    shown = parts[-2:] if len(parts) > 2 else parts[-1:]
    return "\u2026/" + "/".join(shown)


def _free_bytes(layout: CacheLayout) -> int:
    """Free space on the disk the cache lives on, measured at the nearest
    existing parent when the cache folder itself is not there yet."""
    probe = layout.root
    while not probe.exists():
        probe = probe.parent
    return shutil.disk_usage(probe).free


def _rewrite_facts(layout: CacheLayout, manifest: Manifest) -> dict[str, Any] | None:
    """Why an old cache is being re-read, or None when there was no old cache
    (no manifest, or one whose version could not be read, is a first ingest)."""
    if manifest.found_cache_version is None:
        return None
    return {
        "found": manifest.found_cache_version,
        "expected": CACHE_VERSION,
        "writable": probe_writable(layout.root),
        "folder": _display_folder(layout.root),
        "free_bytes": _free_bytes(layout),
        "old_cache_bytes": manifest.found_cache_bytes,
    }


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


def _obs_capability(
    manifest: Manifest,
    run,
    *,
    obs_index_names: list[str],
    obs_ens_names: list[str],
    missing_artifact: str = "obs_ens",
) -> dict[str, Any]:
    """Whether observations are usable. With no observation ensemble planned
    there is nothing to wait for, so the one reason says why: no file in the
    run at all, or none at the iterations the parameters use. The same
    reason serves ``obs_stats``, whose artifact is ``obs_agg``."""
    if obs_ens_names:
        return _capability(manifest, required=obs_index_names, any_of=obs_ens_names)
    from pesto.ingest.runner import observation_iterations

    _selected, notes = observation_iterations(run)
    if run.obs_ens and notes:
        reason = notes[0]
    else:
        reason = "no observation ensemble file was found for this run"
    return {"available": False, "blocked_by": [{"artifact": missing_artifact, "reason": reason}]}


NO_NOISE_REASON = (
    "no case.obs+noise file was found for this run; pesto never uses a starting "
    "observation ensemble as the noise band"
)


def _noise_capability(manifest: Manifest, noise_names: list[str]) -> dict[str, Any]:
    """Whether the noise band exists. Only an obs+noise file makes one, so
    with none planned the reason says that and what pesto will not do."""
    if noise_names:
        return _capability(manifest, required=noise_names, any_of=[])
    return {
        "available": False,
        "blocked_by": [{"artifact": "noise_agg", "reason": NO_NOISE_REASON}],
    }


@router.get("/state")
async def get_ingest_state(request: Request) -> JSONResponse:
    resolved = _resolve(request)
    if isinstance(resolved, JSONResponse):
        return resolved
    run_path, layout, run, planned, manifest = resolved

    artifacts_out: list[dict[str, Any]] = []
    fresh = True
    for planned_artifact in planned:
        artifact = manifest.artifacts.get(planned_artifact.name)
        stale = manifest.is_stale(planned_artifact.name, layout, planned_artifact.sources)
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
    # Since 07-07 par_cell is the only source of cells and positions; without
    # it par_ens is recorded ok with an empty map block.
    par_cell_names = [pa.name for pa in planned if pa.kind == "par_cell"]
    par_ens_names = [pa.name for pa in planned if pa.kind == "par_ens"]
    par_agg_names = [pa.name for pa in planned if pa.kind == "par_agg"]
    config_names = [pa.name for pa in planned if pa.kind == "config"]
    obs_index_names = [pa.name for pa in planned if pa.kind == "obs_index"]
    obs_ens_names = [pa.name for pa in planned if pa.kind == "obs_ens"]
    obs_agg_names = [pa.name for pa in planned if pa.kind == "obs_agg"]
    noise_names = [pa.name for pa in planned if pa.kind == "noise_agg"]

    body = {
        "fresh": fresh,
        "artifacts": artifacts_out,
        "capabilities": {
            "map": _capability(manifest, required=grid_names + par_cell_names, any_of=par_ens_names),
            "stats": _capability(manifest, required=[], any_of=par_agg_names),
            "chips": _capability(manifest, required=config_names, any_of=[]),
            "obs": _obs_capability(
                manifest, run, obs_index_names=obs_index_names, obs_ens_names=obs_ens_names
            ),
            "obs_stats": _obs_capability(
                manifest,
                run,
                obs_index_names=[],
                obs_ens_names=obs_agg_names,
                missing_artifact="obs_agg",
            ),
            "noise": _noise_capability(manifest, noise_names),
        },
        "ingest_seconds": manifest.ingest_seconds,
        "cache_bytes": manifest.cache_bytes,
        "rewrite": _rewrite_facts(layout, manifest),
        "run_id": run_id_for(run_path),
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

    free_bytes = _free_bytes(layout)

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
    run_path, layout, _run, _planned, manifest = resolved

    # A newer pesto's cache may be hours of ingest; D-05 and D-06 only agreed
    # to replace older ones, so this one is left as it is.
    found = manifest.found_cache_version
    if found is not None and found > CACHE_VERSION:
        return problem(
            409,
            "the cache was made by a newer pesto",
            detail=(
                f"the cache was made at cache version {found} and this pesto writes version "
                f"{CACHE_VERSION}; rewriting it would throw away the newer one. Open the run "
                "with that newer pesto, or open it again with --cache-dir set to another folder"
            ),
            extra={"folder": _display_folder(layout.root)},
        )

    # D-07: an old cache that cannot be replaced is refused, never read as if
    # it were current and never left half rewritten. The folder goes in its own
    # field because redacting the detail would cut "~/a/b" down to "~b".
    if manifest.found_cache_version is not None and not probe_writable(layout.root):
        return problem(
            409,
            "the cache is out of date and cannot be rewritten here",
            detail=(
                f"the cache was made at cache version {manifest.found_cache_version} and "
                "pesto cannot write to its folder; "
                "open the run again with --cache-dir set to a folder that can be written"
            ),
            extra={"folder": _display_folder(layout.root)},
        )

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
            # A failed or cancelled ingest may already have rewritten files,
            # so the memo goes either way, and before the stream ends.
            if _invalidate_enscache is not None:
                _invalidate_enscache(request.app.state, str(layout.root))
            state.done = True
            await state.queue.put(None)

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
