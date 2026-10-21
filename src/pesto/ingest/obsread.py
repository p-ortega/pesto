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
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pesto.ingest.ensfile import (
    EnsembleData,
    _orient_by_names,
    _clean,
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
# pyemu's legacy dialect: a 12-byte record (int32 index, float64 value) and
# 12-character column names, 20-character row names.
_LEGACY_RECORD_BYTES = 12
_LEGACY_COL_NAME_BYTES = 12
_LEGACY_ROW_NAME_BYTES = 20
_DENSE_LENGTH_BYTES = 4


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


def _read_exact(f, n: int) -> bytes:
    data = f.read(n)
    if len(data) != n:
        raise ValueError("the file ended inside a header or name table")
    return data


def _estimate_dense(f, file_name: str, size: int, ncol: int) -> tuple[int, int]:
    """Count a dense file's rows by walking its row records (a 4-byte name
    length, the name, then ``ncol`` float64 values), never touching the
    values. Returns ``(nrow, name_bytes)`` and refuses a file whose records
    do not end exactly at the end of the file."""
    if _HEADER_BYTES + _DENSE_LENGTH_BYTES * ncol > size:
        raise ValueError(
            f"{file_name}: its header claims {ncol} columns but the file ({size} bytes) is "
            f"too small to hold their name lengths"
        )
    lengths = np.frombuffer(_read_exact(f, _DENSE_LENGTH_BYTES * ncol), dtype="<i4")
    if ncol and int(lengths.min()) < 0:
        raise ValueError(f"{file_name}: a column name length in the header is negative")
    name_bytes = int(lengths.sum(dtype=np.int64))
    position = _HEADER_BYTES + _DENSE_LENGTH_BYTES * ncol + name_bytes
    if position > size:
        raise ValueError(
            f"{file_name}: its column names would end at byte {position} but the file is "
            f"{size} bytes"
        )
    f.seek(position)
    nrow = 0
    row_name_bytes = 0
    while position < size:
        if position + _DENSE_LENGTH_BYTES > size:
            raise ValueError(
                f"{file_name}: a row record is cut off at byte {position} of {size}"
            )
        slen = int(np.frombuffer(_read_exact(f, _DENSE_LENGTH_BYTES), dtype="<i4")[0])
        record = _DENSE_LENGTH_BYTES + slen + FLOAT64_BYTES * ncol
        if slen < 0 or position + record > size:
            raise ValueError(
                f"{file_name}: row {nrow} needs {record} bytes from byte {position} but the "
                f"file is {size} bytes"
            )
        position += record
        f.seek(position)
        nrow += 1
        row_name_bytes += slen
    return nrow, name_bytes + row_name_bytes


def estimate_peak_bytes(path: Path) -> HeaderEstimate:
    """Size a read from the file's header, or its size for CSV, before
    anything is allocated.

    Modern COO and legacy COO are sized from the 12-byte header and checked
    against the real file size. Dense is sized from its name-length table
    and a walk over the row records. CSV is the file size times
    ``CSV_MEMORY_FACTOR``. Raises ``ValueError`` when a header and the file
    size disagree, naming both numbers. All arithmetic is in Python
    integers, so a crafted header cannot overflow.
    """
    file_path = Path(path)
    name = file_path.name
    size = file_path.stat().st_size

    if file_path.suffix.lower() == ".csv":
        raw = CSV_MEMORY_FACTOR * size
        return HeaderEstimate(
            file=name,
            dialect="csv",
            nrow=None,
            ncol=None,
            icount=None,
            raw_bytes=raw,
            guarded_bytes=_guard(raw),
            notes=(f"CSV memory is estimated at {CSV_MEMORY_FACTOR} times the file size",),
        )

    with open(file_path, "rb") as f:
        head = f.read(_HEADER_BYTES)
        if len(head) < _HEADER_BYTES:
            raise ValueError(f"{name}: too short to hold a 12-byte binary header")
        itemp1, itemp2, icount = (int(v) for v in np.frombuffer(head, dtype="<i4", count=3))

        if itemp1 == 0 and itemp2 == icount:
            ncol = abs(itemp2)
            nrow, name_bytes = _estimate_dense(f, name, size, ncol)
            raw = 16 * nrow * ncol + NAME_OVERHEAD_BYTES * (nrow + ncol)
            return HeaderEstimate(
                file=name,
                dialect="dense",
                nrow=nrow,
                ncol=ncol,
                icount=None,
                raw_bytes=raw,
                guarded_bytes=_guard(raw),
                notes=(),
            )

    if itemp1 > 0 and itemp2 < 0 and icount < 0:
        raise ValueError(
            f"{name}: this is a sequential Fortran binary file, whose size pesto cannot "
            f"work out from its header"
        )
    if icount < 0:
        raise ValueError(f"{name}: its header claims {icount} stored values")

    ncol, nrow = abs(itemp1), abs(itemp2)
    if itemp1 >= 0:
        dialect = "coo"
        expected = _HEADER_BYTES + COO_RECORD_BYTES * icount + _COO_NAME_BYTES * (ncol + nrow)
        raw = (
            COO_RECORD_BYTES * icount
            + FLOAT64_BYTES * nrow * ncol
            + NAME_OVERHEAD_BYTES * (nrow + ncol)
        )
    else:
        dialect = "legacy_coo"
        expected = (
            _HEADER_BYTES
            + _LEGACY_RECORD_BYTES * icount
            + _LEGACY_COL_NAME_BYTES * ncol
            + _LEGACY_ROW_NAME_BYTES * nrow
        )
        # The record array plus the int32 index arrays pyemu derives from it.
        raw = (
            (_LEGACY_RECORD_BYTES + 3 * 4) * icount
            + FLOAT64_BYTES * nrow * ncol
            + NAME_OVERHEAD_BYTES * (nrow + ncol)
        )
    if expected != size:
        raise ValueError(
            f"{name}: its header implies a file of {expected} bytes but the file is "
            f"{size} bytes"
        )
    return HeaderEstimate(
        file=name,
        dialect=dialect,
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


def _examples(names: list[str], limit: int = 3) -> str:
    if not names:
        return ""
    return " (e.g. " + ", ".join(repr(n) for n in names[:limit]) + ")"


def _match_problem(
    file_name: str, entity_names: tuple[str, ...], control_names: list[str]
) -> str | None:
    """Say what is wrong when the file's observation names and the control
    table's differ, or when a name appears twice; ``None`` when they agree.

    Equality is exact string equality first, then ``str.strip().lower()`` on
    both sides, by code point, with no Unicode normalisation.
    """
    control_by_clean: dict[str, str] = {}
    for name in control_names:
        control_by_clean.setdefault(_clean(name), name)
    if len(control_by_clean) != len(control_names):
        return (
            f"{file_name}: two control observation names are the same after trimming "
            f"spaces and lower-casing, so file columns cannot be matched to them by name."
        )

    file_counts = Counter(_clean(name) for name in entity_names)
    duplicated = [name for name in entity_names if file_counts[_clean(name)] > 1]
    missing = [name for name in control_names if _clean(name) not in file_counts]
    extra = [name for name in entity_names if _clean(name) not in control_by_clean]

    if not missing and not extra and not duplicated:
        return None

    parts: list[str] = []
    if missing or extra:
        matched = len(control_names) - len(missing)
        parts.append(
            f"{file_name}: matched {matched} of {len(control_names)} control observations; "
            f"{len(missing)} control name(s) missing from the file{_examples(missing)}; "
            f"{len(extra)} file name(s) not in the control table{_examples(extra)}."
        )
    if duplicated:
        distinct = list(dict.fromkeys(duplicated))
        parts.append(
            f"{file_name}: {len(distinct)} name(s) appear more than once in the file"
            f"{_examples(distinct)}."
        )
    parts.append("pesto refuses rather than guess which column is which.")
    return " ".join(parts)


def _closest_axis(
    row_names: tuple[str, ...], col_names: tuple[str, ...], control_names: list[str]
) -> tuple[str, ...] | None:
    """The one axis that shares names with the control table, when the other
    shares none. Used only to explain a refusal, never to read."""
    control_set = {_clean(name) for name in control_names}
    row_hits = sum(1 for name in row_names if _clean(name) in control_set)
    col_hits = sum(1 for name in col_names if _clean(name) in control_set)
    if col_hits and not row_hits:
        return col_names
    if row_hits and not col_hits:
        return row_names
    return None


def _repair_note(
    file_name: str, entity_names: tuple[str, ...], control_names: list[str]
) -> str | None:
    control_by_clean = {_clean(name): name for name in control_names}
    repaired = [
        (name, control_by_clean[_clean(name)])
        for name in entity_names
        if control_by_clean[_clean(name)] != name
    ]
    if not repaired:
        return None
    shown = ", ".join(f"{a!r} for {b!r}" for a, b in repaired[:3])
    return (
        f"{len(repaired)} observation names in {file_name} matched the control table only "
        f"after trimming spaces and lower-casing (e.g. {shown})"
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
        if not file_path.is_file():
            return fail(f"{file_path.name} is not on disk at {file_path}")
        estimate = estimate_peak_bytes(file_path)
        if estimate.nrow == 0 or estimate.ncol == 0:
            return fail(f"{file_path.name} holds no realizations")
        allowed = budget if budget is not None else memory_budget()
        if estimate.guarded_bytes > allowed.bytes:
            return fail(f"reading {file_path.name} needs more memory than is allowed")

        on_disk_format = sniff(file_path)
        if on_disk_format == "csv":
            raw_values, row_names, col_names = _read_csv_matrix(file_path, notes)
        else:
            raw_values, row_names, col_names = _read_binary_matrix(file_path)

        if raw_values.shape[0] == 0 or raw_values.shape[1] == 0:
            return fail(
                f"{file_path.name} holds no realizations (it has {raw_values.shape[0]} rows "
                f"and {raw_values.shape[1]} columns)"
            )

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
            closest = _closest_axis(row_names, col_names, list(control_names))
            problem = (
                _match_problem(file_path.name, closest, list(control_names))
                if closest is not None
                else None
            )
            return fail(f"{exc} {problem}" if problem else str(exc))

        problem = _match_problem(file_path.name, entity_names, list(control_names))
        if problem is not None:
            return fail(problem)
        if permutation is None:
            return fail(f"{file_path.name}: names could not be matched to the control table.")
        repair = _repair_note(file_path.name, entity_names, list(control_names))
        if repair is not None:
            notes.append(repair)

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
