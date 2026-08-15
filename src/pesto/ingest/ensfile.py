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


@dataclass(frozen=True, eq=False)
class EnsembleData:
    """One ensemble file's values and provenance together (D-02), so a
    caller can report e.g. "read from dense .bin, variable-major" without
    reaching into private state.

    ``permutation``, applied as a fancy index into ``entity_names``, yields
    the control-file order (D-07); it is ``None`` when no control tables
    were supplied to map against. ``entity_names`` itself is always left in
    file order -- nothing in the read path reorders the values.

    Two instances compare with ``==``: ``values`` is compared with
    ``numpy.array_equal``, every other field with plain ``==`` (02-REVIEW.md
    IN-03 -- the dataclass-generated ``__eq__`` would otherwise raise, since
    ``numpy.ndarray.__eq__`` returns an array rather than a bool). Comparing
    against a non-``EnsembleData`` object returns ``False`` rather than
    raising. This record is unhashable -- ``__hash__`` is ``None`` -- because
    it holds a mutable array; a hash derived from mutable data would either
    raise or lie about identity.
    """

    values: np.ndarray
    real_names: tuple[str, ...]
    entity_names: tuple[str, ...]
    source_path: Path
    on_disk_format: str
    orientation: str
    orientation_decided_by: str
    contiguous: bool
    permutation: tuple[int, ...] | None
    hash_ordered: bool
    notes: tuple[str, ...]

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, EnsembleData):
            return NotImplemented
        return (
            np.array_equal(self.values, other.values)
            and self.real_names == other.real_names
            and self.entity_names == other.entity_names
            and self.source_path == other.source_path
            and self.on_disk_format == other.on_disk_format
            and self.orientation == other.orientation
            and self.orientation_decided_by == other.orientation_decided_by
            and self.contiguous == other.contiguous
            and self.permutation == other.permutation
            and self.hash_ordered == other.hash_ordered
            and self.notes == other.notes
        )

    __hash__ = None


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


class _OrientationUndecidable(Exception):
    """Raised internally when neither dimensions nor names decide which
    axis is realizations. Caught by ``read_ensemble`` and turned into a
    ``ReadFailure`` whose reason is this exception's message verbatim
    (D-06) -- never surfaced to a caller as an unhandled exception."""


# D-05's name-matching margin: the winning axis must match at least this
# fraction of its own names against the control file, while the losing
# axis matches no more than the lower fraction below. A bare majority
# (e.g. 51% vs 49%) is exactly the near-tie D-06 wants refused, not
# resolved by rounding -- so the margin between the two thresholds is
# deliberately wide rather than a single 50% cutoff.
_NAME_MATCH_MIN_FRACTION = 0.9
_NAME_MATCH_MAX_OTHER_FRACTION = 0.5


def _clean(name: str) -> str:
    """pyemu's binary readers strip and lower-case names as they read
    (RESEARCH.md Pattern 2); comparisons against control-file names must
    apply the same normalisation to both sides or a real match is missed."""
    return name.strip().lower()


def _match_fraction(candidate_names: tuple[str, ...], control_set: frozenset[str]) -> float:
    if not candidate_names:
        return 0.0
    matched = sum(1 for name in candidate_names if _clean(name) in control_set)
    return matched / len(candidate_names)


def _build_permutation(
    entity_names: tuple[str, ...], control_names: list[str]
) -> tuple[int, ...] | None:
    """Map control-file order onto file order (D-07): applying the
    returned tuple as a fancy index into ``entity_names`` yields the
    control-file order, while ``entity_names`` itself stays in file order
    and nothing is reordered. Every uncertainty resolves to ``None`` --
    when any control name cannot be found in ``entity_names``, no partial
    or best-effort permutation is offered."""
    index_by_name: dict[str, int] = {}
    for idx, name in enumerate(entity_names):
        index_by_name.setdefault(_clean(name), idx)
    permutation: list[int] = []
    for name in control_names:
        idx = index_by_name.get(_clean(name))
        if idx is None:
            return None
        permutation.append(idx)
    return tuple(permutation)


