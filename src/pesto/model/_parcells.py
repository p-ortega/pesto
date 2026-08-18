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

A group that does place at least one parameter, but not all of them, gets a
shortfall note naming each reason a parameter went unplaced, with its own
count -- an unreadable value is never lumped in with one that was simply out
of range. Naming a real cause never turns an ordinary unmapped group into a
note: a value that is genuinely absent stays silent, which is what keeps the
same 99%-unmapped DISV run from gaining hundreds of notes just because this
module can now say more about the parameters that did win a rule.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
import pandas as pd

from pesto.ingest.failures import ReadFailure
from pesto.model import GridShape, GroupResolution, ParCells

DEFAULT_LAYER_PATTERN = r"layer[_-]?(\d+)"
RULE_NAMES = ("kij", "idx-triple", "idx-pair", "ij-name-layer", "ij-single-layer")
UNMAPPED = "unmapped"
GROUP_COLUMN = "pargp"

UNPLACED_REASONS: tuple[tuple[str, str], ...] = (
    ("out_of_range", "fell outside the grid's layer/cell range"),
    ("not_whole", "carried a value that is not a whole number"),
    ("unreadable", "carried a value that could not be read as a number"),
    ("absent", "carried no value at all"),
    ("no_layer_in_name", "carried no layer number in its name"),
    ("too_large", "carried a value too large to turn into a cell number"),
    ("unknown", "could not be placed and pesto could not tell why"),
)
"""The locked wording of every reason a parameter can go unplaced, and the
order its clauses appear in a shortfall note -- one place, so a reason
cannot drift between the code that counts it and the sentence that says it.
``unknown`` is a structural remainder: every known way a cell or layer can
come out unusable is named by one of the six causes ahead of it, and this
last one exists so a future producer of an unusable value cannot silently
break the counts."""

NO_GROUP = "(no pargp)"
"""The ``GroupResolution.group`` label for parameters carrying no ``pargp``
value at all. Parentheses because no real PEST group name has them, so this
bucket's label cannot collide with a real group."""

NULL_GROUP_NOTE_NAME_LIMIT = 3
"""How many parameter names the null-group note spells out before it
switches to a count -- keeps the note readable at the realistic scale of
one stray row, and one line even at 785 null rows, with nothing dropped."""

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


@dataclass
class _Rejections:
    """Per-row record of why each row of one candidate was refused, filled
    where the value is read -- by the time ``resolve()`` sees a ``NaN``
    every cause looks identical, which is why the reason has to be recorded
    here and not guessed later.

    ``absent``, ``unreadable``, ``not_whole`` and ``no_layer_in_name`` are
    filled inside ``_numeric``/``_layer_from_names`` as each column is read.
    ``too_large`` is different: it is filled centrally in
    ``_resolve_group``, because the value it describes -- an overflowed
    combined cell number -- does not exist until after the candidate
    arithmetic has run. ``columns_not_whole`` is the plain list of column
    names plan 03-05 already threads, kept for the existing column note.
    """

    absent: np.ndarray
    unreadable: np.ndarray
    not_whole: np.ndarray
    no_layer_in_name: np.ndarray
    too_large: np.ndarray
    columns_not_whole: list[str]

    @classmethod
    def blank(cls, n: int) -> "_Rejections":
        return cls(
            absent=np.zeros(n, dtype=bool),
            unreadable=np.zeros(n, dtype=bool),
            not_whole=np.zeros(n, dtype=bool),
            no_layer_in_name=np.zeros(n, dtype=bool),
            too_large=np.zeros(n, dtype=bool),
            columns_not_whole=[],
        )


