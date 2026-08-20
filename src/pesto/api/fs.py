"""The directory picker (Plan 05-03): opaque ids only, never a real path.

Per D-09, a listing hands out a display name and an id for each entry, and
a response body never carries a path. The id-to-path map lives on
``app.state.fs_ids``, one dict per process; an id this process did not
issue -- forged, or issued by an earlier process before a restart -- is
refused by name rather than resolved against a guessed path. A restart
empties the map, so every id issued before it is simply absent afterward:
that is the same refusal path already used for a forged id, so there is no
separate expiry code to get wrong.

Per D-10, the run marker (:func:`is_run_directory`) is a filename check
only -- one ``os.scandir`` pass, never a byte of any file's contents read,
and it never calls :func:`pesto.ingest.discover.discover`, which also
line-scans the control file. A large parent directory stays cheap to list.

No path in this module is ever put into ``app.state.fs_ids`` before being
resolved and checked for containment against its parent, the same shape
:func:`pesto.ingest.discover._resolve_starting_ensemble` uses -- a symlink
pointing outside the directory being listed is reported with a reason and
is never descended into.
"""

from __future__ import annotations

import os
import re
import secrets
import string
import sys
from pathlib import Path

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from starlette.responses import JSONResponse

from pesto.api.prefs import read_last_run, write_last_run
from pesto.api.problem import problem, redact_paths
from pesto.cache.layout import for_run
from pesto.ingest.discover import _ENS_EXTS, _ITER_TOKEN, _MACOS_RESOURCE_FORK_PREFIX

router = APIRouter(prefix="/api/fs")

# Built from the same token pieces discover.py's own ensemble regex uses, so
# the two cannot drift into disagreeing about what a parameter-ensemble file
# is named -- the case stem is a capture group here rather than embedded,
# since this check runs before any case is known.
_PAR_ENSEMBLE_RE = re.compile(
    rf"^(?P<case>.+)\.(?:{_ITER_TOKEN})\.(?:rejected\.)?par\.(?:{_ENS_EXTS})$",
    re.IGNORECASE,
)


def _scan_for_run(path: Path) -> tuple[bool, str | None, str | None]:
    """One filename-only pass over ``path``: is it a PEST++ run, and under
    what case name. Returns ``(is_run, case, reason)`` -- ``reason`` is only
    ever an inspection failure, never "this is not a run" prose, since an
    ordinary folder is not an error.

    Short-circuits on the first missing ingredient: no ``*.pst`` name means
    the ensemble pattern is never even evaluated, which is D-10's whole
    point -- one ``readdir`` per candidate, nothing opened.
    """
    try:
        with os.scandir(path) as it:
            names = [
                entry.name for entry in it if not entry.name.startswith(_MACOS_RESOURCE_FORK_PREFIX)
            ]
    except OSError as exc:
        return False, None, redact_paths(str(exc))

    pst_stems = {Path(name).stem for name in names if name.lower().endswith(".pst")}
    if not pst_stems:
        return False, None, None

    lowered_stems = {stem.lower() for stem in pst_stems}
    for name in names:
        match = _PAR_ENSEMBLE_RE.match(name)
        if match is None:
            continue
        candidate_case = match.group("case")
        if candidate_case.lower() not in lowered_stems:
            continue
        matched_stem = next(stem for stem in pst_stems if stem.lower() == candidate_case.lower())
        return True, matched_stem, None

    return False, None, None


def is_run_directory(path: Path) -> tuple[bool, str | None]:
    """Whether ``path`` looks like a PEST++ run, by filename alone.

    Requires a control file (``*.pst``) and a parameter-ensemble file whose
    case stem matches one found in the same pass -- an unrelated ensemble
    file sitting next to an unrelated control file does not count. Opens
    nothing; a scan that cannot even be attempted (a child with no read
    permission) comes back ``(False, <reason>)`` rather than being silently
    treated as an ordinary, non-run folder.
    """
    is_run, _case, reason = _scan_for_run(path)
    return is_run, reason


