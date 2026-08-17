"""The ordered rule table that puts parameters on cells.

This module is private because it is unavoidably MODFLOW-shaped:
``i * ncol + j`` is structured-grid arithmetic, ``idx0``/``idx1``/``idx2``
are ``PstFrom`` conventions, and a vertex grid having no rows or columns is
a MODFLOW fact, not a general one. It lives inside the boundary GRID-05
exists to hold, so nothing outside ``src/pesto/model/`` ever has to know
any of this.

Five rules are tried in order for every parameter group: ``kij``,
``idx-triple``, ``idx-pair``, ``ij-name-layer``, ``ij-single-layer``. The
first rule whose columns are present and that produces at least one
in-range hit takes the whole group.

Row positions used to write into the ``cell``/``layer`` arrays come from
``pandas.DataFrame.groupby(...).indices``, a mapping from group name to the
integer row positions that group occupies -- never from ``block.index``
label lookups, which break silently the moment two parameters share a
``parnme`` (label-based lookup then returns a row for every match, not one
row per request). A parameter nothing matched is ``-1``, never ``0``,
because ``0`` is a real cell and a stated absence beats a wrong answer that
looks right.

A parameter group that resolves ``unmapped`` is not itself unrecorded: its
``GroupResolution`` row is always kept, and a group additionally carrying
``layer``, ``icpl`` or ``node`` -- placement-looking columns the rule table
above does not read -- gets one note naming it and them, so real placement
data stored under an unrecognised name is never silently dropped. An
ordinary unmapped group carrying none of the rule table's columns gets no
note at all: a real ``PstFrom``-built DISV run is typically 99% unmapped
groups, and a note per group would turn "says so once" into a wall of text.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

from pesto.model import GridShape, GroupResolution, ParCells

DEFAULT_LAYER_PATTERN = r"layer[_-]?(\d+)"
RULE_NAMES = ("kij", "idx-triple", "idx-pair", "ij-name-layer", "ij-single-layer")
UNMAPPED = "unmapped"

UNRECOGNIZED_PLACEMENT_COLUMNS = ("layer", "icpl", "node")
"""Column names that look like placement metadata -- each reads like a cell
or layer index -- but that no rule in ``RULE_NAMES`` actually consults. A
real measured DISV run carries two groups (~918 parameters combined) whose
placement data lives under ``layer``/``icpl`` rather than ``idx0``/``idx1``
(03-RESEARCH.md Pitfall 5). The rule table is locked as written, so the fix
here is not a sixth rule -- it is a note saying the data was seen and
deliberately left unused, so it is distinguishable from a group that never
carried any placement data at all."""

_NAME_COLUMNS = ("pname", "pargp", "parnme")


def _numeric(block: pd.DataFrame, column: str) -> np.ndarray:
    """``block[column]`` coerced to numeric; a value that cannot be read as
    a number becomes ``NaN`` rather than being fabricated into anything
    else -- the same coerce-and-note idiom ``control.py`` uses, minus the
    note, since an unreadable placement value is already covered by the
    group's own "could not be placed" outcome."""
    return pd.to_numeric(block[column], errors="coerce").to_numpy(dtype=np.float64)


def _valid_mask(cell: np.ndarray, layer: np.ndarray, shape: GridShape) -> np.ndarray:
    """A candidate row is accepted only when both its cell and its layer
    are real numbers that land inside the grid -- the range check ported
    unchanged from the M0 reference, which is what keeps an out-of-range
    index at ``-1`` instead of wrapping onto a real cell."""
    finite = np.isfinite(cell) & np.isfinite(layer)
    safe_cell = np.where(finite, cell, -1.0)
    safe_layer = np.where(finite, layer, -1.0)
    in_range = (
        (safe_layer >= 0)
        & (safe_layer < shape.nlay)
        & (safe_cell >= 0)
        & (safe_cell < shape.ncpl)
    )
    return finite & in_range


