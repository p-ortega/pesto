"""Proof that every one of the five ordered placement rules fires on a
parameter table shaped the way ``read_control`` really hands one over --
``parnme``-indexed, in whatever row order the control file happened to
carry, with ``pargp`` a pandas ``category`` -- plus the rule table's
ordering contract: the first rule that produces at least one in-range hit
wins the group, not the first rule whose columns merely exist.

Every fixture in this file is a literal ``pd.DataFrame`` built through
``_par_frame`` below, following ``tests/ingest/test_control.py``'s
literal-DataFrame convention. Two properties hold in every one of them,
because the reference implementation's own tests lacked both and that is
why they never caught the positional-index bug a later test module in this
file guards against: the index is a list of ``parnme`` strings,
deliberately not in sorted order, and ``pargp`` is cast to ``category``
dtype.
"""

from __future__ import annotations

import re

import pandas as pd

import numpy as np
import pytest

from pesto.ingest.failures import ReadFailure
from pesto.model import GridShape, GroupResolution, ParCells
from pesto.model._parcells import (
    RULE_NAMES,
    UNMAPPED,
    UNPLACED_REASONS,
    UNRECOGNIZED_PLACEMENT_COLUMNS,
    _summarize,
    resolve,
)


def _par_frame(rows: dict, parnme: list[str]) -> pd.DataFrame:
    """A literal parameter table shaped like ``ControlTables.par``: indexed
    by ``parnme`` (named, not a default ``RangeIndex``) and with ``pargp``
    tightened to ``category`` dtype -- the two properties ``read_control``
    always produces and a synthetic frame with a default index would not.
    """
    df = pd.DataFrame(rows, index=pd.Index(parnme, name="parnme"))
    if "pargp" in df.columns:
        df["pargp"] = df["pargp"].astype("category")
    return df


def _group(result: ParCells, name: str) -> GroupResolution:
    return next(g for g in result.groups if g.group == name)


def _placements(result: ParCells) -> dict[str, tuple[int, int]]:
    """parnme -> (cell, layer), read by name, never by array position --
    the shape every load-bearing assertion in this module uses, because an
    assertion built from a bare array position cannot catch a bug about
    positions."""
    return dict(zip(result.parnme, zip(result.cell.tolist(), result.layer.tolist())))


def test_kij_rule_places_via_k_i_j_columns_on_a_structured_grid():
    """No benchmark run and no vendored fixture anywhere carries a literal
    ``k`` column (03-RESEARCH.md Pitfall 2) -- this rule's only evidence,
    anywhere, is this synthetic frame. That is a real coverage limit, and
    stating it here is better than leaving a reader to assume real data
    backs it."""
    shape = GridShape(ncpl=20, nlay=3, nrow=4, ncol=5)
    par = _par_frame(
        {
            "pargp": ["g1", "g1", "g1"],
            "k": [0, 1, 2],
            "i": [0, 1, 3],
            "j": [0, 2, 4],
        },
        parnme=["par:c", "par:a", "par:b"],
    )

    result = resolve(par, shape)

    group = _group(result, "g1")
    assert group.rule == "kij"
    assert group.mapped == 3
    placements = _placements(result)
    assert placements["par:c"] == (0 * 5 + 0, 0)
    assert placements["par:a"] == (1 * 5 + 2, 1)
    assert placements["par:b"] == (3 * 5 + 4, 2)


def test_idx_triple_rule_places_via_idx0_idx1_idx2_on_a_structured_grid():
    shape = GridShape(ncpl=20, nlay=3, nrow=4, ncol=5)
    par = _par_frame(
        {
            "pargp": ["wel", "wel", "wel"],
            "idx0": [0, 1, 2],
            "idx1": [0, 1, 3],
            "idx2": [0, 2, 4],
        },
        parnme=["par:b", "par:c", "par:a"],
    )

    result = resolve(par, shape)

    group = _group(result, "wel")
    assert group.rule == "idx-triple"
    assert group.mapped == 3
    placements = _placements(result)
    assert placements["par:b"] == (0 * 5 + 0, 0)
    assert placements["par:c"] == (1 * 5 + 2, 1)
    assert placements["par:a"] == (3 * 5 + 4, 2)


