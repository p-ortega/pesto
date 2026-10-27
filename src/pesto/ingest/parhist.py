"""The parameter view's histograms: every parameter group's first and last
iteration binned on one set of edges.

Both iterations are read through their cache memmaps and joined by realization
name, so only realizations present in both are counted. Values are binned in
pestpp's numeric space: log10 for a log-transformed group, native otherwise.
The edges span the pooled minimum and maximum of both iterations, so the two
series can be laid over each other. Density is count / (n x bin width), so each
series integrates to 1.

Which parameters count comes only from ``par_change``'s ``included`` column;
nothing is recomputed here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.ensembles import StoredEnsemble, align_realizations, load_stored
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parview import (
    _control_chunks,
    _count_note,
    _excluded_counts,
    _fail,
    _read_json,
    load_par_change,
)
from pesto.ingest.tables import _write_parquet_atomic

N_BINS = 50
# A raw float64 block of this size is read at a time; the log copy and masks stay near 4x it.
_CHUNK_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True, eq=False)
class Series:
    """One iteration's counts on the shared edges. ``n`` is the number of values counted."""

    n: int
    counts: np.ndarray
    density: np.ndarray


@dataclass(frozen=True, eq=False)
class SharedHistogram:
    """Edges and the two series, or a ``refused`` sentence and nothing else."""

    edges: np.ndarray | None
    first: Series | None
    last: Series | None
    refused: str | None


def shared_edges(low: float, high: float, n_bins: int = N_BINS) -> np.ndarray:
    """``n_bins`` uniform bins from ``low`` to ``high``, the rule ``numpy.histogram`` uses."""
    return np.linspace(low, high, n_bins + 1)


