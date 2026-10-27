"""par_groups' type, layer and drill-down offer: what each group says about
itself, and where each statement came from.

The type and layer rules are tested on their own, then through an ingested
run so the stored entries are the ones a route would serve.
"""

from __future__ import annotations

import pandas as pd

from pesto.cache.layout import CacheLayout
from pesto.ingest import parview
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parview import (
    DRILL_DOWN_MAX_PARAMS,
    drill_down_offer,
    group_layer,
    group_type,
    load_par_groups,
    write_par_groups,
)
from pesto.ingest.runner import ingest_run

from .par_fixtures import ParGroupSpec, make_par_view_run, write_placement
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run = make_par_view_run(tmp_path / "run", **kwargs)
    cache = tmp_path / "cache"
    ingest_run(run.root, cache_root=cache)
    return run, CacheLayout(root=cache)


def _groups(layout):
    loaded = load_par_groups(layout)
    assert not isinstance(loaded, ReadFailure), loaded
    return {g["group"]: g for g in loaded["groups"]}, loaded


# ---------------------------------------------------------------------------
# group_type
# ---------------------------------------------------------------------------


def _named(tag, count=2):
    return [f"pname:g_inst:0_ptype:{tag}_usecol:3_idx0:{i}" for i in range(count)]


def test_a_group_whose_names_and_column_agree_has_that_type_and_says_where_it_came_from():
    result = group_type(_named("pp"), ["pp", "pp"])

    assert result["value"] == "pp"
    assert result["source"] == "parameter name and ptype column"


def test_a_group_with_a_tag_in_its_names_and_no_column_says_the_names_gave_it():
    result = group_type(_named("gr"), None)

    assert result["value"] == "gr"
    assert result["source"] == "parameter name"


def test_a_group_with_only_a_column_says_the_column_gave_it():
    result = group_type(["a", "b"], ["pp", "pp"])

    assert result["value"] == "pp"
    assert result["source"] == "ptype column"


def test_a_name_and_a_column_that_disagree_make_the_group_several_and_name_the_parameter():
    names = _named("pp")
    result = group_type(names, ["pp", "gr"])

    assert result["value"] == "several"
    assert names[1] in result["note"]
    assert "'pp'" in result["note"] and "'gr'" in result["note"]


def test_two_tags_across_a_group_make_it_several():
    result = group_type(_named("pp", 1) + _named("gr", 1), None)

    assert result["value"] == "several"
    assert "gr" in result["note"] and "pp" in result["note"]


def test_a_tag_no_one_has_heard_of_is_shown_as_written():
    assert group_type(_named("zzz"), None)["value"] == "zzz"


def test_a_group_with_no_tag_and_no_column_says_it_is_not_stated_and_why():
    result = group_type(["a", "b"], None)

    assert result["value"] is None
    assert result["source"] == "not stated"
    assert result["note"] == "no ptype tag in the parameter names and no ptype column"


def test_a_blank_column_counts_as_no_column():
    result = group_type(["a", "b"], ["", None])

    assert result["value"] is None
    assert result["source"] == "not stated"


def test_a_group_where_only_some_parameters_say_a_type_counts_the_ones_that_do_not():
    result = group_type(_named("pp", 1) + ["plain"], None)

    assert result["value"] == "pp"
    assert "1 of 2" in result["note"]


# ---------------------------------------------------------------------------
# group_layer
# ---------------------------------------------------------------------------


def test_a_placed_group_takes_its_layer_from_the_placement_and_names_the_rule():
    result = group_layer([2, 2, 2], "idx-layer", "anything")

    assert result["value"] == 2
    assert result["source"] == "placement rule idx-layer"


def test_a_group_placed_on_two_layers_is_several():
    result = group_layer([1, 2, 1], "idx-layer", "g")

    assert result["value"] == "several"
    assert result["source"] == "placement rule idx-layer"