def test_idx_pair_rule_places_via_idx0_idx1_on_a_vertex_grid():
    """``ncol`` unknown means DISV -- ``idx-pair`` reads ``idx1`` straight
    as the cell number, no ``i*ncol+j`` arithmetic."""
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {
            "pargp": ["dewatdrn", "dewatdrn"],
            "idx0": [0, 1],
            "idx1": [3, 7],
        },
        parnme=["par:z", "par:a"],
    )

    result = resolve(par, shape)

    group = _group(result, "dewatdrn")
    assert group.rule == "idx-pair"
    assert group.mapped == 2
    placements = _placements(result)
    assert placements["par:z"] == (3, 0)
    assert placements["par:a"] == (7, 1)


def test_ij_name_layer_rule_reads_layer_from_the_group_name_one_based_to_zero_based():
    """Real ``freyberg_ies`` group names (03-RESEARCH.md Pitfall 4), each
    resolving the one-based layer number in the name to a zero-based
    layer index -- the whole content of this rule."""
    shape = GridShape(ncpl=50, nlay=3, nrow=5, ncol=10)

    layer1 = _par_frame(
        {"pargp": ["npf_k_layer1_gr", "npf_k_layer1_gr"], "i": [0, 1], "j": [0, 2]},
        parnme=["par:b", "par:a"],
    )
    result1 = resolve(layer1, shape)
    group1 = _group(result1, "npf_k_layer1_gr")
    assert group1.rule == "ij-name-layer"
    assert _placements(result1)["par:b"][1] == 0
    assert _placements(result1)["par:a"][1] == 0

    layer2 = _par_frame(
        {"pargp": ["npf_k33_layer2_pp"], "i": [1], "j": [1]}, parnme=["par:c"]
    )
    result2 = resolve(layer2, shape)
    assert _group(result2, "npf_k33_layer2_pp").rule == "ij-name-layer"
    assert _placements(result2)["par:c"][1] == 1

    layer3 = _par_frame(
        {"pargp": ["sto_ss_layer3_gr"], "i": [2], "j": [2]}, parnme=["par:d"]
    )
    result3 = resolve(layer3, shape)
    assert _group(result3, "sto_ss_layer3_gr").rule == "ij-name-layer"
    assert _placements(result3)["par:d"][1] == 2


def test_ij_name_layer_rule_falls_out_of_range_rather_than_wrapping_when_the_name_exceeds_nlay():
    shape = GridShape(ncpl=50, nlay=2, nrow=5, ncol=10)
    par = _par_frame(
        {"pargp": ["npf_k_layer5_gr"], "i": [0], "j": [0]}, parnme=["par:a"]
    )

    result = resolve(par, shape)

    group = _group(result, "npf_k_layer5_gr")
    assert group.rule == UNMAPPED
    assert group.mapped == 0
    assert _placements(result)["par:a"] == (-1, -1)


def test_ij_single_layer_rule_places_layer_zero_when_the_grid_has_one_layer():
    shape = GridShape(ncpl=90, nlay=1, nrow=9, ncol=10)
    par = _par_frame(
        {"pargp": ["ghbb-cond", "ghbb-cond"], "i": [0, 3], "j": [0, 4]},
        parnme=["par:y", "par:x"],
    )

    result = resolve(par, shape)

    group = _group(result, "ghbb-cond")
    assert group.rule == "ij-single-layer"
    placements = _placements(result)
    assert placements["par:y"] == (0, 0)
    assert placements["par:x"] == (3 * 10 + 4, 0)


def test_unmapped_when_no_rule_recognises_any_of_the_groups_columns():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["mystery"], "zone": [1]}, parnme=["par:a"]
    )

    result = resolve(par, shape)

    group = _group(result, "mystery")
    assert group.rule == UNMAPPED
    assert group.mapped == 0
    assert group.total == 1


def test_rule_precedence_kij_wins_over_idx_triple_when_both_present_and_disagree():
    """A group carrying both rule tables' columns, chosen so the two rules
    would place different cells -- proves the table's ordering contract,
    not just that each rule works in isolation."""
    shape = GridShape(ncpl=100, nlay=5, nrow=10, ncol=10)
    par = _par_frame(
        {
            "pargp": ["both"],
            "k": [0],
            "i": [0],
            "j": [0],
            "idx0": [4],
            "idx1": [9],
            "idx2": [9],
        },
        parnme=["par:a"],
    )

    result = resolve(par, shape)

    group = _group(result, "both")
    assert group.rule == "kij"
    assert _placements(result)["par:a"] == (0 * 10 + 0, 0)