def bin_counts(values: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """Counts of the finite ``values`` in each bin of ``edges``.

    A value exactly on an inner edge counts in the bin to its right and the
    largest edge counts in the last bin, as ``numpy.histogram`` does. A value
    outside the edges is an error: the edges are built from these values, so
    one outside means the caller mixed up its data."""
    n_bins = len(edges) - 1
    flat = np.asarray(values, dtype=np.float64).ravel()
    flat = flat[np.isfinite(flat)]
    index = np.searchsorted(edges, flat, side="right") - 1
    index[flat == edges[-1]] = n_bins - 1
    if flat.size and (index.min() < 0 or index.max() >= n_bins):
        raise ValueError("a value lies outside the histogram edges")
    return np.bincount(index, minlength=n_bins).astype(np.int64)


def densities(counts: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """count / (n x bin width); all zero when there is nothing counted."""
    n = int(counts.sum())
    if n == 0:
        return np.zeros(len(counts))
    return counts / (n * np.diff(edges))


def _series(counts: np.ndarray, edges: np.ndarray) -> Series:
    return Series(n=int(counts.sum()), counts=counts, density=densities(counts, edges))


def shared_edge_histogram(
    first_values: np.ndarray,
    last_values: np.ndarray,
    n_bins: int = N_BINS,
) -> SharedHistogram:
    """Bin two sets of values on edges spanning both. The one rule for edges,
    counts and density that ``par_hist`` and the single-parameter drill-down share."""
    first = np.asarray(first_values, dtype=np.float64).ravel()
    last = np.asarray(last_values, dtype=np.float64).ravel()
    first = first[np.isfinite(first)]
    last = last[np.isfinite(last)]
    pooled = np.concatenate([first, last])
    edges = shared_edges(float(pooled.min()), float(pooled.max()), n_bins)
    return SharedHistogram(
        edges=edges,
        first=_series(bin_counts(first, edges), edges),
        last=_series(bin_counts(last, edges), edges),
        refused=None,
    )


def _chunk_step(n_real: int) -> int:
    return max(1, _CHUNK_BYTES // (8 * max(n_real, 1)))


def _active_values(
    stored: StoredEnsemble, rows: np.ndarray, active: np.ndarray, is_log: np.ndarray
):
    """Yield ``(control positions, values)`` for the active parameters only, one
    chunk at a time. Values are over ``rows``, float64, in the numeric space."""
    for control, block in _control_chunks(stored, _chunk_step(len(stored.real_names))):
        keep = np.flatnonzero(active[control])
        if keep.size == 0:
            continue
        sel = block[rows][:, keep]
        columns = control[keep]
        logged = is_log[columns]
        if logged.any():
            sel[:, logged] = np.log10(sel[:, logged])
        yield columns, sel


def write_par_hist(first: int, last: int, layout: CacheLayout) -> WrittenArtifact | ReadFailure:
    """Write ``agg/par_hist.parquet`` and then its sidecar ``agg/par_hist.json``,
    or leave nothing behind. Reads ``par_change`` for the included flags and
    spaces, and the cached ``par_ens/first`` and ``par_ens/last`` for the values."""
    name = "par_hist"
    payload_path = layout.par_hist
    sidecar_path = layout.par_hist_meta
    written: list[Path] = []
    try:
        loaded = load_par_change(layout)
        if isinstance(loaded, ReadFailure):
            return _fail(name, loaded.path, f"par_change could not be read: {loaded.reason}")
        frame, change_meta = loaded
        stored = []
        for iteration in (first, last):
            one = load_stored(iteration, layout)
            if isinstance(one, ReadFailure):
                return _fail(
                    name,
                    one.path,
                    f"the parameter ensemble of iteration {iteration} could not be read: {one.reason}",
                )
            stored.append(one)
        stored_first, stored_last = stored
        names = [str(v) for v in frame["parnme"]]
        for one in stored:
            if tuple(names) != tuple(one.par_names):
                return _fail(
                    name,
                    payload_path,
                    f"the change table and the ensemble of iteration {one.iteration} do not hold "
                    "the same parameters in the same order; ingest the run again",
                )
        aligned = align_realizations(stored_first.real_names, stored_last.real_names)
        if not aligned.names:
            return _fail(
                name,
                payload_path,
                f"no realization name is shared between iteration {first} and iteration {last}",
            )
        rows_first = np.asarray(aligned.index_a, dtype=np.int64)
        rows_last = np.asarray(aligned.index_b, dtype=np.int64)

        group_names = [str(g) for g in dict.fromkeys(frame["pargp"])]
        group_of = {g: i for i, g in enumerate(group_names)}
        gidx = np.array([group_of[str(g)] for g in frame["pargp"]], dtype=np.int64)
        included = frame["included"].to_numpy(dtype=bool)
        is_log = (frame["space"] == "log10").to_numpy(dtype=bool)
        n_groups = len(group_names)
        has_included = np.zeros(n_groups, dtype=bool)
        has_included[gidx[included]] = True
        active = included & has_included[gidx]

        # Pass 1: the pooled range of each group.
        low = np.full(n_groups, np.inf)
        high = np.full(n_groups, -np.inf)
        for one, rows in ((stored_first, rows_first), (stored_last, rows_last)):
            for columns, values in _active_values(one, rows, active, is_log):
                with np.errstate(all="ignore"):
                    finite = np.isfinite(values)
                    lo = np.where(finite, values, np.inf).min(axis=0)
                    hi = np.where(finite, values, -np.inf).max(axis=0)
                np.minimum.at(low, gidx[columns], lo)
                np.maximum.at(high, gidx[columns], hi)

        edges: dict[int, np.ndarray] = {}
        for g in range(n_groups):
            if active[gidx == g].any():
                edges[g] = shared_edges(low[g], high[g])

        # Pass 2: counts on those edges.
        counts = {g: [np.zeros(N_BINS, dtype=np.int64), np.zeros(N_BINS, dtype=np.int64)] for g in edges}
        for slot, (one, rows) in enumerate(((stored_first, rows_first), (stored_last, rows_last))):
            for columns, values in _active_values(one, rows, active, is_log):
                of_column = gidx[columns]
                order = np.argsort(of_column, kind="stable")
                sorted_groups = of_column[order]
                starts = np.flatnonzero(np.r_[True, sorted_groups[1:] != sorted_groups[:-1]])
                stops = np.r_[starts[1:], len(order)]
                for start, stop in zip(starts, stops):
                    g = int(sorted_groups[start])
                    counts[g][slot] += bin_counts(values[:, order[start:stop]], edges[g])

        sidecar_path.unlink(missing_ok=True)

        records = []
        entries = []
        for g, group in enumerate(group_names):
            block = frame[gidx == g]
            entry = {
                "group": group,
                "n_par": int(len(block)),
                "n_included": int(block["included"].sum()),
                "excluded": _excluded_counts(block),
                "space": None,
                "edges": None,
                "first": None,
                "last": None,
                "refused": None,
                "notes": [],
            }
            if g in edges:
                entry["space"] = "log10" if is_log[gidx == g][block["included"].to_numpy()].all() else "native"
                entry["edges"] = [float(v) for v in edges[g]]
                for slot, (key, iteration) in enumerate((("first", first), ("last", last))):
                    series = _series(counts[g][slot], edges[g])
                    entry[key] = {"iteration": int(iteration), "n": series.n}
                    for b in range(N_BINS):
                        records.append((group, int(iteration), b, int(series.counts[b]), float(series.density[b])))
            entries.append(entry)

        table = pd.DataFrame(
            {
                "group": pd.Series([r[0] for r in records], dtype="object"),
                "iteration": pd.Series([r[1] for r in records], dtype="int64"),
                "bin": pd.Series([r[2] for r in records], dtype="int64"),
                "count": pd.Series([r[3] for r in records], dtype="int64"),
                "density": pd.Series([r[4] for r in records], dtype="float64"),
            }
        )
        payload_bytes = _write_parquet_atomic(table, payload_path)
        written.append(payload_path)

        notes = [str(n) for n in change_meta["notes"]]
        sidecar = {
            "cache_version": CACHE_VERSION,
            "first_iteration": int(first),
            "last_iteration": int(last),
            "single_iteration": False,
            "n_bins": N_BINS,
            "n_common": len(aligned.names),
            "only_first": change_meta["only_first"],
            "only_last": change_meta["only_last"],
            "groups": entries,
            "notes": notes,
        }
        sidecar_bytes = write_atomic_text(sidecar_path, json.dumps(sidecar, indent=2))
        written.append(sidecar_path)
        files = (
            CacheFile(path=str(payload_path.relative_to(layout.root)), bytes=payload_bytes),
            CacheFile(path=str(sidecar_path.relative_to(layout.root)), bytes=sidecar_bytes),
        )
        return WrittenArtifact(name=name, files=files, notes=tuple(notes))
    except Exception as exc:
        removed = 0
        for path in written:
            try:
                path.unlink(missing_ok=True)
                removed += 1
            except Exception:
                pass
        return _fail(
            name,
            payload_path,
            f"failed to write the group histograms: {exc} -- cleaned up {removed} file(s) "
            "already written for this artifact",
        )


def load_par_hist(layout: CacheLayout) -> tuple[pd.DataFrame, dict] | ReadFailure:
    """Read ``par_hist`` back as its rows and its sidecar. The sidecar and its
    ``cache_version`` are checked before the rows are trusted."""
    name = "par_hist"
    sidecar = _read_json(name, layout.par_hist_meta)
    if isinstance(sidecar, ReadFailure):
        return sidecar
    try:
        for key in ("first_iteration", "last_iteration", "n_common", "n_bins"):
            int(sidecar[key])
        if not isinstance(sidecar["groups"], list) or not isinstance(sidecar["notes"], list):
            raise TypeError("groups and notes must be lists")
        for group in sidecar["groups"]:
            str(group["group"])
            if group["edges"] is not None and len(group["edges"]) != int(sidecar["n_bins"]) + 1:
                raise ValueError(f"group {group['group']!r} has the wrong number of edges")
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(
            name,
            layout.par_hist_meta,
            f"{layout.par_hist_meta.name} is not shaped like a histogram sidecar: {exc}",
        )
    try:
        frame = pd.read_parquet(layout.par_hist)
    except Exception as exc:
        return _fail(name, layout.par_hist, f"could not read {layout.par_hist.name}: {exc}")
    return frame, sidecar
