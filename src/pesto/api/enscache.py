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
    plus whatever ``map_permutation`` has derived from it so far."""

    stored: "StoredEnsemble"


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

    entry = memo.get(key)
    if entry is not None and not manifest.is_stale(name, layout):
        return entry.stored

    from pesto.ingest.ensembles import load_stored

    result = load_stored(iteration, layout)
    if isinstance(result, ReadFailure):
        return result

    memo[key] = _MemoEntry(stored=result)
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
    memo = getattr(state, "ens_memo", None)
    if not memo:
        return
    root_key = str(cache_root)
    if iteration is None:
        for key in [k for k in memo if k[0] == root_key]:
            del memo[key]
    else:
        memo.pop((root_key, iteration), None)
