"""The parameter view's two tables, built from the cached parameter ensembles.

``par_change`` has one row per control-file parameter: its mean and standard
deviation in the first and the last iteration, and how far they moved. Both
iterations are read through their cache memmaps, never the source files, and
joined by realization name over the realizations present in both. Statistics
are taken in the numeric space pestpp works in: log10 for a log-transformed
parameter, native units otherwise.

The percent change follows pestpp's own definitions, with one guard: a
parameter whose first mean is tiny next to its first sd gets no percent change,
only its shift in first-sd units (``mean_shift_sd``). Nothing is left out
without being counted and given a reason.

``par_groups`` is one JSON file with one entry per parameter group, built from
``par_change``, the control table and pestpp's own group summary.
"""

from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.cache._atomic import write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.aggregate import near_bound_counts
from pesto.ingest.discover import RunLayout, discover
from pesto.ingest.ensembles import StoredEnsemble, align_realizations, load_stored
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parcell import load_par_cell
from pesto.ingest.recfile import RecFacts, RecGroupRow, read_rec
from pesto.ingest.reinflate import ReinflationVerdict, assess_reinflation
from pesto.ingest.runopts import ControlOptions, scan_options
from pesto.ingest.tables import _write_parquet_atomic, load_control_table

CHUNK_PARAMS = 4096
# A first mean smaller than this share of the first sd is too close to zero for a percent change.
NEAR_ZERO_FACTOR = 0.01
# Above this many parameters a group is not offered a per-parameter drill-down.
DRILL_DOWN_MAX_PARAMS = 10_000
# Copied from pesto.model._parcells.DEFAULT_LAYER_PATTERN; nothing under pesto.ingest imports pesto.model.
LAYER_PATTERN = r"layer[_-]?(\d+)"
_PTYPE_TAG = re.compile(r"ptype:([^_]*)")
_EXAMPLES = 3

NEAR_BOUND_NOTE = (
    "Near-bound counts are parameter-by-realization pairs, counted as pestpp counts them "
    "(within one percent of a bound's own size, adjustable parameters only) over each "
    "iteration's own realizations. A parameter whose count cannot be told is missing, not zero."
)


@dataclass(frozen=True, eq=False)
class Moments:
    """Per-parameter figures in control-file order. ``n_valid`` is the number of
    realizations that held a number; ``n_nonpositive`` counts the values a log
    parameter cannot take the logarithm of. The near-bound arrays are filled only
    when bounds were given."""

    mean: np.ndarray
    sd: np.ndarray
    n_valid: np.ndarray
    n_nonpositive: np.ndarray
    near_lower: np.ndarray | None = None
    near_upper: np.ndarray | None = None
    near_missing: np.ndarray | None = None


@dataclass(frozen=True, eq=False)
class ParameterChange:
    """How far each parameter moved, as arrays. A refusal array holds the reason
    text where a figure was refused and None elsewhere."""

    mean_change_pct: np.ndarray
    mean_change_refused: np.ndarray
    sd_change_pct: np.ndarray
    sd_change_refused: np.ndarray
    sd_ratio: np.ndarray
    mean_shift_sd: np.ndarray


def _fail(name: str, path: Path | str, reason: str) -> ReadFailure:
    return ReadFailure(name=name, path=str(path), reason=f"{name}: {reason}")


def _number(value) -> float | None:
    """A JSON-safe number: a finite float, or None where there is none."""
    if value is None:
        return None
    value = float(value)
    return value if np.isfinite(value) else None


def _control_chunks(stored: StoredEnsemble, step: int = CHUNK_PARAMS):
    """Yield ``(control positions, values)`` blocks of about ``step``
    parameters, values as float64 of shape (n_real, k). Reading in column
    chunks keeps memory flat however many parameters there are."""
    n_map = stored.map_values.shape[1]
    n_nomap = stored.nomap_values.shape[0]
    for start in range(0, n_map, step):
        stop = min(start + step, n_map)
        block = np.asarray(stored.map_values[:, start:stop], dtype=np.float64)
        yield stored.block_to_control[start:stop], block
    for start in range(0, n_nomap, step):
        stop = min(start + step, n_nomap)
        block = np.asarray(stored.nomap_values[start:stop], dtype=np.float64).T
        yield stored.block_to_control[n_map + start : n_map + stop], block


def parameter_moments(
    stored: StoredEnsemble,
    rows: np.ndarray,
    log_mask: np.ndarray,
    near_bounds: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
) -> Moments:
    """Mean and population standard deviation (ddof 0) of every parameter over
    the realizations at ``rows``, in control-file order.

    A log parameter is measured in log10. One holding any non-positive value
    among ``rows`` has no logarithm to take, so its mean and sd are missing and
    ``n_nonpositive`` says how many values stopped it.

    ``near_bounds`` is ``(lower, upper, adjustable)``, each in control-file
    order. When given, the near-lower and near-upper counts come out too, over
    all of this iteration's own realizations (not just ``rows``), as pestpp
    counts them.
    """
    rows = np.asarray(rows, dtype=np.int64)
    n_par = len(stored.par_names)
    mean = np.full(n_par, np.nan)
    sd = np.full(n_par, np.nan)
    n_valid = np.zeros(n_par, dtype=np.int64)
    n_nonpositive = np.zeros(n_par, dtype=np.int64)
    log_mask = np.asarray(log_mask, dtype=bool)
    near_lower = near_upper = near_missing = None
    if near_bounds is not None:
        lower, upper, adjustable = near_bounds
        near_lower = np.zeros(n_par, dtype=np.int64)
        near_upper = np.zeros(n_par, dtype=np.int64)
        near_missing = np.ones(n_par, dtype=bool)

    for control, block in _control_chunks(stored):
        sel = block[rows]
        valid = ~np.isnan(sel)
        is_log = log_mask[control]
        with np.errstate(all="ignore"):
            nonpositive = np.where(is_log, (valid & (sel <= 0)).sum(axis=0), 0)
            values = sel.copy()
            log_cols = np.flatnonzero(is_log)
            if log_cols.size:
                values[:, log_cols] = np.log10(sel[:, log_cols])
            n = valid.sum(axis=0)
            total = np.where(valid, values, 0.0).sum(axis=0)
            chunk_mean = np.where(n > 0, total / np.maximum(n, 1), np.nan)
            spread = np.where(valid, values - chunk_mean, 0.0)
            chunk_sd = np.where(n > 0, np.sqrt((spread**2).sum(axis=0) / np.maximum(n, 1)), np.nan)
        stopped = nonpositive > 0
        chunk_mean[stopped] = np.nan
        chunk_sd[stopped] = np.nan
        mean[control] = chunk_mean
        sd[control] = chunk_sd
        n_valid[control] = n
        n_nonpositive[control] = nonpositive
        if near_bounds is not None:
            # The function's own notes are left out: the writer states each
            # kind of loss once, with a count, rather than once per chunk.
            n_low, n_up, _n, missing, _notes = near_bound_counts(
                block,
                lower[control],
                upper[control],
                is_log,
                adjustable_mask=adjustable[control],
            )
            near_lower[control] = n_low
            near_upper[control] = n_up
            near_missing[control] = missing
    return Moments(
        mean=mean,
        sd=sd,
        n_valid=n_valid,
        n_nonpositive=n_nonpositive,
        near_lower=near_lower,
        near_upper=near_upper,
        near_missing=near_missing,
    )


