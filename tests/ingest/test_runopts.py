"""Reading control-file options by canonical name.

Control files here are written as plain text, so each test says exactly what
the file holds.
"""

from __future__ import annotations

import os

from pesto.ingest.failures import ReadFailure
from pesto.ingest.runopts import OPTION_ALIASES, ControlOptions, scan_options


def _scan(tmp_path, body: str) -> ControlOptions:
    path = tmp_path / "case.pst"
    path.write_text("pcf version=2\n* control data keyword\nnoptmax 3\n" + body)
    result = scan_options(path)
    assert isinstance(result, ControlOptions)
    return result


def test_an_alias_spelling_is_found_under_the_canonical_name_with_its_raw_key(tmp_path):
    options = _scan(tmp_path, "ies_add_base true\n")

    reading = options.get("ies_include_base")

    assert reading is not None
    assert reading.raw_key == "ies_add_base"
    assert reading.value == "true"
    assert reading.line == 4


def test_lookup_by_an_alias_name_finds_the_same_reading(tmp_path):
    options = _scan(tmp_path, "ies_include_base true\n")

    assert options.get("ies_add_base") == options.get("ies_include_base")
    assert options.get("IES_ADD_BASE") is not None


def test_upper_case_keys_match(tmp_path):
    options = _scan(tmp_path, "IES_REG_FAC 0.5\n")

    reading = options.get("ies_reg_factor")

    assert reading is not None
    assert reading.value == "0.5"
    assert reading.raw_key == "IES_REG_FAC"


def test_two_plus_plus_items_on_one_line_are_both_found(tmp_path):
    options = _scan(tmp_path, "++ies_no_noise(true) ++ies_num_reals(300)\n")

    assert options.get("ies_no_noise").value == "true"
    assert options.get("ies_num_reals").value == "300"


def test_text_after_a_hash_is_ignored(tmp_path):
    options = _scan(tmp_path, "ies_localizer localization.jcb  # sparse\n# ies_num_reals 5\n")

    assert options.get("ies_localizer").value == "localization.jcb"
    assert options.get("ies_num_reals") is None


def test_a_hash_hides_a_plus_plus_item(tmp_path):
    options = _scan(tmp_path, "++ies_num_reals(300) # ++ies_no_noise(true)\n")

    assert options.get("ies_num_reals").value == "300"
    assert options.get("ies_no_noise") is None


def test_a_repeated_option_keeps_the_last_value_and_leaves_a_note(tmp_path):
    options = _scan(tmp_path, "ies_n_iter_reinflate 5,999\nies_n_iter_mean 3,999\n")

    assert options.get("ies_n_iter_reinflate").value == "3,999"
    assert len(options.notes) == 1
    note = options.notes[0]
    assert "line 4" in note and "line 5" in note
    assert "ies_n_iter_reinflate" in note and "ies_n_iter_mean" in note


def test_readings_lists_every_occurrence_in_file_order(tmp_path):
    options = _scan(tmp_path, "ies_add_base true\nies_include_base false\n")

    readings = options.readings("ies_include_base")

    assert [(r.raw_key, r.value, r.line) for r in readings] == [
        ("ies_add_base", "true", 4),
        ("ies_include_base", "false", 5),
    ]


def test_an_option_with_no_alias_is_found_under_its_own_lower_cased_name(tmp_path):
    options = _scan(tmp_path, "ies_bad_phi 1e20\nIES_Other_Thing 3\n")

    assert options.get("ies_bad_phi").value == "1e20"
    assert options.get("ies_other_thing").value == "3"


def test_every_alias_spelling_in_the_table_maps_to_its_canonical_name(tmp_path):
    for canonical, spellings in OPTION_ALIASES.items():
        for spelling in spellings:
            options = _scan(tmp_path, f"{spelling} x\n")
            assert options.get(canonical) is not None, spelling


def test_table_rows_are_not_read_as_options(tmp_path):
    path = tmp_path / "case.pst"
    path.write_text(
        "pcf version=2\n* control data keyword\nies_num_reals 300\n"
        "* parameter data\nhk_layer1 log factor 1.0 0.1 10.0 grp 1.0 0.0 1\n"
        "ies_like_name_here 1 2 3\n"
    )

    options = scan_options(path)

    assert isinstance(options, ControlOptions)
    assert options.get("ies_num_reals").value == "300"
    assert options.get("ies_like_name_here") is None
    assert options.get("hk_layer1") is None


def test_a_plus_plus_item_after_the_tables_is_read(tmp_path):
    path = tmp_path / "case.pst"
    path.write_text("* control data\n* parameter data\n++ies_num_reals(50)\n")

    options = scan_options(path)

    assert isinstance(options, ControlOptions)
    assert options.get("ies_num_reals").value == "50"


def test_a_name_with_no_reading_is_none_and_an_empty_list(tmp_path):
    options = _scan(tmp_path, "")

    assert options.get("ies_num_reals") is None
    assert options.readings("ies_num_reals") == ()


def test_a_file_that_is_not_utf8_is_a_failure_naming_it(tmp_path):
    path = tmp_path / "case.pst"
    path.write_bytes(b"pcf version=2\n* control data keyword\nies_num_reals 3\xff0\n")

    result = scan_options(path)

    assert isinstance(result, ReadFailure)
    assert "case.pst" in result.reason


def test_a_missing_file_is_a_failure_naming_it(tmp_path):
    result = scan_options(tmp_path / "gone.pst")

    assert isinstance(result, ReadFailure)
    assert "gone.pst" in result.reason


def test_scanning_changes_nothing_in_the_folder(tmp_path):
    path = tmp_path / "case.pst"
    path.write_text("* control data keyword\nies_num_reals 300\n")
    before = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in tmp_path.iterdir()}
    folder_mtime = tmp_path.stat().st_mtime_ns

    scan_options(path)

    after = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in tmp_path.iterdir()}
    assert after == before
    assert tmp_path.stat().st_mtime_ns == folder_mtime
    assert os.listdir(tmp_path) == ["case.pst"]
