"""Which cells touch which, built once from the cached mesh and kept until the grid is
written again; and which pilot points shape which cells, read once from a group's text
factor file and kept until that file changes.

Two cells are neighbours when they share at least one corner, so corner neighbours count
(D-06's "first ring"). A corner is matched by the exact bits of its float32 x and y, the
same numbers the map draws, so no tolerance decides what touches.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

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


# ---- pilot-point factors: which points shape which cells ----

BINARY_FACTORS = "{file} is a binary factor file, and pesto lists the points behind a cell only from text factor files"


@dataclass(frozen=True, eq=False)
class PpFactorIndex:
    """One text factor file read both ways, keeping only non-zero factors.

    The points on cell ``c`` are ``cell_pp[cell_ptr[c]:cell_ptr[c + 1]]`` with weights
    ``cell_w`` at the same positions; the cells of point ``p`` (an index into
    ``parnames``) are ``pp_cell[pp_ptr[p]:pp_ptr[p + 1]]``, ascending, with ``pp_w``."""

    cell_ptr: np.ndarray
    cell_pp: np.ndarray
    cell_w: np.ndarray
    pp_ptr: np.ndarray
    pp_cell: np.ndarray
    pp_w: np.ndarray
    parnames: tuple[str, ...]

    def points_on(self, cell: int) -> tuple[np.ndarray, np.ndarray]:
        if cell < 0 or cell + 1 >= self.cell_ptr.size:
            return np.zeros(0, dtype=np.int32), np.zeros(0, dtype=np.float32)
        a, b = self.cell_ptr[cell], self.cell_ptr[cell + 1]
        return self.cell_pp[a:b], self.cell_w[a:b]

    def cells_of(self, point: int) -> np.ndarray:
        return self.pp_cell[self.pp_ptr[point] : self.pp_ptr[point + 1]]


def _csr(key: np.ndarray, other: np.ndarray, weight: np.ndarray, n: int):
    """Rows of ``key`` grouped together, ``other`` ascending within each row."""
    order = np.lexsort((other, key))
    ptr = np.zeros(n + 1, dtype=np.int64)
    ptr[1:] = np.cumsum(np.bincount(key, minlength=n))
    return ptr.astype(np.int32), other[order].astype(np.int32), weight[order].astype(np.float32)


def scan_factor_file(path, group) -> PpFactorIndex | ReadFailure:
    """Read every cell line of one text factor file, laid out as ``fields.contributors``
    reads it: four header lines, one line per point name, then ``node itrans nfac offset``
    and ``nfac`` (point number, weight) pairs that may run onto the next lines. Both
    ``node`` and the point number are 1-based."""
    name = group.factor_file

    def failed(reason: str) -> ReadFailure:
        return ReadFailure(name=group.group, path=str(path), reason=f"could not read {name}: {reason}")

    npp = len(group.pp_names)
    try:
        with open(path, "r") as f:
            for _ in range(4 + npp):
                f.readline()
            tokens = f.read().split()
    except OSError as exc:
        return failed(exc.strerror or type(exc).__name__)
    except UnicodeDecodeError:
        return failed("it is not a text file")

    starts: list[int] = []
    counts: list[int] = []
    nodes: list[int] = []
    pos, n = 0, len(tokens)
    try:
        while pos < n:
            if pos + 4 > n:
                return failed("the last cell line is cut short")
            nfac = int(tokens[pos + 2])
            if nfac < 0 or pos + 4 + 2 * nfac > n:
                return failed(f"the line for node {tokens[pos]} is cut short")
            nodes.append(int(tokens[pos]))
            starts.append(pos + 4)
            counts.append(nfac)
            pos += 4 + 2 * nfac
        values = np.asarray(tokens, dtype=np.float64) if n else np.zeros(0)
    except ValueError as exc:
        return failed(f"a cell line holds something that is not a number ({exc})")

    counts_a = np.asarray(counts, dtype=np.int64)
    total = int(counts_a.sum()) if counts_a.size else 0
    first = np.repeat(np.asarray(starts, dtype=np.int64), counts_a)
    offset = np.arange(total) - np.repeat(np.cumsum(counts_a) - counts_a, counts_a)
    at = first + 2 * offset
    point = values[at].astype(np.int64) - 1
    weight = values[at + 1]
    cell = np.repeat(np.asarray(nodes, dtype=np.int64), counts_a) - 1
    if cell.size and cell.min() < 0:
        return failed("a cell line names a node below 1")
    if point.size and (point.min() < 0 or point.max() >= npp):
        return failed(f"a cell line names a point outside the {npp} points the file lists")

    keep = weight != 0
    cell, point, weight = cell[keep], point[keep], weight[keep]
    n_cells = int(cell.max()) + 1 if cell.size else 0
    cell_ptr, cell_pp, cell_w = _csr(cell, point, weight, n_cells)
    pp_ptr, pp_cell, pp_w = _csr(point, cell, weight, npp)
    return PpFactorIndex(
        cell_ptr=cell_ptr, cell_pp=cell_pp, cell_w=cell_w,
        pp_ptr=pp_ptr, pp_cell=pp_cell, pp_w=pp_w, parnames=tuple(group.parnames),
    )


def pp_factor_index(state, cache_root, run_dir, group) -> PpFactorIndex | ReadFailure:
    """The factor index of one pilot-point group, scanned once and kept until the factor
    file's size or modified time, the group's points, or the cached index changes.

    The path is ``run_dir / group.factor_file`` as the cached pp_factors index records it;
    the file is only ever opened for reading."""
    path = Path(run_dir) / group.factor_file
    if group.format != "text":
        return ReadFailure(name=group.group, path=str(path), reason=BINARY_FACTORS.format(file=group.factor_file))
    try:
        st = path.stat()
    except OSError as exc:
        return ReadFailure(
            name=group.group, path=str(path),
            reason=f"could not read {group.factor_file}: {exc.strerror or type(exc).__name__}",
        )
    stamp = "\n".join((str(path), *group.parnames, *group.pp_names))
    digest = hashlib.sha256(stamp.encode()).hexdigest()[:16]
    key = ("pp_index", group.group, st.st_size, st.st_mtime_ns, digest)
    _forget_older(state, cache_root, key)
    # Only pp_factors: the scan reads nothing from par_cell, and a par_cell recorded stale
    # would otherwise force a fresh scan on every click.
    return obscache.memoised(
        state, cache_root, key, ("pp_factors",), lambda layout: scan_factor_file(path, group)
    )


def _forget_older(state, cache_root, key: tuple) -> None:
    """Drop the group's index kept under an older stamp, so an edited file is held once."""
    memo = getattr(state, "obs_memo", None)
    if not memo:
        return
    root = str(cache_root)
    for held in [k for k in memo if k[:3] == (root, "pp_index", key[1]) and k[1:] != key]:
        del memo[held]
