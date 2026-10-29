"""The status of every quad in a section, the counts behind it and the notes
the user reads, on small arrays built here."""

from __future__ import annotations

import numpy as np
import pytest

from pesto.section.assemble import (
    ACTIVE,
    BOTTOM_ABOVE_TOP,
    INACTIVE,
    NON_FINITE,
    PASS_THROUGH,
    PINCHED,
    answer_notes,
    assemble,
)

NLAY = 1


def _one_layer(idomain_values, tops, bots):
    """One layer, one cell per value, each crossed by one piece in cell order."""
    ncpl = len(tops)
    elev = np.array([tops, bots], dtype=np.float64)
    idomain = None if idomain_values is None else np.array([idomain_values], dtype=np.int32)
    return assemble(np.arange(ncpl), elev, idomain, NLAY, ncpl)


def test_idomain_decides_inactive_pass_through_and_active_whatever_its_positive_value():
    built = _one_layer([0, -1, -3, 1, 84, 100], [10.0] * 6, [5.0] * 6)

    assert built.status[:, 0].tolist() == [
        INACTIVE,
        PASS_THROUGH,
        PASS_THROUGH,
        ACTIVE,
        ACTIVE,
        ACTIVE,
    ]
    assert built.counts["idomain_below_minus_1"] == 1


def test_elevation_defects_have_their_own_codes_and_a_bottom_above_its_top_is_kept_as_given():
    built = _one_layer([1, 1, 1], [10.0, 10.0, 10.0], [10.0, 12.0, np.nan])

    assert built.status[:, 0].tolist() == [PINCHED, BOTTOM_ABOVE_TOP, NON_FINITE]
    assert built.z[1].tolist() == [10.0, 12.0]
    assert built.counts["pinched"] == 1
    assert built.counts["bottom_above_top"] == 1
    assert built.counts["non_finite"] == 1


def test_an_idomain_status_wins_over_an_elevation_defect_which_is_still_counted():
    built = _one_layer([0, -1, 0], [10.0, 10.0, 10.0], [10.0, 12.0, np.nan])

    assert built.status[:, 0].tolist() == [INACTIVE, PASS_THROUGH, INACTIVE]
    assert built.counts["pinched"] == 1
    assert built.counts["bottom_above_top"] == 1
    assert built.counts["non_finite"] == 1


def test_a_non_finite_elevation_is_not_also_counted_as_pinched_or_inverted():
    built = _one_layer(None, [np.inf, 10.0, np.nan], [np.inf, np.inf, 12.0])

    assert built.status[:, 0].tolist() == [NON_FINITE] * 3
    assert built.counts["non_finite"] == 3
    assert built.counts["pinched"] == 0
    assert built.counts["bottom_above_top"] == 0


def test_with_no_idomain_the_elevations_alone_decide():
    built = _one_layer(None, [10.0, 10.0, 10.0, 10.0], [5.0, 10.0, 11.0, np.nan])

    assert built.status[:, 0].tolist() == [ACTIVE, PINCHED, BOTTOM_ABOVE_TOP, NON_FINITE]
    assert built.counts["idomain_below_minus_1"] == 0


def test_statuses_are_laid_out_per_piece_then_layer_for_two_layers():
    # Two cells, two layers; cell 1 is crossed twice, by pieces 1 and 2.
    elev = np.array([[10.0, 10.0], [5.0, 5.0], [5.0, 0.0]])
    idomain = np.array([[1, 1], [1, 0]], dtype=np.int32)

    built = assemble(np.array([0, 1, 1]), elev, idomain, 2, 2)

    assert built.status.tolist() == [[ACTIVE, PINCHED], [ACTIVE, INACTIVE], [ACTIVE, INACTIVE]]
    assert built.z.shape == (3, 3)


@pytest.mark.parametrize(
    ("key", "count", "sentence"),
    [
        (
            "zero_length_dropped",
            2,
            "2 pieces of zero length were dropped where the line only touches a cell at a corner",
        ),
        (
            "zero_length_dropped",
            1,
            "1 piece of zero length was dropped where the line only touches a cell at a corner",
        ),
        (
            "ties_resolved",
            1,
            "1 stretch lies on an edge shared by two cells; it went to the lower cell index",
        ),
        (
            "ties_resolved",
            3,
            "3 stretches lie on an edge shared by two cells; they went to the lower cell index",
        ),
        (
            "bottom_above_top",
            3,
            "3 section cells have their bottom above their top; drawn as absence",
        ),
        (
            "bottom_above_top",
            1,
            "1 section cell has its bottom above its top; drawn as absence",
        ),
        (
            "pinched",
            4,
            "4 section cells are pinched out (zero thickness); drawn as absence",
        ),
        (
            "pinched",
            1,
            "1 section cell is pinched out (zero thickness); drawn as absence",
        ),
        (
            "idomain_below_minus_1",
            1,
            "1 section cell has an idomain below -1; read as vertical pass-through (idomain -1)",
        ),
        (
            "idomain_below_minus_1",
            2,
            "2 section cells have an idomain below -1; read as vertical pass-through (idomain -1)",
        ),
        (
            "non_finite",
            1,
            "1 section cell has no finite elevation; drawn as absence",
        ),
        (
            "non_finite",
            5,
            "5 section cells have no finite elevation; drawn as absence",
        ),
    ],
)
def test_every_count_above_zero_is_a_sentence(key, count, sentence):
    assert answer_notes({key: count}) == [sentence]


def test_all_counts_zero_give_no_note():
    counts = {
        "candidates": 12,
        "zero_length_dropped": 0,
        "ties_resolved": 0,
        "bottom_above_top": 0,
        "pinched": 0,
        "idomain_below_minus_1": 0,
        "non_finite": 0,
    }

    assert answer_notes(counts) == []


def test_notes_follow_one_fixed_order_and_candidates_is_never_a_note():
    counts = {
        "non_finite": 1,
        "candidates": 9,
        "pinched": 1,
        "zero_length_dropped": 1,
    }

    notes = answer_notes(counts)

    assert len(notes) == 3
    assert notes[0].startswith("1 piece of zero length")
    assert notes[1].startswith("1 section cell is pinched")
    assert notes[2].startswith("1 section cell has no finite elevation")
