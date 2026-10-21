"""phi_check/K: phi recomputed from the cache against pestpp's phi file, by name.

The tracer ingests a generated run whose phi file was computed from the same
values and weights the cache holds, and checks every realization agrees by
name. The later tests pin each mismatch, gap and fallback.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.phicheck import PHI_TOLERANCE, load_phi_check
from pesto.ingest.runner import ingest_run

from .obs_fixtures import make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, **kwargs)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root), manifest


def _tree_snapshot(root):
    return {
        str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(root.rglob("*"))
    }


def _capabilities(run, layout):
    from fastapi.testclient import TestClient

    from pesto.api.app import create_app

    app, token = create_app()
    app.state.initial_run_dir = str(run.root)
    app.state.cache_root = str(layout.root)
    client = TestClient(app, base_url="http://127.0.0.1")
    response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 200, response.text
    return response.json()["capabilities"]


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_phi_recomputed_from_the_cache_matches_pestpps_file_by_realization_name(
    tmp_path, in_process
):
    run, layout, _ = _ingest(tmp_path, with_phi=True)

    manifest = Manifest.load(layout)
    assert manifest.artifacts["phi_check/0"].state == "ok"
    check = load_phi_check(0, layout)
    assert not isinstance(check, ReadFailure), check

    assert check.status == "checked"
    assert check.n_compared == len(run.real_names)
    assert check.n_mismatch == 0
    assert check.n_only_in_cache == 0 and check.n_only_in_file == 0
    assert check.max_rel_diff is not None and check.max_rel_diff < 1e-5
    assert check.tolerance == PHI_TOLERANCE
    assert check.weights_source == "case.adjusted.weights.jcb"
    # The file's columns run in the reverse of the run's realization order.
    assert run.phi_path.read_text().splitlines()[0].split(",")[6:] == list(reversed(run.real_names))
    for row in check.rows:
        assert row.match
        assert row.file == run.phi_values[0][row.realization]
        assert row.recomputed == pytest.approx(run.phi_values[0][row.realization], rel=1e-5)


def test_the_state_route_reports_phi_check_available(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_phi=True)

    capability = _capabilities(run, layout)["phi_check"]
    assert capability == {"available": True, "blocked_by": []}


def test_phi_is_never_joined_by_position(tmp_path, in_process):
    # The file's columns are reversed; reading them by position would pair the wrong ones.
    run, layout, _ = _ingest(tmp_path, with_phi=True)

    check = load_phi_check(1, layout)
    assert not isinstance(check, ReadFailure), check
    by_name = {row.realization: row for row in check.rows}
    assert set(by_name) == set(run.real_names)
    assert len({round(v, 3) for v in run.phi_values[1].values()}) == len(run.real_names)
    for name, row in by_name.items():
        assert row.file == run.phi_values[1][name]
        assert row.match


def test_the_run_folder_is_untouched_by_the_phi_check(tmp_path, in_process):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_phi=True)
    before = _tree_snapshot(run_dir)
    ingest_run(run_dir, cache_root=tmp_path / "cache")
    assert _tree_snapshot(run_dir) == before


def test_the_stored_file_is_valid_json_with_every_realization_in_it(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_phi=True)

    stored = json.loads(layout.phi_check(0).read_text())
    assert stored["status"] == "checked"
    assert {r["realization"] for r in stored["rows"]} == set(run.real_names)
    assert all(set(r) == {"realization", "recomputed", "file", "rel_diff", "match"} for r in stored["rows"])
    assert np.isfinite(stored["max_rel_diff"])