def parameter_change(
    mean_first: np.ndarray,
    sd_first: np.ndarray,
    mean_last: np.ndarray,
    sd_last: np.ndarray,
    near_zero_factor: float = NEAR_ZERO_FACTOR,
) -> ParameterChange:
    """How far each parameter moved, in pestpp's own definitions.

    ``mean_change_pct`` is 100 x |mean_last - mean_first| / |mean_first| and
    ``sd_change_pct`` is 100 x |sd_last - sd_first| / sd_first. A percent change
    of the mean is refused when the first mean is exactly 0 or smaller than
    ``near_zero_factor`` x the first sd (pass 0.0 to refuse only an exact zero).
    A zero first sd leaves no sd change, ratio or shift. ``mean_shift_sd`` is the
    signed shift of the mean in first-sd units, the figure that stays stable when
    the mean is near zero.
    """
    mean_first = np.asarray(mean_first, dtype=np.float64)
    sd_first = np.asarray(sd_first, dtype=np.float64)
    mean_last = np.asarray(mean_last, dtype=np.float64)
    sd_last = np.asarray(sd_last, dtype=np.float64)
    n = mean_first.shape[0]

    with np.errstate(all="ignore"):
        have_mean = np.isfinite(mean_first) & np.isfinite(mean_last)
        exact_zero = have_mean & (mean_first == 0.0)
        too_small = have_mean & ~exact_zero & (np.abs(mean_first) < near_zero_factor * sd_first)
        refused = exact_zero | too_small
        mean_pct = np.full(n, np.nan)
        usable = have_mean & ~refused
        mean_pct[usable] = 100.0 * np.abs(mean_last[usable] - mean_first[usable]) / np.abs(
            mean_first[usable]
        )

        have_sd = np.isfinite(sd_first) & np.isfinite(sd_last)
        no_spread = have_sd & (sd_first == 0.0)
        sd_usable = have_sd & (sd_first > 0.0)
        sd_pct = np.full(n, np.nan)
        sd_pct[sd_usable] = 100.0 * np.abs(sd_last[sd_usable] - sd_first[sd_usable]) / sd_first[sd_usable]
        ratio = np.full(n, np.nan)
        ratio[sd_usable] = sd_last[sd_usable] / sd_first[sd_usable]
        shift = np.full(n, np.nan)
        shifted = sd_usable & have_mean
        shift[shifted] = (mean_last[shifted] - mean_first[shifted]) / sd_first[shifted]

    mean_reason = np.full(n, None, dtype=object)
    mean_reason[exact_zero] = (
        "the first-iteration mean is exactly 0, so a percent change is undefined"
    )
    mean_reason[too_small] = (
        f"the first-iteration mean is less than {near_zero_factor:g} x the first-iteration sd, "
        "so a percent change would be unstable"
    )
    sd_reason = np.full(n, None, dtype=object)
    sd_reason[no_spread] = (
        "no spread in the first iteration (its sd is 0), so the sd change, the sd ratio and "
        "the shift in sd units are undefined"
    )
    return ParameterChange(
        mean_change_pct=mean_pct,
        mean_change_refused=mean_reason,
        sd_change_pct=sd_pct,
        sd_change_refused=sd_reason,
        sd_ratio=ratio,
        mean_shift_sd=shift,
    )


def _names_text(names) -> str:
    return ", ".join(repr(n) for n in list(names)[:_EXAMPLES])


def _count_note(count: int, what: str, names) -> str:
    return f"{count} parameter(s) {what}; for example {_names_text(names)}"