def test_first_applicable_rule_with_no_in_range_hit_yields_to_the_next_one_that_has_one():
    """The table's contract is "first rule that produces at least one
    in-range hit", not "first rule whose columns exist" -- ``kij``'s columns
    are present but every candidate is out of range, so ``idx-triple``
    (also present) must take the group instead."""
    shape = GridShape(ncpl=20, nlay=3, nrow=4, ncol=5)
    par = _par_frame(
        {
            "pargp": ["fallthrough"],
            "k": [99],  # out of range: nlay=3
            "i": [99],
            "j": [99],
            "idx0": [1],
            "idx1": [1],
            "idx2": [2],
        },
        parnme=["par:a"],
    )

    result = resolve(par, shape)

    group = _group(result, "fallthrough")
    assert group.rule == "idx-triple"
    assert _placements(result)["par:a"] == (1 * 5 + 2, 1)


def test_idx_pair_columns_on_a_structured_grid_fall_through_to_unmapped():
    """03-RESEARCH.md Pitfall 7, measured against ``lheg_ies``: ``idx0``/
    ``idx1`` with no ``idx2`` and no ``i``/``j``, on a grid whose ``ncol``
    is known, resolves ``unmapped`` -- ``idx-pair`` guards on ``ncol`` being
    unknown, so it does not fire even though the group plainly carries some
    location metadata."""
    shape = GridShape(ncpl=90, nlay=1, nrow=9, ncol=10)
    par = _par_frame(
        {"pargp": ["chd_head"], "idx0": [0], "idx1": [1]}, parnme=["par:a"]
    )

    result = resolve(par, shape)

    group = _group(result, "chd_head")
    assert group.rule == UNMAPPED
    assert group.mapped == 0


def test_all_five_rule_names_are_covered_by_this_module():
    """A structural check that this file's rule coverage matches
    ``RULE_NAMES`` exactly -- if a sixth rule is ever added, this test fails
    until this file is extended to cover it too."""
    assert RULE_NAMES == (
        "kij",
        "idx-triple",
        "idx-pair",
        "ij-name-layer",
        "ij-single-layer",
    )


# ---------------------------------------------------------------------------
# Task 2: a parameter never lands on a row it does not belong to.
#
# This is the regression test group for the one real bug 03-RESEARCH.md
# found in the M0 reference: `block.index.to_numpy()` (or any label-based
# lookup built from it) treated as if it were already integer row positions.
# Every assertion below is built the same way -- a name-to-cell mapping, read
# by zipping `ParCells.parnme` with `cell`/`layer` -- because an assertion
# that reads a bare array position cannot catch a bug about positions.
# ---------------------------------------------------------------------------


def test_shuffled_parnme_index_places_each_parameter_on_its_own_row_by_name():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {
            "pargp": ["g", "g", "g", "g"],
            "idx0": [0, 1, 0, 1],
            "idx1": [1, 2, 3, 4],
        },
        parnme=["par:d", "par:b", "par:a", "par:c"],
    )

    result = resolve(par, shape)

    expected = {"par:d": (1, 0), "par:b": (2, 1), "par:a": (3, 0), "par:c": (4, 1)}
    assert _placements(result) == expected


def test_resolving_the_same_rows_in_a_different_order_gives_the_same_name_to_cell_mapping():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    rows = {
        "pargp": ["g", "g", "g"],
        "idx0": [0, 1, 0],
        "idx1": [1, 2, 3],
    }
    names = ["par:a", "par:b", "par:c"]
    par1 = _par_frame(rows, parnme=names)

    reordered_rows = {k: [v[2], v[0], v[1]] for k, v in rows.items()}
    par2 = _par_frame(reordered_rows, parnme=[names[2], names[0], names[1]])

    result1 = resolve(par1, shape)
    result2 = resolve(par2, shape)

    assert _placements(result1) == _placements(result2)


def test_a_rangeindex_offset_away_from_zero_is_still_not_treated_as_a_row_position():
    """An index that happens to be integers is still not a row position --
    a RangeIndex starting at 1000 must place exactly as a 0-based one
    would."""
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = pd.DataFrame(
        {
            "pargp": pd.Categorical(["g", "g", "g"]),
            "idx0": [0, 1, 0],
            "idx1": [1, 2, 3],
        },
        index=pd.RangeIndex(1000, 1003),
    )

    result = resolve(par, shape)

    cell_by_label = dict(zip(par.index, zip(result.cell.tolist(), result.layer.tolist())))
    assert cell_by_label[1000] == (1, 0)
    assert cell_by_label[1001] == (2, 1)
    assert cell_by_label[1002] == (3, 0)


