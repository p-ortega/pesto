"""The one place in the read layer that resolves several candidates onto one
slot, and says what it did.

``discover()`` matches filenames against pestpp-ies naming conventions, and
more than one file can match the same slot: two ``.grb`` files, two control
files, a parameter ensemble saved in both ``.jcb`` and ``.bin``. Every one of
those sites used to pick a file and stay quiet about it -- some by first-wins,
some by last-wins, with no note either way (02-REVIEW.md CR-02, WR-01, WR-03).
This module is the fix, once: one function that makes the choice, one record
that says what it chose and what it did not, and one policy so a caller can
predict the outcome without reading five call sites.

Per D-09, resolving a choice never opens a candidate file -- ``choose_one``
compares the names the caller already collected, nothing more.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence, TypeVar

T = TypeVar("T")

AMBIGUITY_POLICY = (
    "more than one candidate matched; the first name in sorted order is "
    "kept and every other candidate is recorded as rejected"
)
"""The one tie-break rule, stated once. Every :class:`Ambiguity` any
``choose_one`` call builds carries this string verbatim as its ``policy`` --
no site tie-breaks in the opposite direction."""


@dataclass(frozen=True)
class Ambiguity:
    """One choice a read made among several recognised candidates, and what
    it did not choose.

    ``chosen`` and ``rejected`` hold display names verbatim as the caller
    supplied them -- never lower-cased, stripped or re-ordered, because a
    name in this project is identity, not a label to be normalised.
    """

    slot: str
    chosen: str
    rejected: tuple[str, ...]
    policy: str

    def note(self) -> str:
        """The only rendering of an :class:`Ambiguity` anywhere in this
        codebase -- no caller formats its own. One plain-English sentence
        naming the slot, how many candidates matched, what was kept, what
        was not, and the policy that decided it."""
        total = 1 + len(self.rejected)
        rejected_list = ", ".join(repr(name) for name in self.rejected)
        return (
            f"{self.slot}: {total} candidates matched -- kept {self.chosen!r}, "
            f"rejected {rejected_list} ({self.policy})"
        )


def choose_one(slot: str, candidates: Sequence[tuple[str, T]]) -> tuple[T, "Ambiguity | None"]:
    """Resolve ``candidates`` onto one value for ``slot``.

    ``candidates`` is the pairs the caller saw, as ``(display_name, value)``,
    in whatever order it found them -- sorted here by ``display_name`` so the
    outcome never depends on filesystem iteration order. Returns the first
    pair's value and, when more than one candidate was offered, an
    :class:`Ambiguity` naming the rest. Returns ``None`` for the ambiguity
    when exactly one candidate was offered -- the ordinary case must add
    nothing to a layout.

    Raises ``ValueError`` naming ``slot`` when ``candidates`` is empty: no
    slot is ever resolved unless at least one candidate matched, so an empty
    sequence is a caller bug, never a fact about a run directory.
    """
    if not candidates:
        raise ValueError(f"no candidate offered for {slot}")

    ordered = sorted(candidates, key=lambda pair: pair[0])
    chosen_name, chosen_value = ordered[0]

    if len(ordered) == 1:
        return chosen_value, None

    rejected = tuple(name for name, _ in ordered[1:])
    ambiguity = Ambiguity(slot=slot, chosen=chosen_name, rejected=rejected, policy=AMBIGUITY_POLICY)
    return chosen_value, ambiguity