def _numeric(block: pd.DataFrame, column: str, rejections: _Rejections) -> np.ndarray:
    """``block[column]`` coerced to numeric; a value that cannot be read as
    a number becomes ``NaN`` rather than being fabricated into anything
    else -- the same coerce-and-note idiom ``control.py`` uses.

    Records, into ``rejections``, which of this column's rows were absent
    (empty or missing), unreadable (present but not a number) or not a
    whole number -- a reason per row, not only a column name, so a later
    note can say which cause applied instead of guessing from a shared
    ``NaN``. ``absent`` and ``unreadable`` are computed on the coerced
    values *before* fractional values are folded into ``NaN``, so a
    fractional value is never also counted unreadable.
    """
    series = block[column]
    values = pd.to_numeric(series, errors="coerce").to_numpy(dtype=np.float64)
    absent = (series.isna() | series.astype(str).str.strip().eq("")).to_numpy()
    unreadable = ~np.isfinite(values) & ~absent
    rejections.absent |= absent
    rejections.unreadable |= unreadable
    fractional = np.isfinite(values) & (np.mod(values, 1) != 0)
    if fractional.any():
        rejections.columns_not_whole.append(column)
        rejections.not_whole |= fractional
        values = np.where(fractional, np.nan, values)
    return values


def _combine_cell(i: np.ndarray, ncol: int, j: np.ndarray) -> np.ndarray:
    """The one place ``i * ncol + j`` is computed. A huge ``i`` can overflow
    this to ``inf`` (measured: ``1e308 * 5`` is ``inf``), which numpy warns
    about by default. That overflow is detected on the very next line, in
    ``_resolve_group``, and named in the shortfall note -- so the warning is
    a duplicate of a handled case here, and only here; nowhere else in this
    module suppresses an error state."""
    with np.errstate(over="ignore"):
        return i * ncol + j


def _valid_mask(cell: np.ndarray, layer: np.ndarray, shape: GridShape) -> np.ndarray:
    """A candidate row is accepted only when both its cell and its layer
    are real, whole numbers that land inside the grid -- the range check
    ported unchanged from the M0 reference, which is what keeps an
    out-of-range index at ``-1`` instead of wrapping onto a real cell. The
    integral check catches any future candidate built without going
    through ``_numeric`` -- e.g. a combined ``i * ncol + j`` value that
    lands on a whole number even though ``i`` itself was fractional."""
    finite = np.isfinite(cell) & np.isfinite(layer)
    safe_cell = np.where(finite, cell, -1.0)
    safe_layer = np.where(finite, layer, -1.0)
    in_range = (
        (safe_layer >= 0)
        & (safe_layer < shape.nlay)
        & (safe_cell >= 0)
        & (safe_cell < shape.ncpl)
    )
    integral = (np.mod(safe_cell, 1) == 0) & (np.mod(safe_layer, 1) == 0)
    return finite & in_range & integral


def _candidate_kij(block: pd.DataFrame, shape: GridShape):
    if shape.ncol is None or not {"k", "i", "j"}.issubset(block.columns):
        return None
    rejections = _Rejections.blank(len(block))
    layer = _numeric(block, "k", rejections)
    i = _numeric(block, "i", rejections)
    j = _numeric(block, "j", rejections)
    return _combine_cell(i, shape.ncol, j), layer, rejections


def _candidate_idx_triple(block: pd.DataFrame, shape: GridShape):
    if shape.ncol is None or not {"idx0", "idx1", "idx2"}.issubset(block.columns):
        return None
    rejections = _Rejections.blank(len(block))
    layer = _numeric(block, "idx0", rejections)
    i = _numeric(block, "idx1", rejections)
    j = _numeric(block, "idx2", rejections)
    return _combine_cell(i, shape.ncol, j), layer, rejections


def _candidate_idx_pair(block: pd.DataFrame, shape: GridShape):
    if shape.ncol is not None or not {"idx0", "idx1"}.issubset(block.columns):
        return None
    rejections = _Rejections.blank(len(block))
    layer = _numeric(block, "idx0", rejections)
    cell = _numeric(block, "idx1", rejections)
    return cell, layer, rejections


