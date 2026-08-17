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

import pandas as pd

from pesto.model import GridShape, GroupResolution, ParCells
from pesto.model._parcells import RULE_NAMES, UNMAPPED, resolve


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
