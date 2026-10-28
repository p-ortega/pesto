"""Basemap routes: list image files, inspect one, register it for the open
run, and serve its state and bytes (MAPX-04, D-16 to D-23).

The browser only ever holds opaque ids and display names; the id-to-path
map is the directory picker's own ``app.state.fs_ids``. A world-file
placement is always recomputed from the file on the server, never taken
from numbers the browser sends. The user's image, its folder, the run
folder and the run's cache root are only read; the one write goes to the
home store through :mod:`pesto.basemap.store`.

Every handler is a plain ``def`` because each one reads files, so it runs in
the threadpool and the event loop stays free.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict
from starlette.responses import FileResponse, JSONResponse, Response

from pesto.api.fs import _issue_id, _resolves_inside
from pesto.api.problem import problem, problem_from_failure, redact_paths
from pesto.api.query import RunQuery
from pesto.basemap import imageinfo, store, worldfile
from pesto.basemap.imageinfo import TEXTURE_CAP, TIFF_REASON, ImageRefusal
from pesto.basemap.worldfile import WorldFileRefusal
from pesto.cache.layout import CacheLayout
from pesto.ingest.discover import _MACOS_RESOURCE_FORK_PREFIX
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import load_mesh_extent

router = APIRouter(prefix="/api/run/basemap")
fs_router = APIRouter(prefix="/api/fs")

NO_WORLD_FILE_REASON = "no world file was found next to the image"
NO_OVERLAP_REASON = "the image does not overlap the model; reprojection is not supported yet"
LINK_REASON = "this entry's target resolves outside the folder being listed"

_MEDIA_TYPES = {"png": "image/png", "jpeg": "image/jpeg"}
_SERVE_MIN, _SERVE_MAX = 512, 16384


def _refuse(status: int, code: str, title: str, *, detail: str | None = None) -> JSONResponse:
    return problem(status, title, detail=detail, extra={"code": code})


def _no_run() -> JSONResponse:
    return _refuse(409, "no_run", "no run is open")


def _open(request: Request) -> tuple[CacheLayout, Path] | None:
    cache_root = getattr(request.app.state, "cache_root", None)
    run_dir = getattr(request.app.state, "initial_run_dir", None)
    if cache_root is None or run_dir is None:
        return None
    return CacheLayout(root=Path(cache_root)), Path(run_dir)


def _digest(*parts: object) -> str:
    return hashlib.sha256("\0".join(str(p) for p in parts).encode()).hexdigest()[:16]


@router.get("/start")
def basemap_start(request: Request) -> Response:
    opened = _open(request)
    if opened is None:
        return _no_run()
    _layout, run_dir = opened
    fs_ids: dict[str, Path] = request.app.state.fs_ids
    return JSONResponse({"id": _issue_id(fs_ids, run_dir), "name": run_dir.resolve().name})


def _image_row(fs_ids: dict[str, Path], entry: os.DirEntry, kind: str) -> dict[str, object]:
    return {
        "id": _issue_id(fs_ids, Path(entry.path)),
        "name": entry.name,
        "kind": kind,
        "note": imageinfo.extension_note(entry.name, kind),
        "reason": TIFF_REASON if kind == "tiff" else None,
    }


@fs_router.get("/images")
def list_images(request: Request, directory_id: str = Query(..., alias="id")) -> Response:
    fs_ids: dict[str, Path] = request.app.state.fs_ids
    parent = fs_ids.get(directory_id)
    if parent is None:
        return problem(404, "that folder is no longer available")

    try:
        with os.scandir(parent) as it:
            entries = [e for e in it if not e.name.startswith(_MACOS_RESOURCE_FORK_PREFIX)]
    except OSError as exc:
        return problem(403, "that folder cannot be read", detail=str(exc))
    entries.sort(key=lambda e: e.name.lower())

    folders: list[dict[str, object]] = []
    files: list[dict[str, object]] = []
    skipped = {"other_files": 0, "not_checked": 0, "unreadable": 0}
    for entry in entries:
        try:
            inside = _resolves_inside(parent, Path(entry.path))
            is_dir = entry.is_dir()
            is_file = entry.is_file()
        except (OSError, RuntimeError):
            skipped["unreadable"] += 1
            continue
        if not inside:
            # Never stored in fs_ids, so this id always misses, like a forged one.
            folders.append(
                {"id": secrets.token_urlsafe(16), "name": entry.name, "kind": "link", "note": None, "reason": LINK_REASON}
            )
            continue
        if is_dir:
            folders.append(
                {"id": _issue_id(fs_ids, Path(entry.path)), "name": entry.name, "kind": "folder", "note": None, "reason": None}
            )
            continue
        if not is_file:
            skipped["other_files"] += 1
            continue
        try:
            kind = imageinfo.sniff(imageinfo.read_head(Path(entry.path)))
        except OSError:
            skipped["unreadable"] += 1
            continue
        if kind == "other":
            skipped["other_files"] += 1
            continue
        files.append(_image_row(fs_ids, entry, kind))

    return JSONResponse({"entries": folders + files, "skipped": skipped})


class _InspectBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str


class _RegisterBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    stamp: str
    by: Literal["world_file"]


@dataclass(frozen=True)
class _Inspection:
    path: Path
    size: int
    mtime_ns: int
    kind: str
    width: int
    height: int
    notes: tuple[str, ...]
    model_extent: tuple[float, float, float, float]
    placement: dict
    world_file_size: int | None
    world_file_mtime_ns: int | None
    stamp: str

    def body(self, file_id: str) -> dict[str, object]:
        return {
            "file_id": file_id,
            "name": self.path.name,
            "format": self.kind,
            "width": self.width,
            "height": self.height,
            "stamp": self.stamp,
            "notes": list(self.notes),
            "model_extent": list(self.model_extent),
            "placement": self.placement,
        }


def _numbers(reason: str, world_files: list[str]) -> dict[str, object]:
    return {"by": "numbers", "reason": redact_paths(reason), "world_files": world_files}


def _overlaps(a: tuple[float, ...], b: tuple[float, ...]) -> bool:
    return max(a[0], b[0]) < min(a[1], b[1]) and max(a[2], b[2]) < min(a[3], b[3])


def _place(
    path: Path, kind: str, width: int, height: int, model_extent
) -> tuple[dict, os.stat_result | None] | JSONResponse:
    """The placement a world file gives, or the four-number form with the
    reason. A rotated or mirrored world file refuses the image outright: it
    says the image is not north-up, so typed numbers would ignore it."""
    try:
        names = worldfile.find_world_files(path, kind)
    except WorldFileRefusal as refusal:
        return _numbers(refusal.reason, []), None
    if not names:
        return _numbers(NO_WORLD_FILE_REASON, []), None
    if len(names) > 1:
        listed = ", ".join(names)
        return _numbers(
            f"{len(names)} world files were found next to the image ({listed}); pesto does not pick one",
            names,
        ), None

    name = names[0]
    wf_path = path.parent / name
    try:
        wf_stat = wf_path.stat()
        wf = worldfile.parse_world_file(wf_path)
        extent = worldfile.corners(wf, width, height)
    except OSError as exc:
        return _numbers(f"the world file {name} could not be read: {exc.strerror}", [name]), None
    except WorldFileRefusal as refusal:
        if refusal.code in ("rotated", "mirrored"):
            return _refuse(422, refusal.code, refusal.reason, detail=f"the world file is {name}")
        return _numbers(refusal.reason, [name]), None
    if not _overlaps(extent, model_extent):
        return _numbers(NO_OVERLAP_REASON, [name]), None
    return {"by": "world_file", "world_file": name, "extent": list(extent)}, wf_stat


def _inspect(request: Request, file_id: str) -> _Inspection | JSONResponse:
    opened = _open(request)
    if opened is None:
        return _no_run()
    layout, _run_dir = opened
    fs_ids: dict[str, Path] = request.app.state.fs_ids
    path = fs_ids.get(file_id)
    if path is None:
        return _refuse(404, "gone", "that file is no longer available")

    try:
        st = path.stat()
    except FileNotFoundError:
        return _refuse(404, "gone", "that file is no longer available")
    except OSError as exc:
        return _refuse(403, "unreadable", "that file cannot be read", detail=str(exc))
    if not stat.S_ISREG(st.st_mode):
        return _refuse(409, "not_file", "that is a folder, not an image file")

    try:
        head = imageinfo.read_head(path)
        kind = imageinfo.sniff(head)
        if kind == "tiff":
            return _refuse(422, "tiff", TIFF_REASON)
        if kind not in _MEDIA_TYPES:
            return _refuse(422, "format", imageinfo.format_refusal(head))
        width, height = imageinfo.image_size(path, kind)
        imageinfo.check_budget(width, height)
    except ImageRefusal as refusal:
        return _refuse(422, refusal.code, refusal.reason)
    except OSError as exc:
        return _refuse(403, "unreadable", "that file cannot be read", detail=str(exc))

    notes = [n for n in (imageinfo.extension_note(path.name, kind),) if n]

    model_extent = load_mesh_extent(layout)
    if isinstance(model_extent, ReadFailure):
        return problem_from_failure(502, model_extent)

    placed = _place(path, kind, width, height, model_extent)
    if isinstance(placed, JSONResponse):
        return placed
    placement, wf_stat = placed
    wf_size = wf_stat.st_size if wf_stat is not None else None
    wf_mtime = wf_stat.st_mtime_ns if wf_stat is not None else None
    stamp = _digest(path, st.st_size, st.st_mtime_ns, placement.get("world_file"), wf_size, wf_mtime)
    return _Inspection(
        path=path,
        size=st.st_size,
        mtime_ns=st.st_mtime_ns,
        kind=kind,
        width=width,
        height=height,
        notes=tuple(notes),
        model_extent=tuple(model_extent),
        placement=placement,
        world_file_size=wf_size,
        world_file_mtime_ns=wf_mtime,
        stamp=stamp,
    )


@router.post("/inspect")
def inspect_image(request: Request, body: _InspectBody) -> Response:
    found = _inspect(request, body.id)
    if isinstance(found, JSONResponse):
        return found
    return JSONResponse(found.body(body.id))


def _state(record: dict) -> dict[str, object]:
    return {
        "status": "ready",
        "name": Path(record["source"]).name,
        "format": record["format"],
        "width": record["width"],
        "height": record["height"],
        "extent": record["extent"],
        "placed_by": record["placed_by"],
        "world_file": record["world_file"],
        "notes": record["notes"],
        "tag": record["tag"],
    }


@router.post("")
def register_basemap(request: Request, body: _RegisterBody) -> Response:
    found = _inspect(request, body.id)
    if isinstance(found, JSONResponse):
        return found
    if found.stamp != body.stamp:
        return _refuse(409, "changed", "the image or its world file changed since it was inspected; inspect it again")
    if found.placement["by"] != "world_file":
        return _refuse(409, "no_world_file", "this image has no world file pesto can use", detail=found.placement["reason"])

    layout, run_dir = _open(request)
    if store.store_inside(run_dir, layout.root):
        return _refuse(
            409,
            "store_inside_run",
            "the basemap store would sit inside the run folder or its cache, so the basemap cannot be saved",
        )
    record = {
        "version": store.STORE_VERSION,
        "source": str(found.path),
        "size": found.size,
        "mtime_ns": found.mtime_ns,
        "format": found.kind,
        "width": found.width,
        "height": found.height,
        "extent": found.placement["extent"],
        "placed_by": "world_file",
        "world_file": found.placement["world_file"],
        "world_file_size": found.world_file_size,
        "world_file_mtime_ns": found.world_file_mtime_ns,
        "notes": list(found.notes),
    }
    record["tag"] = _digest(json.dumps(record, sort_keys=True))
    try:
        store.write_registration(run_dir, record)
    except OSError as exc:
        return _refuse(500, "store", "the basemap could not be saved", detail=str(exc))
    return JSONResponse(_state(record))


def _unreadable_record(failure: store.StoreFailure) -> str:
    return f"the saved basemap record could not be read: {failure.reason}"


@router.get("")
def basemap_state(request: Request) -> Response:
    opened = _open(request)
    if opened is None:
        return _no_run()
    _layout, run_dir = opened
    record = store.read_registration(run_dir)
    if record is None:
        return JSONResponse({"status": "none"})
    if isinstance(record, store.StoreFailure):
        return JSONResponse(
            {
                "status": "unavailable",
                "reason": _unreadable_record(record),
                "name": None,
                "placed_by": None,
                "extent": None,
            }
        )
    return JSONResponse(_state(record))


class _ImageQuery(RunQuery):
    max: int = 4096


def _resize_to(width: int, height: int, requested: int) -> tuple[int, int] | None:
    limit = min(max(requested, _SERVE_MIN), _SERVE_MAX, TEXTURE_CAP)
    longest = max(width, height)
    if longest <= limit:
        return None
    scale = limit / longest
    return max(1, round(width * scale)), max(1, round(height * scale))


@router.get("/image")
def basemap_image(request: Request, params: Annotated[_ImageQuery, Query()]) -> Response:
    opened = _open(request)
    if opened is None:
        return _no_run()
    _layout, run_dir = opened
    record = store.read_registration(run_dir)
    if record is None:
        return _refuse(404, "none", "no basemap is registered for this run")
    if isinstance(record, store.StoreFailure):
        return _refuse(409, "unavailable", _unreadable_record(record))

    source = Path(record["source"])
    try:
        kind = imageinfo.sniff(imageinfo.read_head(source))
    except FileNotFoundError:
        return _refuse(404, "missing", "the basemap image is no longer there")
    except OSError as exc:
        return _refuse(403, "unreadable", "the basemap image cannot be read", detail=str(exc))
    if kind != record["format"]:
        return _refuse(409, "changed", "the basemap image is no longer the file that was registered")

    width, height = int(record["width"]), int(record["height"])
    notes = list(record["notes"])
    resize_to = _resize_to(width, height, params.max)
    if resize_to is not None:
        notes.append(
            f"the image is {width} × {height} pixels, more than the graphics card can hold; "
            f"it is drawn at {resize_to[0]} × {resize_to[1]}"
        )
    meta = {
        "format": kind,
        "width": width,
        "height": height,
        "served_width": width,
        "served_height": height,
        "resize_to": list(resize_to) if resize_to is not None else None,
        "notes": notes,
        "tag": record["tag"],
    }
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "X-Pesto-Meta": json.dumps(meta, separators=(",", ":")),
    }
    return FileResponse(source, media_type=_MEDIA_TYPES[kind], headers=headers)