def write_par_change(
    first: int, last: int, layout: CacheLayout
) -> WrittenArtifact | ReadFailure:
    """Write ``agg/par_change.parquet`` and then its sidecar
    ``agg/par_change.json``, or leave nothing behind. Reads the cached
    ``par_ens/first`` and ``par_ens/last`` and the cached control table.

    With ``first == last`` only one iteration was ingested: the first-iteration
    columns are filled, the last-iteration moments are missing, and the sidecar
    says why."""
    name = "par_change"
    payload_path = layout.par_change
    sidecar_path = layout.par_change_meta
    written: list[Path] = []
    try:
        single = first == last
        stored_first = load_stored(first, layout)
        if isinstance(stored_first, ReadFailure):
            return _fail(
                name,
                stored_first.path,
                f"the parameter ensemble of iteration {first} could not be read: "
                f"{stored_first.reason}",
            )
        stored_last = stored_first if single else load_stored(last, layout)
        if isinstance(stored_last, ReadFailure):
            return _fail(
                name,
                stored_last.path,
                f"the parameter ensemble of iteration {last} could not be read: "
                f"{stored_last.reason}",
            )
        loaded = load_control_table(
            layout, "par", columns=["parnme", "pargp", "partrans", "parlbnd", "parubnd"]
        )
        if isinstance(loaded, ReadFailure):
            return _fail(name, loaded.path, f"the control table: {loaded.reason}")
        table, _table_notes = loaded
        parnme = [str(v) for v in table.column("parnme").to_pylist()]
        for stored in (stored_first, stored_last):
            if tuple(parnme) != tuple(stored.par_names):
                return _fail(
                    name,
                    payload_path,
                    f"the control table and the ensemble of iteration {stored.iteration} "
                    "do not hold the same parameters in the same order; ingest the run again",
                )
        n_par = len(parnme)
        pargp = [str(v) for v in table.column("pargp").to_pylist()]
        partrans = [str(v).strip().lower() for v in table.column("partrans").to_pylist()]
        lower = table.column("parlbnd").to_numpy().astype(np.float64)
        upper = table.column("parubnd").to_numpy().astype(np.float64)
        log_mask = np.array([t == "log" for t in partrans], dtype=bool)
        adjustable = np.array([t in ("log", "none") for t in partrans], dtype=bool)

        notes: list[str] = []
        if single:
            rows_first = np.arange(len(stored_first.real_names))
            rows_last = rows_first
            only_first: tuple[str, ...] = ()
            only_last: tuple[str, ...] = ()
            n_common = len(rows_first)
        else:
            aligned = align_realizations(stored_first.real_names, stored_last.real_names)
            if not aligned.names:
                return _fail(
                    name,
                    payload_path,
                    f"no realization name is shared between iteration {first} and "
                    f"iteration {last}",
                )
            rows_first = np.asarray(aligned.index_a, dtype=np.int64)
            rows_last = np.asarray(aligned.index_b, dtype=np.int64)
            only_first, only_last = aligned.only_a, aligned.only_b
            n_common = len(aligned.names)
            notes.extend(aligned.notes)

        sidecar_path.unlink(missing_ok=True)

        bounds = (lower, upper, adjustable)
        moments_first = parameter_moments(stored_first, rows_first, log_mask, bounds)
        moments_last = (
            moments_first
            if single
            else parameter_moments(stored_last, rows_last, log_mask, bounds)
        )

        kind = np.full(n_par, None, dtype=object)
        reason = np.full(n_par, None, dtype=object)
        fixed = np.array([t == "fixed" for t in partrans])
        tied = np.array([t == "tied" for t in partrans])
        unknown = ~adjustable & ~fixed & ~tied
        no_values = adjustable & (
            (moments_first.n_valid == 0) | (False if single else moments_last.n_valid == 0)
        )
        nonpositive = (
            adjustable
            & ~no_values
            & ((moments_first.n_nonpositive > 0) | (False if single else moments_last.n_nonpositive > 0))
        )
        kind[fixed], reason[fixed] = "fixed", "fixed parameter, never adjusted"
        kind[tied], reason[tied] = "tied", "tied parameter, follows another parameter"
        for position in np.flatnonzero(unknown):
            kind[position] = "unknown_transform"
            reason[position] = f"unknown parameter transform {partrans[position]!r}"
        for position in np.flatnonzero(no_values):
            where = first if moments_first.n_valid[position] == 0 else last
            kind[position] = "no_values"
            reason[position] = f"no values in iteration {where}"
        looked_at = [(first, moments_first)] if single else [(first, moments_first), (last, moments_last)]
        for position in np.flatnonzero(nonpositive):
            parts = []
            for number, moments in looked_at:
                if moments.n_nonpositive[position] > 0:
                    parts.append(
                        f"{int(moments.n_nonpositive[position])} non-positive value(s) in "
                        f"iteration {number}"
                    )
            kind[position] = "nonpositive_log"
            reason[position] = "log-transformed, but holds " + " and ".join(parts)
        included = np.array([k is None for k in kind], dtype=bool)

        def _left_out(values: np.ndarray) -> np.ndarray:
            out = np.array(values, dtype=np.float64)
            out[~included] = np.nan
            return out

        change = parameter_change(
            _left_out(moments_first.mean),
            _left_out(moments_first.sd),
            _left_out(moments_last.mean) if not single else np.full(n_par, np.nan),
            _left_out(moments_last.sd) if not single else np.full(n_par, np.nan),
        )

        def _counts(values: np.ndarray, missing: np.ndarray) -> pd.arrays.IntegerArray:
            return pd.array(
                [None if m else int(v) for v, m in zip(values, missing)], dtype="Int64"
            )

        frame = pd.DataFrame(
            {
                "parnme": pd.Series(parnme, dtype="object"),
                "pargp": pd.Series(pargp, dtype="object"),
                "partrans": pd.Series(partrans, dtype="object"),
                "space": pd.Series(["log10" if m else "native" for m in log_mask], dtype="object"),
                "included": included,
                "excluded_kind": pd.Series(kind, dtype="object"),
                "excluded_reason": pd.Series(reason, dtype="object"),
                "mean_first": _left_out(moments_first.mean),
                "sd_first": _left_out(moments_first.sd),
                "mean_last": np.full(n_par, np.nan) if single else _left_out(moments_last.mean),
                "sd_last": np.full(n_par, np.nan) if single else _left_out(moments_last.sd),
                "mean_change_pct": change.mean_change_pct,
                "mean_change_refused": pd.Series(change.mean_change_refused, dtype="object"),
                "sd_change_pct": change.sd_change_pct,
                "sd_change_refused": pd.Series(change.sd_change_refused, dtype="object"),
                "sd_ratio": change.sd_ratio,
                "mean_shift_sd": change.mean_shift_sd,
                "near_lower_first": _counts(moments_first.near_lower, moments_first.near_missing),
                "near_upper_first": _counts(moments_first.near_upper, moments_first.near_missing),
                "near_lower_last": _counts(moments_last.near_lower, moments_last.near_missing),
                "near_upper_last": _counts(moments_last.near_upper, moments_last.near_missing),
            }
        )
        payload_bytes = _write_parquet_atomic(frame, payload_path)
        written.append(payload_path)

        counts = {
            "n_par": n_par,
            "n_included": int(included.sum()),
            "n_fixed": int(fixed.sum()),
            "n_tied": int(tied.sum()),
            "n_nonpositive_log": int(nonpositive.sum()),
            "n_no_values": int(no_values.sum()),
            "n_unknown_transform": int(unknown.sum()),
            "n_mean_change_refused": int(sum(r is not None for r in change.mean_change_refused)),
            "n_no_spread": int(sum(r is not None for r in change.sd_change_refused)),
        }
        examples = {
            label: [parnme[i] for i in np.flatnonzero(mask)[:_EXAMPLES]]
            for label, mask in (
                ("nonpositive_log", nonpositive),
                ("no_values", no_values),
                ("unknown_transform", unknown),
            )
        }
        if counts["n_fixed"] or counts["n_tied"]:
            notes.append(
                f"{counts['n_fixed']} fixed and {counts['n_tied']} tied parameter(s) are left out "
                "of the change and of the statistics, because pestpp never adjusts them"
            )
        if counts["n_nonpositive_log"]:
            notes.append(
                _count_note(
                    counts["n_nonpositive_log"],
                    "are log-transformed but hold a value that is not positive, so they have no "
                    "mean or sd in log space and are left out of the change",
                    examples["nonpositive_log"],
                )
            )
        if counts["n_no_values"]:
            notes.append(
                _count_note(
                    counts["n_no_values"],
                    "hold no value in one of the two iterations and are left out",
                    examples["no_values"],
                )
            )
        if counts["n_unknown_transform"]:
            notes.append(
                _count_note(
                    counts["n_unknown_transform"],
                    "have a transform pesto does not know and are left out",
                    examples["unknown_transform"],
                )
            )
        refused_names = [parnme[i] for i, r in enumerate(change.mean_change_refused) if r is not None]
        if refused_names:
            notes.append(
                _count_note(
                    len(refused_names),
                    f"have a first-iteration mean under {NEAR_ZERO_FACTOR:g} x their sd (or exactly "
                    "0), so their percent change is refused; their shift in sd units is kept",
                    refused_names,
                )
            )
        spreadless = [parnme[i] for i, r in enumerate(change.sd_change_refused) if r is not None]
        if spreadless:
            notes.append(
                _count_note(
                    len(spreadless),
                    "have no spread in the first iteration, so they have no sd change, sd ratio "
                    "or shift",
                    spreadless,
                )
            )
        bad_bounds = adjustable & log_mask & ~((lower > 0) & (upper > 0))
        if bad_bounds.any():
            notes.append(
                _count_note(
                    int(bad_bounds.sum()),
                    "are log-transformed with a bound that is not positive, so their near-bound "
                    "counts are missing",
                    [parnme[i] for i in np.flatnonzero(bad_bounds)],
                )
            )

        sidecar = {
            "cache_version": CACHE_VERSION,
            "first_iteration": int(first),
            "last_iteration": int(last),
            "single_iteration": single,
            "n_real_first": len(stored_first.real_names),
            "n_real_last": len(stored_last.real_names),
            "n_common": int(n_common),
            "only_first": {"count": len(only_first), "names": list(only_first[:_EXAMPLES])},
            "only_last": {"count": len(only_last), "names": list(only_last[:_EXAMPLES])},
            "near_zero_factor": NEAR_ZERO_FACTOR,
            "near_bound_note": NEAR_BOUND_NOTE,
            "counts": counts,
            "reason": (
                f"only iteration {first} was ingested, so there is no before and after"
                if single
                else None
            ),
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
            f"failed to write the parameter change: {exc} -- cleaned up {removed} file(s) "
            "already written for this artifact",
        )