def test_an_unplaced_group_reads_the_layer_from_its_name_as_written_and_never_converts_it():
    zero = group_layer([], None, "ghb_layer0_pp")
    three = group_layer([], None, "hk_layer3")

    assert (zero["value"], zero["source"]) == (0, "group name, as written")
    assert (three["value"], three["source"]) == (3, "group name, as written")


def test_a_group_name_naming_two_layers_is_several():
    result = group_layer([], None, "layer1_to_layer2")

    assert result["value"] == "several"
    assert result["source"] == "group name, as written"


def test_a_group_with_no_placement_and_no_layer_in_its_name_says_not_stated():
    result = group_layer([], None, "plain")

    assert result["value"] is None
    assert result["source"] == "not stated"
    assert result["note"]


def test_placement_wins_over_the_group_name():
    assert group_layer([4], "idx-layer", "hk_layer3")["value"] == 4


# ---------------------------------------------------------------------------
# Through an ingested run
# ---------------------------------------------------------------------------

SPECS = (
    ParGroupSpec("hk_layer3", 3, "log", tag="pp", column="pp"),
    ParGroupSpec("ghb_layer0_pp", 2, "log", tag="gr", column="gr"),
    ParGroupSpec("disagree", 2, "none", tag="pp", column="gr"),
    ParGroupSpec("bare", 2, "none", tag=None, column=None),
)


def test_the_stored_entries_carry_each_groups_type_and_name_based_layer(tmp_path, in_process):  # noqa: F811
    run, layout = _ingest(tmp_path, groups=SPECS)
    # pyemu fills the ptype column from the names, so a disagreement is made in the cache.
    path = layout.control / "par.parquet"
    frame = pd.read_parquet(path)
    frame.loc[frame["pargp"].astype(str) == "disagree", "ptype"] = "gr"
    frame.to_parquet(path, index=False)
    assert not isinstance(write_par_groups(run.root, layout), ReadFailure)
    groups, top = _groups(layout)

    assert groups["hk_layer3"]["type"]["value"] == "pp"
    assert groups["disagree"]["type"]["value"] == "several"
    assert groups["bare"]["type"]["value"] is None
    assert groups["bare"]["type"]["source"] == "not stated"
    assert groups["hk_layer3"]["layer"]["value"] == 3
    assert groups["hk_layer3"]["layer"]["source"] == "group name, as written"
    assert groups["ghb_layer0_pp"]["layer"]["value"] == 0
    assert groups["bare"]["layer"]["value"] is None
    # No grid in this run: the run says why no layer came from a placement.
    assert any("placement" in note for note in top["notes"])


def test_a_placed_group_takes_its_layer_from_par_cell_even_when_its_name_says_another(
    tmp_path, in_process  # noqa: F811
):
    run, layout = _ingest(tmp_path, groups=SPECS)
    written = write_placement(layout, {"hk_layer3": 1, "ghb_layer0_pp": [0, 2]})
    assert not isinstance(written, ReadFailure), written
    assert not isinstance(write_par_groups(run.root, layout), ReadFailure)
    groups, top = _groups(layout)

    assert groups["hk_layer3"]["layer"]["value"] == 1
    assert groups["hk_layer3"]["layer"]["source"] == "placement rule idx-layer"
    assert groups["ghb_layer0_pp"]["layer"]["value"] == "several"
    assert groups["disagree"]["layer"]["source"] == "not stated"
    assert not any("placement is unavailable" in note for note in top["notes"])


# ---------------------------------------------------------------------------
# Drill-down offer
# ---------------------------------------------------------------------------


def test_the_limit_is_ten_thousand_parameters():
    assert DRILL_DOWN_MAX_PARAMS == 10_000