def _layer_from_names(
    block: pd.DataFrame, pattern: re.Pattern[str], rejections: _Rejections
) -> np.ndarray | None:
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

    Once a name column is found that matches at least one row, a row in
    that same column whose extracted number came back missing is marked
    into ``rejections.no_layer_in_name`` -- its name carried no layer
    number, a different fact from its ``i``/``j`` columns being empty.
    Returns ``None``, marking nothing, when no name column matches any row
    at all -- that is the rule declining, not a parameter failing.
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
            rejections.no_layer_in_name |= numbers.isna().to_numpy()
            # Names are conventionally one-based; layer indices are
            # zero-based.
            return (numbers - 1).to_numpy(dtype=np.float64)
    return None


def _candidate_ij_name_layer(block: pd.DataFrame, shape: GridShape, pattern: re.Pattern[str]):
    if shape.ncol is None or not {"i", "j"}.issubset(block.columns):
        return None
    rejections = _Rejections.blank(len(block))
    layer = _layer_from_names(block, pattern, rejections)
    if layer is None:
        return None
    i = _numeric(block, "i", rejections)
    j = _numeric(block, "j", rejections)
    return _combine_cell(i, shape.ncol, j), layer, rejections


def _candidate_ij_single_layer(block: pd.DataFrame, shape: GridShape):
    if shape.ncol is None or shape.nlay != 1 or not {"i", "j"}.issubset(block.columns):
        return None
    rejections = _Rejections.blank(len(block))
    i = _numeric(block, "i", rejections)
    j = _numeric(block, "j", rejections)
    layer = np.zeros(len(block))
    return _combine_cell(i, shape.ncol, j), layer, rejections


def _resolve_group(block: pd.DataFrame, shape: GridShape, pattern: re.Pattern[str]):
    """Try each rule in ``RULE_NAMES`` order; the first one whose columns
    are present and that produces at least one in-range hit takes the
    whole group. Rows that rule still cannot place stay ``-1`` within it --
    winning a group is not a promise that every row in it lands.

    A rule whose only hits are non-integral, unreadable or too large yields
    to the next rule the same way an out-of-range candidate already does --
    a later rule with a real in-range, integral hit still wins the group
    over it. But when no rule ever wins, the fallback reports the first
    rule whose columns were present and that hit one of three triggers:
    ``columns_not_whole`` is non-empty, an ``unreadable`` value was found,
    or a ``too_large`` (overflowed) cell or layer was found. It does
    *not* fire for ``absent`` alone, and it does *not* fire for a group
    that is only out of range -- an out-of-range value is a real value
    that was really compared, so its ``GroupResolution`` row is already a
    complete record of it, and firing the fallback there would turn the
    measured 777-unplaceable-group real run into 777 notes.

    ``too_large`` is filled here, not inside ``_numeric``, because the
    value it describes -- ``cell``/``layer`` non-finite even though every
    source column read cleanly -- does not exist until after a candidate's
    arithmetic has run; a gate that inspected only the per-column masks
    could never see it.
    """
    candidates = (
        ("kij", _candidate_kij(block, shape)),
        ("idx-triple", _candidate_idx_triple(block, shape)),
        ("idx-pair", _candidate_idx_pair(block, shape)),
        ("ij-name-layer", _candidate_ij_name_layer(block, shape, pattern)),
        ("ij-single-layer", _candidate_ij_single_layer(block, shape)),
    )
    fallback = None
    for rule, candidate in candidates:
        if candidate is None:
            continue
        cell, layer, rejections = candidate
        rejections.too_large = (~np.isfinite(cell) | ~np.isfinite(layer)) & ~(
            rejections.absent
            | rejections.unreadable
            | rejections.not_whole
            | rejections.no_layer_in_name
        )
        valid = _valid_mask(cell, layer, shape)
        if valid.any():
            return rule, cell, layer, valid, rejections
        fires_fallback = (
            bool(rejections.columns_not_whole)
            or rejections.unreadable.any()
            or rejections.too_large.any()
        )
        if fires_fallback and fallback is None:
            fallback = (rule, cell, layer, valid, rejections)
    if fallback is not None:
        return fallback
    return UNMAPPED, None, None, None, _Rejections.blank(0)


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


