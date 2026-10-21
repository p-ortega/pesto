"""Read one observation ensemble file safely.

Observation ensembles can be huge (2,167,174 observations times 494
realizations is about 25.7 GB as COO), so the file is sized from its header
first and refused, with a reason, when it will not fit this machine. When it
fits it is read once through ``pyemu.Matrix.from_binary`` (or the existing
CSV reader) and its observation and realization names are matched to the
control table by name, never by position.

No module-level pyemu or flopy import: the heavy libraries load inside
``pesto.ingest.ensfile`` functions, after the guard has decided.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pesto.ingest.ensfile import (
    EnsembleData,
    _orient_by_names,
    _OrientationUndecidable,
    _read_binary_matrix,
    _read_csv_matrix,
    sniff,
)
from pesto.ingest.failures import ReadFailure

COO_RECORD_BYTES = 16
FLOAT64_BYTES = 8
NAME_OVERHEAD_BYTES = 300
ESTIMATE_MARGIN = 1.1
BUDGET_FRACTION = 0.6
FALLBACK_BUDGET_BYTES = 2 * 1024**3
CSV_MEMORY_FACTOR = 5

_HEADER_BYTES = 12
_COO_NAME_BYTES = 200


@dataclass(frozen=True)
class HeaderEstimate:
    """What the file's header says a read will cost, before anything is allocated."""

    file: str
    dialect: str
    nrow: int | None
    ncol: int | None
    icount: int | None
    raw_bytes: int
    guarded_bytes: int
    notes: tuple[str, ...]


@dataclass(frozen=True)
class MemoryBudget:
    """How many bytes one read may use on this machine, and why."""

    bytes: int
    physical_bytes: int | None
    fraction: float
    note: str


def _guard(raw_bytes: int) -> int:
    return math.ceil(raw_bytes * ESTIMATE_MARGIN)


def estimate_peak_bytes(path: Path) -> HeaderEstimate:
    """Size a read from the file header alone (modern COO dialect for now).

    Raises ``ValueError`` when the header and the file size disagree. All
    arithmetic is in Python integers, so a crafted header cannot overflow.
    """
    file_path = Path(path)
    size = file_path.stat().st_size
    with open(file_path, "rb") as f:
        head = f.read(_HEADER_BYTES)
    if len(head) < _HEADER_BYTES:
        raise ValueError(f"{file_path.name}: too short to hold a 12-byte binary header")
    itemp1, itemp2, icount = (int(v) for v in np.frombuffer(head, dtype="<i4", count=3))
    ncol, nrow = abs(itemp1), abs(itemp2)
    expected = _HEADER_BYTES + COO_RECORD_BYTES * icount + _COO_NAME_BYTES * (ncol + nrow)
    if expected != size:
        raise ValueError(
            f"{file_path.name}: its header implies a file of {expected} bytes but the file "
            f"is {size} bytes"
        )
    raw = (
        COO_RECORD_BYTES * icount
        + FLOAT64_BYTES * nrow * ncol
        + NAME_OVERHEAD_BYTES * (nrow + ncol)
    )
    return HeaderEstimate(
        file=file_path.name,
        dialect="coo",
        nrow=nrow,
        ncol=ncol,
        icount=icount,
        raw_bytes=raw,
        guarded_bytes=_guard(raw),
        notes=(),
    )


def memory_budget(fraction: float = BUDGET_FRACTION) -> MemoryBudget:
    physical = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    return MemoryBudget(
        bytes=int(physical * fraction), physical_bytes=int(physical), fraction=fraction, note=""
    )


def read_obs_file(
    path: Path,
    control_names: list[str],
    *,
    artifact: str,
    budget: MemoryBudget | None = None,
) -> EnsembleData | ReadFailure:
    """Read an observation ensemble file and match it to ``control_names`` by name.

    Returns an ``EnsembleData`` (values float32, names exactly as in the
    file, in file order, with the permutation that puts them in control
    order) or a ``ReadFailure`` whose reason starts with ``artifact``.
    """
    file_path = Path(path)
    notes: list[str] = []

    def fail(reason: str) -> ReadFailure:
        return ReadFailure(name=file_path.name, path=str(file_path), reason=f"{artifact}: {reason}")

    try:
        estimate = estimate_peak_bytes(file_path)
        allowed = budget if budget is not None else memory_budget()
        if estimate.guarded_bytes > allowed.bytes:
            return fail(f"reading {file_path.name} needs more memory than is allowed")

        on_disk_format = sniff(file_path)
        if on_disk_format == "csv":
            raw_values, row_names, col_names = _read_csv_matrix(file_path, notes)
        else:
            raw_values, row_names, col_names = _read_binary_matrix(file_path)

        if np.isnan(raw_values).any():
            notes.append(f"{file_path.name} contains at least one NaN value")

        try:
            (
                values,
                real_names,
                entity_names,
                orientation,
                decided_by,
                contiguous,
                permutation,
                hash_ordered,
            ) = _orient_by_names(
                raw_values, row_names, col_names, list(control_names), "observations", notes
            )
        except _OrientationUndecidable as exc:
            return fail(str(exc))

        return EnsembleData(
            values=values,
            real_names=real_names,
            entity_names=entity_names,
            source_path=file_path,
            on_disk_format=on_disk_format,
            orientation=orientation,
            orientation_decided_by=decided_by,
            contiguous=contiguous,
            permutation=permutation,
            hash_ordered=hash_ordered,
            notes=tuple(notes),
        )
    except Exception as exc:
        return fail(f"failed to read observation ensemble {file_path.name}: {exc}")