def _candidate_kij(block: pd.DataFrame, shape: GridShape):
    if shape.ncol is None or not {"k", "i", "j"}.issubset(block.columns):
        return None
    layer = _numeric(block, "k")
    i = _numeric(block, "i")
    j = _numeric(block, "j")
    return i * shape.ncol + j, layer


def _candidate_idx_triple(block: pd.DataFrame, shape: GridShape):
    if shape.ncol is None or not {"idx0", "idx1", "idx2"}.issubset(block.columns):
        return None
    layer = _numeric(block, "idx0")
    i = _numeric(block, "idx1")
    j = _numeric(block, "idx2")
    return i * shape.ncol + j, layer


def _candidate_idx_pair(block: pd.DataFrame, shape: GridShape):
    if shape.ncol is not None or not {"idx0", "idx1"}.issubset(block.columns):
        return None
    layer = _numeric(block, "idx0")
    cell = _numeric(block, "idx1")
    return cell, layer


def _layer_from_names(block: pd.DataFrame, pattern: re.Pattern[str]) -> np.ndarray | None:
    """Search ``pname``, ``pargp`` and ``parnme`` in that order for a layer
    number -- matching the locked rule table's "layer parsed from ``pname``
    or ``pargp``" wording (03-RESEARCH.md Pattern 4) plus the M0 reference's
    ``parnme`` fallback.

    ``ControlTables.par`` never carries ``parnme`` as a column -- it is the
    table's own index -- so the reference implementation's bare
    ``frame["parnme"]`` lookup silently finds nothing and moves on, even
    though the name is right there on every row. The ``parnme`` case here
    reaches into ``block.index`` instead, when that index is named
    ``parnme``, so the rule can do what the table actually says.
    """
    for column in _NAME_COLUMNS:
        if column in block.columns:
            values = block[column].astype(str)
        elif column == "parnme" and block.index.name == "parnme":
            values = block.index.to_series().astype(str)
        else:
            continue
        found = values.str.extract(pattern, expand=False)
        if found.notna().any():
            numbers = pd.to_numeric(found, errors="coerce")
            # Names are conventionally one-based; layer indices are
            # zero-based.
            return (numbers - 1).to_numpy(dtype=np.float64)
    return None


def _candidate_ij_name_layer(block: pd.DataFrame, shape: GridShape, pattern: re.Pattern[str]):
    if shape.ncol is None or not {"i", "j"}.issubset(block.columns):
        return None
    layer = _layer_from_names(block, pattern)
    if layer is None:
        return None
    i = _numeric(block, "i")
    j = _numeric(block, "j")
    return i * shape.ncol + j, layer


def _candidate_ij_single_layer(block: pd.DataFrame, shape: GridShape):
    if shape.ncol is None or shape.nlay != 1 or not {"i", "j"}.issubset(block.columns):
        return None
    i = _numeric(block, "i")
    j = _numeric(block, "j")
    layer = np.zeros(len(block))
    return i * shape.ncol + j, layer


def _resolve_group(block: pd.DataFrame, shape: GridShape, pattern: re.Pattern[str]):
    """Try each rule in ``RULE_NAMES`` order; the first one whose columns
    are present and that produces at least one in-range hit takes the
    whole group. Rows that rule still cannot place stay ``-1`` within it --
    winning a group is not a promise that every row in it lands."""
    candidates = (
        ("kij", _candidate_kij(block, shape)),
        ("idx-triple", _candidate_idx_triple(block, shape)),
        ("idx-pair", _candidate_idx_pair(block, shape)),
        ("ij-name-layer", _candidate_ij_name_layer(block, shape, pattern)),
        ("ij-single-layer", _candidate_ij_single_layer(block, shape)),
    )
    for rule, candidate in candidates:
        if candidate is None:
            continue
        cell, layer = candidate
        valid = _valid_mask(cell, layer, shape)
        if valid.any():
            return rule, cell, layer, valid
    return UNMAPPED, None, None, None