def test_a_duplicated_parnme_value_resolves_both_rows_correctly_without_raising():
    """A real control file should not carry two parameters with the same
    name, but a broken one can. Row-position lookup via
    ``groupby(...).indices`` handles this naturally -- it is positional, not
    label-based -- so both rows place, in order, with no double-write and
    no exception."""
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {
            "pargp": ["g", "g", "g"],
            "idx0": [0, 1, 0],
            "idx1": [1, 2, 3],
        },
        parnme=["par:dup", "par:b", "par:dup"],
    )

    result = resolve(par, shape)

    assert result.cell.tolist() == [1, 2, 3]
    assert result.layer.tolist() == [0, 1, 0]
    assert result.parnme == ("par:dup", "par:b", "par:dup")


def test_parcells_parnme_is_the_same_length_and_order_as_cell_and_layer():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g", "g"], "idx0": [0, 1], "idx1": [1, 2]},
        parnme=["par:b", "par:a"],
    )

    result = resolve(par, shape)

    assert len(result.parnme) == len(result.cell) == len(result.layer) == 2
    assert result.parnme == ("par:b", "par:a")


def test_resolve_leaves_the_callers_dataframe_completely_untouched():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g", "g"], "idx0": [0, 1], "idx1": [1, 2]},
        parnme=["par:b", "par:a"],
    )
    before = par.copy(deep=True)

    resolve(par, shape)

    pd.testing.assert_frame_equal(par, before)


def test_a_group_whose_candidates_are_all_out_of_range_writes_nothing_leaving_minus_one():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g", "g"], "idx0": [9, 9], "idx1": [99, 99]},
        parnme=["par:a", "par:b"],
    )

    result = resolve(par, shape)

    assert result.cell.tolist() == [-1, -1]
    assert result.layer.tolist() == [-1, -1]


# ---------------------------------------------------------------------------
# Task 3: unplaceable is -1, said once, with nothing dropped.
# ---------------------------------------------------------------------------


def test_summary_for_a_scale_matching_the_real_measured_777_of_785_group_run():
    """03-RESEARCH.md Pitfall 5, measured against a real DISV run: 777 of
    785 parameter groups carry no placement columns at all. The one-sentence
    summary must hold at exactly this scale -- one period, both counts, and
    not one of the 777 group names."""
    n_unplaceable = 777
    n_placeable = 8
    rows: dict[str, list] = {"pargp": [], "idx0": [], "idx1": []}
    parnme: list[str] = []
    for i in range(n_unplaceable):
        rows["pargp"].append(f"unplaceable_group_{i}")
        rows["idx0"].append(None)
        rows["idx1"].append(None)
        parnme.append(f"par:unplaceable:{i}")
    for i in range(n_placeable):
        rows["pargp"].append(f"placeable_group_{i}")
        rows["idx0"].append(0)
        rows["idx1"].append(i)
        parnme.append(f"par:placeable:{i}")

    shape = GridShape(ncpl=100, nlay=2, nrow=None, ncol=None)
    par = _par_frame(rows, parnme=parnme)

    result = resolve(par, shape)

    assert len(result.groups) == n_unplaceable + n_placeable
    assert result.summary.count(".") == 1
    assert str(n_unplaceable) in result.summary
    assert str(n_unplaceable + n_placeable) in result.summary
    for i in range(n_unplaceable):
        assert f"unplaceable_group_{i}" not in result.summary


def test_placed_groups_and_unplaced_groups_partition_every_group_with_no_overlap():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {
            "pargp": ["placed", "placed", "empty"],
            "idx0": [0, 1, None],
            "idx1": [1, 2, None],
        },
        parnme=["par:a", "par:b", "par:c"],
    )

    result = resolve(par, shape)

    all_groups = {g.group for g in result.groups}
    assert set(result.placed_groups) | set(result.unplaced_groups) == all_groups
    assert set(result.placed_groups) & set(result.unplaced_groups) == set()


def test_no_group_anywhere_in_this_module_gives_cell_zero_or_layer_zero_as_a_stand_in():
    """The blunt, module-wide never-zero assertion: an unplaceable case has
    cell/layer exactly -1, never 0, which is a real cell."""
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["a", "b"], "idx0": [None, None], "idx1": [None, None]},
        parnme=["par:a", "par:b"],
    )

    result = resolve(par, shape)
    unplaced_rows = result.cell == -1

    assert unplaced_rows.all()
    assert (result.cell[unplaced_rows] == -1).all()
    assert not (result.cell[unplaced_rows] == 0).any()
    assert (result.layer[unplaced_rows] == -1).all()
    assert not (result.layer[unplaced_rows] == 0).any()


