"""The grid mesh as a cache artifact.

Written as raw little-endian binary so the graphics card can take it
without a parse step. Vertices are duplicated per cell because a shared
vertex cannot carry a per-cell value -- the renderer needs every vertex to
know which cell it came from. A run with no grid file at all is a designed
state, not a failure: Phase 3 already treats no grid as normal, and a
caller here must be able to tell "there is no grid" from "the grid could
not be read".
"""

from __future__ import annotations

import json

import numpy as np

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure

# MeshBuffers, GridShape and SpatialAdapter live in pesto.model, which
# nothing under pesto.ingest may import -- even for typing
# (test_no_ingest_file_imports_anything_from_model). The annotations below
# stay unresolved forward references, never evaluated at runtime.


def write_mesh(
    mesh: "MeshBuffers", shape: "GridShape | None", layout: CacheLayout
) -> WrittenArtifact | ReadFailure:
    """Write ``mesh`` into ``layout.grid`` as three little-endian binaries
    plus a JSON sidecar, and return the artifact describing what was
    written.

    Byte order is forced explicitly on every binary write, never left to
    the machine's own -- a cache written on one machine and read on
    another must not depend on which one wrote it. ``mesh.json`` is
    written last, after the three binaries are already in place, so a
    reader never finds a sidecar naming a file that is not there yet.
    """
    name = "grid"
    try:
        positions = np.ascontiguousarray(mesh.positions, dtype="<f4")
        cell_index = np.ascontiguousarray(mesh.cell_index, dtype="<f4")
        indices = np.ascontiguousarray(mesh.indices, dtype="<u4")

        positions_path = layout.grid / "positions.f32"
        cell_index_path = layout.grid / "cell_index.f32"
        indices_path = layout.grid / "indices.u32"
        mesh_json_path = layout.grid / "mesh.json"

        positions_bytes = write_atomic_bytes(
            positions_path, lambda f: f.write(positions.tobytes())
        )
        cell_index_bytes = write_atomic_bytes(
            cell_index_path, lambda f: f.write(cell_index.tobytes())
        )
        indices_bytes = write_atomic_bytes(indices_path, lambda f: f.write(indices.tobytes()))

        n_vert = int(positions.shape[0])
        n_tri = int(indices.shape[0] // 3)

        notes: list[str] = []
        if mesh.crs is None:
            notes.append(
                "no projection recorded -- the binary grid format carries no "
                "projection field, so an absent projection is a known fact, "
                "not an unexplained gap"
            )

        payload = {
            "cache_version": CACHE_VERSION,
            "n_vert": n_vert,
            "n_tri": n_tri,
            "n_cells": int(mesh.n_cells),
            "nlay": int(mesh.nlay),
            "bounds": list(mesh.bounds),
            "crs": mesh.crs,
            "files": {
                "positions": {
                    "name": positions_path.name,
                    "dtype": "<f4",
                    "count": 2 * n_vert,
                },
                "cell_index": {
                    "name": cell_index_path.name,
                    "dtype": "<f4",
                    "count": n_vert,
                },
                "indices": {
                    "name": indices_path.name,
                    "dtype": "<u4",
                    "count": 3 * n_tri,
                },
            },
            "notes": notes,
        }
        mesh_json_bytes = write_atomic_text(mesh_json_path, json.dumps(payload, indent=2))

        root = layout.root
        files = (
            CacheFile(path=str(positions_path.relative_to(root)), bytes=positions_bytes),
            CacheFile(path=str(cell_index_path.relative_to(root)), bytes=cell_index_bytes),
            CacheFile(path=str(indices_path.relative_to(root)), bytes=indices_bytes),
            CacheFile(path=str(mesh_json_path.relative_to(root)), bytes=mesh_json_bytes),
        )
        return WrittenArtifact(name=name, files=files, notes=tuple(notes))
    except Exception as exc:
        return ReadFailure(
            name=name,
            path=str(layout.grid),
            reason=f"failed to write grid mesh to {layout.grid}: {exc}",
        )


def write_grid_from_adapter(
    adapter: "SpatialAdapter | None", layout: CacheLayout
) -> WrittenArtifact | ReadFailure | None:
    """Read the grid from ``adapter`` and write it, or report the normal
    absence of a grid.

    ``adapter`` is ``None`` when the run has no grid file at all -- Phase 3
    already treats that as a normal state, so nothing is written and
    ``None`` is returned, distinguishable from a real failure. A
    ``ReadFailure`` from either adapter call is passed straight back,
    never turned into an empty mesh.
    """
    if adapter is None:
        return None

    mesh = adapter.grid_mesh()
    if isinstance(mesh, ReadFailure):
        return mesh

    shape = adapter.grid_shape()
    if isinstance(shape, ReadFailure):
        return shape

    return write_mesh(mesh, shape, layout)


def load_mesh(layout: CacheLayout) -> "MeshBuffers | ReadFailure":
    """Read the grid mesh back from ``layout.grid``.

    ``mesh.json`` is validated the defensive way ``Manifest.load``
    validates the manifest -- including a ``cache_version`` check before any
    other field is read, so per D-08 a version bump is a hard reset, same as
    ``Manifest.load``, ``load_config`` and ``load_stored`` -- then each
    binary is read with ``numpy.fromfile`` at the dtype and count the JSON
    declares, refusing with a ``ReadFailure`` naming the file whose size
    does not match the count it was declared to hold. The version check
    runs before any binary is read, so a mismatch costs no file reads.
    """
    from pesto.model import MeshBuffers

    name = "grid"
    mesh_json_path = layout.grid / "mesh.json"

    try:
        raw = json.loads(mesh_json_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return ReadFailure(
            name=name, path=str(mesh_json_path), reason=f"failed to read {mesh_json_path.name}: {exc}"
        )

    if not isinstance(raw, dict):
        return ReadFailure(
            name=name,
            path=str(mesh_json_path),
            reason=f"{mesh_json_path.name} is not a JSON object",
        )

    if raw.get("cache_version") != CACHE_VERSION:
        return ReadFailure(
            name=name,
            path=str(mesh_json_path),
            reason=(
                f"{mesh_json_path.name} was written at cache_version "
                f"{raw.get('cache_version')!r}, this reader expects {CACHE_VERSION}"
            ),
        )

    try:
        n_vert = int(raw["n_vert"])
        n_tri = int(raw["n_tri"])
        n_cells = int(raw["n_cells"])
        nlay = int(raw["nlay"])
        bounds = tuple(float(b) for b in raw["bounds"])
        crs = raw.get("crs")
    except (KeyError, TypeError, ValueError) as exc:
        return ReadFailure(
            name=name,
            path=str(mesh_json_path),
            reason=f"{mesh_json_path.name} has an unexpected shape: {exc}",
        )

    def _read_binary(filename: str, dtype: str, count: int):
        path = layout.grid / filename
        try:
            array = np.fromfile(path, dtype=dtype)
        except OSError as exc:
            return ReadFailure(name=name, path=str(path), reason=f"failed to read {path.name}: {exc}")
        if array.shape[0] != count:
            return ReadFailure(
                name=name,
                path=str(path),
                reason=(
                    f"{path.name} has {array.shape[0]} elements, expected {count}"
                ),
            )
        return array

    positions_flat = _read_binary("positions.f32", "<f4", 2 * n_vert)
    if isinstance(positions_flat, ReadFailure):
        return positions_flat
    cell_index = _read_binary("cell_index.f32", "<f4", n_vert)
    if isinstance(cell_index, ReadFailure):
        return cell_index
    indices = _read_binary("indices.u32", "<u4", 3 * n_tri)
    if isinstance(indices, ReadFailure):
        return indices

    positions = positions_flat.reshape(n_vert, 2).astype(np.float32, copy=False)

    return MeshBuffers(
        positions=positions,
        cell_index=cell_index.astype(np.float32, copy=False),
        indices=indices.astype(np.uint32, copy=False),
        n_cells=n_cells,
        nlay=nlay,
        bounds=bounds,
        crs=crs,
    )
