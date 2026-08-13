"""Read one ensemble file, whatever shape pestpp-ies wrote it in.

Five on-disk shapes -- dense ``.bin``, modern ``.jcb``, legacy ``.jcb``,
realization-major CSV and variable-major CSV -- all read to the same
realization-major float32 array. The binary path goes through
``pyemu.Matrix.from_binary``, which already dispatches on the file's
12-byte header (RESEARCH.md Pattern 1); the pandas-returning matrix
converter and the two ``Ensemble``-subclass binary readers forbidden by
PROJECT.md never appear here.
"""

from __future__ import annotations

import csv as csv_module
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pesto.ingest.control import ControlTables
from pesto.ingest.failures import ReadFailure


@dataclass(frozen=True)
class EnsembleData:
    """One ensemble file's values and provenance together (D-02), so a
    caller can report e.g. "read from dense .bin, variable-major" without
    reaching into private state."""

    values: np.ndarray
    real_names: tuple[str, ...]
    entity_names: tuple[str, ...]
    source_path: Path
    on_disk_format: str
    orientation: str
    orientation_decided_by: str
    contiguous: bool
    notes: tuple[str, ...]


def sniff(path: Path) -> str:
    """Return ``"csv"`` for a ``.csv`` suffix (case-insensitively);
    otherwise read the 12-byte binary header and return ``"dense"`` when
    ``itemp1 == 0`` and ``itemp2 == icount``, ``"binary"`` otherwise --
    covering both the modern and legacy COO dialects that
    ``pyemu.Matrix.from_binary`` dispatches between internally
    (RESEARCH.md Pattern 1).

    The decision comes from the file's own bytes, never its extension: a
    dense file wearing a ``.jcb`` name still sniffs as ``"dense"``. A file
    too short to hold the 12-byte header raises here; ``read_ensemble``
    catches it and returns a ``ReadFailure`` rather than letting it escape
    as an unhandled exception.
    """
    from pesto.warm import load_pyemu

    file_path = Path(path)
    if file_path.suffix.lower() == ".csv":
        return "csv"

    pyemu = load_pyemu()
    with open(file_path, "rb") as f:
        header_bytes = f.read(12)
    if len(header_bytes) < 12:
        raise ValueError(f"{file_path.name}: too short to hold a 12-byte binary header")
    header = np.frombuffer(header_bytes, dtype=pyemu.Matrix.binary_header_dt, count=1)[0]
    itemp1 = int(header["itemp1"])
    itemp2 = int(header["itemp2"])
    icount = int(header["icount"])
    if itemp1 == 0 and itemp2 == icount:
        return "dense"
    return "binary"


def _read_binary_matrix(file_path: Path) -> tuple[np.ndarray, tuple[str, ...], tuple[str, ...]]:
    """Read a dense/JCO binary ensemble via ``pyemu.Matrix.from_binary``,
    the one entry point that dispatches all three binary dialects
    (RESEARCH.md Pattern 1). Values are cast to float32 immediately -- a
    measured near-free downcast -- so any later transpose for a
    variable-major file is a view over an already-float32 array, not a
    second copy."""
    from pesto.warm import load_pyemu

    pyemu = load_pyemu()
    matrix = pyemu.Matrix.from_binary(str(file_path))
    values = np.ascontiguousarray(matrix.x, dtype=np.float32)
    row_names = tuple(matrix.row_names)
    col_names = tuple(matrix.col_names)
    return values, row_names, col_names


