"""par_hist: every parameter group's first and last iteration binned on one set
of edges, over the realizations present in both, in pestpp's numeric space.

Each test ingests a generated run whose values are known to the test, then
compares what the cache holds with numpy on those values.
"""

from __future__ import annotations

import numpy as np
import pytest

from pesto.cache.layout import CacheLayout
from pesto.ingest.failures import ReadFailure
from pesto.ingest.parhist import N_BINS, load_par_hist, shared_edge_histogram
from pesto.ingest.runner import ingest_run

from .par_fixtures import make_par_view_run, numeric_space
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