def test_a_group_at_the_limit_is_offered_drill_down_and_one_over_is_refused_with_the_reason(
    tmp_path, in_process, monkeypatch  # noqa: F811
):
    run, layout = _ingest(tmp_path)
    monkeypatch.setattr(parview, "DRILL_DOWN_MAX_PARAMS", 4)
    assert not isinstance(write_par_groups(run.root, layout), ReadFailure)
    at_limit, _top = _groups(layout)
    monkeypatch.setattr(parview, "DRILL_DOWN_MAX_PARAMS", 3)
    assert not isinstance(write_par_groups(run.root, layout), ReadFailure)
    over, _top = _groups(layout)

    assert at_limit["hk_pp"]["drill_down"] == {"offered": True, "reason": None}
    assert over["hk_pp"]["drill_down"] == {
        "offered": False,
        "reason": "This group has 4 parameters. Drill-down is offered up to 3.",
    }
    assert over["mix"]["drill_down"]["offered"] is True


def test_the_refusal_writes_the_numbers_with_thousands_separators():
    assert drill_down_offer(10_001, 10_000) == {
        "offered": False,
        "reason": "This group has 10,001 parameters. Drill-down is offered up to 10,000.",
    }
    assert drill_down_offer(10_000, 10_000) == {"offered": True, "reason": None}


# ---------------------------------------------------------------------------
# pestpp's own group figures: the CSV, or the run record when the CSV is absent
# ---------------------------------------------------------------------------

_RECORD_ROW = ("hk_pp", 4, 12.35, 1.5, 3, 2.5, 7, 6.0, 0)


def _csv_row(mean_change, *, lower=7, upper=3):
    return {
        "group": "hk_pp",
        "mean_change": mean_change,
        "std_change": 1.5,
        "num_at_near_lbound": lower,
        "num_at_near_ubound": upper,
    }


def test_without_the_csv_pestpps_figures_come_from_the_run_record_and_say_so(tmp_path, in_process):  # noqa: F811
    _run, layout = _ingest(tmp_path, rec={"group_tables": {"case.1.pcs.csv": [_RECORD_ROW]}})
    groups, _top = _groups(layout)

    pestpp = groups["hk_pp"]["change"]["pestpp"]
    assert pestpp["source"] == "case.rec, from the run record, 4 significant digits"
    assert pestpp["mean_change"] == 12.35
    assert pestpp["std_change"] == 1.5
    # the record's ubnd and lbnd columns map by name onto the CSV's names
    assert pestpp["num_at_near_lbound"] == 7
    assert pestpp["num_at_near_ubound"] == 3
    assert "pcs.csv file for iteration 1 was not found" in pestpp["note"]


def test_without_the_csv_and_without_a_record_table_the_figures_stay_empty_with_the_reason(
    tmp_path, in_process  # noqa: F811
):
    _run, layout = _ingest(tmp_path, rec=True)
    groups, _top = _groups(layout)

    pestpp = groups["hk_pp"]["change"]["pestpp"]
    assert pestpp["source"] is None
    assert pestpp["mean_change"] is None
    assert "not found" in pestpp["note"]


def _pcs_file(tmp_path, text: str | bytes):
    path = tmp_path / "case.1.pcs.csv"
    path.write_bytes(text if isinstance(text, bytes) else text.encode())
    return path


def test_a_group_named_twice_in_the_pcs_file_keeps_the_first_row_and_names_both_lines(tmp_path):
    path = _pcs_file(tmp_path, "group,mean_change\nhk_pp,1.5\nhk_pp,9.5\n")

    figures, note = parview._read_pcs(path, 1)

    assert figures["hk_pp"]["mean_change"] == 1.5
    assert "'hk_pp'" in note and "lines 2 and 3" in note and "first row is kept" in note


def test_a_group_name_in_capitals_is_joined_on_its_lower_case_name(tmp_path):
    path = _pcs_file(tmp_path, "group,mean_change\nHK_PP,1.5\n")

    figures, _note = parview._read_pcs(path, 1)
    entry = parview._pestpp_entry("hk_pp", figures, path.name, None)

    assert entry["mean_change"] == 1.5
    assert entry["source"] == "pestpp, case.1.pcs.csv"


