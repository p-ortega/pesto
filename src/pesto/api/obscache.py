"""One memo for the observation artifacts: the parsed index, the opened
ensembles, the noise band and the placement table, kept across requests.

The loaders cost the time, not the frames cut from them: ``load_obs_ensemble``
re-reads and re-checks the whole index on every call. Each value is held with the
write identity of every artifact it was built from, so a re-ingest of any of them
is seen on the next request. A ``ReadFailure`` is never kept.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from pesto.api.enscache import _write_identity
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure

OBS_ENS_PREFIX = "obs_ens/"


def _memo(state) -> dict[tuple, tuple[tuple, Any]]:
    """The memo dict on ``state``, created lazily so ``create_app()`` stays as it is."""
    memo = getattr(state, "obs_memo", None)
    if memo is None:
        memo = {}
        state.obs_memo = memo
    return memo


def memoised(
    state,
    cache_root: Path | str,
    key: tuple,
    names: tuple[str, ...],
    build: Callable[[CacheLayout], Any],
) -> Any:
    """The value for ``(cache_root, key)``, built at most once until one of the
    artifacts in ``names`` is written again or reports stale.

    ``build`` gets the layout and returns the value or a ``ReadFailure``. A failure
    is handed back as it is and nothing is stored, so it never outlives its cause.
    """
    memo = _memo(state)
    memo_key = (str(cache_root), *key)
    layout = CacheLayout(root=Path(cache_root))
    manifest = Manifest.load(layout)
    identity = _write_identity(manifest, layout, names)

    held = memo.get(memo_key)
    if held is not None and held[0] == identity and not any(manifest.is_stale(n, layout) for n in names):
        return held[1]

    result = build(layout)
    if isinstance(result, ReadFailure):
        memo.pop(memo_key, None)
        return result
    memo[memo_key] = (identity, result)
    return result


def get_index(state, cache_root: Path | str):
    from pesto.ingest import obsindex

    return memoised(
        state, cache_root, ("index",), ("obs_index",), lambda layout: obsindex.load_obs_index(layout)
    )


def get_ens(state, cache_root: Path | str, iteration: int):
    from pesto.ingest import obsens

    return memoised(
        state,
        cache_root,
        ("ens", iteration),
        ("obs_index", f"{OBS_ENS_PREFIX}{iteration}"),
        lambda layout: obsens.load_obs_ensemble(iteration, layout),
    )


def get_agg(state, cache_root: Path | str, iteration: int):
    from pesto.ingest import obsagg

    return memoised(
        state,
        cache_root,
        ("agg", iteration),
        ("obs_index", f"obs_agg/{iteration}"),
        lambda layout: obsagg.load_obs_agg(iteration, layout),
    )


def get_noise(state, cache_root: Path | str):
    from pesto.ingest import obsagg

    return memoised(
        state,
        cache_root,
        ("noise",),
        ("obs_index", "noise_agg"),
        lambda layout: obsagg.load_noise_agg(layout),
    )


def get_cell(state, cache_root: Path | str):
    from pesto.ingest import obscell

    return memoised(
        state,
        cache_root,
        ("cell",),
        ("obs_index", "obs_cell"),
        lambda layout: obscell.load_obs_cell(layout),
    )


def obs_iterations(manifest: Manifest) -> list[int]:
    """Every iteration with an ``obs_ens/K`` recorded ok, ascending."""
    found = []
    for name, artifact in manifest.artifacts.items():
        if not name.startswith(OBS_ENS_PREFIX) or artifact.state != "ok":
            continue
        tail = name[len(OBS_ENS_PREFIX) :]
        if tail.isdigit():
            found.append(int(tail))
    return sorted(found)


def obs_ends(state, cache_root: Path | str, manifest: Manifest) -> tuple[int, int | None] | None:
    """The first and last observation iteration every observation route uses, or None when
    there is none. The last is None when only one iteration was ingested.

    They are the ends the last ingest planned, as ``obs_1to1`` recorded them, so an
    ``obs_ens/K`` left in the manifest by an older ingest is never taken for the last. When
    ``obs_1to1`` is not recorded ok that record is not trusted and the ends fall back to
    every ``obs_ens/K`` recorded ok; ``/obs/1to1`` is refused in that case, so the two never
    show different ends side by side."""
    recorded = manifest.artifacts.get("obs_1to1")
    if recorded is not None and recorded.state == "ok":
        from pesto.ingest import obs1to1

        planned = memoised(
            state, cache_root, ("ends",), ("obs_1to1",), lambda layout: obs1to1.read_planned_ends(layout)
        )
        if not isinstance(planned, ReadFailure):
            return planned
    found = obs_iterations(manifest)
    if not found:
        return None
    return found[0], (found[-1] if len(found) > 1 else None)


def invalidate(state, cache_root: Path | str) -> None:
    """Drop every entry for ``cache_root``; the ingest routes call this when an ingest ends."""
    memo = getattr(state, "obs_memo", None)
    if not memo:
        return
    root_key = str(cache_root)
    for key in [k for k in memo if k[0] == root_key]:
        del memo[key]