def test_a_group_carrying_an_unrecognised_placement_column_with_data_gets_exactly_one_note():
    """03-RESEARCH.md Pitfall 5: two groups in a real run carry ``layer``/
    ``icpl`` instead of ``idx0``/``idx1`` -- column names the locked rule
    table does not read at all. The rule table is not amended; a note says
    the data was seen and deliberately not used."""
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["gwt_src_benzene_decayexp"], "icpl": [3]}, parnme=["par:a"]
    )

    result = resolve(par, shape)

    group = _group(result, "gwt_src_benzene_decayexp")
    assert group.rule == UNMAPPED
    matching_notes = [
        n for n in result.notes if "gwt_src_benzene_decayexp" in n and "icpl" in n
    ]
    assert len(matching_notes) == 1


def test_a_group_with_no_placement_columns_at_all_produces_no_note():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame({"pargp": ["ordinary"]}, parnme=["par:a"])

    result = resolve(par, shape)

    assert _group(result, "ordinary").rule == UNMAPPED
    assert not any("ordinary" in n for n in result.notes)


def test_unrecognized_placement_columns_constant_names_layer_icpl_and_node():
    assert set(UNRECOGNIZED_PLACEMENT_COLUMNS) == {"layer", "icpl", "node"}


def test_a_group_with_some_in_range_and_some_out_of_range_reports_the_shortfall():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["mixed", "mixed"], "idx0": [0, 0], "idx1": [1, 99]},
        parnme=["par:a", "par:b"],
    )

    result = resolve(par, shape)

    group = _group(result, "mixed")
    assert group.mapped == 1
    assert group.total == 2
    assert any("mixed" in n for n in result.notes)


def test_boundary_zero_accepted_nlay_and_ncpl_rejected():
    shape = GridShape(ncpl=5, nlay=3, nrow=None, ncol=None)
    par = _par_frame(
        {
            "pargp": ["boundary", "boundary"],
            "idx0": [0, 3],  # 0 accepted, 3 == nlay rejected
            "idx1": [0, 5],  # 0 accepted, 5 == ncpl rejected
        },
        parnme=["par:in", "par:out"],
    )

    result = resolve(par, shape)

    placements = _placements(result)
    assert placements["par:in"] == (0, 0)
    assert placements["par:out"] == (-1, -1)


def test_empty_parameter_table_gives_zero_length_arrays_and_a_non_error_summary():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame({"pargp": [], "idx0": [], "idx1": []}, parnme=[])

    result = resolve(par, shape)

    assert result.cell.dtype == np.int32
    assert result.layer.dtype == np.int32
    assert len(result.cell) == 0
    assert len(result.layer) == 0
    assert result.groups == ()
    assert result.summary


def test_summary_when_every_group_placed_says_so_in_one_sentence():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame({"pargp": ["g"], "idx0": [0], "idx1": [1]}, parnme=["par:a"])

    result = resolve(par, shape)

    assert result.summary.count(".") == 1
    assert not any(g.mapped == 0 for g in result.groups)


@pytest.mark.parametrize("column", ["k", "i", "j", "idx0", "idx1", "idx2"])
def test_a_column_that_cannot_be_read_as_a_number_is_coerced_to_nan_not_fabricated(column):
    """A malformed placement value should not crash resolution -- it is
    coerced to NaN, which then fails the range check honestly."""
    shape = GridShape(ncpl=10, nlay=2, nrow=4, ncol=3)
    rows = {
        "pargp": ["g"],
        "k": [0],
        "i": [0],
        "j": [0],
        "idx0": [0],
        "idx1": [0],
        "idx2": [0],
    }
    rows[column] = ["not-a-number"]
    par = _par_frame(rows, parnme=["par:a"])

    result = resolve(par, shape)  # must not raise
    assert isinstance(result, ParCells)


# ---------------------------------------------------------------------------
# Task 1: a parameter table with no `pargp` column is refused by name,
# never by a KeyError escaping the resolve()/locate_par() boundary.
# ---------------------------------------------------------------------------