def _read_json(name: str, path: Path) -> dict | ReadFailure:
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return _fail(name, path, f"could not read {path.name}: {exc}")
    if not isinstance(raw, dict):
        return _fail(name, path, f"{path.name} is not a JSON object")
    if raw.get("cache_version") != CACHE_VERSION:
        return _fail(
            name,
            path,
            f"{path.name} was written at cache_version {raw.get('cache_version')!r}, "
            f"this reader expects {CACHE_VERSION}",
        )
    return raw


def load_par_change(layout: CacheLayout) -> tuple[pd.DataFrame, dict] | ReadFailure:
    """Read ``par_change`` back as a table and its sidecar. The sidecar and its
    ``cache_version`` are checked before the table is trusted."""
    name = "par_change"
    sidecar = _read_json(name, layout.par_change_meta)
    if isinstance(sidecar, ReadFailure):
        return sidecar
    try:
        int(sidecar["first_iteration"])
        int(sidecar["last_iteration"])
        int(sidecar["n_common"])
        bool(sidecar["single_iteration"])
        for side in ("only_first", "only_last"):
            int(sidecar[side]["count"])
            list(sidecar[side]["names"])
        if not isinstance(sidecar["notes"], list):
            raise TypeError("notes is not a list")
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(
            name,
            layout.par_change_meta,
            f"{layout.par_change_meta.name} is not shaped like a par_change sidecar: {exc}",
        )
    try:
        frame = pd.read_parquet(layout.par_change)
    except Exception as exc:
        return _fail(name, layout.par_change, f"could not read {layout.par_change.name}: {exc}")
    return frame, sidecar


# ---------------------------------------------------------------------------
# par_groups
# ---------------------------------------------------------------------------

_PCS_FIGURES = ("mean_change", "std_change", "num_at_near_lbound", "num_at_near_ubound")


def _read_pcs(path: Path | None, last: int) -> tuple[dict[str, dict] | None, str | None]:
    """pestpp's group summary by lower-cased group name, read by header name.
    The second item is a note saying why there is nothing to read, or what was
    absent from a file that was read."""
    if path is None:
        return None, f"the pcs.csv file for iteration {last} was not found"
    try:
        with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader, None)
            rows = list(reader)
    except OSError as exc:
        return None, f"{path.name} could not be read: {_base_names(str(exc))}"
    if not header:
        return None, f"{path.name} is empty, so pestpp's figures were not read"
    columns = [h.strip() for h in header]
    if "group" not in columns:
        return None, (
            f"{path.name} has no 'group' column (it has {', '.join(columns)}), so pestpp's "
            "figures were not read"
        )
    position = {c: i for i, c in enumerate(columns)}
    out: dict[str, dict] = {}
    for row in rows:
        if len(row) <= position["group"]:
            continue
        group = row[position["group"]].strip()
        if group in out:
            continue
        figures: dict[str, float | int | None] = {}
        for figure in _PCS_FIGURES:
            at = position.get(figure)
            value = None
            if at is not None and at < len(row):
                try:
                    value = float(row[at])
                except ValueError:
                    value = None
            if value is not None and not np.isfinite(value):
                value = None
            if value is not None and figure.startswith("num_"):
                value = int(value)
            figures[figure] = value
        out[group] = figures
    missing = [f for f in _PCS_FIGURES if f not in position]
    note = f"{path.name} has no column {', '.join(repr(m) for m in missing)}" if missing else None
    return out, note


# The record prints four significant digits, so a figure may be off by half a unit of the fourth.
_RECORD_DIGITS = 4
_RECORD_FIGURES = (
    ("mean_change", "mean_chg", "float"),
    ("std_change", "std_chg", "float"),
    ("num_at_near_lbound", "n_at_lbnd", "int"),
    ("num_at_near_ubound", "n_at_ubnd", "int"),
)


