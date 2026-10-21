"""Read the weights pestpp actually used, ``case.adjusted.weights.*``.

pestpp-ies adjusts observation weights (for example to balance groups or
zero out conflicting observations) and writes the result as a matrix with one
row per realization and one column per observation that has a weight. Phi
and the computed prior-data conflict are only right with these weights, not
the control file's.

The matrix is read through the same guarded path as an observation ensemble
(estimate first, refuse when it will not fit), kept as float64, and every
column is tied to its control-table row by name, never by position.

No module-level pyemu or flopy import: the heavy libraries load inside
``pesto.ingest.ensfile`` functions, after the guard has decided.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pesto.ingest.ensfile import (
    _clean,
    _orient_by_names,
    _OrientationUndecidable,
    _read_binary_matrix,
    _read_csv_matrix,
    sniff,
)
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsread import (
    MemoryBudget,
    _closest_axis,
    _examples,
    _refusal_reason,
    estimate_peak_bytes,
    memory_budget,
)


@dataclass(frozen=True, eq=False)
class AdjustedWeights:
    """The adjusted weights of one run.

    ``weights`` is float64, realizations by columns, exactly as the file
    holds them. ``real_names`` and ``obs_names`` are exactly as read, in file
    order. ``control_rows[j]`` is the control-table row of column ``j``,
    found by name. A control observation with no column has weight 0;
    ``n_unweighted`` counts them. Unhashable because it holds an array.
    """

    weights: np.ndarray
    real_names: tuple[str, ...]
    obs_names: tuple[str, ...]
    control_rows: np.ndarray
    n_unweighted: int
    source: Path
    notes: tuple[str, ...]

    __hash__ = None


def _name_problem(
    file_name: str, obs_names: tuple[str, ...], control_names: list[str]
) -> str | None:
    """Say what is wrong when a weights column is not a control observation or
    appears twice; ``None`` when every column is a distinct control name.
    A subset of the control observations is fine."""
    control_clean: dict[str, str] = {}
    for name in control_names:
        control_clean.setdefault(_clean(name), name)
    if len(control_clean) != len(control_names):
        return (
            f"{file_name}: two control observation names are the same after trimming "
            f"spaces and lower-casing, so weights columns cannot be matched to them by name."
        )
    counts = Counter(_clean(name) for name in obs_names)
    duplicated = list(dict.fromkeys(name for name in obs_names if counts[_clean(name)] > 1))
    extra = [name for name in obs_names if _clean(name) not in control_clean]
    if not extra and not duplicated:
        return None
    parts: list[str] = []
    if extra:
        parts.append(
            f"{file_name}: {len(extra)} file name(s) not in the control table{_examples(extra)}."
        )
    if duplicated:
        parts.append(
            f"{file_name}: {len(duplicated)} name(s) appear more than once in the file"
            f"{_examples(duplicated)}."
        )
    parts.append("pesto refuses rather than guess which column is which.")
    return " ".join(parts)


def _control_rows(
    obs_names: tuple[str, ...], control_names: list[str]
) -> tuple[np.ndarray, list[tuple[str, str]]]:
    """Each column's control row: an exact name first, then the trimmed and
    lower-cased name. Also returns the ``(file name, control name)`` pairs
    that matched only after cleaning."""
    exact = {name: i for i, name in enumerate(control_names)}
    cleaned = {_clean(name): i for i, name in enumerate(control_names)}
    rows = np.empty(len(obs_names), dtype=np.int64)
    repaired: list[tuple[str, str]] = []
    for j, name in enumerate(obs_names):
        if name in exact:
            rows[j] = exact[name]
        else:
            rows[j] = cleaned[_clean(name)]
            repaired.append((name, control_names[rows[j]]))
    return rows, repaired


def read_adjusted_weights(
    path: Path,
    control_names: list[str],
    *,
    artifact: str,
    budget: MemoryBudget | None = None,
) -> AdjustedWeights | ReadFailure:
    """Read an adjusted weights matrix and tie its columns to control rows by name.

    Returns an ``AdjustedWeights`` or a ``ReadFailure`` whose reason starts
    with ``artifact``. Never raises. Every column must be a control
    observation, once; a control observation with no column has weight 0.
    """
    file_path = Path(path)
    file_name = file_path.name
    notes: list[str] = []

    def fail(reason: str) -> ReadFailure:
        return ReadFailure(name=file_name, path=str(file_path), reason=f"{artifact}: {reason}")

    try:
        if not file_path.is_file():
            return fail(f"{file_name} is not on disk at {file_path}")
        estimate = estimate_peak_bytes(file_path)
        if estimate.nrow == 0 or estimate.ncol == 0:
            return fail(f"{file_name} holds no realizations")
        allowed = budget if budget is not None else memory_budget()
        if estimate.guarded_bytes > allowed.bytes:
            return fail(_refusal_reason(artifact, file_name, estimate, allowed))

        on_disk_format = sniff(file_path)
        if on_disk_format == "csv":
            raw_values, row_names, col_names = _read_csv_matrix(file_path, notes, np.float64)
        else:
            raw_values, row_names, col_names = _read_binary_matrix(file_path, np.float64)

        if raw_values.shape[0] == 0 or raw_values.shape[1] == 0:
            return fail(
                f"{file_name} holds no realizations (it has {raw_values.shape[0]} rows "
                f"and {raw_values.shape[1]} columns)"
            )

        try:
            values, real_names, obs_names, *_ = _orient_by_names(
                raw_values, row_names, col_names, list(control_names), "observations", notes
            )
        except _OrientationUndecidable as exc:
            closest = _closest_axis(row_names, col_names, list(control_names))
            problem = (
                _name_problem(file_name, closest, list(control_names))
                if closest is not None
                else None
            )
            return fail(f"{exc} {problem}" if problem else str(exc))

        problem = _name_problem(file_name, obs_names, list(control_names))
        if problem is not None:
            return fail(problem)

        control_rows, repaired = _control_rows(obs_names, list(control_names))
        if repaired:
            shown = ", ".join(f"{a!r} for {b!r}" for a, b in repaired[:3])
            notes.append(
                f"{len(repaired)} observation names in {file_name} matched the control table "
                f"only after trimming spaces and lower-casing (e.g. {shown})"
            )

        weights = np.ascontiguousarray(values, dtype=np.float64)
        if np.isnan(weights).any():
            notes.append(f"{file_name} contains at least one NaN weight")

        has_zero = (weights == 0).any(axis=0)
        has_positive = (weights > 0).any(axis=0)
        mixed = [obs_names[j] for j in np.flatnonzero(has_zero & has_positive)]
        if mixed:
            notes.append(
                f"{len(mixed)} observation(s) have weight 0 in some realizations and a "
                f"positive weight in others{_examples(mixed)}"
            )

        return AdjustedWeights(
            weights=weights,
            real_names=real_names,
            obs_names=obs_names,
            control_rows=control_rows,
            n_unweighted=len(control_names) - len(obs_names),
            source=file_path,
            notes=tuple(notes),
        )
    except Exception as exc:
        return fail(f"failed to read adjusted weights {file_name}: {exc}")