def _classify_unplaced(
    cell: np.ndarray, layer: np.ndarray, valid: np.ndarray, rejections: _Rejections
) -> list[tuple[str, int]]:
    """Turn one group's candidate arrays and rejection masks into an
    ordered list of ``(reason key, count)`` pairs, in ``UNPLACED_REASONS``
    order, omitting zero counts.

    Every unplaced row is assigned to exactly one reason: the first one in
    ``UNPLACED_REASONS`` order whose mask is true for it. ``out_of_range``
    is worked out here as ``unplaced & isfinite(cell) & isfinite(layer)`` --
    a row whose numbers are real and whole but that the range test rejected
    is the only kind of row that clause may count. Whatever is left over
    after every named mask has had first claim goes to ``unknown``, built
    as the remainder rather than its own mask -- that is what guarantees
    the counts always sum to ``(~valid).sum()`` without a separate
    assertion.
    """
    unplaced = ~valid
    masks = {
        "out_of_range": unplaced & np.isfinite(cell) & np.isfinite(layer),
        "not_whole": rejections.not_whole,
        "unreadable": rejections.unreadable,
        "absent": rejections.absent,
        "no_layer_in_name": rejections.no_layer_in_name,
        "too_large": rejections.too_large,
    }
    counts: list[tuple[str, int]] = []
    assigned = np.zeros(len(unplaced), dtype=bool)
    for key, _ in UNPLACED_REASONS:
        if key == "unknown":
            continue
        mask = masks[key] & unplaced & ~assigned
        count = int(mask.sum())
        if count:
            counts.append((key, count))
        assigned |= mask
    remainder = int((unplaced & ~assigned).sum())
    if remainder:
        counts.append(("unknown", remainder))
    return counts


def _shortfall_note(
    name: object, rule: str, mapped: int, total: int, counts: list[tuple[str, int]]
) -> str:
    """Build the one shortfall sentence from a group name, the rule that
    won it, the placement counts, and the reasons the rest went unplaced.
    Names counts and causes only -- it must never interpolate the offending
    value itself, since that value came from a user's control file and a
    later view renders this text."""
    phrase_by_key = dict(UNPLACED_REASONS)
    clauses = [f"{count} {phrase_by_key[key]}" for key, count in counts]
    if len(clauses) > 1:
        body = ", ".join(clauses[:-1]) + " and " + clauses[-1]
    else:
        body = clauses[0]
    return f"group {name!r}: rule {rule!r} placed {mapped} of {total} parameters; {body}"


def _summarize(groups: tuple[GroupResolution, ...], total_params: int) -> str:
    """The single sentence GRID-03 asks for -- built entirely from counts,
    never from a list of group names, so it does not grow with however many
    groups a real run happens to leave unplaceable.

    ``total_params`` is the parameter count from the table itself
    (``len(par)``), not derived from the groups this function was handed --
    a total built from tracked groups shrinks silently whenever a group is
    dropped, which is exactly how this sentence once claimed full success
    while a real parameter sat untracked.
    """
    if not groups and total_params == 0:
        return "no parameter groups were present to place."

    unplaced = tuple(g for g in groups if g.mapped == 0)
    untracked = total_params - sum(g.total for g in groups)
    if not unplaced and untracked == 0:
        return f"every one of the {len(groups)} parameter group(s) was placed on the grid."

    unplaced_params = sum(g.total for g in unplaced) + untracked
    return (
        f"{len(unplaced)} of {len(groups)} parameter group(s) could not be placed on the "
        f"grid, accounting for {unplaced_params} of {total_params} parameters."
    )


