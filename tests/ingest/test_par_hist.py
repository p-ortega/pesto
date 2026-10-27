"""par_hist: every parameter group's first and last iteration binned on one set
of edges, over the realizations present in both, in pestpp's numeric space.

Each test ingests a generated run whose values are known to the test, then
compares what the cache holds with numpy on those values.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pesto.cache.layout import CacheLayout
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parhist import N_BINS, load_par_hist, shared_edge_histogram, write_par_hist
from pesto.ingest.parview import write_par_change
from pesto.ingest.runner import ingest_run

from .par_fixtures import (
    DEFAULT_GROUPS,
    ParGroupSpec,
    make_par_view_run,
    numeric_space,
    parameter_names,
)
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run = make_par_view_run(tmp_path / "run", **kwargs)
    cache = tmp_path / "cache"
    manifest = ingest_run(run.root, cache_root=cache)
    return run, CacheLayout(root=cache), manifest


def _hist(layout):
    loaded = load_par_hist(layout)
    assert not isinstance(loaded, ReadFailure), loaded
    return loaded


def _common(run):
    return [n for n in run.real_names[0] if n in run.real_names[1]]


def _group_values(run, group, iteration, names):
    """The included parameters' values of one group, pooled, in numeric space."""
    return np.concatenate(
        [numeric_space(run, iteration, p, names) for p in run.groups[group] if run.trans[p] in ("log", "none")]
    )


def _series(frame, group, iteration):
    rows = frame[(frame["group"] == group) & (frame["iteration"] == iteration)]
    return rows.sort_values("bin")


# ---------------------------------------------------------------------------
# The tracer: an ingested run's group histograms on shared edges
# ---------------------------------------------------------------------------


def test_par_hist_is_ok_after_an_ingest(tmp_path, in_process):  # noqa: F811
    _run, _layout, manifest = _ingest(tmp_path)

    assert manifest.artifacts["par_hist"].state == "ok", manifest.artifacts["par_hist"].reason


def test_a_log_group_has_51_edges_in_log10_space_spanning_both_iterations(tmp_path, in_process):  # noqa: F811
    run, layout, _ = _ingest(tmp_path)
    frame, meta = _hist(layout)
    common = _common(run)
    entry = {g["group"]: g for g in meta["groups"]}["hk_pp"]

    first = _group_values(run, "hk_pp", 0, common)
    last = _group_values(run, "hk_pp", 1, common)
    pooled = np.concatenate([first, last])

    assert entry["space"] == "log10"
    assert len(entry["edges"]) == N_BINS + 1
    assert entry["edges"][0] == pytest.approx(pooled.min(), rel=1e-9)
    assert entry["edges"][-1] == pytest.approx(pooled.max(), rel=1e-9)
    assert entry["edges"] == sorted(entry["edges"])


def test_counts_for_both_iterations_equal_numpy_histogram_on_the_same_edges(tmp_path, in_process):  # noqa: F811
    run, layout, _ = _ingest(tmp_path)
    frame, meta = _hist(layout)
    common = _common(run)
    entry = {g["group"]: g for g in meta["groups"]}["hk_pp"]
    edges = np.asarray(entry["edges"])

    for iteration in (0, 1):
        expected, _ = np.histogram(_group_values(run, "hk_pp", iteration, common), bins=edges)
        stored = _series(frame, "hk_pp", iteration)
        assert stored["count"].tolist() == expected.tolist()
        assert stored["bin"].tolist() == list(range(N_BINS))


def test_each_series_density_integrates_to_one(tmp_path, in_process):  # noqa: F811
    run, layout, _ = _ingest(tmp_path)
    frame, meta = _hist(layout)
    widths = {g["group"]: np.diff(g["edges"]) for g in meta["groups"] if g["edges"]}

    for group in ("hk_pp", "rch_gr"):
        for iteration in (0, 1):
            density = _series(frame, group, iteration)["density"].to_numpy()
            assert float((density * widths[group]).sum()) == pytest.approx(1.0, abs=1e-9)


