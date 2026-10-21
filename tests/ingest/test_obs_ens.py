"""obs_ens/K: each selected iteration's observation ensemble, stored by name.

The tracer ingests a generated run with hash-ordered observation columns and
checks every stored number against what the generator wrote for that
observation name. The later tests pin each way a read can fail.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

import pesto.ingest.runner as runner
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsens import load_obs_ensemble
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.runner import ingest_run, plan_artifacts

from .obs_fixtures import make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)

REAL_NAMES = ["34", "base", "35", "176"]


def _ingest(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, **kwargs)
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root)


def _snapshot(root):
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
    }


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_every_stored_observation_row_equals_the_values_written_for_that_name(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, hash_ordered=True, real_names=REAL_NAMES)
    before = _snapshot(run_dir)
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)

    manifest = Manifest.load(layout)
    assert manifest.artifacts["obs_ens/0"].state == "ok"
    assert manifest.artifacts["obs_ens/1"].state == "ok"

    index = load_obs_index(layout)
    assert not isinstance(index, ReadFailure), index
    for iteration in (0, 1):
        stored = load_obs_ensemble(iteration, layout)
        assert not isinstance(stored, ReadFailure), stored
        assert stored.values.dtype == np.float32
        assert stored.values.shape == (len(run.obs_names), 4)
        by_name = {
            run.obs_names[int(control_row)]: stored.values[position]
            for position, control_row in enumerate(index.order)
        }
        assert sorted(by_name) == sorted(run.obs_names)
        for control_row, obs_name in enumerate(run.obs_names):
            expected = run.values[iteration][:, control_row].astype(np.float32)
            np.testing.assert_array_equal(by_name[obs_name], expected)
    assert _snapshot(run_dir) == before


def test_one_site_is_one_unbroken_slice_of_the_stored_rows(tmp_path, in_process):
    run, layout = _ingest(tmp_path, hash_ordered=True, real_names=REAL_NAMES)
    index = load_obs_index(layout)
    stored = load_obs_ensemble(0, layout)

    for site in index.sites.itertuples():
        rows = stored.values[site.start : site.start + site.count]
        control_rows = index.order[site.start : site.start + site.count]
        expected = run.values[0][:, control_rows].T.astype(np.float32)
        np.testing.assert_array_equal(rows, expected)


def test_the_realization_index_keeps_the_names_as_read_in_file_order(tmp_path, in_process):
    _run, layout = _ingest(tmp_path, hash_ordered=True, real_names=REAL_NAMES)

    reals = json.loads(layout.obs_reals(0).read_text())

    assert reals["names"] == REAL_NAMES
    stored = load_obs_ensemble(0, layout)
    assert list(stored.real_names) == REAL_NAMES


def test_the_state_route_reports_obs_available_once_obs_index_and_obs_ens_are_ok(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)

    app, token = create_app()
    app.state.initial_run_dir = str(run_dir)
    app.state.cache_root = str(cache_root)
    client = TestClient(app, base_url="http://127.0.0.1")
    response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})

    body = response.json()
    assert body["capabilities"]["obs"] == {"available": True, "blocked_by": []}
    names = [a["name"] for a in body["artifacts"]]
    assert "obs_ens/0" in names and "obs_ens/1" in names


def test_obs_ens_is_planned_after_the_parameter_artifacts_and_needs_obs_index(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    planned = plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "cache"))

    names = [a.name for a in planned]
    assert names.index("obs_ens/0") > names.index("par_agg/1")
    by_name = {a.name: a for a in planned}
    assert by_name["obs_ens/0"].needs == ("obs_index",)
    assert by_name["obs_ens/0"].sources[0].endswith("case.0.obs.jcb")
    assert by_name["control"].needs == ()
