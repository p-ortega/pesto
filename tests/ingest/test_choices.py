"""Unit proofs for the shared choice-recording mechanism, independent of any
call site that uses it."""

from __future__ import annotations

import pytest

from pesto.ingest.choices import AMBIGUITY_POLICY, Ambiguity, choose_one


def test_single_candidate_returns_that_value_and_no_ambiguity():
    value, ambiguity = choose_one("grid file", [("only.grb", "the-path")])

    assert value == "the-path"
    assert ambiguity is None


def test_three_candidates_out_of_order_return_the_sorted_first_value_and_name_the_rest():
    value, ambiguity = choose_one(
        "grid file",
        [("z.grb", "z-path"), ("a.grb", "a-path"), ("m.grb", "m-path")],
    )

    assert value == "a-path"
    assert ambiguity is not None
    assert ambiguity.chosen == "a.grb"
    assert set(ambiguity.rejected) == {"z.grb", "m.grb"}


def test_note_contains_slot_chosen_rejected_and_policy():
    _, ambiguity = choose_one("grid file", [("b.grb", 2), ("a.grb", 1)])

    note = ambiguity.note()

    assert "grid file" in note
    assert "a.grb" in note
    assert "b.grb" in note
    assert ambiguity.policy in note


def test_chosen_and_rejected_preserve_mixed_case_and_spaces_byte_for_byte():
    _, ambiguity = choose_one(
        "grid file",
        [("  Mixed Case Name.grb", 1), ("aaa.grb", 2)],
    )

    assert "  Mixed Case Name.grb" in (ambiguity.chosen, *ambiguity.rejected)
    # Neither the chosen nor the rejected name was lower-cased or stripped.
    assert ambiguity.chosen == "  Mixed Case Name.grb" or "  Mixed Case Name.grb" in ambiguity.rejected


def test_empty_candidate_sequence_raises_value_error_naming_the_slot():
    with pytest.raises(ValueError, match="grid file"):
        choose_one("grid file", [])


def test_ambiguity_policy_is_a_non_empty_string_and_is_the_policy_of_every_ambiguity():
    assert isinstance(AMBIGUITY_POLICY, str)
    assert AMBIGUITY_POLICY

    _, ambiguity = choose_one("grid file", [("b.grb", 2), ("a.grb", 1)])

    assert ambiguity.policy == AMBIGUITY_POLICY


def test_ambiguity_is_a_frozen_dataclass_with_the_documented_fields():
    ambiguity = Ambiguity(slot="grid file", chosen="a.grb", rejected=("b.grb",), policy="p")

    with pytest.raises(Exception):
        ambiguity.slot = "something else"  # type: ignore[misc]
