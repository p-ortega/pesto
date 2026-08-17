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

Row positions used to write into the ``cell``/``layer`` arrays are integer
positions into the parameter table, never index labels -- the table is
indexed by parameter name, so treating that index as row numbers would put
parameters on the wrong cells with no error at all. A parameter nothing
matched is ``-1``, never ``0``, because ``0`` is a real cell and a stated
absence beats a wrong answer that looks right.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd

from pesto.model import GridShape, GroupResolution, ParCells

DEFAULT_LAYER_PATTERN = r"layer[_-]?(\d+)"
RULE_NAMES = ("kij", "idx-triple", "idx-pair", "ij-name-layer", "ij-single-layer")
UNMAPPED = "unmapped"

_RULE_COLUMNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("kij", ("k", "i", "j")),
    ("idx-triple", ("idx0", "idx1", "idx2")),
    ("idx-pair", ("idx0", "idx1")),
    ("ij-name-layer", ("i", "j")),
    ("ij-single-layer", ("i", "j")),
)

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


def _unmapped_reason(name: object, block: pd.DataFrame) -> str:
    """Distinguish, in plain English, "no rule's columns are present" from
    "columns are present but nothing landed in range" -- a group resolving
    to ``unmapped`` is not itself un-traced, even though no single row
    carries a note of its own."""
    any_columns_present = any(
        set(columns).issubset(block.columns) for _, columns in _RULE_COLUMNS
    )
    if not any_columns_present:
        return f"group {name!r} carries none of the placement columns any rule recognises"
    return (
        f"group {name!r} carries placement columns but no row landed inside "
        "the grid's layer/cell range"
    )


def _summarize(groups: tuple[GroupResolution, ...]) -> str:
    """The single sentence GRID-03 asks for -- said once, not repeated per
    group."""
    if not groups:
        return "no parameter groups were present to place."
    total = sum(g.total for g in groups)
    mapped = sum(g.mapped for g in groups)
    unplaced = sum(1 for g in groups if g.mapped == 0)
    return (
        f"{mapped} of {total} parameters were placed on the grid; "
        f"{unplaced} of {len(groups)} group(s) could not be placed at all."
    )


def resolve(
    par: pd.DataFrame,
    shape: GridShape,
    layer_pattern: str = DEFAULT_LAYER_PATTERN,
) -> ParCells:
    """Place every parameter in ``par`` on a layer and cell, one group
    (``pargp``) at a time, trying the five rules in ``RULE_NAMES`` order.

    Row positions are taken from ``par.index`` by lookup, never assumed to
    already be integer positions -- ``par`` is indexed by ``parnme``, a
    string, and writing into the positional ``cell``/``layer`` arrays with
    anything else would place a parameter on the wrong row with no error at
    all. ``par`` itself is only read here, never mutated or reindexed.
    """
    n = len(par)
    cell = np.full(n, -1, dtype=np.int32)
    layer = np.full(n, -1, dtype=np.int32)
    notes: list[str] = []
    groups: list[GroupResolution] = []
    pattern = re.compile(layer_pattern, re.IGNORECASE)
    row_position = pd.Series(np.arange(n), index=par.index)

    for name, block in par.groupby("pargp", sort=True, observed=True):
        positions = row_position.loc[block.index].to_numpy()
        rule, candidate_cell, candidate_layer, valid = _resolve_group(block, shape, pattern)
        total = len(block)

        if rule == UNMAPPED:
            notes.append(f"{_unmapped_reason(name, block)}; resolved as {UNMAPPED!r}")
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
