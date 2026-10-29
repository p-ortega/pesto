"""Elevations and a status code for every layer of every piece of a section.

The status says why a quad is drawn the way it is, from the model's own
idomain first and then from its elevations. Nothing is swapped or repaired:
a bottom above its top stays where the grid file put it, with a code and a
count saying so.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

ACTIVE = 0
INACTIVE = 1
PASS_THROUGH = 2
PINCHED = 3
BOTTOM_ABOVE_TOP = 4
NON_FINITE = 5

STATUS_TEXT = {
    ACTIVE: "active",
    INACTIVE: "inactive (idomain 0)",
    PASS_THROUGH: "vertical pass-through (idomain -1)",
    PINCHED: "pinched out (zero thickness)",
    BOTTOM_ABOVE_TOP: "bottom above top",
    NON_FINITE: "no finite elevation",
}


@dataclass(frozen=True)
class Assembled:
    """``z`` is ``(P, nlay + 1)`` float64, column 0 the top and column
    ``k + 1`` the bottom of layer ``k``; ``status`` is ``(P, nlay)`` int8."""

    z: np.ndarray
    status: np.ndarray
    counts: dict[str, int]


def assemble(
    cell: np.ndarray,
    elev: np.ndarray,
    idomain: np.ndarray | None,
    nlay: int,
    ncpl: int,
) -> Assembled:
    """Gather each piece's elevations from ``elev`` (``(nlay + 1, ncpl)``) and
    give every quad its status. ``idomain`` is the flat ``nlay x ncpl`` array,
    or ``None`` when the grid records none, in which case the elevations alone
    decide. Raises ``ValueError`` when the arrays disagree with ``nlay`` and
    ``ncpl``, rather than reading a quad from the wrong cell."""
    cell = np.asarray(cell, dtype=np.int64)
    elev = np.asarray(elev)
    if elev.shape != (nlay + 1, ncpl):
        raise ValueError(
            f"the elevations are shaped {elev.shape}, not (nlay + 1, ncpl) = {(nlay + 1, ncpl)}"
        )
    if cell.size and (cell.min() < 0 or cell.max() >= ncpl):
        raise ValueError(f"a piece names a cell outside 0..{ncpl - 1}")

    z = elev[:, cell].T.astype(np.float64)
    top = z[:, :-1]
    bot = z[:, 1:]

    non_finite = ~(np.isfinite(top) & np.isfinite(bot))
    # A quad with no finite elevation is counted once, as non-finite, not also as pinched.
    above = (bot > top) & ~non_finite
    pinched = (bot == top) & ~non_finite

    status = np.full((cell.size, nlay), ACTIVE, dtype=np.int8)
    status[pinched] = PINCHED
    status[above] = BOTTOM_ABOVE_TOP
    status[non_finite] = NON_FINITE

    below_minus_1 = 0
    if idomain is not None:
        flat = np.asarray(idomain).reshape(-1)
        if flat.size != nlay * ncpl:
            raise ValueError(
                f"the idomain holds {flat.size} values, not nlay x ncpl = {nlay * ncpl}"
            )
        ido = flat.reshape(nlay, ncpl)[:, cell].T
        # The model's own word on a cell outranks what its elevations say.
        status[ido < 0] = PASS_THROUGH
        status[ido == 0] = INACTIVE
        below_minus_1 = int((ido < -1).sum())

    counts = {
        "bottom_above_top": int(above.sum()),
        "pinched": int(pinched.sum()),
        "idomain_below_minus_1": below_minus_1,
        "non_finite": int(non_finite.sum()),
    }
    return Assembled(z=z, status=status, counts=counts)


# (count key, singular sentence, plural sentence), in the order the notes are read.
_NOTES = (
    (
        "zero_length_dropped",
        "{n} piece of zero length was dropped where the line only touches a cell at a corner",
        "{n} pieces of zero length were dropped where the line only touches a cell at a corner",
    ),
    (
        "ties_resolved",
        "{n} stretch lies on an edge shared by two cells; it went to the lower cell index",
        "{n} stretches lie on an edge shared by two cells; they went to the lower cell index",
    ),
    (
        "bottom_above_top",
        "{n} section cell has its bottom above its top; drawn as absence",
        "{n} section cells have their bottom above their top; drawn as absence",
    ),
    (
        "pinched",
        "{n} section cell is pinched out (zero thickness); drawn as absence",
        "{n} section cells are pinched out (zero thickness); drawn as absence",
    ),
    (
        "idomain_below_minus_1",
        "{n} section cell has an idomain below -1; read as vertical pass-through (idomain -1)",
        "{n} section cells have an idomain below -1; read as vertical pass-through (idomain -1)",
    ),
    (
        "non_finite",
        "{n} section cell has no finite elevation; drawn as absence",
        "{n} section cells have no finite elevation; drawn as absence",
    ),
)


def answer_notes(counts: dict[str, int]) -> list[str]:
    """One plain sentence for every count above zero, so nothing the walk or
    the statuses dropped, resolved or read as absence goes without a trace.
    ``candidates`` is bookkeeping, not a defect, and never gives a note."""
    notes = []
    for key, one, many in _NOTES:
        n = int(counts.get(key, 0))
        if n > 0:
            notes.append((one if n == 1 else many).format(n=n))
    return notes