def _decide_orientation(
    values: np.ndarray,
    row_names: tuple[str, ...],
    col_names: tuple[str, ...],
    tables: "ControlTables | None",
    notes: list[str],
) -> tuple[
    np.ndarray,
    tuple[str, ...],
    tuple[str, ...],
    str,
    str,
    bool,
    tuple[int, ...] | None,
    bool,
]:
    """Decide which axis is realizations and which is entities.

    Dimensions first, names second (D-05): with no ``tables`` at all,
    orientation is *assumed* realization-major -- there is nothing to
    compare against, so ``orientation_decided_by`` says ``"assumed"``
    rather than claiming a decision was made, and the permutation is
    ``None``. With ``tables``, exactly one axis's count matching
    ``len(tables.par)`` decides it by ``"dimensions"``; neither axis
    matching, or both matching (a square ensemble), decides nothing and
    falls through to comparing the actual names, case-insensitively after
    stripping, against the control file's parameter names. The winning
    axis must match at least 90% of its own names while the other axis
    matches at most 50% -- a decisive margin, not a bare majority, per
    D-06. When names decide nothing either, this function raises
    ``_OrientationUndecidable`` naming the counts and axes that were
    tried, rather than guessing or silently transposing.

    This function validates against ``tables.par`` only, by design, never
    ``tables.obs`` -- that is a stated boundary, not an oversight. Reading
    observation ensemble content is out of scope for M0 (REQUIREMENTS.md Out
    of Scope); ``read_ensemble``'s ``kind`` argument is the seam a later
    milestone widens to let a caller validate against the observation table
    instead, without this function needing to guess which table applies.
    """
    if tables is None:
        return values, row_names, col_names, "realization_major", "assumed", True, None, False

    control_names = list(tables.par["parnme"])
    n_par = len(control_names)
    ncol = len(col_names)
    nrow = len(row_names)

    col_matches_dims = ncol == n_par
    row_matches_dims = nrow == n_par

    if col_matches_dims and not row_matches_dims:
        entity_is_columns = True
        decided_by = "dimensions"
    elif row_matches_dims and not col_matches_dims:
        entity_is_columns = False
        decided_by = "dimensions"
    else:
        # Dimensions decide nothing: neither side matched, or (a square
        # ensemble) both did. Fall through to name matching.
        control_set = frozenset(_clean(name) for name in control_names)
        col_fraction = _match_fraction(col_names, control_set)
        row_fraction = _match_fraction(row_names, control_set)

        if col_fraction >= _NAME_MATCH_MIN_FRACTION and row_fraction <= _NAME_MATCH_MAX_OTHER_FRACTION:
            entity_is_columns = True
            decided_by = "names"
        elif (
            row_fraction >= _NAME_MATCH_MIN_FRACTION and col_fraction <= _NAME_MATCH_MAX_OTHER_FRACTION
        ):
            entity_is_columns = False
            decided_by = "names"
        else:
            raise _OrientationUndecidable(
                f"ncol={ncol}, nrow={nrow}: neither axis's count matches the {n_par} "
                f"parameters in the control file's parameter table, which is the only "
                f"table this comparison was made against (column name match="
                f"{col_fraction:.0%}, row name match={row_fraction:.0%}). An observation "
                f"ensemble would look exactly like this -- pesto does not read observation "
                f"ensemble values yet, so if this file holds observations, pass "
                f'kind="obs" to read_ensemble to get that stated directly rather than '
                f"this refusal."
            )

    if entity_is_columns:
        real_names = row_names
        entity_names = col_names
        contiguous = True
    else:
        # D-08: returned as a transposed view, not a materialised copy --
        # the non-contiguity is recorded so a caller iterating
        # realizations off it knows it walks a strided gather.
        real_names = col_names
        entity_names = row_names
        values = values.T
        contiguous = False
        notes.append("variable-major file transposed to realization-major as a view")

    permutation = _build_permutation(entity_names, control_names)
    hash_ordered = permutation is not None and tuple(permutation) != tuple(range(len(permutation)))
    orientation = "realization_major" if entity_is_columns else "variable_major"
    return (
        values,
        real_names,
        entity_names,
        orientation,
        decided_by,
        contiguous,
        permutation,
        hash_ordered,
    )