def _record_table(rec: RecFacts, csv_name: str) -> dict[str, RecGroupRow] | None:
    """The record's group table saved to ``csv_name`` by lower-cased group
    name, or None when the record holds none for that file."""
    for key, rows in rec.group_tables.items():
        if key.lower() == csv_name.lower():
            return {row.group.lower(): row for row in rows}
    return None


def _record_figures(table: dict[str, RecGroupRow]) -> dict[str, dict]:
    """The record's rows named the way the pcs.csv names its columns."""
    return {
        group: {csv_name: getattr(row, field) for csv_name, field, _kind in _RECORD_FIGURES}
        for group, row in table.items()
    }


def _record_tolerance(value: float) -> float:
    """Half a unit in the fourth significant digit of a printed ``value``."""
    if value == 0.0:
        return 0.0
    return 0.5 * 10.0 ** (int(np.floor(np.log10(abs(value)))) - (_RECORD_DIGITS - 1))


def _disagreements(csv_row: dict, record_row: RecGroupRow) -> list[tuple[str, float | int, float | int]]:
    """The figures where the csv and the record differ by more than the record's rounding."""
    found = []
    for csv_name, field, kind in _RECORD_FIGURES:
        ours, theirs = csv_row.get(csv_name), getattr(record_row, field)
        if ours is None or theirs is None:
            continue
        tolerance = 0.0 if kind == "int" else _record_tolerance(theirs)
        if abs(ours - theirs) > tolerance * (1.0 + 1e-9):
            found.append((csv_name, ours, theirs))
    return found


def _pestpp_entry(
    group: str,
    pcs: dict[str, dict] | None,
    file_name: str | None,
    file_note: str | None,
    *,
    source: str | None = None,
    record: dict[str, RecGroupRow] | None = None,
    record_name: str | None = None,
) -> dict:
    """pestpp's own figures for ``group``. ``source`` overrides the label when
    the figures came from the run record. ``record`` is the record's table for
    the same file as ``pcs``, compared against it when both exist."""
    entry: dict = {figure: None for figure in _PCS_FIGURES}
    entry["source"] = None
    entry["note"] = None
    if pcs is None:
        entry["note"] = file_note
        return entry
    lowered = group.lower()
    row = pcs.get(lowered)
    if row is None:
        entry["note"] = f"not joined: {file_name} has no row for group {lowered!r}"
        return entry
    entry.update(row)
    entry["source"] = source or f"pestpp, {file_name}"
    notes = []
    if lowered != group:
        notes.append(
            f"pestpp writes group names in lower case, so this group was joined on {lowered!r}"
        )
    if file_note:
        notes.append(file_note)
    record_row = record.get(lowered) if record is not None else None
    if record_row is not None:
        differing = _disagreements(row, record_row)
        if differing:
            parts = "; ".join(
                f"{name} is {ours:.10g} in {file_name} and {theirs:.10g} in {record_name}"
                for name, ours, theirs in differing
            )
            notes.append(
                f"{file_name} and the run record {record_name} disagree beyond the record's "
                f"{_RECORD_DIGITS}-digit rounding: {parts}"
            )
            entry["record"] = {
                "source": f"{record_name}, from the run record, {_RECORD_DIGITS} significant digits",
                **{name: getattr(record_row, field) for name, field, _kind in _RECORD_FIGURES},
            }
    entry["note"] = "; ".join(notes) if notes else None
    return entry


def _excluded_counts(block: pd.DataFrame) -> dict[str, int]:
    kinds = block["excluded_kind"]
    counts = {
        "fixed": int((kinds == "fixed").sum()),
        "tied": int((kinds == "tied").sum()),
        "nonpositive_log": int((kinds == "nonpositive_log").sum()),
        "no_values": int((kinds == "no_values").sum()),
        "unknown_transform": int((kinds == "unknown_transform").sum()),
    }
    return counts


def _nothing_to_adjust(n_par: int, excluded: dict[str, int]) -> str:
    parts = [f"{n} {label.replace('_', ' ')}" for label, n in excluded.items() if n]
    return f"no adjustable parameters: all {n_par} are left out ({', '.join(parts)})"


def _pesto_figure(included: pd.DataFrame, n_common: int) -> dict:
    refused = included["mean_change_refused"].notna()
    spreadless = included["sd_change_refused"].notna()
    mean_pct = included["mean_change_pct"].dropna()
    sd_pct = included["sd_change_pct"].dropna()
    shift = included["mean_shift_sd"].dropna()
    return {
        "mean_change_pct": _number(mean_pct.mean()) if len(mean_pct) else None,
        "sd_change_pct": _number(sd_pct.mean()) if len(sd_pct) else None,
        "mean_shift_sd_median": _number(shift.median()) if len(shift) else None,
        "n_used": int(len(mean_pct)),
        "n_refused_near_zero": int(refused.sum()),
        "n_no_spread": int(spreadless.sum()),
        "label": f"pesto, over the {n_common} realizations present in both iterations",
    }


_ABSOLUTE_PATH = re.compile(r"(?<![\w.:])/(?:[^/\s'\"]+/)+([^\s/'\"]+)")


def _base_names(text: str) -> str:
    """``text`` with every absolute path cut down to its file name, so a note
    that travels to the browser never carries a folder layout."""
    return _ABSOLUTE_PATH.sub(r"\1", text)


def _text(value) -> str | None:
    """A column cell as trimmed text, or None when it is blank or missing."""
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return None
    return str(value).strip() or None


def group_type(names, ptype_column) -> dict:
    """A group's PstFrom parameter type, from the ``ptype:`` token in each
    parameter name and from the ``ptype`` column of the control table.

    One value when everything stated agrees, ``"several"`` when it does not, and
    ``None`` with source ``"not stated"`` when neither names nor column say. An
    unknown tag is shown as written. ``ptype_column`` is one entry per name, or
    None when the control table has no such column."""
    names = list(names)
    tags = []
    for name in names:
        found = _PTYPE_TAG.search(str(name))
        tags.append(found.group(1) if found and found.group(1) else None)
    cells = [None] * len(names) if ptype_column is None else [_text(c) for c in ptype_column]
    from_names = {t for t in tags if t}
    from_column = {c for c in cells if c}
    if not from_names and not from_column:
        return {
            "value": None,
            "source": "not stated",
            "note": "no ptype tag in the parameter names and no ptype column",
        }
    if from_names and from_column:
        source = "parameter name and ptype column"
    else:
        source = "parameter name" if from_names else "ptype column"
    stated = from_names | from_column
    clash = next(
        ((n, t, c) for n, t, c in zip(names, tags, cells) if t and c and t != c), None
    )
    if clash is not None or len(stated) > 1:
        seen = ", ".join(sorted(stated))
        if clash is not None:
            name, tag, cell = clash
            note = (
                f"parameter {name!r}: its name says {tag!r} but the ptype column says {cell!r}; "
                f"types stated in this group: {seen}"
            )
        else:
            note = f"types stated in this group: {seen}"
        return {"value": "several", "source": source, "note": note}
    silent = sum(1 for t, c in zip(tags, cells) if not t and not c)
    note = f"{silent} of {len(names)} parameters state no type" if silent else None
    return {"value": next(iter(stated)), "source": source, "note": note}


