"""The one rule for finding the base realization among realization names.

The noise band leaves base out and the setup facts say whether base survived,
so both ask here and never disagree about what counts as base.
"""

from __future__ import annotations

from pesto.ingest.ensfile import _clean

BASE_NAME = "base"
_EXAMPLES = 3


def find_base(real_names: tuple[str, ...]) -> tuple[list[int], str | None]:
    """Positions of the base realization, by the name rule used everywhere
    else: exact ``base`` first, then trimmed and lower-cased. The second item
    is a note when only the folded name matched."""
    exact = [i for i, n in enumerate(real_names) if n == BASE_NAME]
    if exact:
        return exact, None
    folded = [i for i, n in enumerate(real_names) if _clean(n) == BASE_NAME]
    if not folded:
        return [], None
    shown = ", ".join(repr(real_names[i]) for i in folded[:_EXAMPLES])
    return folded, (
        f"the base realization matched only after trimming spaces and lower-casing "
        f"(the file names it {shown})"
    )