def test_the_first_series_is_the_first_ingested_iteration(tmp_path, in_process):  # noqa: F811
    _run, layout, _ = _ingest(tmp_path)
    _frame, meta = _hist(layout)
    entry = {g["group"]: g for g in meta["groups"]}["hk_pp"]

    assert entry["first"]["iteration"] == 0
    assert entry["last"]["iteration"] == 1
    assert meta["first_iteration"] == 0
    assert meta["last_iteration"] == 1


# ---------------------------------------------------------------------------
# Edges, refusals and exclusions
# ---------------------------------------------------------------------------

IDENTICAL = "every value in this group is the same, so there is no spread to draw"


def _entry(meta, group):
    return {g["group"]: g for g in meta["groups"]}[group]


def _merge_groups(run, layout, mapping):
    """Rename groups in the cached control table, then build both tables again."""
    path = layout.control / "par.parquet"
    frame = pd.read_parquet(path)
    frame["pargp"] = frame["pargp"].astype(str).map(lambda g: mapping.get(g, g))
    frame.to_parquet(path, index=False)
    first, last = min(run.par_ens), max(run.par_ens)
    assert not isinstance(write_par_change(first, last, layout), ReadFailure)
    written = write_par_hist(first, last, layout)
    assert not isinstance(written, ReadFailure), written


def test_a_value_on_an_inner_edge_lands_in_the_bin_to_its_right():
    first = np.array([0.0, 5.0, 10.0])
    last = np.array([10.0])

    result = shared_edge_histogram(first, last, n_bins=10)

    assert result.edges.tolist() == [float(i) for i in range(11)]
    assert result.first.counts[5] == 1
    assert result.first.counts[4] == 0
    assert result.first.counts[0] == 1


def test_the_pooled_maximum_lands_in_the_last_bin_and_totals_equal_n():
    first = np.array([0.0, 5.0, 10.0])
    last = np.array([10.0, 10.0])

    result = shared_edge_histogram(first, last, n_bins=10)

    assert result.first.counts[9] == 1
    assert result.last.counts[9] == 2
    assert result.first.counts.sum() == result.first.n == 3
    assert result.last.counts.sum() == result.last.n == 2


def test_identical_values_are_refused_with_the_stated_sentence():
    result = shared_edge_histogram(np.full(4, 2.5), np.full(3, 2.5))

    assert result.refused == IDENTICAL
    assert result.edges is None
    assert result.first is None


def test_a_group_whose_values_are_all_equal_is_refused_and_writes_no_rows(tmp_path, in_process):  # noqa: F811
    same = {}
    for p in parameter_names(DEFAULT_GROUPS[1]):
        same[(0, p)] = np.full(6, 7.0)
        same[(1, p)] = np.full(5, 7.0)
    _run, layout, _ = _ingest(tmp_path, overrides=same)
    frame, meta = _hist(layout)

    entry = _entry(meta, "rch_gr")
    assert entry["refused"] == IDENTICAL
    assert entry["edges"] is None
    assert entry["first"] is None and entry["last"] is None
    assert frame[frame["group"] == "rch_gr"].empty
    assert _entry(meta, "hk_pp")["refused"] is None


def test_a_group_of_only_fixed_parameters_is_refused_with_its_fixed_count(tmp_path, in_process):  # noqa: F811
    _run, layout, _ = _ingest(tmp_path)
    frame, meta = _hist(layout)

    entry = _entry(meta, "fixed_gr")
    assert entry["refused"] is not None
    assert "2 fixed" in entry["refused"]
    assert entry["excluded"]["fixed"] == 2
    assert frame[frame["group"] == "fixed_gr"].empty


def test_a_non_positive_log_parameter_is_left_out_and_the_group_still_draws(tmp_path, in_process):  # noqa: F811
    run, layout, _ = _ingest(tmp_path, nonpositive_log=True)
    frame, meta = _hist(layout)
    common = _common(run)

    entry = _entry(meta, "hk_pp")
    bad = run.groups["hk_pp"][0]
    assert entry["refused"] is None
    assert entry["excluded"]["nonpositive_log"] == 1
    assert entry["n_included"] == 3
    assert entry["first"]["n"] == 3 * len(common)
    assert any("1 " in note and "not positive" in note and bad in note for note in entry["notes"])
    kept = np.concatenate(
        [numeric_space(run, 0, p, common) for p in run.groups["hk_pp"][1:]]
    )
    expected, _ = np.histogram(kept, bins=np.asarray(entry["edges"]))
    assert _series(frame, "hk_pp", 0)["count"].tolist() == expected.tolist()


