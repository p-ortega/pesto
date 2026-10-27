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