def resolve(
    par: pd.DataFrame,
    shape: GridShape,
    layer_pattern: str = DEFAULT_LAYER_PATTERN,
) -> ParCells | ReadFailure:
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

    Returns a ``ReadFailure`` naming the parameter table, rather than
    raising, when ``par`` carries no ``pargp`` column at all -- there is
    nothing to group by, so every rule below is unreachable.
    """
    if GROUP_COLUMN not in par.columns:
        return ReadFailure(
            name="parameter table",
            path="",
            reason=(
                "the parameter table carries no 'pargp' column, so there are "
                "no parameter groups to place"
            ),
        )

    n = len(par)
    cell = np.full(n, -1, dtype=np.int32)
    layer = np.full(n, -1, dtype=np.int32)
    notes: list[str] = []
    groups: list[GroupResolution] = []
    pattern = re.compile(layer_pattern, re.IGNORECASE)

    grouped = par.groupby(GROUP_COLUMN, sort=True, observed=True)
    for name, block in grouped:
        # grouped.indices[name] gives integer row positions, computed by
        # groupby itself -- a label-based lookup (e.g. block.index) would
        # expand into more rows than the group has the moment two
        # parameters share a parnme, since pandas returns every match per
        # requested label rather than one row per request.
        positions = grouped.indices[name]
        rule, candidate_cell, candidate_layer, valid, rejections = _resolve_group(
            block, shape, pattern
        )
        total = len(block)

        if rule == UNMAPPED:
            note = _unrecognized_column_note(name, block)
            if note is not None:
                notes.append(note)
            groups.append(GroupResolution(group=str(name), rule=UNMAPPED, mapped=0, total=total))
            continue

        if rejections.columns_not_whole:
            columns_text = ", ".join(repr(column) for column in rejections.columns_not_whole)
            notes.append(
                f"group {name!r}: column(s) {columns_text} hold values that are not "
                "whole numbers, so those parameters were given no cell rather than "
                "rounded down"
            )

        mapped_positions = positions[valid]
        cell[mapped_positions] = candidate_cell[valid].astype(np.int32)
        layer[mapped_positions] = candidate_layer[valid].astype(np.int32)
        mapped = int(valid.sum())
        if mapped < total:
            counts = _classify_unplaced(candidate_cell, candidate_layer, valid, rejections)
            notes.append(_shortfall_note(name, rule, mapped, total, counts))
        groups.append(GroupResolution(group=str(name), rule=rule, mapped=mapped, total=total))

    # par.groupby(...) drops rows whose pargp is null (pandas' dropna=True
    # default), so they never reach the loop above at all -- account for
    # them here, after the sorted groups, which is what makes the bucket's
    # position in `groups` and its note's position in `notes` deterministic.
    # Their cell/layer are already -1 because nothing writes to them.
    null_mask = par[GROUP_COLUMN].isna().to_numpy()
    null_count = int(null_mask.sum())
    if null_count:
        null_names = [repr(value) for value in par.index[null_mask]]
        shown = null_names[:NULL_GROUP_NOTE_NAME_LIMIT]
        names_text = ", ".join(shown)
        if len(null_names) > NULL_GROUP_NOTE_NAME_LIMIT:
            names_text += f", and {len(null_names) - NULL_GROUP_NOTE_NAME_LIMIT} more"
        notes.append(
            f"group {NO_GROUP!r}: {null_count} parameter(s) carry no 'pargp' value at "
            "all, so no rule could be tried for them; they are counted here and given "
            f"no cell -- {names_text}"
        )
        groups.append(
            GroupResolution(group=NO_GROUP, rule=UNMAPPED, mapped=0, total=null_count)
        )

    parnme = tuple(str(value) for value in par.index)
    groups_tuple = tuple(groups)
    return ParCells(
        cell=cell,
        layer=layer,
        parnme=parnme,
        groups=groups_tuple,
        summary=_summarize(groups_tuple, len(par)),
        notes=tuple(notes),
    )
