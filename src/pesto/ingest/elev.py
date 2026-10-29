"""The layer elevations and float64 cell rings as a cache artifact.

The section view walks a line across the cells and reads their layers, so it
needs two things the render mesh does not carry: each cell's own ring at full
precision, and the top and bottoms of every layer. Both are written under the
cache root only, next to the mesh, and the section route reads nothing else.

Rings are float64 and relative to the origin stored in ``mesh.json``, in the
same cell order the plan mesh uses. The render mesh is float32, which moves an
edge by up to half a metre at real northings; the walk must not inherit that.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import load_mesh_origin

# Geometry and SpatialAdapter live in pesto.model, which nothing under
# pesto.ingest may import, even for typing; the annotations stay strings.

ELEV_PREDATES = "this cache predates the section view; it is added on the next ingest"

_NAME = "elev"
_NO_ELEVATIONS = "the grid file records no layer elevations"


@dataclass(frozen=True)
class ElevArrays:
    """``elev`` is ``(nlay + 1, ncpl)`` float32, row 0 the top and row ``k + 1``
    the bottom of layer ``k``. ``ring`` is ``(n_ring, 2)`` float64 relative to
    ``origin``; cell ``c`` owns ``ring[ring_start[c]:ring_start[c + 1]]``."""

    grid_type: str | None
    nlay: int
    ncpl: int
    origin: tuple[float, float]
    elev: np.ndarray
    ring: np.ndarray
    ring_start: np.ndarray
    length_units: str | None = None
    counts: dict[str, int] = field(default_factory=dict)
    notes: tuple[str, ...] = ()


def _elev_counts(stacked: np.ndarray) -> dict[str, int]:
    # The bottom of layer k is compared with the top of layer k, the row above it.
    upper = stacked[:-1]
    lower = stacked[1:]
    return {
        "bottom_above_top": int((lower > upper).sum()),
        "zero_thickness": int((lower == upper).sum()),
        "non_finite": int((~np.isfinite(stacked)).sum()),
    }


def write_elev(
    *,
    ring: np.ndarray,
    ring_start: np.ndarray,
    top: np.ndarray,
    botm: np.ndarray,
    grid_type: str | None,
    origin: tuple[float, float],
    layout: CacheLayout,
) -> WrittenArtifact | ReadFailure:
    """Write ``grid/elev.f32``, ``grid/ring.f64`` and ``grid/ring_start.u32``,
    then ``grid/elev.json`` last, so a reader never finds a sidecar naming a
    file that is not there yet. Byte order is forced on every binary."""
    try:
        top64 = np.asarray(top, dtype=np.float64).reshape(-1)
        botm64 = np.asarray(botm, dtype=np.float64)
        if botm64.ndim != 2 or botm64.shape[1] != top64.shape[0]:
            raise ValueError(
                f"the bottoms are shaped {botm64.shape}, not (nlay, ncpl) with ncpl = {top64.shape[0]}"
            )
        nlay, ncpl = int(botm64.shape[0]), int(top64.shape[0])
        ring64 = np.ascontiguousarray(ring, dtype="<f8")
        if ring64.ndim != 2 or ring64.shape[1] != 2:
            raise ValueError(f"the rings are shaped {ring64.shape}, not (n, 2)")
        starts = np.asarray(ring_start, dtype=np.int64).reshape(-1)
        if starts.shape[0] != ncpl + 1 or starts[0] != 0 or starts[-1] != ring64.shape[0]:
            raise ValueError(
                f"the ring starts do not cover {ring64.shape[0]} vertices over {ncpl} cells"
            )
        if np.any(np.diff(starts) <= 0):
            raise ValueError("a cell's ring is empty or out of order")

        stacked = np.vstack([top64[None, :], botm64])
        counts = _elev_counts(stacked)
        elev32 = np.ascontiguousarray(stacked, dtype="<f4")
        starts32 = np.ascontiguousarray(starts, dtype="<u4")

        elev_path = layout.grid / "elev.f32"
        ring_path = layout.grid / "ring.f64"
        start_path = layout.grid / "ring_start.u32"
        json_path = layout.grid / "elev.json"

        elev_bytes = write_atomic_bytes(elev_path, lambda f: f.write(elev32.tobytes()))
        ring_bytes = write_atomic_bytes(ring_path, lambda f: f.write(ring64.tobytes()))
        start_bytes = write_atomic_bytes(start_path, lambda f: f.write(starts32.tobytes()))

        notes: list[str] = []
        payload = {
            "cache_version": CACHE_VERSION,
            "grid_type": grid_type,
            "nlay": nlay,
            "ncpl": ncpl,
            "n_ring_vertices": int(ring64.shape[0]),
            "origin": [float(origin[0]), float(origin[1])],
            "length_units": None,
            "files": {
                "elev": {"name": elev_path.name, "dtype": "<f4", "count": int(elev32.size)},
                "ring": {"name": ring_path.name, "dtype": "<f8", "count": int(ring64.size)},
                "ring_start": {
                    "name": start_path.name,
                    "dtype": "<u4",
                    "count": int(starts32.size),
                },
            },
            "counts": counts,
            "notes": notes,
        }
        json_bytes = write_atomic_text(json_path, json.dumps(payload, indent=2))

        root = layout.root
        files = (
            CacheFile(path=str(elev_path.relative_to(root)), bytes=elev_bytes),
            CacheFile(path=str(ring_path.relative_to(root)), bytes=ring_bytes),
            CacheFile(path=str(start_path.relative_to(root)), bytes=start_bytes),
            CacheFile(path=str(json_path.relative_to(root)), bytes=json_bytes),
        )
        return WrittenArtifact(name=_NAME, files=files, notes=tuple(notes))
    except Exception as exc:
        return ReadFailure(
            name=_NAME,
            path=str(layout.grid),
            reason=f"failed to write the layer elevations to {layout.grid}: {exc}",
        )


def _ring_starts(cell_index: np.ndarray, ncpl: int) -> "np.ndarray | str":
    """Where each cell's ring begins, or a reason when the vertices are not
    grouped as cells 0..ncpl-1 in order."""
    raw = np.asarray(cell_index).reshape(-1)
    as_int = raw.astype(np.int64)
    if raw.size == 0 or not np.array_equal(as_int, raw):
        return "the mesh's cell numbers are missing or not whole numbers"
    first = np.concatenate([[0], np.nonzero(np.diff(as_int))[0] + 1])
    if not np.array_equal(as_int[first], np.arange(ncpl)):
        return (
            f"the mesh's vertices are not grouped as cells 0 to {ncpl - 1} in order, "
            f"so a ring could not be matched to its cell"
        )
    return np.concatenate([first, [raw.size]]).astype(np.int64)


def write_elev_from_adapter(
    adapter: "SpatialAdapter | None", layout: CacheLayout
) -> WrittenArtifact | ReadFailure | None:
    """Read the rings and elevations from ``adapter`` and write them.

    ``None`` when the run has no grid file, the same designed absence the grid
    artifact reports. The origin is the one the grid artifact already stored,
    so the rings and the plan mesh share one frame; it is never recomputed.
    """
    if adapter is None:
        return None
    geometry = adapter.geometry()
    if isinstance(geometry, ReadFailure):
        return geometry

    origin = load_mesh_origin(layout)
    if isinstance(origin, ReadFailure):
        return ReadFailure(
            name=_NAME,
            path=origin.path,
            reason=f"the grid artifact's origin could not be read: {origin.reason}",
        )
    if geometry.top is None or geometry.botm is None:
        return ReadFailure(name=_NAME, path=str(layout.grid), reason=_NO_ELEVATIONS)

    ncpl = int(np.asarray(geometry.top).reshape(-1).shape[0])
    starts = _ring_starts(geometry.cell_index, ncpl)
    if isinstance(starts, str):
        return ReadFailure(name=_NAME, path=str(layout.grid), reason=starts)

    positions = np.asarray(geometry.positions, dtype=np.float64)
    ring = positions - np.array(origin, dtype=np.float64)
    return write_elev(
        ring=ring,
        ring_start=starts,
        top=geometry.top,
        botm=geometry.botm,
        grid_type=getattr(geometry, "grid_type", None),
        origin=origin,
        layout=layout,
    )


def _read_binary(layout: CacheLayout, entry: object, label: str) -> "np.ndarray | ReadFailure":
    try:
        filename = str(entry["name"])  # type: ignore[index]
        dtype = str(entry["dtype"])  # type: ignore[index]
        count = int(entry["count"])  # type: ignore[index]
    except (KeyError, TypeError, ValueError) as exc:
        return ReadFailure(
            name=_NAME,
            path=str(layout.grid / "elev.json"),
            reason=f"elev.json has an unexpected {label} entry: {exc}",
        )
    path = layout.grid / filename
    try:
        array = np.fromfile(path, dtype=dtype)
    except OSError as exc:
        return ReadFailure(name=_NAME, path=str(path), reason=f"failed to read {path.name}: {exc}")
    if array.shape[0] != count:
        return ReadFailure(
            name=_NAME,
            path=str(path),
            reason=f"{path.name} has {array.shape[0]} elements, expected {count}",
        )
    return array


def load_elev(layout: CacheLayout) -> ElevArrays | ReadFailure:
    """Read the artifact back, checking the cache version before any other
    field, the origin against ``mesh.json``'s, and each binary's size against
    the count the sidecar declares."""
    json_path = layout.grid / "elev.json"
    try:
        raw = json.loads(json_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return ReadFailure(name=_NAME, path=str(json_path), reason=f"failed to read elev.json: {exc}")
    if not isinstance(raw, dict):
        return ReadFailure(name=_NAME, path=str(json_path), reason="elev.json is not a JSON object")
    if raw.get("cache_version") != CACHE_VERSION:
        return ReadFailure(
            name=_NAME,
            path=str(json_path),
            reason=(
                f"elev.json was written at cache_version {raw.get('cache_version')!r}, "
                f"this reader expects {CACHE_VERSION}"
            ),
        )
    try:
        nlay = int(raw["nlay"])
        ncpl = int(raw["ncpl"])
        n_ring = int(raw["n_ring_vertices"])
        ox, oy = raw["origin"]
        origin = (float(ox), float(oy))
        grid_type = raw.get("grid_type")
        grid_type = None if grid_type is None else str(grid_type)
        units = raw.get("length_units")
        files = raw["files"]
        counts = {str(k): int(v) for k, v in (raw.get("counts") or {}).items()}
        notes = tuple(str(n) for n in (raw.get("notes") or []))
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        return ReadFailure(
            name=_NAME, path=str(json_path), reason=f"elev.json has an unexpected shape: {exc}"
        )

    mesh_origin = load_mesh_origin(layout)
    if isinstance(mesh_origin, ReadFailure):
        return ReadFailure(
            name=_NAME,
            path=mesh_origin.path,
            reason=f"the grid artifact's origin could not be read: {mesh_origin.reason}",
        )
    if mesh_origin != origin:
        return ReadFailure(
            name=_NAME,
            path=str(json_path),
            reason=(
                f"elev.json's origin {origin} is not mesh.json's {mesh_origin}, so the rings "
                "and the plan mesh are in different frames"
            ),
        )

    if not isinstance(files, dict):
        return ReadFailure(name=_NAME, path=str(json_path), reason="elev.json names no files")
    elev = _read_binary(layout, files.get("elev"), "elev")
    if isinstance(elev, ReadFailure):
        return elev
    ring = _read_binary(layout, files.get("ring"), "ring")
    if isinstance(ring, ReadFailure):
        return ring
    starts = _read_binary(layout, files.get("ring_start"), "ring_start")
    if isinstance(starts, ReadFailure):
        return starts
    if elev.size != (nlay + 1) * ncpl or ring.size != 2 * n_ring or starts.size != ncpl + 1:
        return ReadFailure(
            name=_NAME,
            path=str(json_path),
            reason="elev.json's counts disagree with its nlay, ncpl and ring vertex count",
        )
    starts64 = starts.astype(np.int64)
    if starts64[0] != 0 or starts64[-1] != n_ring or np.any(np.diff(starts64) <= 0):
        return ReadFailure(
            name=_NAME,
            path=str(layout.grid / "ring_start.u32"),
            reason="ring_start.u32 does not split the rings into one non-empty run per cell",
        )

    return ElevArrays(
        grid_type=grid_type,
        nlay=nlay,
        ncpl=ncpl,
        origin=origin,
        elev=elev.reshape(nlay + 1, ncpl).astype(np.float32, copy=False),
        ring=ring.reshape(n_ring, 2).astype(np.float64, copy=False),
        ring_start=starts64,
        length_units=None if units is None else str(units),
        counts=counts,
        notes=notes,
    )
