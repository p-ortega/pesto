"""One memo per (cache root, iteration): the parsed ensemble sidecar and the
map-block permutation, kept across requests (Plan 05-06).

``load_stored`` was designed to be called once per script run: it parses a
JSON sidecar, opens two ``numpy.memmap``s and reads the block-to-control
permutation Phase 4 already computed. Calling it once per HTTP request
would pay that cost on every realization-slider drag. The invalidation
signal is the manifest's own staleness check (``Manifest.is_stale``),
never a wall-clock timer -- a timer would either serve a re-ingested run's
old bytes until it expired, or throw away a valid memo for no reason.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import pandas as pd

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure

if TYPE_CHECKING:
    from pesto.ingest.ensembles import StoredEnsemble

STATS: tuple[str, ...] = ("value", "mean", "std", "q05", "q25", "q50", "q75", "q95")
"""The statistics an M0 cache actually holds (D-07). The design spec's enum
also lists ``rmse`` and ``pdc`` -- both observation-side, and M0 stores
parameters only -- and ``sigma_ratio``, which needs a prior-versus-posterior
pair nothing in this cache computes yet. The picker only offers what it can
draw, so a control that would fail is never shown."""


@dataclass
class _MemoEntry:
    """One cache root's, one iteration's worth of memo: the opened ensemble
    plus whatever ``map_permutation`` has derived from it so far, and the
    write identity of what it was read from."""

    stored: "StoredEnsemble"
    identity: tuple


def _write_identity(manifest: Manifest, layout: CacheLayout, names) -> tuple:
    """What changes on every write of the artifacts in ``names``: the
    recorded source checksums, and each cache file's size and mtime on disk.

    ``is_stale`` alone misses a re-ingest that writes a file of the same size
    against new, matching sources -- a moved pilot point usually does exactly
    that -- and a write by another process that never reached the manifest.
    """
    identity = []
    for name in names:
        artifact = manifest.artifacts.get(name)
        if artifact is None:
            identity.append(None)
            continue
        files = []
        for cache_file in artifact.files:
            try:
                info = (layout.root / cache_file.path).stat()
                files.append((cache_file.path, info.st_size, info.st_mtime_ns))
            except OSError:
                files.append((cache_file.path, None, None))
        sources = tuple((s.path, s.checksum) for s in artifact.sources)
        identity.append((artifact.state, sources, tuple(files)))
    return tuple(identity)


def _memo(state) -> dict[tuple[str, int], _MemoEntry]:
    """The memo dict on ``state``, created lazily so no change to
    ``create_app()`` is needed. Lives on ``app.state`` rather than a module
    global, so two apps in one test process cannot share it."""
    memo = getattr(state, "ens_memo", None)
    if memo is None:
        memo = {}
        state.ens_memo = memo
    return memo


def get_stored(state, cache_root: Path | str, iteration: int) -> "StoredEnsemble | ReadFailure":
    """Return the ``StoredEnsemble`` for ``(cache_root, iteration)``, reading
    it at most once until the manifest reports it stale.

    Builds the layout, loads the manifest, and asks
    ``is_stale(f"par_ens/{iteration}", layout)``. When a memo entry exists
    and the artifact is not stale, the memoised object comes back unchanged
    -- a caller dragging the realization slider on one iteration pays the
    parse exactly once. Otherwise ``load_stored`` runs again; a
    :class:`ReadFailure` is returned as-is and nothing is memoised, so a
    failure never survives past whatever caused it. Never evicts another
    iteration's entry: switching iterations back and forth costs at most one
    read per iteration actually visited.
    """
    memo = _memo(state)
    key = (str(cache_root), iteration)
    layout = CacheLayout(root=Path(cache_root))
    manifest = Manifest.load(layout)
    name = f"par_ens/{iteration}"

    identity = _write_identity(manifest, layout, (name,))
    entry = memo.get(key)
    if entry is not None and entry.identity == identity and not manifest.is_stale(name, layout):
        return entry.stored

    from pesto.ingest.ensembles import load_stored

    result = load_stored(iteration, layout)
    if isinstance(result, ReadFailure):
        return result

    memo[key] = _MemoEntry(stored=result, identity=identity)
    return result


@dataclass(frozen=True)
class BlockCells:
    """The map block's cell, layer and position per row, in block order,
    joined by parameter name from ``par_cell``. ``xy`` is flat float32 pairs
    relative to the mesh origin, or ``None`` when no row has a position."""

    cell: np.ndarray
    layer: np.ndarray
    xy: np.ndarray | None


def _block_cells_memo(state) -> dict[tuple[str, int], tuple[tuple, BlockCells]]:
    memo = getattr(state, "block_cells_memo", None)
    if memo is None:
        memo = {}
        state.block_cells_memo = memo
    return memo


def _par_cell_failure(reason: str, layout: CacheLayout) -> ReadFailure:
    return ReadFailure(name="par_cell", path=str(layout.grid / "par_cell.parquet"), reason=reason)


def _build_block_cells(
    stored: "StoredEnsemble", layout: CacheLayout, iteration: int
) -> BlockCells | ReadFailure:
    from pesto.ingest.mesh import load_mesh_origin
    from pesto.ingest.parcell import load_par_cell

    permutation = map_permutation(stored)
    if permutation is None:
        return _par_cell_failure(
            f"no map-block permutation was recorded for iteration {iteration}, so its "
            f"rows cannot be named",
            layout,
        )
    # par_names is in control order; the permutation turns it into block order.
    names = [stored.par_names[int(i)] for i in permutation]
    table = load_par_cell(layout)
    if isinstance(table, ReadFailure):
        return table

    table_names = pd.Index(table.parnme)
    if not table_names.is_unique:
        repeated = table_names[table_names.duplicated()][0]
        return _par_cell_failure(
            f"par_cell names {repeated!r} more than once, so a parameter name cannot be "
            f"joined to one cell",
            layout,
        )

    idx = table_names.get_indexer(names)
    missing = np.flatnonzero(idx < 0)
    if missing.size:
        count = int(missing.size)
        noun = "parameter" if count == 1 else "parameters"
        verb = "is" if count == 1 else "are"
        return _par_cell_failure(
            f"{count} map-block {noun} of iteration {iteration} {verb} not in par_cell; "
            f"the first is {names[int(missing[0])]!r}",
            layout,
        )

    cell = table.cell[idx].astype("<i4")
    layer = table.layer[idx].astype("<i4")

    x, y = table.x[idx], table.y[idx]
    if not np.isfinite(x).any():
        return BlockCells(cell=cell, layer=layer, xy=None)

    origin = load_mesh_origin(layout)
    if isinstance(origin, ReadFailure):
        return origin
    ox, oy = origin
    xy = np.column_stack([x - ox, y - oy]).astype("<f4").reshape(-1)
    return BlockCells(cell=cell, layer=layer, xy=xy)


def get_block_cells(
    state, cache_root: Path | str, iteration: int
) -> BlockCells | ReadFailure:
    """The cell, layer and origin-relative position of every map-block row of
    ``iteration``, looked up in ``par_cell`` by parameter name.

    A name that ``par_cell`` lacks, or lists twice, is a refusal; no row is
    ever matched by position. The result is memoised until the manifest
    reports ``par_cell``, ``par_ens/{iteration}`` or ``grid`` stale or any of
    them is written again, and ``invalidate`` drops it. A failure is never
    memoised.
    """
    memo = _block_cells_memo(state)
    key = (str(cache_root), iteration)
    layout = CacheLayout(root=Path(cache_root))
    manifest = Manifest.load(layout)
    names = ("par_cell", f"par_ens/{iteration}", "grid")
    identity = _write_identity(manifest, layout, names)

    entry = memo.get(key)
    if (
        entry is not None
        and entry[0] == identity
        and not any(manifest.is_stale(n, layout) for n in names)
    ):
        return entry[1]

    stored = get_stored(state, cache_root, iteration)
    if isinstance(stored, ReadFailure):
        return stored
    result = _build_block_cells(stored, layout, iteration)
    if isinstance(result, ReadFailure):
        memo.pop(key, None)
        return result

    memo[key] = (identity, result)
    return result


def map_permutation(stored: "StoredEnsemble") -> np.ndarray | None:
    """The map block's slice of the recorded control-to-block permutation:
    ``stored.block_to_control[:n_map]``, where ``n_map`` is
    ``stored.blocks[0].n_par`` -- the map block sits first, at offset zero.

    This is what turns a control-order aggregate column into block order,
    and it comes straight out of the sidecar Phase 4 wrote; it is never
    re-derived by assuming a row order. Returns ``None`` when
    ``stored.block_to_control`` is ``None``, so a caller refuses by name
    rather than guessing.

    The slice is cached on ``stored`` itself after the first call, so a
    second call for the same object returns the identical array rather than
    a fresh (if equal) view -- ``stored`` is otherwise frozen, so the cache
    is attached with ``object.__setattr__`` rather than by widening the
    dataclass this module does not own.
    """
    cached = getattr(stored, "_map_permutation", None)
    if cached is not None:
        return cached
    if stored.block_to_control is None:
        return None
    n_map = stored.blocks[0].n_par
    permutation = stored.block_to_control[:n_map]
    object.__setattr__(stored, "_map_permutation", permutation)
    return permutation


def invalidate(state, cache_root: Path | str, iteration: int | None = None) -> None:
    """Drop one memo entry, or every entry for ``cache_root`` when
    ``iteration`` is ``None``. Plan 05-07's ingest routes call this after an
    ingest finishes, so a re-ingest is visible immediately without waiting
    for the next request's own staleness check."""
    root_key = str(cache_root)
    for memo in (getattr(state, "ens_memo", None), getattr(state, "block_cells_memo", None)):
        if not memo:
            continue
        if iteration is None:
            for key in [k for k in memo if k[0] == root_key]:
                del memo[key]
        else:
            memo.pop((root_key, iteration), None)