def test_bytes_that_are_not_utf8_in_the_pcs_file_are_counted_in_the_note(tmp_path):
    header = "group,mean_change,std_change,num_at_near_lbound,num_at_near_ubound\n"
    path = _pcs_file(tmp_path, header.encode() + b"hk\xff\xfe,1.5,1,0,0\n")

    figures, note = parview._read_pcs(path, 1)

    assert len(figures) == 1
    assert "2 characters in case.1.pcs.csv were not valid UTF-8" in note


def test_an_unreadable_pcs_file_in_a_folder_with_a_space_leaks_no_part_of_the_folder_name(tmp_path):
    folder = tmp_path / "Jane Doe" / "runs"
    (folder / "case.1.pcs.csv").mkdir(parents=True)

    figures, note = parview._read_pcs(folder / "case.1.pcs.csv", 1)

    assert figures is None
    assert note.startswith("case.1.pcs.csv could not be read")
    assert "Jane" not in note and "Doe" not in note and "runs/" not in note


def test_a_csv_and_a_record_that_agree_to_the_records_rounding_show_no_disagreement(
    tmp_path, in_process  # noqa: F811
):
    _run, layout = _ingest(
        tmp_path,
        pcs_rows=[_csv_row(12.3456)],
        rec={"group_tables": {"case.1.pcs.csv": [_RECORD_ROW]}},
    )
    groups, _top = _groups(layout)

    pestpp = groups["hk_pp"]["change"]["pestpp"]
    assert pestpp["source"] == "pestpp, case.1.pcs.csv"
    assert pestpp["mean_change"] == 12.3456
    assert pestpp["note"] is None
    assert pestpp.get("record") is None


def test_a_csv_and_a_record_that_differ_show_both_numbers_and_say_they_disagree(
    tmp_path, in_process  # noqa: F811
):
    _run, layout = _ingest(
        tmp_path,
        pcs_rows=[_csv_row(12.3456)],
        rec={"group_tables": {"case.1.pcs.csv": [("hk_pp", 4, 12.40, 1.5, 3, 2.5, 7, 6.0, 0)]}},
    )
    groups, _top = _groups(layout)

    pestpp = groups["hk_pp"]["change"]["pestpp"]
    assert pestpp["mean_change"] == 12.3456
    assert "disagree" in pestpp["note"]
    assert "12.3456" in pestpp["note"] and "12.4" in pestpp["note"]
    assert pestpp["record"]["mean_change"] == 12.4
    assert pestpp["record"]["source"] == "case.rec, from the run record, 4 significant digits"


def test_a_bound_count_that_differs_between_the_csv_and_the_record_is_a_disagreement(
    tmp_path, in_process  # noqa: F811
):
    _run, layout = _ingest(
        tmp_path,
        pcs_rows=[_csv_row(12.3456, lower=8)],
        rec={"group_tables": {"case.1.pcs.csv": [_RECORD_ROW]}},
    )
    groups, _top = _groups(layout)

    note = groups["hk_pp"]["change"]["pestpp"]["note"]
    assert "disagree" in note and "num_at_near_lbound" in note
    assert "8" in note and "7" in note


def test_a_record_table_that_the_csv_has_no_group_for_adds_nothing_to_that_group(
    tmp_path, in_process  # noqa: F811
):
    rows = [("other", 4, 12.40, 1.5, 3, 2.5, 7, 6.0, 0)]
    _run, layout = _ingest(
        tmp_path, pcs_rows=[_csv_row(12.3456)], rec={"group_tables": {"case.1.pcs.csv": rows}}
    )
    groups, _top = _groups(layout)

    assert groups["hk_pp"]["change"]["pestpp"]["note"] is None


def test_a_malformed_record_row_is_named_in_the_top_level_notes(tmp_path, in_process):  # noqa: F811
    rows = [_RECORD_ROW, ("bad", 4, 1.5, 2.5, 3, 1.0, 7, 2.0)]
    _run, layout = _ingest(tmp_path, rec={"group_tables": {"case.1.pcs.csv": rows}})
    _groups_by_name, top = _groups(layout)

    assert any("'bad'" in note and "line" in note for note in top["notes"])
