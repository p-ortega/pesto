"""A whole benchmark run ingested end to end, every observation artifact accounted for.

Every test here is slow and runs against whichever benchmark runs are present;
each skips when its folder is absent. The cache goes under ``tmp_path`` and a
snapshot of the run folder is compared before and after, because a run folder
is a scientist's finished output and must never be written.

Nothing below asserts how many sites, groups or realizations a folder holds.
The checks are relationships that hold for any run: an artifact is ok or says
why not under its own name, and a capability is available exactly when the
artifacts behind it are ok.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.runner import ingest_run, plan_artifacts

pytestmark = pytest.mark.slow

OBS_KINDS = ("obs_index", "obs_cell", "obs_ens", "obs_agg", "noise_agg", "pdc", "phi_check")
RUN_FIXTURES = ("hm_run", "pl253_run", "forecast_run", "restarted_run")


_INGESTED: dict[str, tuple[Path, Path, Manifest, dict]] = {}


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _state(run_dir: Path, cache_root: Path) -> dict:
    app, token = create_app()
    app.state.initial_run_dir = str(run_dir)
    app.state.cache_root = str(cache_root)
    client = TestClient(app, base_url="http://127.0.0.1")
    response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 200, response.text
    return response.json()


def _is_ok(manifest: Manifest, name: str) -> bool:
    artifact = manifest.artifacts.get(name)
    return artifact is not None and artifact.state == "ok"


@pytest.fixture
def ingested(request: pytest.FixtureRequest, tmp_path_factory: pytest.TempPathFactory, run_fixture: str):
    """The run, its manifest, the run folder's snapshot from before, and the cache root.
    Ingested once per run for the whole module; later tests reuse it."""
    if run_fixture not in _INGESTED:
        run_dir = request.getfixturevalue(run_fixture)
        cache_root = tmp_path_factory.mktemp(f"obs-real-{run_fixture}") / "cache"
        before = _snapshot(run_dir)
        manifest = ingest_run(run_dir, cache_root=cache_root)
        _INGESTED[run_fixture] = (run_dir, cache_root, manifest, before)
    return _INGESTED[run_fixture]


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_a_whole_run_ingests_and_every_observation_artifact_accounts_for_itself(
    ingested, run_fixture: str
):
    run_dir, cache_root, manifest, before = ingested

    assert _snapshot(run_dir) == before, "ingesting changed the run folder"

    layout = CacheLayout(root=cache_root)
    run = discover(run_dir)
    planned = plan_artifacts(run, layout)
    observation = [pa for pa in planned if pa.kind in OBS_KINDS]
    assert any(pa.kind == "obs_index" for pa in observation), "no obs_index was planned"

    for pa in observation:
        artifact = manifest.artifacts.get(pa.name)
        assert artifact is not None, f"{pa.name} was planned but the manifest holds no record of it"
        if artifact.state != "ok":
            assert artifact.reason, f"{pa.name} is {artifact.state} with no reason"
            assert artifact.reason.startswith(pa.name), (
                f"{pa.name} failed with a reason that does not start with its own name: "
                f"{artifact.reason!r}"
            )


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_capabilities_are_available_exactly_when_their_artifacts_are_ok(
    ingested, run_fixture: str
):
    run_dir, cache_root, manifest, _before = ingested
    layout = CacheLayout(root=cache_root)
    run = discover(run_dir)
    planned = plan_artifacts(run, layout)
    names = {kind: [pa.name for pa in planned if pa.kind == kind] for kind in OBS_KINDS}

    capabilities = _state(run_dir, cache_root)["capabilities"]

    index_ok = all(_is_ok(manifest, n) for n in names["obs_index"])
    expected = {
        "obs": index_ok and any(_is_ok(manifest, n) for n in names["obs_ens"]),
        "obs_stats": any(_is_ok(manifest, n) for n in names["obs_agg"]),
        "noise": bool(names["noise_agg"]) and all(_is_ok(manifest, n) for n in names["noise_agg"]),
        "pdc": bool(names["pdc"]) and all(_is_ok(manifest, n) for n in names["pdc"]),
        "phi_check": bool(names["phi_check"]) and all(_is_ok(manifest, n) for n in names["phi_check"]),
    }
    for capability, should_be_available in expected.items():
        got = capabilities[capability]
        assert got["available"] is should_be_available, (
            f"{capability}: available={got['available']} but the artifacts say {should_be_available}; "
            f"blocked_by={got['blocked_by']}"
        )
        if not got["available"]:
            assert got["blocked_by"], f"{capability} is unavailable and gives no reason"
            for fact in got["blocked_by"]:
                assert fact["reason"], f"{capability} is blocked by {fact['artifact']} with no reason"


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_a_run_with_no_observation_ensemble_file_says_so_and_a_pdc_file_is_still_read(
    ingested, run_fixture: str
):
    run_dir, cache_root, manifest, _before = ingested
    layout = CacheLayout(root=cache_root)
    run = discover(run_dir)

    if not run.obs_ens:
        capabilities = _state(run_dir, cache_root)["capabilities"]
        assert capabilities["obs"]["available"] is False
        reasons = " ".join(fact["reason"] or "" for fact in capabilities["obs"]["blocked_by"])
        assert "no observation ensemble file" in reasons

    for key, path in run.pdc.items():
        name = f"pdc/{key}"
        artifact = manifest.artifacts.get(name)
        if artifact is None or artifact.state != "ok":
            continue
        assert path.is_file()
        sidecar = json.loads(layout.pdc_meta(key).read_text())
        assert sidecar["source"] == "file", f"{name} has a pestpp pdc file but says {sidecar['source']!r}"
