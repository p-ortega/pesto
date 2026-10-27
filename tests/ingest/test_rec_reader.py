"""Reading the facts a pestpp run record states.

Every test writes a record with ``write_rec`` and reads it back; none depends
on a local benchmark folder.
"""

from __future__ import annotations

import os

from pesto.ingest.failures import ReadFailure
from pesto.ingest.recfile import RecFacts, read_rec

from .rec_fixtures import write_rec


def _read(tmp_path, **kwargs) -> RecFacts:
    facts = read_rec(write_rec(tmp_path / "case.rec", **kwargs))
    assert isinstance(facts, RecFacts)
    return facts


def _snapshot(folder):
    return {
        p.name: (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(folder.iterdir())
    } | {"": (0, folder.stat().st_mtime_ns)}


def test_the_version_is_read(tmp_path):
    facts = _read(tmp_path)

    assert facts.version is not None
    assert facts.version.value == "5.2.23"
    assert facts.version.line > 0


def test_a_list_option_takes_its_value_from_the_next_line(tmp_path):
    facts = _read(tmp_path)

    reinflate = facts.options["ies_n_iter_reinflate"]
    assert reinflate.value == "3,999,"
    assert reinflate.line > 0
    assert facts.options["ies_reg_factor"].value == "0"
    assert facts.options["ies_num_reals"].value == "300"


def test_an_empty_option_does_not_take_the_next_key_as_its_value(tmp_path):
    facts = _read(tmp_path)

    assert facts.options["ies_weights_ensemble"].value == ""
    assert facts.options["ies_reg_factor"].value == "0"


def test_the_option_dump_stops_at_the_next_options_block(tmp_path):
    facts = _read(tmp_path, options={"ies_num_reals": "300"})

    assert set(facts.options) == {"ies_num_reals"}


def test_each_noise_line_gets_its_own_kind(tmp_path):
    kinds = (
        "reset_to_no_noise",
        "no_noise_ensemble",
        "drawn_noise",
        "loaded_obs_ensemble",
        "standard_deviation_column",
    )

    facts = _read(tmp_path, noise=kinds)

    assert tuple(n.kind for n in facts.noise) == kinds
    by_kind = {n.kind: n for n in facts.noise}
    assert by_kind["loaded_obs_ensemble"].value == "noise_oe.jcb"
    assert by_kind["drawn_noise"].value == 300
    assert by_kind["no_noise_ensemble"].value == 494


def test_reg_factor_is_a_number(tmp_path):
    facts = _read(tmp_path, reg_factor=0.5)

    assert facts.reg_factor is not None
    assert facts.reg_factor.value == 0.5


def test_localization_off_and_on(tmp_path):
    off = _read(tmp_path, localization="off")
    on = _read(tmp_path, localization=48785)

    assert off.localization is not None and off.localization.kind == "off"
    assert on.localization is not None and on.localization.kind == "on"
    assert on.localization.value == 48785


def test_the_base_kept_line_is_found_with_its_line_number(tmp_path):
    facts = _read(tmp_path, base_kept=True)

    assert facts.base_kept is not None
    assert facts.base_kept.value is True
    assert facts.base_kept.line > 0


def test_a_record_without_the_base_line_has_no_base_fact(tmp_path):
    assert _read(tmp_path, base_kept=False).base_kept is None


def test_a_reinflation_takes_its_iteration_from_the_report_that_follows(tmp_path):
    facts = _read(tmp_path, reinflations=(4,))

    assert len(facts.reinflations) == 1
    assert facts.reinflations[0].iteration == 4
    assert facts.reinflations[0].factor == 0.75


def test_two_reinflations_are_both_kept_in_order(tmp_path):
    facts = _read(tmp_path, reinflations=(4, 9))

    assert [r.iteration for r in facts.reinflations] == [4, 9]


def test_a_reinflation_with_no_report_after_it_has_no_iteration_and_a_note(tmp_path):
    facts = _read(tmp_path, reinflation_without_report=True)

    assert len(facts.reinflations) == 1
    assert facts.reinflations[0].iteration is None
    assert any("reinflation" in n and "iteration" in n for n in facts.notes)


def test_a_bad_byte_is_replaced_counted_and_never_raises(tmp_path):
    facts = _read(tmp_path, bad_byte=True)

    assert facts.replaced_chars == 1
    assert sum("replaced" in n for n in facts.notes) == 1
    assert facts.version is not None


def test_a_clean_record_reports_no_replacements(tmp_path):
    facts = _read(tmp_path)

    assert facts.replaced_chars == 0
    assert not any("replaced" in n for n in facts.notes)


def test_a_record_of_unknown_lines_has_empty_facts_and_one_note_naming_what_was_sought(tmp_path):
    path = tmp_path / "case.rec"
    path.write_text("nothing here\nor here\n")

    facts = read_rec(path)

    assert isinstance(facts, RecFacts)
    assert facts.version is None
    assert dict(facts.options) == {}
    assert facts.noise == ()
    assert facts.reg_factor is None
    assert facts.localization is None
    assert facts.base_kept is None
    assert facts.reinflations == ()
    assert len(facts.notes) == 1
    assert "version" in facts.notes[0] and "reinflation" in facts.notes[0]


def test_an_empty_record_is_empty_facts_not_a_failure(tmp_path):
    path = tmp_path / "case.rec"
    path.write_text("")

    facts = read_rec(path)

    assert isinstance(facts, RecFacts)
    assert len(facts.notes) == 1


def test_a_missing_record_is_a_failure_naming_the_file(tmp_path):
    result = read_rec(tmp_path / "gone.rec")

    assert isinstance(result, ReadFailure)
    assert "gone.rec" in result.reason


def test_a_line_that_is_not_known_is_absent_not_guessed(tmp_path):
    facts = _read(tmp_path, version=None, reg_factor=None, unknown_lines=50)

    assert facts.version is None
    assert facts.reg_factor is None
    assert facts.noise == ()


def test_recognised_text_is_cut_to_200_characters(tmp_path):
    long_name = "x" * 500
    path = tmp_path / "case.rec"
    path.write_text(f"...loading obs ensemble from binary file {long_name}.jcb\n")

    facts = read_rec(path)

    assert isinstance(facts, RecFacts)
    assert facts.noise
    assert all(len(n.text) <= 200 for n in facts.noise)


def test_reading_a_record_changes_nothing_in_its_folder(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    write_rec(run / "case.rec", noise="loaded_obs_ensemble", reinflations=(3,))
    (run / "case.pst").write_text("pcf\n")
    before = _snapshot(run)

    read_rec(run / "case.rec")
    read_rec(run / "missing.rec")

    assert _snapshot(run) == before
    assert sorted(os.listdir(run)) == ["case.pst", "case.rec"]