def group_layer(placed_layers, rule: str | None, group_name: str, placement_note: str | None = None) -> dict:
    """A group's layer, zero-based when it comes from the grid placement.

    The placement wins: ``placed_layers`` are the layers of the group's placed
    parameters and ``rule`` the rule that placed them. Without one, the number
    after ``layer`` in the group name is shown exactly as written and never
    converted from one base to another. With neither, the layer is not stated.
    More than one layer is ``"several"``. ``placement_note`` says why there was
    no placement, and is kept on an answer that came from the name."""
    layers = sorted({int(v) for v in placed_layers if int(v) >= 0})
    if layers:
        source = f"placement rule {rule}" if rule else "placement"
        if len(layers) == 1:
            return {"value": layers[0], "source": source, "note": None}
        shown = ", ".join(str(v) for v in layers[:10]) + (" and more" if len(layers) > 10 else "")
        return {
            "value": "several",
            "source": source,
            "note": f"placed on layers {shown} (zero-based)",
        }
    written = sorted({int(v) for v in re.findall(LAYER_PATTERN, group_name or "", re.IGNORECASE)})
    extra = f"; {placement_note}" if placement_note else ""
    if len(written) == 1:
        return {
            "value": written[0],
            "source": "group name, as written",
            "note": "the number in the group name, shown as written and not converted" + extra,
        }
    if len(written) > 1:
        shown = ", ".join(str(v) for v in written)
        return {
            "value": "several",
            "source": "group name, as written",
            "note": f"the group name names layers {shown}, shown as written and not converted" + extra,
        }
    return {
        "value": None,
        "source": "not stated",
        "note": "no grid placement and no layer number in the group name" + extra,
    }


def group_sigma_ratio(sd_first, sd_last, included) -> dict:
    """The spread shrinkage of one group: the median of its parameters'
    ``sd_last / sd_first`` with the 10th and 90th percentile beside it.

    ``sd_first`` and ``sd_last`` are in pestpp's numeric space (log10 for a log
    parameter), one entry per parameter of the group; ``included`` marks the
    ones that count. Everything is float64 and the percentiles use numpy's
    default linear method. A parameter with no spread at the first iteration
    has no ratio and is counted in ``n_no_spread``. ``reason`` is None when a
    ratio came out, and says why none could when it did not."""
    sd_first = np.asarray(sd_first, dtype=np.float64)
    sd_last = np.asarray(sd_last, dtype=np.float64)
    included = np.asarray(included, dtype=bool)
    with np.errstate(all="ignore"):
        usable = included & np.isfinite(sd_first) & np.isfinite(sd_last)
        has_spread = usable & (sd_first > 0.0)
        n_no_spread = int((usable & (sd_first == 0.0)).sum())
        ratios = sd_last[has_spread] / sd_first[has_spread]
    if not included.any():
        reason = "no adjustable parameters in this group"
    elif not has_spread.any():
        reason = "no parameter in this group had any spread at the first iteration"
    else:
        reason = None
    if reason is not None:
        return {
            "median": None,
            "p10": None,
            "p90": None,
            "n_used": 0,
            "n_no_spread": n_no_spread,
            "reason": reason,
        }
    p10, p90 = np.percentile(ratios, [10, 90])
    return {
        "median": _number(np.median(ratios)),
        "p10": _number(p10),
        "p90": _number(p90),
        "n_used": int(ratios.size),
        "n_no_spread": n_no_spread,
        "reason": None,
    }


_SETTING = "ies_n_iter_reinflate"
_NAMES_REUSED = (
    "Pestpp reuses the prior's realization names for the new draws, so a join by name "
    "would pair unrelated realizations."
)


def _read_record(run: RunLayout) -> RecFacts | ReadFailure | None:
    """The run record of ``run`` read once, or None when it has none."""
    if run.rec is None:
        return None
    try:
        return read_rec(run.rec)
    except Exception as exc:
        return ReadFailure(
            name="rec",
            path=str(run.rec),
            reason=f"could not read the run record: {_base_names(str(exc))}",
        )


def _assess_reinflation(
    run: RunLayout, first: int, last: int, rec: RecFacts | ReadFailure | None
) -> tuple[ReinflationVerdict, ControlOptions | None]:
    """Ask whether the ensemble was reinflated between ``first`` and ``last``,
    from the run record already read and the control-file options."""
    try:
        options = scan_options(run.pst_path)
    except Exception as exc:
        options = ReadFailure(
            name="control file",
            path=str(run.pst_path),
            reason=f"could not read the options in the control file: {_base_names(str(exc))}",
        )
    verdict = assess_reinflation(run, first, last, rec, options)
    return verdict, options if isinstance(options, ControlOptions) else None


def _source_name(evidence, run: RunLayout, options: ControlOptions | None) -> str:
    """The file or setting one piece of evidence came from, by base name."""
    if evidence.source == "run record":
        return run.rec.name if run.rec is not None else "the run record"
    if evidence.source == "files present":
        path = run.pcs.get((evidence.iteration, "reinflate"))
        return path.name if path is not None else "a reinflate pcs file"
    reading = options.get(_SETTING) if options is not None else None
    if reading is None:
        return f"the {_SETTING} setting"
    return f"{reading.raw_key} {reading.value} in {options.path_name}"


