"""Words for a layer shown to a person: one-based with the zero-based index alongside,
``layer 4 (index 3)``. The client's ``data/layer-words.ts`` writes the same text; both are
tested against ``tests/fixtures/layer_words_cases.json``.

Only words change. Inputs, URLs, the cache and the wire stay zero-based. A layer number that is
part of a parameter, group or file name is quoted as written and never passed through here.
"""

from __future__ import annotations

from collections.abc import Iterable
from numbers import Integral

UNKNOWN = "layer unknown"
UNKNOWN_TAIL = " and an unknown layer"


def _index(value: object) -> int | None:
    """The layer index, or None when it cannot be told; never a guessed number."""
    if isinstance(value, bool) or not isinstance(value, Integral):
        return None
    index = int(value)
    return index if index >= 0 else None


def _split(indices: Iterable[object]) -> tuple[list[int], bool]:
    known: set[int] = set()
    unknown = False
    for value in indices:
        index = _index(value)
        if index is None:
            unknown = True
        else:
            known.add(index)
    return sorted(known), unknown


def _runs(sorted_indices: list[int], shift: int) -> str:
    """Consecutive layers as one run: ``0–3, 5 and 7–16``."""
    runs: list[str] = []
    i = 0
    while i < len(sorted_indices):
        j = i
        while j + 1 < len(sorted_indices) and sorted_indices[j + 1] == sorted_indices[j] + 1:
            j += 1
        a, b = sorted_indices[i] + shift, sorted_indices[j] + shift
        runs.append(str(a) if i == j else f"{a}–{b}")
        i = j + 1
    if len(runs) <= 1:
        return "".join(runs)
    return f"{', '.join(runs[:-1])} and {runs[-1]}"


def _many(known: list[int], unknown: bool, ones: str, indices: str) -> str:
    if not known:
        return UNKNOWN if unknown else "no layer"
    tail = UNKNOWN_TAIL if unknown else ""
    if len(known) == 1:
        return f"{layer_words(known[0])}{tail}"
    return f"layers {ones} (index {indices}){tail}"


def layer_words(index: object) -> str:
    """``layer 4 (index 3)``; ``layer unknown`` for a blank, negative or non-integer index."""
    i = _index(index)
    return UNKNOWN if i is None else f"layer {i + 1} (index {i})"


def layer_compact(index: object) -> str:
    """``4 (3)`` where space is tight; ``unknown`` when the index cannot be told."""
    i = _index(index)
    return "unknown" if i is None else f"{i + 1} ({i})"


def layer_range_words(indices: Iterable[object]) -> str:
    """``layers 1–4, 6 and 8–17 (index 0–3, 5 and 7–16)``; order and repeats do not matter."""
    known, unknown = _split(indices)
    return _many(known, unknown, _runs(known, 1), _runs(known, 0))


def layer_list_words(indices: Iterable[object], cap: int | None = None) -> str:
    """``layers 1, 2, 3 (index 0, 1, 2)``; past ``cap`` entries both halves end in ``and more``."""
    known, unknown = _split(indices)
    shown = known if cap is None else known[:cap]
    more = " and more" if len(shown) < len(known) else ""
    ones = ", ".join(str(i + 1) for i in shown) + more
    zeros = ", ".join(str(i) for i in shown) + more
    return _many(known, unknown, ones, zeros)


def layer_span_words(first: object, last: object) -> str:
    """``layers 2 to 3 (index 1 to 2)``; ``layer unknown`` when either end cannot be told."""
    a, b = _index(first), _index(last)
    if a is None or b is None:
        return UNKNOWN
    if a == b:
        return layer_words(a)
    return f"layers {a + 1} to {b + 1} (index {a} to {b})"


def grid_layer_count_words(nlay: object) -> str:
    """``17 layers (index 0–16)``, ``1 layer (index 0)``: how many layers a grid has."""
    n = _index(nlay)
    if n is None:
        return "an unknown number of layers"
    if n == 0:
        return "no layers"
    if n == 1:
        return "1 layer (index 0)"
    return f"{n} layers (index 0–{n - 1})"