def test_a_parameter_table_with_no_pargp_column_is_refused_by_name_rather_than_raising():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = pd.DataFrame(
        {"idx0": [0], "idx1": [1]}, index=pd.Index(["par:a"], name="parnme")
    )

    result = resolve(par, shape)

    assert isinstance(result, ReadFailure)


def test_the_no_pargp_column_refusal_names_the_parameter_table_not_the_grid_file():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = pd.DataFrame(
        {"idx0": [0], "idx1": [1]}, index=pd.Index(["par:a"], name="parnme")
    )

    result = resolve(par, shape)

    assert isinstance(result, ReadFailure)
    assert "pargp" in result.reason
    assert result.name == "parameter table"
    assert result.path == ""


def test_an_empty_parameter_table_with_no_pargp_column_is_refused_whatever_its_row_count():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = pd.DataFrame(
        {"idx0": [], "idx1": []}, index=pd.Index([], name="parnme")
    )

    result = resolve(par, shape)

    assert isinstance(result, ReadFailure)


# ---------------------------------------------------------------------------
# Task 2: a parameter with no group at all is counted, named and never
# allowed to shrink the reported total.
# ---------------------------------------------------------------------------


def test_a_parameter_whose_pargp_is_null_gets_its_own_group_row_and_a_note():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g", None], "idx0": [0, 0], "idx1": [1, 2]},
        parnme=["par:a", "par:b"],
    )

    result = resolve(par, shape)

    assert (
        result.summary
        == "1 of 2 parameter group(s) could not be placed on the grid, "
        "accounting for 1 of 2 parameters."
    )
    no_group = _group(result, "(no pargp)")
    assert no_group.total == 1
    matching_notes = [n for n in result.notes if "(no pargp)" in n and "par:b" in n]
    assert len(matching_notes) == 1
    assert _placements(result)["par:b"] == (-1, -1)


def test_a_table_whose_pargp_is_null_on_every_row_reports_every_parameter_as_unplaced():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    n = 785
    par = _par_frame(
        {"pargp": [None] * n, "idx0": [0] * n, "idx1": [0] * n},
        parnme=[f"p{i}" for i in range(n)],
    )

    result = resolve(par, shape)

    assert "785 of 785 parameters" in result.summary
    assert "1 of 1 parameter group(s)" in result.summary
    assert result.summary != "no parameter groups were present to place."


def test_the_null_group_note_names_the_first_three_parameters_and_counts_the_rest():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": [None] * 5, "idx0": [0] * 5, "idx1": [0] * 5},
        parnme=["par:a", "par:b", "par:c", "par:d", "par:e"],
    )

    result = resolve(par, shape)

    matching_notes = [n for n in result.notes if "(no pargp)" in n]
    assert len(matching_notes) == 1
    note = matching_notes[0]
    assert "'par:a'" in note
    assert "'par:b'" in note
    assert "'par:c'" in note
    assert "2 more" in note


def test_the_summary_counts_parameters_from_the_table_not_from_the_groups_it_tracked():
    summary = _summarize((GroupResolution(group="g", rule=UNMAPPED, mapped=0, total=1),), 2)

    assert "every one of the" not in summary


# ---------------------------------------------------------------------------
# Task 3: a fractional placement value is refused and named, never
# truncated toward zero.
# ---------------------------------------------------------------------------


def test_a_fractional_placement_value_is_refused_and_named_rather_than_truncated():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g"], "idx0": [0], "idx1": [1.9]}, parnme=["par:a"]
    )

    result = resolve(par, shape)

    assert _placements(result)["par:a"] == (-1, -1)
    group = _group(result, "g")
    assert group.mapped == 0
    matching_notes = [n for n in result.notes if "g" in n and "'idx1'" in n]
    assert len(matching_notes) == 1


def test_a_fractional_i_that_multiplies_into_a_whole_cell_number_is_still_refused():
    """``ncol = 2`` and ``i = 1.5``: ``i * ncol + j`` is ``1.5 * 2 + 0 == 3.0``,
    a whole number that a check on the combined value alone would accept --
    the case a per-column check is needed to catch."""
    shape = GridShape(ncpl=20, nlay=2, nrow=5, ncol=2)
    par = _par_frame(
        {"pargp": ["g"], "idx0": [0], "idx1": [1.5], "idx2": [0]},
        parnme=["par:a"],
    )

    result = resolve(par, shape)

    assert _placements(result)["par:a"] == (-1, -1)