def _reinflation_json(verdict: ReinflationVerdict) -> dict:
    findings = [
        {
            "iteration": iteration,
            "in_range": any(e.in_range for e in evidence),
            "evidence": [
                {"source": e.source, "text": e.text, "in_range": e.in_range} for e in evidence
            ],
        }
        for iteration, evidence in verdict.findings
    ]
    notes = list(verdict.notes)
    for iteration, evidence in verdict.findings:
        if iteration is not None and not any(e.in_range for e in evidence):
            notes.append(
                f"a reinflation at iteration {iteration} was found, but it lies outside "
                f"iterations {verdict.first} to {verdict.last}, so it does not touch the ratio"
            )
    return {
        "verdict": verdict.verdict,
        "first": verdict.first,
        "last": verdict.last,
        "findings": findings,
        "checked": list(verdict.checked),
        "notes": notes,
    }


def _capital(text: str) -> str:
    return text[:1].upper() + text[1:]


def _reinflation_refusal(verdict: ReinflationVerdict, run: RunLayout, options: ControlOptions | None) -> str:
    """The sentence shown in place of a ratio across a reinflation: the
    iteration, every source that found it, and why a join by name misleads."""
    placed = []
    for iteration, evidence in verdict.findings:
        hits = [e for e in evidence if e.in_range]
        if hits:
            names = ", ".join(dict.fromkeys(_source_name(e, run, options) for e in hits))
            placed.append((iteration, names))
    if len(placed) == 1:
        iteration, names = placed[0]
        head = (
            f"Not shown: the ensemble was reinflated at iteration {iteration}, so the spread "
            f"before and after is not comparable (source: {names})."
        )
    else:
        listed = " and ".join(f"iteration {i} (source: {names})" for i, names in placed)
        head = (
            f"Not shown: the ensemble was reinflated at {listed}, so the spread before and "
            "after is not comparable."
        )
    disagree = [_capital(n) + "." for n in verdict.notes if n.startswith("the sources disagree")]
    return " ".join([head, *disagree, _NAMES_REUSED])


def _unchecked_warning(verdict: ReinflationVerdict) -> str:
    looked = "; ".join(verdict.checked)
    notes = " ".join(_capital(n) + "." for n in verdict.notes)
    text = (
        "Reinflation could not be checked, so this ratio may compare draws that are not "
        f"related. Looked for: {looked}."
    )
    return f"{text} {notes}" if notes else text


def _group_sigma_entry(
    included: pd.DataFrame,
    single: bool,
    single_reason: str,
    nothing_reason: str | None,
    reinflation_refusal: str | None,
    unchecked_warning: str | None,
) -> dict:
    """One group's ``sigma_ratio``: shown, shown with a warning (``unchecked``)
    or refused, and the reason for anything but shown. Refusals that come
    before any arithmetic leave every figure None."""

    def refused(reason: str, computed: dict | None = None) -> dict:
        entry = {"median": None, "p10": None, "p90": None, "n_used": None, "n_no_spread": None}
        if computed is not None:
            entry["n_used"], entry["n_no_spread"] = computed["n_used"], computed["n_no_spread"]
        return {"state": "refused", **entry, "reason": reason}

    if included.empty:
        return refused(nothing_reason or "no adjustable parameters in this group")
    if single:
        return refused(single_reason)
    if reinflation_refusal is not None:
        return refused(reinflation_refusal)
    computed = group_sigma_ratio(
        included["sd_first"].to_numpy(), included["sd_last"].to_numpy(), np.ones(len(included), dtype=bool)
    )
    if computed["reason"] is not None:
        return refused(computed["reason"], computed)
    state = "unchecked" if unchecked_warning is not None else "shown"
    return {
        "state": state,
        **{k: computed[k] for k in ("median", "p10", "p90", "n_used", "n_no_spread")},
        "reason": unchecked_warning,
    }


def drill_down_offer(n_par: int, limit: int) -> dict:
    """Whether a group of ``n_par`` parameters is offered a per-parameter
    drill-down, and the sentence to show when it is not."""
    if n_par <= limit:
        return {"offered": True, "reason": None}
    return {
        "offered": False,
        "reason": f"This group has {n_par:,} parameters. Drill-down is offered up to {limit:,}.",
    }


