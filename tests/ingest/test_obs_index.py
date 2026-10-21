"""obs_index: a site, a time and a sort order for every observation.

The tracer test ingests a generated run end to end. The rest build the index
straight from an in-memory observation table so each rule is pinned alone.
"""

from __future__ import annotations

import re

import numpy as np
import pytest

import pesto.ingest.runner as runner
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsindex import (
    TIME_TOKEN_PATTERN,
    load_obs_index,
)
from pesto.ingest.runner import ingest_run, plan_artifacts

from .obs_fixtures import make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, **kwargs)
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root)


def _site_of(name: str) -> str:
    return re.sub(TIME_TOKEN_PATTERN, "", name, count=1)


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_a_generated_runs_sites_come_out_one_unbroken_run_of_rows_sorted_by_time(
    tmp_path, in_process
):
    run, layout = _ingest(tmp_path)

    manifest = Manifest.load(layout)
    assert manifest.artifacts["obs_index"].state == "ok"

    index = load_obs_index(layout)
    assert not isinstance(index, ReadFailure), index
    names = [run.obs_names[i] for i in index.order]

    # Every control row appears exactly once.
    assert sorted(index.order.tolist()) == list(range(len(run.obs_names)))

    seen_sites: list[str] = []
    for site in index.sites.itertuples():
        rows = names[site.start : site.start + site.count]
        keys = {_site_of(n) for n in rows}
        assert keys == {site.site}
        assert site.site not in seen_sites, "a site must be one unbroken run"
        seen_sites.append(site.site)
        times = index.time[site.start : site.start + site.count]
        assert list(times) == sorted(times)

    head = index.sites[index.sites["site"].str.endswith("trgw-0-1")].iloc[0]
    assert list(index.time[head["start"] : head["start"] + head["count"]]) == [1.0, 9.0, 10.0]
    assert head.time_kind == "numeric"


def test_the_order_file_holds_every_control_row_exactly_once(tmp_path, in_process):
    run, layout = _ingest(tmp_path)

    raw = np.fromfile(layout.obs_order, dtype="<i4")

    assert raw.dtype.itemsize * raw.size == layout.obs_order.stat().st_size
    assert sorted(raw.tolist()) == list(range(len(run.obs_names)))


def test_obs_index_is_planned_right_after_par_cell_with_the_control_sources(tmp_path):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    layout = CacheLayout(root=tmp_path / "cache")

    planned = plan_artifacts(discover(run_dir), layout)

    names = [a.name for a in planned]
    assert names[: names.index("obs_index") + 1][-2:] == ["par_cell", "obs_index"]
    by_name = {a.name: a for a in planned}
    assert by_name["obs_index"].sources == by_name["control"].sources
    assert by_name["obs_index"].kind == "obs_index"
    assert str(layout.obs_order) in by_name["obs_index"].outputs
    assert str(layout.obs_index_meta) in by_name["obs_index"].outputs
    assert run.pst_path.name in by_name["obs_index"].sources[0]


def test_obs_index_follows_control_when_the_run_has_no_grid(tmp_path):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    run.grid_path.unlink()

    names = [a.name for a in plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "c"))]

    assert names[:2] == ["control", "obs_index"]


def test_a_failed_control_makes_obs_index_fail_by_name(tmp_path, in_process, monkeypatch):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    monkeypatch.setattr(
        runner, "read_control", lambda p: ReadFailure("control", str(p), "the file is broken")
    )
    cache_root = tmp_path / "cache"

    manifest = ingest_run(run_dir, cache_root=cache_root)

    artifact = manifest.artifacts["obs_index"]
    assert artifact.state == "failed"
    assert artifact.reason.startswith("obs_index depends on control, which failed: ")


def test_the_worker_reads_named_observation_columns_never_the_whole_table(
    tmp_path, in_process, monkeypatch
):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    full_reads: list[object] = []
    column_reads: list[tuple] = []
    real_tables = runner.load_control_tables
    real_table = runner.load_control_table

    def _tables(layout, obs="full"):
        full_reads.append(obs)
        return real_tables(layout, obs=obs)

    def _table(layout, kind, columns=None, optional_columns=None):
        column_reads.append((kind, tuple(columns or ())))
        return real_table(layout, kind, columns=columns, optional_columns=optional_columns)

    monkeypatch.setattr(runner, "load_control_tables", _tables)
    monkeypatch.setattr(runner, "load_control_table", _table)

    ingest_run(run_dir, cache_root=tmp_path / "cache")

    assert "full" not in full_reads
    assert ("obs", ("obsnme", "obgnme")) in column_reads