def test_a_whole_number_written_as_a_float_is_accepted():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g"], "idx0": [0], "idx1": [2.0]}, parnme=["par:a"]
    )

    result = resolve(par, shape)

    assert _placements(result)["par:a"] == (2, 0)
    group = _group(result, "g")
    assert group.mapped == 1
    assert not any("g" in n for n in result.notes)


def test_a_rule_whose_only_hits_are_fractional_yields_to_the_next_rule_with_a_whole_one():
    shape = GridShape(ncpl=20, nlay=3, nrow=4, ncol=5)
    par = _par_frame(
        {
            "pargp": ["fallthrough"],
            "k": [1.5],
            "i": [1.5],
            "j": [1.5],
            "idx0": [1],
            "idx1": [1],
            "idx2": [2],
        },
        parnme=["par:a"],
    )

    result = resolve(par, shape)

    group = _group(result, "fallthrough")
    assert group.rule == "idx-triple"
    assert _placements(result)["par:a"] == (1 * 5 + 2, 1)


# ---------------------------------------------------------------------------
# 03-06 Task 1: a parameter's shortfall note names the reason that actually
# applied -- an unreadable value, an overflowed cell number, or a genuine
# grid-range miss -- instead of always blaming the grid's range. And the
# fallback that lets a note be built at all must stay narrow: it must not
# fire for a group whose values are simply absent, and it must not fire for
# a group that is only out of range.
# ---------------------------------------------------------------------------


def test_a_group_whose_shortfall_is_an_unreadable_value_says_so_instead_of_blaming_the_grid_range():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g", "g"], "idx0": [0, 0], "idx1": [3, "garbage-not-a-number"]},
        parnme=["par:a", "par:b"],
    )

    result = resolve(par, shape)

    assert result.notes == (
        "group 'g': rule 'idx-pair' placed 1 of 2 parameters; "
        "1 carried a value that could not be read as a number",
    )


def test_a_single_parameter_whose_value_cannot_be_read_leaves_a_note_instead_of_silence():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g"], "idx0": [0], "idx1": ["garbage-not-a-number"]},
        parnme=["par:a"],
    )

    result = resolve(par, shape)

    assert result.notes == (
        "group 'g': rule 'idx-pair' placed 0 of 1 parameters; "
        "1 carried a value that could not be read as a number",
    )
    group = _group(result, "g")
    assert group.rule == "idx-pair"
    assert group.mapped == 0


def test_a_genuinely_out_of_range_shortfall_still_reads_as_a_grid_range_miss():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g", "g"], "idx0": [0, 0], "idx1": [3, 99]},
        parnme=["par:a", "par:b"],
    )

    result = resolve(par, shape)

    assert result.notes == (
        "group 'g': rule 'idx-pair' placed 1 of 2 parameters; "
        "1 fell outside the grid's layer/cell range",
    )


def test_a_placement_value_too_large_to_turn_into_a_cell_number_is_named_as_too_large():
    """Against the code before this task, this same frame yields
    ``rule == 'unmapped'`` and ``notes == ()`` -- every per-column check
    passes for ``1e308`` (it is readable, whole and present) and the value
    only becomes unusable once ``i * ncol + j`` overflows to ``inf``, after
    ``_numeric`` has already returned. This is the blocker this task
    exists to close."""
    shape = GridShape(ncpl=20, nlay=2, nrow=5, ncol=5)
    par = _par_frame(
        {"pargp": ["g"], "idx0": [0], "idx1": [1e308], "idx2": [0]},
        parnme=["par:a"],
    )

    result = resolve(par, shape)

    assert result.notes == (
        "group 'g': rule 'idx-triple' placed 0 of 1 parameters; "
        "1 carried a value too large to turn into a cell number",
    )
    assert _group(result, "g").rule == "idx-triple"


def test_a_group_that_is_only_out_of_range_still_reports_no_rule_and_no_note():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame({"pargp": ["g"], "idx0": [9], "idx1": [99]}, parnme=["par:a"])

    result = resolve(par, shape)

    assert _group(result, "g").rule == UNMAPPED
    assert result.notes == ()


def test_seven_hundred_and_seventy_seven_groups_with_no_placement_values_still_produce_no_notes():
    n = 777
    rows = {
        "pargp": [f"ug{i}" for i in range(n)],
        "idx0": [None] * n,
        "idx1": [None] * n,
    }
    parnme = [f"p{i}" for i in range(n)]
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(rows, parnme=parnme)

    result = resolve(par, shape)

    assert len(result.groups) == 777
    assert result.notes == ()


