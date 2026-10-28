"""Which cells touch which, built once from the cached mesh and kept until the grid is
written again.

Two cells are neighbours when they share at least one corner, so corner neighbours count
(D-06's "first ring"). A corner is matched by the exact bits of its float32 x and y, the
same numbers the map draws, so no tolerance decides what touches.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from pesto.api import obscache
from pesto.cache.layout import CacheLayout
from pesto.ingest.failures import ReadFailure

RING_RULE = "a neighbouring cell shares at least one corner with a clicked cell"


@dataclass(frozen=True, eq=False)
class CellNeighbours:
    """The neighbours of cell ``c`` are ``idx[ptr[c]:ptr[c + 1]]``, ascending, never ``c``."""

    ptr: np.ndarray
    idx: np.ndarray

    @property
    def n_cells(self) -> int:
        return int(self.ptr.size - 1)

    def ring(self, cells) -> np.ndarray:
        """The union of the neighbours of ``cells``, without ``cells`` themselves, ascending."""
        cells = np.asarray(cells, dtype=np.int64)
        if cells.size == 0:
            return np.zeros(0, dtype=np.int32)
        parts = [self.idx[self.ptr[c] : self.ptr[c + 1]] for c in cells]
        found = np.unique(np.concatenate(parts)) if parts else np.zeros(0, dtype=np.int32)
        return found[~np.isin(found, cells)].astype(np.int32)


def build_neighbours(positions: np.ndarray, cell_index: np.ndarray, n_cells: int) -> CellNeighbours:
    """The neighbour table of an unshared vertex list: ``positions`` (n, 2) and the cell of
    each vertex."""
    cell = np.asarray(cell_index, dtype=np.int64)
    if n_cells <= 0 or cell.size == 0:
        return CellNeighbours(ptr=np.zeros(max(n_cells, 0) + 1, dtype=np.int32), idx=np.zeros(0, dtype=np.int32))
    # Adding 0.0 turns -0.0 into 0.0, so the two zeros share one key.
    pos = np.ascontiguousarray(np.asarray(positions, dtype=np.float32).reshape(-1, 2) + np.float32(0.0))
    bits = pos.view(np.uint32).astype(np.uint64)
    key = (bits[:, 0] << np.uint64(32)) | bits[:, 1]
    _, corner = np.unique(key, return_inverse=True)
    corner = corner.reshape(-1).astype(np.int64)

    # One entry per (corner, cell), sorted by corner, so each corner's cells sit together.
    pairs = np.unique(corner * n_cells + cell)
    pair_corner = pairs // n_cells
    pair_cell = pairs % n_cells
    starts = np.flatnonzero(np.r_[True, pair_corner[1:] != pair_corner[:-1]])
    sizes = np.diff(np.r_[starts, pairs.size])
    size_of = np.repeat(sizes, sizes)
    start_of = np.repeat(starts, sizes)

    # Every ordered pair of cells that share a corner, built without a loop over corners.
    total = int(size_of.sum())
    src = np.repeat(np.arange(pairs.size), size_of)
    first_out = np.repeat(np.cumsum(size_of) - size_of, size_of)
    dst = start_of[src] + (np.arange(total) - first_out)
    a = pair_cell[src]
    b = pair_cell[dst]
    keep = a != b
    edges = np.unique(a[keep] * n_cells + b[keep])
    edge_src = edges // n_cells
    edge_dst = edges % n_cells

    ptr = np.zeros(n_cells + 1, dtype=np.int64)
    ptr[1:] = np.cumsum(np.bincount(edge_src, minlength=n_cells))
    return CellNeighbours(ptr=ptr.astype(np.int32), idx=edge_dst.astype(np.int32))


def cell_neighbours(state, cache_root) -> CellNeighbours | ReadFailure:
    def build(layout: CacheLayout):
        from pesto.ingest.mesh import load_mesh

        mesh = load_mesh(layout)
        if isinstance(mesh, ReadFailure):
            return mesh
        cell = np.asarray(mesh.cell_index, dtype=np.int64)
        n_cells = int(mesh.n_cells)
        if cell.size and (cell.min() < 0 or cell.max() >= n_cells):
            return ReadFailure(
                name="grid", path="", reason="the cached mesh names a cell outside its own cell count"
            )
        return build_neighbours(mesh.positions, cell, n_cells)

    return obscache.memoised(state, cache_root, ("link_adj",), ("grid",), build)
