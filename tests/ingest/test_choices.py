"""Unit proofs for the shared choice-recording mechanism, independent of any
call site that uses it, plus the cross-reader contract proving the
mechanism is genuinely the same thing in both readers that use it -- not two
parallel record types that happen to look alike."""

from __future__ import annotations

import dataclasses

import pandas as pd
import pytest

from pesto.ingest.choices import AMBIGUITY_POLICY, Ambiguity, choose_one
from pesto.ingest.control import COLUMN_COLLISION_POLICY, ControlTables, read_control
from pesto.ingest.discover import RunLayout, discover

from .fixtures import write_control_file


def _touch(path):
    path.write_bytes(b"placeholder -- discover never opens this file")
    return path


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


# ---------------------------------------------------------------------------
# Cross-reader contract: this is the only place "one mechanism, applied
# everywhere" is asserted rather than described.
# ---------------------------------------------------------------------------


def test_cross_reader_contract_both_readers_carry_the_same_ambiguity_type(tmp_path):
    """Every reader that can make a choice carries the same field, holding
    instances of the same record type -- not two parallel record types that
    happen to look alike."""
    layout_fields = {f.name for f in dataclasses.fields(RunLayout)}
    control_fields = {f.name for f in dataclasses.fields(ControlTables)}
    assert "ambiguities" in layout_fields
    assert "ambiguities" in control_fields

    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    _touch(tmp_path / "aaa.grb")
    _touch(tmp_path / "zzz.grb")
    layout = discover(tmp_path)
    assert isinstance(layout.ambiguities, tuple)
    assert layout.ambiguities
    assert all(isinstance(a, Ambiguity) for a in layout.ambiguities)

    pst_path, obs_data_path = write_control_file(
        tmp_path / "collide.pst", par_names=["p0"], obs_names=["o0"]
    )
    df = pd.read_csv(obs_data_path)
    df[" id"] = [-1] * len(df)
    df.to_csv(obs_data_path, index=False)
    tables = read_control(pst_path)
    assert isinstance(tables, ControlTables)
    assert isinstance(tables.ambiguities, tuple)
    assert tables.ambiguities
    assert all(isinstance(a, Ambiguity) for a in tables.ambiguities)


def test_both_readers_ambiguities_agree_with_their_own_notes_channel(tmp_path):
    """The structured and prose channels never disagree, in either reader:
    every ``Ambiguity.note()`` string appears verbatim in that same
    record's own ``notes`` tuple."""
    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    _touch(tmp_path / "aaa.grb")
    _touch(tmp_path / "zzz.grb")
    layout = discover(tmp_path)
    assert layout.ambiguities
    for ambiguity in layout.ambiguities:
        assert ambiguity.note() in layout.notes

    pst_path, obs_data_path = write_control_file(
        tmp_path / "collide.pst", par_names=["p0"], obs_names=["o0"]
    )
    df = pd.read_csv(obs_data_path)
    df[" id"] = [-1] * len(df)
    df.to_csv(obs_data_path, index=False)
    tables = read_control(pst_path)
    assert isinstance(tables, ControlTables)
    assert tables.ambiguities
    for ambiguity in tables.ambiguities:
        assert ambiguity.note() in tables.notes


def test_exactly_two_named_policies_exist_and_each_is_used_where_it_belongs(tmp_path):
    """Two is the right number, not one and not five: a discover() choice
    among *files* has no discriminator beyond sort order, while a
    control-file column collision has a real one (a column that was already
    correctly named). Collapsing these into one policy would either lie
    about the column case (pretending sort order matters, when it doesn't)
    or lie about the file case (pretending one file is more "correct" than
    another, when neither is). See ``control.COLUMN_COLLISION_POLICY``'s own
    comment for the full reasoning -- this test just proves both constants
    are actually used where documented, and that they differ."""
    assert AMBIGUITY_POLICY != COLUMN_COLLISION_POLICY

    write_control_file(tmp_path / "case.pst", par_names=["p0"], obs_names=["o0"])
    _touch(tmp_path / "aaa.grb")
    _touch(tmp_path / "zzz.grb")
    layout = discover(tmp_path)
    assert layout.ambiguities
    assert all(a.policy == AMBIGUITY_POLICY for a in layout.ambiguities)

    pst_path, obs_data_path = write_control_file(
        tmp_path / "collide.pst", par_names=["p0"], obs_names=["o0"]
    )
    df = pd.read_csv(obs_data_path)
    df[" id"] = [-1] * len(df)
    df.to_csv(obs_data_path, index=False)
    tables = read_control(pst_path)
    assert isinstance(tables, ControlTables)
    assert tables.ambiguities
    assert all(a.policy == COLUMN_COLLISION_POLICY for a in tables.ambiguities)


def test_every_site_that_chooses_records_the_choice_when_seeded_at_once(tmp_path):
    """A directory ambiguous in every category discover() can genuinely be
    made ambiguous in, seeded at once, reports every one of them --
    grep is not a test, so this is asserted behaviourally: a new unguarded
    assignment anywhere in ``discover()`` makes this fail.

    ``phi``/``pdc``/``pcs`` are deliberately not seeded here.
    02-07-SUMMARY.md's key-decisions record why: their regexes fix every
    literal filename segment except the kind/iteration token, so two
    byte-distinct real files can only collide via a character-case
    difference in the filename -- and this development machine's default
    filesystem (APFS, case-insensitive) folds those together before two
    files can even exist. That generic collapse is already covered by
    ``test_discover.py::test_every_ambiguity_note_appears_in_layout_notes``,
    which holds for any ambiguity discover() produces, those three
    categories included, the moment one occurs on a filesystem where it
    can.
    """
    write_control_file(
        tmp_path / "case.pst",
        par_names=["p0"],
        obs_names=["o0"],
        pestpp_options={"ies_par_en": "first.jcb", "ies_parameter_ensemble": "second.jcb"},
    )
    # A second, decoy control file -- sorts after "case.pst" and is never
    # itself scanned, but still an ambiguous "control file" slot.
    write_control_file(tmp_path / "zzz_extra.pst", par_names=["p0"], obs_names=["o0"])
    _touch(tmp_path / "first.jcb")
    _touch(tmp_path / "second.jcb")
    _touch(tmp_path / "aaa.grb")
    _touch(tmp_path / "zzz.grb")
    _touch(tmp_path / "case.0.par.bin")
    _touch(tmp_path / "case.0.par.jcb")
    _touch(tmp_path / "case.0.obs.csv")
    _touch(tmp_path / "case.0.obs.jco")
    _touch(tmp_path / "case.0.rejected.par.jcb")
    _touch(tmp_path / "case.0.rejected.par.jco")
    _touch(tmp_path / "case.obs+noise.bin")
    _touch(tmp_path / "case.obs+noise.jcb")

    layout = discover(tmp_path)

    expected_slots = {
        "control file",
        "parameter ensemble for iteration 0",
        "observation ensemble for iteration 0",
        "rejected parameter ensemble for iteration 0",
        "measurement-noise ensemble",
        "grid file",
        "starting parameter ensemble named by the control file",
    }
    seen_slots = {a.slot for a in layout.ambiguities}
    assert seen_slots == expected_slots
    assert len(layout.ambiguities) == len(expected_slots)