def test_a_group_mixing_log_and_untransformed_parameters_is_refused_with_both_counts(
    tmp_path, in_process  # noqa: F811
):
    run, layout, _ = _ingest(tmp_path)
    _merge_groups(run, layout, {"hk_pp": "merged", "rch_gr": "merged"})
    frame, meta = _hist(layout)

    entry = _entry(meta, "merged")
    assert entry["refused"] is not None
    assert "4 log-transformed and 3 untransformed parameters cannot share one axis" in entry["refused"]
    assert entry["edges"] is None
    assert frame[frame["group"] == "merged"].empty


def test_one_ingested_iteration_gives_one_series_and_says_so(tmp_path, in_process):  # noqa: F811
    run, layout, manifest = _ingest(tmp_path, iterations=(0,), drop_in_last=None)
    assert manifest.artifacts["par_hist"].state == "ok", manifest.artifacts["par_hist"].reason
    frame, meta = _hist(layout)

    entry = _entry(meta, "hk_pp")
    assert entry["first"]["iteration"] == 0
    assert entry["last"] is None
    assert meta["single_iteration"] is True
    assert any("only iteration 0 was ingested" in note for note in meta["notes"])
    expected, _ = np.histogram(
        _group_values(run, "hk_pp", 0, run.real_names[0]), bins=np.asarray(entry["edges"])
    )
    assert _series(frame, "hk_pp", 0)["count"].tolist() == expected.tolist()
    assert frame[frame["iteration"] != 0].empty


def test_the_result_does_not_depend_on_the_chunk_size(tmp_path, in_process, monkeypatch):  # noqa: F811
    from pesto.ingest import parhist

    run, layout, _ = _ingest(tmp_path)
    big_frame, big_meta = _hist(layout)

    monkeypatch.setattr(parhist, "_CHUNK_BYTES", 8 * 6)
    written = write_par_hist(0, 1, layout)
    assert not isinstance(written, ReadFailure), written
    small_frame, small_meta = _hist(layout)

    pd.testing.assert_frame_equal(big_frame, small_frame)
    assert big_meta["groups"] == small_meta["groups"]


def test_a_2000_parameter_300_realization_group_stays_within_the_memory_bound(tmp_path, in_process):  # noqa: F811
    import tracemalloc

    spec = (ParGroupSpec("big", 2000, "log", tag="gr", column="gr"),)
    run, layout, manifest = _ingest(tmp_path, groups=spec, n_real=300, drop_in_last=None)
    assert manifest.artifacts["par_change"].state == "ok", manifest.artifacts["par_change"].reason

    tracemalloc.start()
    try:
        written = write_par_hist(0, 1, layout)
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert not isinstance(written, ReadFailure), written
    assert peak < 128 * 1024 * 1024
    _frame, meta = _hist(layout)
    assert _entry(meta, "big")["first"]["n"] == 2000 * 300


def test_shared_edge_histogram_gives_numpy_counts_and_unit_density():
    rng = np.random.default_rng(3)
    first = rng.normal(size=200)
    last = rng.normal(loc=0.5, size=150)

    result = shared_edge_histogram(first, last)

    assert result.refused is None
    pooled = np.concatenate([first, last])
    edges = np.histogram_bin_edges(pooled, bins=N_BINS)
    np.testing.assert_allclose(result.edges, edges)
    assert result.first.counts.tolist() == np.histogram(first, bins=edges)[0].tolist()
    assert result.last.counts.tolist() == np.histogram(last, bins=edges)[0].tolist()
    assert (result.first.density * np.diff(result.edges)).sum() == pytest.approx(1.0)
