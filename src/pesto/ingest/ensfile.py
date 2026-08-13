"""Read one ensemble file, whatever shape pestpp-ies wrote it in.

Tracer scope is the binary path only -- both dense and JCO (modern and
legacy) formats go through ``pyemu.Matrix.from_binary``, which already
dispatches on the file's 12-byte header (RESEARCH.md Pattern 1). The
pandas-returning matrix converter and the two ``Ensemble``-subclass binary
readers forbidden by PROJECT.md never appear here.
"""

from __future__ import annotations

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
    ``itemp1 == 0`` and ``itemp2 == icount``, ``"binary"`` otherwise
    (RESEARCH.md Pattern 1)."""
    from pesto.warm import load_pyemu

    file_path = Path(path)
    if file_path.suffix.lower() == ".csv":
        return "csv"

    pyemu = load_pyemu()
    with open(file_path, "rb") as f:
        header = np.fromfile(f, pyemu.Matrix.binary_header_dt, 1)[0]
    itemp1 = int(header["itemp1"])
    itemp2 = int(header["itemp2"])
    icount = int(header["icount"])
    if itemp1 == 0 and itemp2 == icount:
        return "dense"
    return "binary"


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
    from pesto.warm import load_pyemu

    file_path = Path(path)
    notes: list[str] = []
    try:
        on_disk_format = sniff(file_path)
        pyemu = load_pyemu()
        matrix = pyemu.Matrix.from_binary(str(file_path))
        values = np.ascontiguousarray(matrix.x, dtype=np.float32)
        row_names = tuple(matrix.row_names)
        col_names = tuple(matrix.col_names)

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
