"""Layer words for a person: one-based with the zero-based index alongside. The case table is
shared with the client's helper, so both sides are held to the same text."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from pesto import layer_words as words

CASES = json.loads((Path(__file__).parent / "fixtures" / "layer_words_cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=[f"{c['fn']}{c['args']}" for c in CASES])
def test_every_shared_case_reads_as_the_table_says(case):
    fn = getattr(words, case["fn"])

    assert fn(*case["args"]) == case["expected"]


def test_a_numpy_integer_is_a_layer_like_any_other():
    assert words.layer_words(np.int32(3)) == "layer 4 (index 3)"
    assert words.layer_range_words(np.array([0, 1, 2])) == "layers 1–3 (index 0–2)"


def test_a_span_names_both_ends_in_both_halves():
    assert words.layer_span_words(1, 2) == "layers 2 to 3 (index 1 to 2)"
    assert words.layer_span_words(3, 3) == "layer 4 (index 3)"


def test_a_span_with_an_end_it_cannot_tell_is_unknown():
    assert words.layer_span_words(None, 2) == "layer unknown"
    assert words.layer_span_words(1, -1) == "layer unknown"