def _unrecognized_column_note(name: object, block: pd.DataFrame) -> str | None:
    """One note if ``block`` carries any of ``UNRECOGNIZED_PLACEMENT_COLUMNS``
    with at least one non-null value; ``None`` otherwise. This is the only
    note an unmapped group ever gets -- a group carrying none of the rule
    table's columns and none of these look-alikes is the ordinary case and
    stays quiet, which is what keeps 777 unplaceable groups from becoming
    777 lines of prose."""
    present = [
        column
        for column in UNRECOGNIZED_PLACEMENT_COLUMNS
        if column in block.columns and block[column].notna().any()
    ]
    if not present:
        return None
    columns_text = ", ".join(repr(column) for column in present)
    return (
        f"group {name!r} carries {columns_text}, which look like placement data but "
        "which the rule table does not read (the rule table is locked as written); "
        "the data was seen and deliberately not used, and the group resolved unmapped"
    )


def _summarize(groups: tuple[GroupResolution, ...]) -> str:
    """The single sentence GRID-03 asks for -- built entirely from counts,
    never from a list of group names, so it does not grow with however many
    groups a real run happens to leave unplaceable."""
    if not groups:
        return "no parameter groups were present to place."

    unplaced = tuple(g for g in groups if g.mapped == 0)
    if not unplaced:
        return f"every one of the {len(groups)} parameter group(s) was placed on the grid."

    total_params = sum(g.total for g in groups)
    unplaced_params = sum(g.total for g in unplaced)
    return (
        f"{len(unplaced)} of {len(groups)} parameter group(s) could not be placed on the "
        f"grid, accounting for {unplaced_params} of {total_params} parameters."
    )


def resolve(
    par: pd.DataFrame,
    shape: GridShape,
    layer_pattern: str = DEFAULT_LAYER_PATTERN,
) -> ParCells:
    """Place every parameter in ``par`` on a layer and cell, one group
    (``pargp``) at a time, trying the five rules in ``RULE_NAMES`` order.

    Row positions come from ``par.groupby("pargp", ...).indices``, a mapping
    from group name to the integer positions that group occupies in ``par``
    -- not from ``block.index`` or any other label-based lookup. ``par`` is
    indexed by ``parnme``, a string; a label-based lookup keyed on that
    index breaks silently the moment two parameters share a name, because
    pandas then returns every matching row for each request rather than one
    row per request, misaligning the write entirely. ``par`` itself is only
    read here, never mutated or reindexed.
    """
    n = len(par)
    cell = np.full(n, -1, dtype=np.int32)
    layer = np.full(n, -1, dtype=np.int32)
    notes: list[str] = []
    groups: list[GroupResolution] = []
    pattern = re.compile(layer_pattern, re.IGNORECASE)

    grouped = par.groupby("pargp", sort=True, observed=True)
    for name, block in grouped:
        # grouped.indices[name] gives integer row positions, computed by
        # groupby itself -- a label-based lookup (e.g. block.index) would
        # expand into more rows than the group has the moment two
        # parameters share a parnme, since pandas returns every match per
        # requested label rather than one row per request.
        positions = grouped.indices[name]
        rule, candidate_cell, candidate_layer, valid = _resolve_group(block, shape, pattern)
        total = len(block)

        if rule == UNMAPPED:
            note = _unrecognized_column_note(name, block)
            if note is not None:
                notes.append(note)
            groups.append(GroupResolution(group=str(name), rule=UNMAPPED, mapped=0, total=total))
            continue

        mapped_positions = positions[valid]
        cell[mapped_positions] = candidate_cell[valid].astype(np.int32)
        layer[mapped_positions] = candidate_layer[valid].astype(np.int32)
        mapped = int(valid.sum())
        if mapped < total:
            notes.append(
                f"group {name!r}: rule {rule!r} placed {mapped} of {total} parameters; "
                "the rest fell outside the grid's layer/cell range"
            )
        groups.append(GroupResolution(group=str(name), rule=rule, mapped=mapped, total=total))

    parnme = tuple(str(value) for value in par.index)
    groups_tuple = tuple(groups)
    return ParCells(
        cell=cell,
        layer=layer,
        parnme=parnme,
        groups=groups_tuple,
        summary=_summarize(groups_tuple),
        notes=tuple(notes),
    )