# ---------------------------------------------------------------------------
# 03-06 Task 2: every remaining reason is named truthfully, and the counts
# always add up to every parameter that was not placed.
# ---------------------------------------------------------------------------


def test_a_blank_placement_cell_is_named_as_carrying_no_value_not_as_unreadable():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {"pargp": ["g", "g"], "idx0": [0, 0], "idx1": [3, ""]},
        parnme=["par:a", "par:b"],
    )
    expected = (
        "group 'g': rule 'idx-pair' placed 1 of 2 parameters; 1 carried no value at all",
    )

    result = resolve(par, shape)
    assert result.notes == expected

    spaces = _par_frame(
        {"pargp": ["g", "g"], "idx0": [0, 0], "idx1": [3, "   "]},
        parnme=["par:a", "par:b"],
    )
    result_spaces = resolve(spaces, shape)
    assert result_spaces.notes == expected


def test_a_fractional_value_is_counted_under_its_own_reason_not_the_grid_range():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame({"pargp": ["g"], "idx0": [0], "idx1": [1.9]}, parnme=["par:a"])

    result = resolve(par, shape)

    assert len(result.notes) == 2
    assert result.notes[0].endswith("given no cell rather than rounded down")
    assert result.notes[1] == (
        "group 'g': rule 'idx-pair' placed 0 of 1 parameters; "
        "1 carried a value that is not a whole number"
    )


def test_several_reasons_in_one_group_are_each_named_with_their_own_count_in_one_note():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {
            "pargp": ["g", "g", "g", "g"],
            "idx0": [0, 0, 0, 0],
            "idx1": [3, 99, "garbage-not-a-number", None],
        },
        parnme=["par:a", "par:b", "par:c", "par:d"],
    )

    result = resolve(par, shape)

    assert result.notes == (
        "group 'g': rule 'idx-pair' placed 1 of 4 parameters; "
        "1 fell outside the grid's layer/cell range, "
        "1 carried a value that could not be read as a number and "
        "1 carried no value at all",
    )


def test_a_parameter_whose_name_carries_no_layer_number_is_named_as_such():
    shape = GridShape(ncpl=50, nlay=3, nrow=5, ncol=10)
    par = _par_frame(
        {"pargp": ["mixed", "mixed"], "i": [0, 1], "j": [0, 2]},
        parnme=["par:layer1:a", "par:b"],
    )

    result = resolve(par, shape)

    assert result.notes == (
        "group 'mixed': rule 'ij-name-layer' placed 1 of 2 parameters; "
        "1 carried no layer number in its name",
    )


def test_a_value_a_hair_under_two_is_not_a_whole_number_and_two_point_zero_still_places():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    whole = _par_frame({"pargp": ["g"], "idx0": [0], "idx1": [2.0]}, parnme=["par:a"])
    fractional = _par_frame(
        {"pargp": ["g"], "idx0": [0], "idx1": [1.9999999999999998]}, parnme=["par:a"]
    )

    whole_result = resolve(whole, shape)
    fractional_result = resolve(fractional, shape)

    assert _placements(whole_result)["par:a"] == (2, 0)
    assert _placements(fractional_result)["par:a"] == (-1, -1)
    assert fractional_result.notes[-1] == (
        "group 'g': rule 'idx-pair' placed 0 of 1 parameters; "
        "1 carried a value that is not a whole number"
    )


def test_the_reason_counts_in_a_note_add_up_to_every_parameter_that_was_not_placed():
    shape = GridShape(ncpl=10, nlay=2, nrow=None, ncol=None)
    par = _par_frame(
        {
            "pargp": ["g", "g", "g", "g"],
            "idx0": [0, 0, 0, 0],
            "idx1": [3, 99, "garbage-not-a-number", None],
        },
        parnme=["par:a", "par:b", "par:c", "par:d"],
    )

    result = resolve(par, shape)

    group = _group(result, "g")
    note = next(n for n in result.notes if n.startswith("group 'g': rule"))
    clause_text = note.split("; ", 1)[1]
    counts = [int(token) for token in re.findall(r"\d+", clause_text)]
    assert sum(counts) == group.total - group.mapped


def test_the_unplaced_reasons_table_lists_seven_reasons_in_a_fixed_order():
    assert tuple(key for key, _ in UNPLACED_REASONS) == (
        "out_of_range",
        "not_whole",
        "unreadable",
        "absent",
        "no_layer_in_name",
        "too_large",
        "unknown",
    )
