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


# ---------------------------------------------------------------------------
# The parameter group change table
# ---------------------------------------------------------------------------

_TABLE = {
    "case.1.pcs.csv": [
        ("hk_pp", 4, 0.01411, 3.848, 226, 76.09, 71, 23.91, 0),
        ("rch_gr", 3, 12.35, 5.52, 5, 1.5, 9, 3.0, 2),
    ]
}


def test_a_group_table_is_keyed_by_the_file_it_was_saved_to_and_read_by_header_name(tmp_path):
    facts = _read(tmp_path, group_tables=_TABLE, heading="summmary")

    rows = facts.group_tables["case.1.pcs.csv"]
    assert [r.group for r in rows] == ["hk_pp", "rch_gr"]
    second = rows[1]
    assert second.count == 3
    assert second.mean_chg == 12.35
    assert second.std_chg == 5.52
    assert second.n_at_ubnd == 5
    assert second.n_at_lbnd == 9
    assert second.n_std_decr == 2


def test_both_heading_spellings_give_the_same_rows(tmp_path):
    (tmp_path / "old").mkdir()
    (tmp_path / "new").mkdir()
    old = _read(tmp_path / "old", group_tables=_TABLE, heading="summmary")
    new = _read(tmp_path / "new", group_tables=_TABLE, heading="summary")

    assert old.group_tables == new.group_tables
    assert old.group_tables["case.1.pcs.csv"]


def test_ubnd_and_lbnd_are_mapped_by_header_name_even_when_the_columns_swap(tmp_path):
    path = tmp_path / "case.rec"
    path.write_text(
        "   ---  parameter group change summary  ---    \n"
        "group   count  mean chg  std chg  n at lbnd  % at lbnd  n at ubnd  % at ubnd  n std decr\n"
        "hk_pp   4      1.5       2.5      11         5.0        22         9.0        0\n"
        "\n"
        "...saved parameter change summary to case.1.pcs.csv\n"
    )

    row = read_rec(path).group_tables["case.1.pcs.csv"][0]

    assert (row.n_at_lbnd, row.n_at_ubnd) == (11, 22)
    assert (row.pct_at_lbnd, row.pct_at_ubnd) == (5.0, 9.0)


def test_pestpps_own_column_order_puts_ubnd_before_lbnd_and_is_still_read_right(tmp_path):
    rows = [("hk_pp", 4, 1.5, 2.5, 11, 5.0, 22, 9.0, 0)]
    facts = _read(tmp_path, group_tables={"case.1.pcs.csv": rows})

    row = facts.group_tables["case.1.pcs.csv"][0]
    assert (row.n_at_ubnd, row.n_at_lbnd) == (11, 22)


def test_a_row_of_the_wrong_width_goes_into_a_note_naming_its_line_and_not_into_the_table(tmp_path):
    table = {
        "case.1.pcs.csv": [
            ("hk_pp", 4, 1.5, 2.5, 3, 1.0, 7, 2.0, 0),
            ("bad", 4, 1.5, 2.5, 3, 1.0, 7, 2.0),
        ]
    }
    path = write_rec(tmp_path / "case.rec", group_tables=table)
    facts = read_rec(path)

    assert [r.group for r in facts.group_tables["case.1.pcs.csv"]] == ["hk_pp"]
    bad_line = next(
        i for i, text in enumerate(path.read_text().splitlines(), 1) if text.startswith("bad")
    )
    assert any(f"line {bad_line}" in note and "'bad'" in note for note in facts.notes)


def _table_text(tmp_path, name, rows):
    path = write_rec(tmp_path / name, group_tables={"case.1.pcs.csv": rows})
    text = path.read_text()
    return text[text.index("   ---  parameter group change"):]


def test_a_second_different_table_for_the_same_file_is_left_out_with_a_note_naming_both(tmp_path):
    first = [("hk_pp", 4, 0.01, 3.8, 226, 76.09, 71, 23.91, 0)]
    second = [("hk_pp", 4, 9.99, 3.8, 226, 76.09, 71, 23.91, 0)]
    path = write_rec(tmp_path / "case.rec", group_tables={"case.1.pcs.csv": first})
    path.write_text(path.read_text() + "\n" + _table_text(tmp_path, "other.rec", second))
    lines = path.read_text().splitlines()
    headings = [i for i, t in enumerate(lines, 1) if "parameter group change" in t]

    facts = read_rec(path)

    assert [r.mean_chg for r in facts.group_tables["case.1.pcs.csv"]] == [0.01]
    assert any(
        f"lines {headings[0]} and {headings[1]}" in note and "case.1.pcs.csv" in note and "first is kept" in note
        for note in facts.notes
    )


def test_a_second_identical_table_for_the_same_file_needs_no_note(tmp_path):
    rows = [("hk_pp", 4, 0.01, 3.8, 226, 76.09, 71, 23.91, 0)]
    path = write_rec(tmp_path / "case.rec", group_tables={"case.1.pcs.csv": rows})
    path.write_text(path.read_text() + "\n" + _table_text(tmp_path, "other.rec", rows))

    facts = read_rec(path)

    assert not any("saved to case.1.pcs.csv" in note for note in facts.notes)


def test_a_table_with_no_saved_to_line_is_filed_under_the_last_iteration_report_with_a_note(
    tmp_path,
):
    path = tmp_path / "case.rec"
    path.write_text(
        "  ---  EnsembleMethod iteration 2 report  ---  \n"
        "   ---  parameter group change summary  ---    \n"
        "group   count  mean chg  std chg  n at ubnd  % at ubnd  n at lbnd  % at lbnd  n std decr\n"
        "hk_pp   4      1.5       2.5      3          1.0        7          2.0        0\n"
        "\n"
    )

    facts = read_rec(path)

    assert list(facts.group_tables) == ["case.2.pcs.csv"]
    assert any("no saved-to line" in note and "iteration 2" in note for note in facts.notes)


def test_the_notes_pestpp_prints_right_under_the_last_row_end_the_table_without_a_note_of_ours(
    tmp_path,
):
    path = tmp_path / "case.rec"
    path.write_text(
        "   ---  parameter group change summary  ---    \n"
        "group   count  mean chg  std chg  n at ubnd  % at ubnd  n at lbnd  % at lbnd  n std decr\n"
        "hk_pp   4      1.5       2.5      3          1.0        7          2.0        0\n"
        "    Note: parameter change summary sorted according to percent at bounds.\n"
        "    Note: the parameter change statistics implicitly include the effect of \n"
        "          realizations that have failed or have been dropped.\n"
        "\n"
        "...saved parameter change summary to case.1.pcs.csv\n"
    )

    facts = read_rec(path)

    assert [r.group for r in facts.group_tables["case.1.pcs.csv"]] == ["hk_pp"]
    assert not any("parameter group table" in note for note in facts.notes)


def test_a_header_this_reader_does_not_know_leaves_the_table_out_and_says_so(tmp_path):
    path = tmp_path / "case.rec"
    path.write_text(
        "   ---  parameter group change summary  ---    \n"
        "group   count  something new  mean chg\n"
        "hk_pp   4      1              1.5\n"
        "\n"
        "...saved parameter change summary to case.1.pcs.csv\n"
    )

    facts = read_rec(path)

    assert facts.group_tables == {}
    assert any("header" in note and "line 2" in note for note in facts.notes)