def write_par_groups(run_dir: Path, layout: CacheLayout) -> WrittenArtifact | ReadFailure:
    """Write ``agg/par_groups.json``: one entry per parameter group, in the
    order the control table first names them. ``run_dir`` is read only to find
    pestpp's own group summary (the last iteration's plain ``pcs.csv``, or the
    run record's table when that is missing) and the reinflation evidence."""
    name = "par_groups"
    path = layout.par_groups
    try:
        loaded = load_par_change(layout)
        if isinstance(loaded, ReadFailure):
            return _fail(name, loaded.path, f"par_change could not be read: {loaded.reason}")
        frame, meta = loaded
        first, last = int(meta["first_iteration"]), int(meta["last_iteration"])
        single = bool(meta["single_iteration"])
        n_common = int(meta["n_common"])
        run_notes: list[str] = []

        pcs_path = None
        run_layout: RunLayout | None = None
        try:
            run_layout = discover(Path(run_dir))
            pcs_path = run_layout.pcs_file(last)
        except Exception as exc:
            run_notes.append(
                f"the run folder could not be searched for a pcs.csv file: {_base_names(str(exc))}"
            )
        rec = _read_record(run_layout) if run_layout is not None else None
        pcs, pcs_note = _read_pcs(pcs_path, last)
        pcs_name = pcs_path.name if pcs_path is not None else None
        if pcs is not None and pcs_note:
            run_notes.append(pcs_note)
            pcs_note = None
        record_table = None
        if isinstance(rec, RecFacts):
            record_table = _record_table(rec, pcs_name or f"{run_layout.case}.{last}.pcs.csv")
            run_notes.extend(n for n in rec.notes if n.startswith("the parameter group table"))
        pestpp_source = None
        if pcs is None and record_table is not None:
            pcs, pcs_name = _record_figures(record_table), rec.name
            pestpp_source = f"{rec.name}, from the run record, 4 significant digits"
            pcs_note = (
                f"{pcs_note}; the figures are from the run record's group table instead"
                if pcs_note
                else "the figures are from the run record's group table"
            )

        control = load_control_table(layout, "par", columns=["parnme"], optional_columns=["ptype"])
        if isinstance(control, ReadFailure):
            return _fail(name, control.path, f"the control table: {control.reason}")
        control_table, _control_notes = control
        ptype_of: dict[str, str | None] | None = None
        if "ptype" in control_table.column_names:
            ptype_of = dict(
                zip(
                    (str(v) for v in control_table.column("parnme").to_pylist()),
                    control_table.column("ptype").to_pylist(),
                )
            )

        # Layers come from the grid placement joined by parameter name, never by row position.
        layer_of: dict[str, int] = {}
        rule_of: dict[str, str] = {}
        placement_note: str | None = None
        placement = load_par_cell(layout)
        if isinstance(placement, ReadFailure):
            why = _base_names(placement.reason)
            placement_note = f"no grid placement is available ({why})"
            run_notes.append(
                "the layer from the grid placement is unavailable: "
                f"{why}; layers come from group names where they carry one"
            )
        else:
            for pname, layer_number in zip(placement.parnme, placement.layer):
                if int(layer_number) >= 0:
                    layer_of[pname] = int(layer_number)
            rule_of = {g["group"]: g["rule"] for g in placement.groups}
            absent = len(set(frame["parnme"]) - set(placement.parnme))
            if absent:
                run_notes.append(
                    f"{absent} parameter(s) of the control table are not in the grid placement "
                    "and count as unplaced"
                )

        verdict: ReinflationVerdict | None = None
        control_options: ControlOptions | None = None
        if run_layout is not None:
            verdict, control_options = _assess_reinflation(run_layout, first, last, rec)
            reinflation = _reinflation_json(verdict)
        else:
            reinflation = {
                "verdict": "unchecked",
                "first": first,
                "last": last,
                "findings": [],
                "checked": ["the run folder could not be searched, so nothing was looked for"],
                "notes": [],
            }
        reinflation_refusal = (
            _reinflation_refusal(verdict, run_layout, control_options)
            if verdict is not None and verdict.verdict == "found"
            else None
        )
        if verdict is None:
            unchecked_warning = "Reinflation could not be checked: " + "; ".join(reinflation["checked"]) + "."
        elif verdict.verdict == "unchecked":
            unchecked_warning = _unchecked_warning(verdict)
        else:
            unchecked_warning = None

        groups = []
        for group, block in frame.groupby("pargp", sort=False):
            group = str(group)
            excluded = _excluded_counts(block)
            n_par = int(len(block))
            included = block[block["included"]]
            if included.empty:
                pesto, reason = None, _nothing_to_adjust(n_par, excluded)
            elif single:
                pesto, reason = None, str(meta["reason"])
            else:
                pesto, reason = _pesto_figure(included, n_common), None
            counted = included["near_lower_last"].notna()
            at_bounds = {
                "near_lower": int(included.loc[counted, "near_lower_last"].sum()) if counted.any() else None,
                "near_upper": int(included.loc[counted, "near_upper_last"].sum()) if counted.any() else None,
                "n_counted": int(counted.sum()),
            }
            group_notes = []
            for kind, label in (
                ("nonpositive_log", "log parameter(s) left out for a value that is not positive"),
                ("no_values", "parameter(s) left out for holding no value"),
            ):
                hit = block.loc[block["excluded_kind"] == kind, "parnme"].tolist()
                if hit:
                    group_notes.append(_count_note(len(hit), label, hit))
            sigma = _group_sigma_entry(
                included, single, str(meta["reason"]), reason, reinflation_refusal, unchecked_warning
            )
            members = block["parnme"].tolist()
            placed = [layer_of[m] for m in members if m in layer_of]
            groups.append(
                {
                    "group": group,
                    "n_par": n_par,
                    "n_included": int(len(included)),
                    "excluded": excluded,
                    "type": group_type(
                        members,
                        None if ptype_of is None else [ptype_of.get(m) for m in members],
                    ),
                    "layer": group_layer(
                        placed,
                        rule_of.get(group),
                        group,
                        placement_note
                        or (None if placed else "the grid placement does not place this group"),
                    ),
                    "change": {
                        "pesto": pesto,
                        "pestpp": _pestpp_entry(
                            group,
                            pcs,
                            pcs_name,
                            pcs_note,
                            source=pestpp_source,
                            record=record_table if pestpp_source is None else None,
                            record_name=rec.name if isinstance(rec, RecFacts) else None,
                        ),
                        "reason": reason,
                    },
                    "sigma_ratio": sigma,
                    "at_bounds_last": at_bounds,
                    "drill_down": drill_down_offer(n_par, DRILL_DOWN_MAX_PARAMS),
                    "notes": group_notes,
                }
            )

        left_count = int(meta["only_first"]["count"]) + int(meta["only_last"]["count"])
        payload = {
            "cache_version": CACHE_VERSION,
            "first_iteration": first,
            "last_iteration": last,
            "n_common": n_common,
            "single_iteration": single,
            "left_out": {
                "count": left_count,
                "n_only_first": int(meta["only_first"]["count"]),
                "n_only_last": int(meta["only_last"]["count"]),
                "only_first": [str(n) for n in meta["only_first"]["names"]],
                "only_last": [str(n) for n in meta["only_last"]["names"]],
                "reason": (
                    f"a realization present in only one of iteration {first} and iteration "
                    f"{last} is left out of every change figure"
                    if left_count
                    else None
                ),
            },
            "reinflation": reinflation,
            "groups": groups,
            "notes": [*[str(n) for n in meta["notes"]], *run_notes],
        }
        # allow_nan=False makes a stray NaN fail here instead of writing a file no browser can parse.
        size = write_atomic_text(path, json.dumps(payload, indent=2, allow_nan=False))
        files = (CacheFile(path=str(path.relative_to(layout.root)), bytes=size),)
        return WrittenArtifact(name=name, files=files, notes=tuple(payload["notes"]))
    except Exception as exc:
        return _fail(name, path, f"failed to write the group summary: {exc}")


def load_par_groups(layout: CacheLayout) -> dict | ReadFailure:
    """Read ``par_groups.json`` back, refusing a file of the wrong version or shape."""
    name = "par_groups"
    raw = _read_json(name, layout.par_groups)
    if isinstance(raw, ReadFailure):
        return raw
    try:
        for key in ("first_iteration", "last_iteration", "n_common"):
            int(raw[key])
        if not isinstance(raw["groups"], list) or not isinstance(raw["notes"], list):
            raise TypeError("groups and notes must be lists")
        if not isinstance(raw["left_out"], dict):
            raise TypeError("left_out must be an object")
        for group in raw["groups"]:
            str(group["group"])
            int(group["n_par"])
            if not isinstance(group["change"], dict):
                raise TypeError("a group's change must be an object")
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(
            name,
            layout.par_groups,
            f"{layout.par_groups.name} is not shaped like a group summary: {exc}",
        )
    return raw
