"""The one sentinel rule, and the 1:1 helpers that apply it to simulated values."""

from __future__ import annotations

import numpy as np

from pesto.ingest.obs1to1 import bin_pairs, one_to_one_range, rank_outlying, rms_of_mean_residual
from pesto.ingest.obsindex import SENTINEL_LIMIT, blank_sentinels, sentinel_mask, usable_mask


def test_a_sentinel_is_1e20_or_more_in_either_sign_and_nan_is_not_one():
    values = np.array([1e30, -1e30, SENTINEL_LIMIT, 9.99e19, np.nan, np.inf, 0.0])

    assert sentinel_mask(values).tolist() == [True, True, True, False, False, True, False]
    assert usable_mask(values).tolist() == [False, False, False, True, False, False, True]


def test_blank_sentinels_copies_sets_nan_and_counts_leaving_infinity_to_the_nonfinite_counts():
    original = np.array([1.0, 1e30, np.inf, np.nan], dtype=np.float32)

    blanked, n = blank_sentinels(original)

    assert n == 1
    assert np.isnan(blanked[1]) and np.isinf(blanked[2]) and blanked.dtype == np.float32
    assert original[1] == np.float32(1e30)


def test_blank_sentinels_returns_the_input_itself_when_there_is_none():
    values = np.array([1.0, 2.0], dtype=np.float32)

    blanked, n = blank_sentinels(values)

    assert n == 0 and blanked is values


def test_the_range_ignores_a_sentinel_quantile():
    obs = np.array([1.0, 2.0, 3.0])
    low = np.array([1.0, 2.0, 1e30])
    high = np.array([2.0, 3.0, 1e30])

    lo, hi = one_to_one_range(obs, low, high)

    assert abs(lo) < 10 and abs(hi) < 10


def test_a_range_made_only_of_sentinels_is_refused_with_a_reason():
    reason = one_to_one_range(np.array([1e30]), np.array([1e30]), np.array([1e30]))

    assert isinstance(reason, str) and "no value" in reason


def test_a_sentinel_simulated_value_is_not_a_point_and_is_not_counted_outside():
    obs = np.array([1.0, 2.0])
    block = np.array([[1.0, 1e30], [1e30, 1e30]])

    counts, n_points, n_outside, n_no_valid, n_nonfinite = bin_pairs(obs, block, 0.0, 3.0, n_bins=3)

    assert n_points == 1 and n_outside == 0
    assert int(counts.sum()) == 1
    assert n_no_valid == 1 and n_nonfinite == 1


def test_the_rms_of_the_mean_residual_skips_a_sentinel_residual():
    rms, used = rms_of_mean_residual(np.array([3.0, 4.0, 1e30]))

    assert used == 2 and abs(rms - np.sqrt(12.5)) < 1e-12


def test_the_outlying_ranking_skips_a_sentinel_residual_and_a_site_with_only_that():
    ids = np.array([10, 20, 30])
    starts = np.array([0, 2, 4])
    counts = np.array([2, 2, 1])
    resid = np.array([1.0, 1e30, 5.0, 1.0, 1e30])

    assert rank_outlying(ids, starts, counts, resid) == [20, 10]