def _read_csv_matrix(
    file_path: Path, notes: list[str]
) -> tuple[np.ndarray, tuple[str, ...], tuple[str, ...]]:
    """Read a CSV ensemble: the header row (after its first, label, cell)
    carries the column names, and each data row's first cell carries that
    row's name. Which axis is realizations and which is entities is not
    decided here -- that is the orientation decision, not the reader
    guessing (D-05).

    Every header cell is stripped of surrounding whitespace; a cell whose
    raw text differed from its stripped text is a real diagnostic about
    the run that produced the file (the documented ``standard_deviation``
    case), so a note names the column rather than silently fixing it.
    """
    with open(file_path, newline="") as f:
        reader = csv_module.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            raise ValueError(f"{file_path.name}: empty CSV file, no header row") from None

        col_names_list: list[str] = []
        for cell in header[1:]:
            stripped = cell.strip()
            if stripped != cell:
                notes.append(
                    f"column header {cell!r} in {file_path.name} was stripped to {stripped!r}"
                )
            col_names_list.append(stripped)

        row_names_list: list[str] = []
        value_rows: list[list[float]] = []
        for row in reader:
            if not row:
                continue
            row_names_list.append(row[0])
            value_rows.append([float(v) for v in row[1:]])

    if value_rows:
        raw_values = np.array(value_rows, dtype=np.float64)
    else:
        raw_values = np.zeros((0, len(col_names_list)), dtype=np.float64)

    values = np.ascontiguousarray(raw_values, dtype=np.float32)
    return values, tuple(row_names_list), tuple(col_names_list)


def read_ensemble(path: Path, tables: "ControlTables | None" = None) -> "EnsembleData | ReadFailure":
    """Read ``path`` into a realization-major float32 array.

    Names are taken verbatim from the file and never renumbered, sorted or
    replaced by control-file order -- this is READ-04, and it is the
    difference between reporting realization ``34`` and reporting
    realization ``1``.

    Orientation is decided by dimensions first, per D-05: when ``tables``
    is supplied, the column count is compared against
    ``len(tables.par)``; if they agree the file is realization-major, and
    if the row count agrees instead it is variable-major.
    ``orientation_decided_by`` records which of ``"dimensions"``,
    ``"names"`` or ``"assumed"`` decided it -- with no ``tables`` supplied,
    the tracer records ``"realization_major"`` decided by ``"assumed"``;
    Wave 3 replaces the assumed branch with the name-matching fallback and
    the refusal.

    ``sniff`` raising, a missing file, or any exception out of pyemu
    returns a ``ReadFailure`` named for ``path.name``.
    """
    file_path = Path(path)
    notes: list[str] = []
    try:
        on_disk_format = sniff(file_path)
        if on_disk_format == "csv":
            values, row_names, col_names = _read_csv_matrix(file_path, notes)
        else:
            values, row_names, col_names = _read_binary_matrix(file_path)

        if np.isnan(values).any():
            notes.append(f"{file_path.name} contains at least one NaN value")

        if tables is not None:
            n_par = len(tables.par)
            if len(col_names) == n_par:
                orientation = "realization_major"
                orientation_decided_by = "dimensions"
                real_names = row_names
                entity_names = col_names
                contiguous = True
            elif len(row_names) == n_par:
                # D-08: returned as a transposed view, not a materialised
                # copy -- the non-contiguity is recorded so a caller
                # iterating realizations off it knows it walks a strided
                # gather.
                orientation = "variable_major"
                orientation_decided_by = "dimensions"
                real_names = col_names
                entity_names = row_names
                values = values.T
                contiguous = False
            else:
                orientation = "realization_major"
                orientation_decided_by = "assumed"
                real_names = row_names
                entity_names = col_names
                contiguous = True
                notes.append(
                    f"neither axis of {file_path.name} matched the control file's "
                    f"{n_par} parameters; orientation assumed realization-major"
                )
        else:
            orientation = "realization_major"
            orientation_decided_by = "assumed"
            real_names = row_names
            entity_names = col_names
            contiguous = True

        return EnsembleData(
            values=values,
            real_names=real_names,
            entity_names=entity_names,
            source_path=file_path,
            on_disk_format=on_disk_format,
            orientation=orientation,
            orientation_decided_by=orientation_decided_by,
            contiguous=contiguous,
            notes=tuple(notes),
        )
    except Exception as exc:
        return ReadFailure(
            name=file_path.name,
            path=str(file_path),
            reason=f"failed to read ensemble {file_path.name}: {exc}",
        )