def read_ensemble(
    path: Path, tables: "ControlTables | None" = None, kind: str = "par"
) -> "EnsembleData | ReadFailure":
    """Read ``path`` into a realization-major float32 array.

    Names are taken verbatim from the file and never renumbered, sorted or
    replaced by control-file order -- this is READ-04, and it is the
    difference between reporting realization ``34`` and reporting
    realization ``1``.

    ``kind`` states what the caller believes ``path`` holds, and is
    validated first, before any file is opened. ``kind="par"`` (the default)
    is the only path this function actually reads. ``kind="obs"`` refuses
    immediately with a ``ReadFailure`` saying plainly that pesto does not
    read observation ensemble values yet, that orientation can currently
    only be validated against the control file's parameter table, and that
    the file was still found and named -- so the caller learns a stated
    boundary rather than inferring a corrupt or unreadable file (02-REVIEW.md
    CR-01; reading observation ensemble content is out of M0's scope, and
    ``kind`` is the seam a later milestone widens). Any value other than
    ``"par"`` or ``"obs"`` refuses with a ``ReadFailure`` naming the value
    given and the two values this function accepts -- an unrecognised
    ``kind`` is never silently treated as ``"par"``, because a caller that
    believes it validated something it did not is worse off than one that
    got a plain refusal.

    Orientation is decided by dimensions first, names second, and refused
    with a stated reason when neither decides -- see
    ``_decide_orientation`` for the full rule and D-05/D-06.
    ``orientation_decided_by`` records which of ``"dimensions"``,
    ``"names"`` or ``"assumed"`` decided it.

    ``sniff`` raising, a missing file, an undecidable orientation, or any
    exception out of pyemu all resolve to a returned ``ReadFailure`` named
    for ``path.name`` -- never an exception out of this function. This
    function opens ``path`` for reading only; it never writes to,
    truncates, or re-timestamps the file it is pointed at.
    """
    file_path = Path(path)

    if kind == "obs":
        return ReadFailure(
            name=file_path.name,
            path=str(file_path),
            reason=(
                f"{file_path.name} was found and named, but pesto does not read "
                f"observation ensemble values yet -- orientation can only be validated "
                f'against the control file\'s parameter table in M0. Pass kind="par" once '
                f"observation ensemble reading is supported, or treat this file's "
                f"existence and name as everything M0 reports about it."
            ),
        )
    if kind != "par":
        return ReadFailure(
            name=file_path.name,
            path=str(file_path),
            reason=(
                f"read_ensemble was given kind={kind!r}, which it does not recognise -- "
                f'it accepts only "par" or "obs".'
            ),
        )

    notes: list[str] = []
    try:
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
                orientation_decided_by,
                contiguous,
                permutation,
                hash_ordered,
            ) = _decide_orientation(raw_values, row_names, col_names, tables, notes)
        except _OrientationUndecidable as exc:
            return ReadFailure(name=file_path.name, path=str(file_path), reason=str(exc))

        return EnsembleData(
            values=values,
            real_names=real_names,
            entity_names=entity_names,
            source_path=file_path,
            on_disk_format=on_disk_format,
            orientation=orientation,
            orientation_decided_by=orientation_decided_by,
            contiguous=contiguous,
            permutation=permutation,
            hash_ordered=hash_ordered,
            notes=tuple(notes),
        )
    except Exception as exc:
        return ReadFailure(
            name=file_path.name,
            path=str(file_path),
            reason=f"failed to read ensemble {file_path.name}: {exc}",
        )