def _resolves_inside(parent: Path, child: Path) -> bool:
    """Whether ``child``, once resolved, is genuinely inside resolved
    ``parent`` -- the same containment shape
    ``discover.py::_resolve_starting_ensemble`` uses, so a symlink pointing
    elsewhere is caught rather than followed.
    """
    resolved_parent = parent.resolve()
    resolved_child = child.resolve()
    return resolved_parent in (resolved_child, *resolved_child.parents)


def _issue_id(fs_ids: dict[str, Path], path: Path) -> str:
    """Return the id already issued for ``path``, or mint and record a
    fresh one. The path is resolved before it ever enters the map.

    A fresh id is ``secrets.token_urlsafe(16)`` -- the same CSPRNG
    primitive ``mint_token()`` already uses, never a non-cryptographic
    generator. Scanning the small map on every call is what makes listing
    the same directory twice re-issue the same ids instead of growing the
    map on every refresh.
    """
    resolved = path.resolve()
    for existing_id, existing_path in fs_ids.items():
        if existing_path == resolved:
            return existing_id
    new_id = secrets.token_urlsafe(16)
    fs_ids[new_id] = resolved
    return new_id


def _entry(fs_ids: dict[str, Path], path: Path, name: str) -> dict[str, object]:
    is_run, reason = is_run_directory(path)
    return {"id": _issue_id(fs_ids, path), "name": name, "is_run": is_run, "reason": reason}


@router.get("/roots")
async def list_roots(request: Request) -> JSONResponse:
    fs_ids: dict[str, Path] = request.app.state.fs_ids
    roots: list[dict[str, object]] = []

    last_run = read_last_run()
    if last_run is not None:
        roots.append(_entry(fs_ids, last_run, last_run.name))

    roots.append(_entry(fs_ids, Path.home(), "Home"))

    if sys.platform.startswith("win"):
        for letter in string.ascii_uppercase:
            drive = Path(f"{letter}:/")
            if drive.exists():
                roots.append(_entry(fs_ids, drive, f"{letter}:\\"))
    else:
        roots.append(_entry(fs_ids, Path("/"), "/"))

    return JSONResponse(roots)


@router.get("/list")
async def list_directory(
    request: Request, directory_id: str = Query(..., alias="id")
) -> JSONResponse:
    fs_ids: dict[str, Path] = request.app.state.fs_ids
    parent = fs_ids.get(directory_id)
    if parent is None:
        return problem(404, "that folder is no longer available")

    try:
        with os.scandir(parent) as it:
            candidates = [
                entry
                for entry in it
                if not entry.name.startswith(_MACOS_RESOURCE_FORK_PREFIX) and entry.is_dir()
            ]
    except OSError as exc:
        return problem(403, "that folder cannot be read", detail=str(exc))

    candidates.sort(key=lambda entry: entry.name.lower())

    listing: list[dict[str, object]] = []
    for entry in candidates:
        child_path = Path(entry.path)
        if not _resolves_inside(parent, child_path):
            # Not stored in fs_ids at all -- a random id that will always
            # miss, refusing this entry by the same lookup-miss path a
            # forged id takes, rather than a special-cased second refusal.
            listing.append(
                {
                    "id": secrets.token_urlsafe(16),
                    "name": entry.name,
                    "is_run": False,
                    "reason": "this entry's target resolves outside the directory being listed",
                }
            )
            continue
        listing.append(_entry(fs_ids, child_path, entry.name))

    return JSONResponse(listing)


class _OpenBody(BaseModel):
    id: str


@router.post("/open")
async def open_directory(request: Request, body: _OpenBody) -> JSONResponse:
    fs_ids: dict[str, Path] = request.app.state.fs_ids
    path = fs_ids.get(body.id)
    if path is None:
        return problem(404, "that folder is no longer available")

    try:
        layout = for_run(path)
    except NotADirectoryError:
        return problem(409, "that folder is not a directory pesto can open")
    except PermissionError as exc:
        return problem(403, "that folder cannot be opened", detail=str(exc))

    layout.ensure()
    request.app.state.initial_run_dir = str(path.resolve())
    request.app.state.cache_root = str(layout.root)
    write_last_run(path)

    is_run, case, _reason = _scan_for_run(path)
    return JSONResponse({"is_run": is_run, "case": case})
