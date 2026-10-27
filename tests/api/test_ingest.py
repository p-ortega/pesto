"""Route tests for Plan 05-07: the freshness check, the estimate, the
start, the SSE stream and the cancel -- all driven with a synchronous
``TestClient`` and no ``pytest-asyncio``.

Every streaming test uses ``with _client(app) as client:`` deliberately --
outside a ``with`` block, ``starlette.testclient.TestClient`` opens a fresh
event loop per call, and the background task the start route schedules
would be torn down with it before it ever finished. Inside a ``with``
block, one event loop lives across every call in the block, exactly like a
real server's does.

``starlette.testclient.TestClient`` also drains a streamed response fully
before returning anything from it -- there is no genuine partial read or
socket-level disconnect available in this harness. The disconnect test
below exercises the route's own reaction to ``Request.is_disconnected()``
by monkeypatching that one method, rather than pretending a severed
connection can be produced here.
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

import pesto.ingest.runner as runner_module
from pesto.api.app import create_app
from pesto.api.ingest import _display_folder
from pesto.cache.layout import CACHE_VERSION, CacheLayout, run_id_for
from pesto.cache.manifest import CacheFile, Manifest, SourceFingerprint
from ingest.obs_fixtures import make_obs_run
from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.runner import Progress, plan_artifacts

BASE_URL = "http://127.0.0.1"


def _client(app) -> TestClient:
    return TestClient(app, base_url=BASE_URL)


def _make_run(tmp_path: Path, *, with_grid: bool = True, iterations: tuple[int, ...] = (0, 3)) -> Path:
    """A run directory just complete enough for ``discover()`` to find it:
    a control file with a ``noptmax`` line, an ensemble file per requested
    iteration, and an arbitrary ``.grb`` when ``with_grid``. None of it is a
    real PEST++ run -- discovery matches filenames and opens only the
    control file as a line scan, so content past that never matters here.
    """
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "case.pst").write_text("pcf\nnoptmax 3\n")
    for iteration in iterations:
        (run_dir / f"case.{iteration}.par.csv").write_bytes(b"x" * 200)
    if with_grid:
        (run_dir / "model.grb").write_bytes(b"x" * 100)
    return run_dir


def _app_for(run_dir: Path, cache_root: Path):
    app, token = create_app()
    app.state.initial_run_dir = str(run_dir)
    app.state.cache_root = str(cache_root)
    return app, token


def _planned_for(run_dir: Path, layout: CacheLayout):
    return plan_artifacts(discover(run_dir), layout)


def _mark_ok_with_file(manifest: Manifest, layout: CacheLayout, name: str, *, sources=(), seconds=1.0) -> None:
    """Mark ``name`` ok with one real on-disk file of a known size, so
    ``Manifest.is_stale``'s per-file size check -- which the state route
    always runs with a real layout -- sees a file that matches what was
    recorded, rather than reporting stale for a file that was never
    written."""
    layout.root.mkdir(parents=True, exist_ok=True)
    content = b"x" * 32
    file_name = name.replace("/", "_") + ".bin"
    (layout.root / file_name).write_bytes(content)
    manifest.mark_ok(
        name, sources=list(sources), files=(CacheFile(path=file_name, bytes=len(content)),), seconds=seconds
    )


def _row(artifact: str, state: str, index: int, total: int, **kwargs: Any) -> Progress:
    defaults = {"source_bytes": 10, "written_bytes": 0, "seconds": 0.0}
    defaults.update(kwargs)
    return Progress(artifact=artifact, state=state, index=index, total=total, **defaults)


def _scripted_ingest(names: list[str], *, sleep: float = 0.02):
    """A stand-in for ``ingest_run``: for each name in order, emits a
    started row, sleeps, marks it ok and saves the manifest, then emits its
    ok row -- so a client polling ``/state`` mid-run sees real incremental
    progress, the same way the real ``ingest_run`` does. Honours ``cancel``
    at each boundary, exactly like the real thing."""

    def fake(run_dir, cache_root, iterations, on_progress, cancel):
        manifest = Manifest.empty(str(run_dir))
        layout = CacheLayout(root=Path(cache_root))
        total = len(names)
        for index, name in enumerate(names):
            if cancel is not None and cancel.is_set():
                break
            if on_progress is not None:
                on_progress(_row(name, "started", index, total))
            time.sleep(sleep)
            manifest.mark_ok(name, sources=[])
            manifest.save(layout)
            if on_progress is not None:
                on_progress(_row(name, "ok", index, total, written_bytes=5, seconds=sleep))
        return manifest

    return fake


def _drain_events(client: TestClient, token: str):
    """Open the event stream, read it to completion, and split it into its
    media type, its ordered progress-frame payloads, and the done frame's
    payload (``None`` if the stream ended before one arrived)."""
    with client.stream("GET", "/api/run/ingest/events", headers={"x-pesto-token": token}) as response:
        content_type = response.headers["content-type"]
        text = "".join(response.iter_text())
    blocks = [block for block in text.split("\n\n") if block.strip()]
    progress: list[dict[str, Any]] = []
    done: dict[str, Any] | None = None
    for block in blocks:
        lines = block.split("\n")
        if lines[0].startswith("event:"):
            done = json.loads(lines[1][len("data:") :].strip())
        else:
            progress.append(json.loads(lines[0][len("data:") :].strip()))
    return content_type, progress, done


# --- freshness and capabilities (GET /state) --------------------------------


def test_fresh_true_on_a_complete_unchanged_manifest(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.empty(str(run_dir))
    for planned in _planned_for(run_dir, layout):
        sources = [SourceFingerprint.of(Path(s)) for s in planned.sources]
        _mark_ok_with_file(manifest, layout, planned.name, sources=sources)
    manifest.save(layout)

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 200
    body = response.json()
    assert body["fresh"] is True
    assert all(not a["stale"] for a in body["artifacts"])


def test_fresh_false_on_an_empty_cache(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    body = response.json()
    assert body["fresh"] is False
    assert all(a["state"] == "absent" for a in body["artifacts"])


def test_fresh_false_with_only_the_touched_artifact_stale(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.empty(str(run_dir))
    for planned in _planned_for(run_dir, layout):
        sources = [SourceFingerprint.of(Path(s)) for s in planned.sources]
        _mark_ok_with_file(manifest, layout, planned.name, sources=sources)
    manifest.save(layout)

    (run_dir / "case.0.par.csv").write_bytes(b"y" * 999)

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    by_name = {a["name"]: a for a in response.json()["artifacts"]}
    assert response.json()["fresh"] is False
    assert by_name["par_ens/0"]["stale"] is True
    assert by_name["par_agg/0"]["stale"] is True
    assert by_name["control"]["stale"] is False
    assert by_name["grid"]["stale"] is False
    assert by_name["config"]["stale"] is False


def _mark_every_planned_artifact_ok(run_dir: Path, layout: CacheLayout) -> Manifest:
    manifest = Manifest.empty(str(run_dir))
    for planned in _planned_for(run_dir, layout):
        sources = [SourceFingerprint.of(Path(s)) for s in planned.sources]
        _mark_ok_with_file(manifest, layout, planned.name, sources=sources)
    manifest.save(layout)
    return manifest


def _make_run_with_external_table(tmp_path: Path) -> Path:
    run_dir = _make_run(tmp_path, iterations=(0,))
    (run_dir / "case.pst").write_text(
        "pcf version=2\nnoptmax 3\n* parameter data external\ncase.par_data.csv\n"
    )
    (run_dir / "case.par_data.csv").write_text("parnme,parlbnd\np0,0.1\n")
    return run_dir


def test_fresh_true_when_the_external_table_is_unchanged(tmp_path):
    run_dir = _make_run_with_external_table(tmp_path)
    cache_root = tmp_path / "cache"
    _mark_every_planned_artifact_ok(run_dir, CacheLayout(root=cache_root))

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})

    assert response.json()["fresh"] is True


def test_editing_only_the_external_table_makes_control_stale_and_grid_fresh(tmp_path):
    run_dir = _make_run_with_external_table(tmp_path)
    cache_root = tmp_path / "cache"
    _mark_every_planned_artifact_ok(run_dir, CacheLayout(root=cache_root))

    (run_dir / "case.par_data.csv").write_text("parnme,parlbnd\np0,0.5\n")

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    by_name = {a["name"]: a for a in response.json()["artifacts"]}
    assert response.json()["fresh"] is False
    assert by_name["control"]["stale"] is True
    assert by_name["grid"]["stale"] is False


def test_editing_only_the_external_table_makes_everything_built_from_control_stale(tmp_path):
    run_dir = _make_run_with_external_table(tmp_path)
    cache_root = tmp_path / "cache"
    _mark_every_planned_artifact_ok(run_dir, CacheLayout(root=cache_root))

    (run_dir / "case.par_data.csv").write_text("parnme,parlbnd\np0,0.5\n")

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    by_name = {a["name"]: a for a in response.json()["artifacts"]}
    for name in ("control", "par_cell", "obs_index", "par_ens/0", "par_agg/0", "config"):
        assert by_name[name]["stale"] is True, name
    assert by_name["grid"]["stale"] is False


def test_a_record_made_before_the_tables_were_sources_reports_stale_without_a_rewrite_notice(
    tmp_path,
):
    run_dir = _make_run_with_external_table(tmp_path)
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    table = run_dir / "case.par_data.csv"
    manifest = Manifest.empty(str(run_dir))
    for planned in _planned_for(run_dir, layout):
        old_sources = [
            SourceFingerprint.of(Path(s)) for s in planned.sources if Path(s) != table
        ]
        _mark_ok_with_file(manifest, layout, planned.name, sources=old_sources)
    manifest.save(layout)

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    body = response.json()
    by_name = {a["name"]: a for a in body["artifacts"]}
    assert body["fresh"] is False
    assert body["rewrite"] is None
    for name in ("control", "par_cell", "obs_index", "par_ens/0", "par_agg/0", "config"):
        assert by_name[name]["stale"] is True, name
    assert by_name["grid"]["stale"] is False


def test_fresh_false_and_every_artifact_absent_on_a_foreign_cache_version(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    manifest = Manifest(cache_version=999, run_dir=str(run_dir))
    manifest.mark_ok("control", sources=[])
    manifest.save(layout)

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    body = response.json()
    assert body["fresh"] is False
    assert all(a["state"] == "absent" for a in body["artifacts"])


def test_ingest_seconds_and_cache_bytes_null_when_absent(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    body = response.json()
    assert body["ingest_seconds"] is None
    assert body["cache_bytes"] is None


def test_ingest_seconds_and_cache_bytes_reported_from_the_manifest(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.empty(str(run_dir))
    manifest.ingest_seconds = 12.5
    manifest.cache_bytes = 4096
    manifest.save(layout)

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    body = response.json()
    assert body["ingest_seconds"] == 12.5
    assert body["cache_bytes"] == 4096


def test_capability_stats_blocked_names_the_summary_and_its_reason_while_map_stays_available(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.empty(str(run_dir))
    _mark_ok_with_file(manifest, layout, "grid")
    _mark_ok_with_file(manifest, layout, "par_cell")
    _mark_ok_with_file(manifest, layout, "par_ens/0")
    manifest.mark_failed("par_agg/0", "boom")
    manifest.save(layout)

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    capabilities = response.json()["capabilities"]

    stats = capabilities["stats"]
    assert stats["available"] is False
    assert any(b["artifact"] == "par_agg/0" and b["reason"] == "boom" for b in stats["blocked_by"])
    assert capabilities["map"]["available"] is True
    assert capabilities["map"]["blocked_by"] == []


def test_capability_map_blocked_names_par_cell_when_it_failed(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.empty(str(run_dir))
    _mark_ok_with_file(manifest, layout, "grid")
    _mark_ok_with_file(manifest, layout, "par_ens/0")
    manifest.mark_failed("par_cell", "no group could be placed on the grid")
    manifest.save(layout)

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    map_capability = response.json()["capabilities"]["map"]

    assert map_capability["available"] is False
    assert map_capability["blocked_by"] == [
        {"artifact": "par_cell", "reason": "no group could be placed on the grid"}
    ]


def test_capability_chips_blocked_names_config_and_its_reason(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.empty(str(run_dir))
    manifest.mark_failed("config", "control file could not be read")
    manifest.save(layout)

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    chips = response.json()["capabilities"]["chips"]
    assert chips["available"] is False
    assert chips["blocked_by"] == [{"artifact": "config", "reason": "control file could not be read"}]


def test_capability_map_blocked_when_nothing_has_been_ingested(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    map_capability = response.json()["capabilities"]["map"]
    assert map_capability["available"] is False
    blocked_names = {b["artifact"] for b in map_capability["blocked_by"]}
    assert "grid" in blocked_names
    assert "par_cell" in blocked_names
    assert "par_ens/0" in blocked_names


def _obs_capability(app, token):
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    return response.json()["capabilities"]["obs"]


def test_capability_obs_for_a_run_with_no_observation_file_says_so(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0, 3))
    app, token = _app_for(run_dir, tmp_path / "cache")

    assert _obs_capability(app, token) == {
        "available": False,
        "blocked_by": [
            {"artifact": "obs_ens", "reason": "no observation ensemble file was found for this run"}
        ],
    }


def test_capability_obs_names_the_iteration_when_files_exist_only_for_others(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0, 3))
    (run_dir / "case.1.obs.csv").write_bytes(b"x" * 50)
    app, token = _app_for(run_dir, tmp_path / "cache")

    capability = _obs_capability(app, token)

    assert capability["available"] is False
    assert capability["blocked_by"] == [
        {
            "artifact": "obs_ens",
            "reason": "no observation ensemble file was found for iteration 0",
        }
    ]


def test_capability_obs_blocked_names_obs_index_and_its_recorded_reason(
    tmp_path, in_process, monkeypatch
):
    from pesto.ingest.failures import ReadFailure as Failure

    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    cache_root = tmp_path / "cache"
    monkeypatch.setattr(
        runner_module,
        "_write_obs_index_artifact",
        lambda cache_root: Failure(name="obs_index", path="x", reason="no observation names"),
    )
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)
    capability = _obs_capability(app, token)

    assert capability["available"] is False
    by_artifact = {b["artifact"]: b["reason"] for b in capability["blocked_by"]}
    assert by_artifact["obs_index"] == "no observation names"
    assert by_artifact["obs_ens/0"].startswith("obs_ens/0 depends on obs_index, which failed")


def test_capability_obs_is_available_when_one_of_two_observation_files_is_ok(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    run.obs_ens[1].write_bytes(b"not an ensemble file")
    cache_root = tmp_path / "cache"
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})

    body = response.json()
    states = {a["name"]: a["state"] for a in body["artifacts"]}
    assert states["obs_ens/0"] == "ok"
    assert states["obs_ens/1"] == "failed"
    assert body["capabilities"]["obs"] == {"available": True, "blocked_by": []}


def _obs_stats_capability(app, token):
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    return response.json()["capabilities"]["obs_stats"]


def test_capability_obs_stats_is_available_once_obs_agg_is_ok(tmp_path, in_process):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    cache_root = tmp_path / "cache"
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)

    assert _obs_stats_capability(app, token) == {"available": True, "blocked_by": []}


def test_capability_obs_stats_is_blocked_before_anything_is_ingested(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    app, token = _app_for(run_dir, tmp_path / "cache")

    capability = _obs_stats_capability(app, token)

    assert capability["available"] is False
    assert {b["artifact"] for b in capability["blocked_by"]} == {"obs_agg/0", "obs_agg/1"}


def test_capability_obs_stats_blocked_names_obs_agg_and_its_recorded_reason(
    tmp_path, in_process, monkeypatch
):
    from pesto.ingest.failures import ReadFailure as Failure

    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    cache_root = tmp_path / "cache"
    monkeypatch.setattr(
        runner_module,
        "_write_obs_agg_artifact",
        lambda cache_root, iteration: Failure(
            name=f"obs_agg/{iteration}", path="x", reason="the statistics would not write"
        ),
    )
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)
    capability = _obs_stats_capability(app, token)

    assert capability["available"] is False
    by_artifact = {b["artifact"]: b["reason"] for b in capability["blocked_by"]}
    assert by_artifact == {
        "obs_agg/0": "the statistics would not write",
        "obs_agg/1": "the statistics would not write",
    }
    # The ensembles themselves are fine, so obs is still available.
    assert _obs_capability(app, token) == {"available": True, "blocked_by": []}


def test_capability_obs_stats_for_a_run_with_no_observation_file_says_why(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0, 3))
    app, token = _app_for(run_dir, tmp_path / "cache")

    assert _obs_stats_capability(app, token) == {
        "available": False,
        "blocked_by": [
            {"artifact": "obs_agg", "reason": "no observation ensemble file was found for this run"}
        ],
    }


def _noise_capability(app, token):
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    return response.json()["capabilities"]["noise"]


NO_NOISE_REASON = (
    "no case.obs+noise file was found for this run; pesto never uses a starting "
    "observation ensemble as the noise band"
)


def test_capability_noise_is_available_once_noise_agg_is_ok(tmp_path, in_process):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True)
    cache_root = tmp_path / "cache"
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)

    assert _noise_capability(app, token) == {"available": True, "blocked_by": []}


def test_capability_noise_is_blocked_before_anything_is_ingested(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True)
    app, token = _app_for(run_dir, tmp_path / "cache")

    capability = _noise_capability(app, token)

    assert capability["available"] is False
    assert [b["artifact"] for b in capability["blocked_by"]] == ["noise_agg"]


def test_capability_noise_names_noise_agg_and_its_recorded_reason(
    tmp_path, in_process, monkeypatch
):
    from pesto.ingest.failures import ReadFailure as Failure

    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True)
    cache_root = tmp_path / "cache"
    monkeypatch.setattr(
        runner_module,
        "_write_noise_agg_artifact",
        lambda source, cache_root: Failure(
            name="noise_agg", path="x", reason="the noise band would not write"
        ),
    )
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)
    capability = _noise_capability(app, token)

    assert capability["available"] is False
    assert capability["blocked_by"] == [
        {"artifact": "noise_agg", "reason": "the noise band would not write"}
    ]
    # Observations and their statistics are unaffected.
    assert _obs_capability(app, token) == {"available": True, "blocked_by": []}
    assert _obs_stats_capability(app, token) == {"available": True, "blocked_by": []}


def test_capability_noise_for_a_run_with_no_obs_noise_file_says_why(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    app, token = _app_for(run_dir, tmp_path / "cache")

    assert _noise_capability(app, token) == {
        "available": False,
        "blocked_by": [{"artifact": "noise_agg", "reason": NO_NOISE_REASON}],
    }


def test_capability_noise_for_a_run_with_only_a_starting_ensemble_says_why(tmp_path, in_process):
    from ingest.fixtures import sample_values

    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, pestpp_options={"ies_obs_en": "noise_oe.jcb"})
    from ingest.fixtures import _ENSEMBLE_WRITERS

    _ENSEMBLE_WRITERS["jcb"][0](
        run_dir / "noise_oe.jcb",
        sample_values(5, len(run.obs_names), seed=7),
        ["a", "b", "c", "d", "e"],
        run.obs_names,
    )
    cache_root = tmp_path / "cache"
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)

    assert _noise_capability(app, token) == {
        "available": False,
        "blocked_by": [{"artifact": "noise_agg", "reason": NO_NOISE_REASON}],
    }


def _pdc_capability(app, token):
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    return response.json()["capabilities"]["pdc"]


NEITHER_PDC_REASON = (
    "no pestpp pdc file and no obs+noise file to compute one from, for iteration(s) 0, 1"
)


def test_capability_pdc_is_available_once_pestpps_file_is_read(tmp_path, in_process):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True, with_pdc=True)
    cache_root = tmp_path / "cache"
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)

    assert _pdc_capability(app, token) == {"available": True, "blocked_by": []}


def test_capability_pdc_is_available_when_it_was_computed_from_the_noise_file(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True)
    cache_root = tmp_path / "cache"
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)

    assert _pdc_capability(app, token) == {"available": True, "blocked_by": []}


def test_capability_pdc_is_blocked_before_anything_is_ingested(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True, with_pdc=True)
    app, token = _app_for(run_dir, tmp_path / "cache")

    capability = _pdc_capability(app, token)

    assert capability["available"] is False
    assert [b["artifact"] for b in capability["blocked_by"]] == ["pdc/0", "pdc/1"]


def test_capability_pdc_for_a_run_with_neither_file_says_which_iterations(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    app, token = _app_for(run_dir, tmp_path / "cache")

    assert _pdc_capability(app, token) == {
        "available": False,
        "blocked_by": [{"artifact": "pdc", "reason": NEITHER_PDC_REASON}],
    }


def test_capability_pdc_names_the_artifact_and_its_recorded_reason(
    tmp_path, in_process, monkeypatch
):
    from pesto.ingest.failures import ReadFailure as Failure

    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True, with_pdc=True)
    cache_root = tmp_path / "cache"
    monkeypatch.setattr(
        runner_module,
        "_write_pdc_artifact",
        lambda cache_root, iteration, pdc_file, weights_file: Failure(
            name=f"pdc/{iteration}", path="x", reason=f"pdc/{iteration}: would not read"
        ),
    )
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)
    capability = _pdc_capability(app, token)

    assert capability["available"] is False
    assert capability["blocked_by"] == [
        {"artifact": "pdc/0", "reason": "pdc/0: would not read"},
        {"artifact": "pdc/1", "reason": "pdc/1: would not read"},
    ]
    # Observations, their statistics and the noise band are unaffected.
    assert _obs_capability(app, token) == {"available": True, "blocked_by": []}
    assert _obs_stats_capability(app, token) == {"available": True, "blocked_by": []}
    assert _noise_capability(app, token) == {"available": True, "blocked_by": []}


def _phi_check_capability(app, token):
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    return response.json()["capabilities"]["phi_check"]


def test_capability_phi_check_is_available_once_phi_was_checked(tmp_path, in_process):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_phi=True)
    cache_root = tmp_path / "cache"
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)

    assert _phi_check_capability(app, token) == {"available": True, "blocked_by": []}


def test_capability_phi_check_is_blocked_before_anything_is_ingested(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_phi=True)
    app, token = _app_for(run_dir, tmp_path / "cache")

    capability = _phi_check_capability(app, token)

    assert capability["available"] is False
    assert [b["artifact"] for b in capability["blocked_by"]] == ["phi_check/0", "phi_check/1"]


def test_capability_phi_check_for_a_run_without_a_phi_file_says_so(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    app, token = _app_for(run_dir, tmp_path / "cache")

    assert _phi_check_capability(app, token) == {
        "available": False,
        "blocked_by": [
            {"artifact": "phi_check", "reason": "no case.phi.actual.csv was found for this run"}
        ],
    }


def test_capability_phi_check_for_a_phi_file_with_no_observation_file_names_the_missing_file(
    tmp_path,
):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_phi=True, iterations=(), par_iterations=(0, 1))
    app, token = _app_for(run_dir, tmp_path / "cache")

    capability = _phi_check_capability(app, token)

    assert capability["available"] is False
    assert capability["blocked_by"][0]["artifact"] == "phi_check"
    assert "no observation ensemble file" in capability["blocked_by"][0]["reason"]


def test_capability_phi_check_names_the_artifact_and_its_recorded_reason(
    tmp_path, in_process, monkeypatch
):
    from pesto.ingest.failures import ReadFailure as Failure

    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_phi=True)
    cache_root = tmp_path / "cache"
    monkeypatch.setattr(
        runner_module,
        "_write_phi_check_artifact",
        lambda cache_root, iteration, phi_file, weights_file: Failure(
            name=f"phi_check/{iteration}", path="x", reason=f"phi_check/{iteration}: would not read"
        ),
    )
    runner_module.ingest_run(run_dir, cache_root=cache_root)

    app, token = _app_for(run_dir, cache_root)
    capability = _phi_check_capability(app, token)

    assert capability["available"] is False
    assert capability["blocked_by"] == [
        {"artifact": "phi_check/0", "reason": "phi_check/0: would not read"},
        {"artifact": "phi_check/1", "reason": "phi_check/1: would not read"},
    ]
    # Observations and their statistics are unaffected.
    assert _obs_capability(app, token) == {"available": True, "blocked_by": []}
    assert _obs_stats_capability(app, token) == {"available": True, "blocked_by": []}


def _par_view_capability(app, token):
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    return response.json()["capabilities"]["par_view"]


def test_capability_par_view_is_available_after_a_full_ingest(tmp_path, in_process):
    from ingest.par_fixtures import make_par_view_run

    run = make_par_view_run(tmp_path / "run")
    cache_root = tmp_path / "cache"
    runner_module.ingest_run(run.root, cache_root=cache_root)

    app, token = _app_for(run.root, cache_root)

    assert _par_view_capability(app, token) == {"available": True, "blocked_by": []}


def test_capability_par_view_names_par_hist_and_its_reason_when_it_failed(
    tmp_path, in_process, monkeypatch
):
    from ingest.par_fixtures import make_par_view_run

    run = make_par_view_run(tmp_path / "run")
    cache_root = tmp_path / "cache"
    monkeypatch.setattr(
        runner_module,
        "_write_par_hist_artifact",
        lambda cache_root, first, last: ReadFailure(
            name="par_hist", path="x", reason="the histograms would not write"
        ),
    )
    runner_module.ingest_run(run.root, cache_root=cache_root)

    app, token = _app_for(run.root, cache_root)
    capability = _par_view_capability(app, token)

    assert capability["available"] is False
    assert capability["blocked_by"] == [
        {"artifact": "par_hist", "reason": "the histograms would not write"}
    ]


def test_capability_par_view_is_blocked_before_anything_is_ingested(tmp_path):
    from ingest.par_fixtures import make_par_view_run

    run = make_par_view_run(tmp_path / "run")
    app, token = _app_for(run.root, tmp_path / "cache")

    capability = _par_view_capability(app, token)

    assert capability["available"] is False
    assert [b["artifact"] for b in capability["blocked_by"]] == ["par_change", "par_groups", "par_hist"]
    assert {b["reason"] for b in capability["blocked_by"]} == {"not yet ingested"}


def test_capability_par_view_for_a_run_with_no_parameter_ensemble_says_so(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    app, token = _app_for(run_dir, tmp_path / "cache")

    capability = _par_view_capability(app, token)

    assert capability == {
        "available": False,
        "blocked_by": [
            {"artifact": "par_ens", "reason": "no parameter ensemble file was found for this run"}
        ],
    }


# --- the byte estimate (GET /estimate) --------------------------------------


def test_estimate_reports_total_per_artifact_notes_and_free_space(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/estimate", headers={"x-pesto-token": token})
    body = response.json()
    assert body["total"] > 0
    assert body["per_artifact"]
    assert body["notes"]
    assert body["free_bytes"] > 0
    assert body["cache_root_exists"] is False


def test_estimate_never_creates_the_cache_root(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    app, token = _app_for(run_dir, cache_root)
    _client(app).get("/api/run/ingest/estimate", headers={"x-pesto-token": token})
    assert not cache_root.exists()


# --- resolving the active run ------------------------------------------------


def test_no_run_open_returns_409_for_state_and_estimate():
    app, token = create_app()
    for path in ("/api/run/ingest/state", "/api/run/ingest/estimate"):
        response = _client(app).get(path, headers={"x-pesto-token": token})
        assert response.status_code == 409
        assert response.headers["content-type"] == "application/problem+json"


def test_a_run_directory_that_no_longer_exists_returns_410(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    app, token = _app_for(run_dir, cache_root)
    shutil.rmtree(run_dir)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 410


def test_no_failure_body_leaks_an_absolute_path(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    app, token = _app_for(run_dir, cache_root)

    bodies = [
        _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token}).text,
        _client(app).get("/api/run/ingest/estimate", headers={"x-pesto-token": token}).text,
        _client(app).post("/api/run/ingest/cancel", headers={"x-pesto-token": token}).text,
    ]

    gone_root = tmp_path.parent / "gone_root"
    gone_root.mkdir()
    gone_dir = _make_run(gone_root)
    app2, token2 = _app_for(gone_dir, cache_root)
    shutil.rmtree(gone_dir)
    bodies.append(_client(app2).get("/api/run/ingest/state", headers={"x-pesto-token": token2}).text)

    for body in bodies:
        assert str(tmp_path) not in body
        assert str(gone_dir) not in body


# --- start, stream and cancel (POST /, GET /events, POST /cancel) ----------


def test_start_returns_202_promptly_even_for_a_slow_ingest(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())

    def fake(run_dir, cache_root, iterations, on_progress, cancel):
        if on_progress is not None:
            on_progress(_row("control", "started", 0, 1))
        time.sleep(1.2)
        if on_progress is not None:
            on_progress(_row("control", "ok", 0, 1, written_bytes=5, seconds=1.2))
        manifest = Manifest.empty(str(run_dir))
        manifest.mark_ok("control", sources=[])
        return manifest

    cache_root = tmp_path / "cache"
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            started_at = time.monotonic()
            response = client.post("/api/run/ingest", headers={"x-pesto-token": token})
            elapsed = time.monotonic() - started_at
            assert response.status_code == 202
            assert response.json() == {"started": True}
            assert elapsed < 1.0
            _drain_events(client, token)  # let the background task finish


def test_a_second_start_while_one_is_running_returns_409(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    fake = _scripted_ingest(["control"], sleep=0.2)
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            first = client.post("/api/run/ingest", headers={"x-pesto-token": token})
            assert first.status_code == 202
            second = client.post("/api/run/ingest", headers={"x-pesto-token": token})
            assert second.status_code == 409
            assert second.headers["content-type"] == "application/problem+json"
            _drain_events(client, token)


def test_a_start_after_completion_is_accepted_again(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    fake = _scripted_ingest(["control"], sleep=0.02)
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            first = client.post("/api/run/ingest", headers={"x-pesto-token": token})
            assert first.status_code == 202
            _drain_events(client, token)
            second = client.post("/api/run/ingest", headers={"x-pesto-token": token})
            assert second.status_code == 202
            _drain_events(client, token)


def test_events_stream_media_type(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    fake = _scripted_ingest(["control"], sleep=0.02)
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            client.post("/api/run/ingest", headers={"x-pesto-token": token})
            with client.stream("GET", "/api/run/ingest/events", headers={"x-pesto-token": token}) as response:
                assert response.headers["content-type"].startswith("text/event-stream")
                for _chunk in response.iter_text():
                    pass


def test_every_frame_parses_and_carries_an_artifact_and_a_state(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    fake = _scripted_ingest(["control", "config"], sleep=0.02)
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            client.post("/api/run/ingest", headers={"x-pesto-token": token})
            _content_type, progress, done = _drain_events(client, token)
    assert len(progress) == 4
    for row in progress:
        assert "artifact" in row
        assert "state" in row
    assert done is not None


def test_started_row_precedes_terminal_row_per_artifact(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    fake = _scripted_ingest(["control", "config"], sleep=0.02)
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            client.post("/api/run/ingest", headers={"x-pesto-token": token})
            _content_type, progress, _done = _drain_events(client, token)
    started_at: dict[str, int] = {}
    for index, row in enumerate(progress):
        if row["state"] == "started":
            started_at[row["artifact"]] = index
        else:
            assert row["artifact"] in started_at
            assert started_at[row["artifact"]] < index


def test_late_connect_replays_rows_produced_before_connecting(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    fake = _scripted_ingest(["control", "config"], sleep=0.3)
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            client.post("/api/run/ingest", headers={"x-pesto-token": token})
            time.sleep(0.35)  # "control" has already started and finished
            _content_type, progress, done = _drain_events(client, token)
    assert progress[0]["artifact"] == "control" and progress[0]["state"] == "started"
    assert progress[1]["artifact"] == "control" and progress[1]["state"] == "ok"
    assert len(progress) == 4  # both artifacts, none replayed twice
    assert done is not None


def test_the_done_frame_carries_the_final_artifact_states(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    fake = _scripted_ingest(["control", "config"], sleep=0.02)
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            client.post("/api/run/ingest", headers={"x-pesto-token": token})
            _content_type, _progress, done = _drain_events(client, token)
    assert done == {
        "control": {"state": "ok", "reason": None},
        "config": {"state": "ok", "reason": None},
    }


def test_disconnect_stops_the_stream_and_not_the_ingest(tmp_path, monkeypatch):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    fake = _scripted_ingest(["control", "config"], sleep=0.3)
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            client.post("/api/run/ingest", headers={"x-pesto-token": token})
            time.sleep(0.15)  # "control" has started but not yet finished

            async def _already_gone(self) -> bool:
                return True

            monkeypatch.setattr(Request, "is_disconnected", _already_gone)
            with client.stream("GET", "/api/run/ingest/events", headers={"x-pesto-token": token}) as response:
                text = "".join(response.iter_text())
            assert '"artifact": "control", "state": "started"' in text
            assert "config" not in text
            assert "event: done" not in text

            monkeypatch.undo()
            time.sleep(0.8)  # nothing told the ingest itself to stop
            state_response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
            by_name = {a["name"]: a for a in state_response.json()["artifacts"]}
            assert by_name["control"]["state"] == "ok"
            assert by_name["config"]["state"] == "ok"


def test_cancel_stops_at_a_boundary_and_preserves_finished_artifacts(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    fake = _scripted_ingest(["control", "grid", "config"], sleep=0.25)
    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            client.post("/api/run/ingest", headers={"x-pesto-token": token})
            time.sleep(0.3)  # "control" has finished; "grid" is in flight
            cancel_response = client.post("/api/run/ingest/cancel", headers={"x-pesto-token": token})
            assert cancel_response.status_code == 202
            assert cancel_response.json() == {"cancelling": True}
            time.sleep(0.6)  # let it observe the cancel at the next boundary
            state_response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
            by_name = {a["name"]: a for a in state_response.json()["artifacts"]}
            assert by_name["control"]["state"] == "ok"
            assert by_name["config"]["state"] == "absent"


def test_cancel_with_nothing_running_returns_409():
    app, token = create_app()
    response = _client(app).post("/api/run/ingest/cancel", headers={"x-pesto-token": token})
    assert response.status_code == 409
    assert response.headers["content-type"] == "application/problem+json"


def test_ingest_run_raising_ends_the_stream_with_a_failure_frame(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"

    def failing(run_dir, cache_root, iterations, on_progress, cancel):
        if on_progress is not None:
            on_progress(_row("control", "started", 0, 1))
        raise RuntimeError("the run directory vanished mid-ingest")

    with mock.patch.object(runner_module, "ingest_run", failing):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            start = client.post("/api/run/ingest", headers={"x-pesto-token": token})
            assert start.status_code == 202
            with client.stream("GET", "/api/run/ingest/events", headers={"x-pesto-token": token}) as response:
                text = "".join(response.iter_text())

    assert "event: error" in text
    assert "the run directory vanished mid-ingest" in text


def test_an_ingest_that_raises_still_drops_the_memo_for_its_cache(tmp_path):
    """An ingest can rewrite par_cell and then raise; the memo built from the
    old file must not outlive it."""
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"

    def failing(run_dir, cache_root, iterations, on_progress, cancel):
        raise RuntimeError("boom after par_cell was rewritten")

    with mock.patch.object(runner_module, "ingest_run", failing):
        app, token = _app_for(run_dir, cache_root)
        app.state.block_cells_memo = {(str(cache_root), 0): object()}
        app.state.ens_memo = {(str(cache_root), 0): object()}
        with _client(app) as client:
            assert client.post("/api/run/ingest", headers={"x-pesto-token": token}).status_code == 202
            _drain_events(client, token)

    assert app.state.block_cells_memo == {}
    assert app.state.ens_memo == {}


def test_a_start_after_a_failed_ingest_is_accepted_not_permanently_refused(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"

    def failing(run_dir, cache_root, iterations, on_progress, cancel):
        raise RuntimeError("boom")

    with mock.patch.object(runner_module, "ingest_run", failing):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            first = client.post("/api/run/ingest", headers={"x-pesto-token": token})
            assert first.status_code == 202
            _drain_events(client, token)

            fake = _scripted_ingest(["control"], sleep=0.02)
            with mock.patch.object(runner_module, "ingest_run", fake):
                second = client.post("/api/run/ingest", headers={"x-pesto-token": token})
                assert second.status_code == 202
                _drain_events(client, token)


# --- one real ingest, driven end to end through the routes -----------------


@pytest.mark.slow
def test_a_real_ingest_through_the_routes(forecast_run, tmp_path):
    """No mock, no scripted rows: a real ``ingest_run`` against a real
    benchmark, reading only, writing its cache to a throwaway ``tmp_path``
    -- never into the benchmark's own directory. Asserts only behaviour,
    never this particular run's artifact count or timings, per CLAUDE.md's
    rule against tests that describe a local folder instead of the code."""
    cache_root = tmp_path / "cache"
    app, token = _app_for(forecast_run, cache_root)
    with _client(app) as client:
        start = client.post("/api/run/ingest", headers={"x-pesto-token": token})
        assert start.status_code == 202

        _content_type, progress, done = _drain_events(client, token)
        started = {row["artifact"] for row in progress if row["state"] == "started"}
        terminal = {row["artifact"] for row in progress if row["state"] != "started"}
        assert started
        assert started <= terminal
        assert done is not None

        state_response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
        assert state_response.json()["fresh"] is True

        second_start = client.post("/api/run/ingest", headers={"x-pesto-token": token})
        assert second_start.status_code == 202
        _content_type2, progress2, _done2 = _drain_events(client, token)
        assert progress2
        assert all(row["state"] == "skipped" for row in progress2)


# --- an old cache is reported, then re-read ---------------------------------


def _write_old_manifest(cache_root: Path, run_dir: Path, *, version: int = 2, cache_bytes: int | None = 4096):
    cache_root.mkdir(parents=True, exist_ok=True)
    payload = {
        "cache_version": version,
        "run_dir": str(run_dir),
        "artifacts": {},
        "ingest_seconds": 3.0,
        "cache_bytes": cache_bytes,
    }
    (cache_root / "manifest.json").write_text(json.dumps(payload))


def _state(app, token) -> dict[str, Any]:
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 200
    return response.json()


def _ingest_that_leaves_a_fresh_cache(run_dir, cache_root, iterations, on_progress, cancel):
    """What a finished real ingest leaves behind: every planned artifact ok,
    recorded against its sources, saved at the current cache version."""
    layout = CacheLayout(root=Path(cache_root))
    manifest = Manifest.empty(str(run_dir))
    for planned in _planned_for(Path(run_dir), layout):
        sources = [SourceFingerprint.of(Path(s)) for s in planned.sources]
        _mark_ok_with_file(manifest, layout, planned.name, sources=sources)
    manifest.save(layout)
    return manifest


def test_state_of_a_version_2_cache_says_it_was_made_at_version_2(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    _write_old_manifest(cache_root, run_dir, version=2)
    app, token = _app_for(run_dir, cache_root)

    body = _state(app, token)

    assert body["fresh"] is False
    assert body["rewrite"]["found"] == 2
    assert body["rewrite"]["expected"] == CACHE_VERSION
    assert body["rewrite"]["writable"] is True
    assert isinstance(body["rewrite"]["folder"], str)


def test_state_of_a_version_1_cache_says_version_1(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    _write_old_manifest(cache_root, run_dir, version=1)
    app, token = _app_for(run_dir, cache_root)

    assert _state(app, token)["rewrite"]["found"] == 1


def test_state_of_a_newer_cache_reports_its_higher_version(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    _write_old_manifest(cache_root, run_dir, version=CACHE_VERSION + 1)
    app, token = _app_for(run_dir, cache_root)

    rewrite = _state(app, token)["rewrite"]

    assert rewrite["found"] == CACHE_VERSION + 1
    assert rewrite["expected"] == CACHE_VERSION


def test_state_with_no_manifest_is_a_first_ingest_not_a_rewrite(tmp_path):
    run_dir = _make_run(tmp_path)
    app, token = _app_for(run_dir, tmp_path / "cache")

    body = _state(app, token)

    assert body["fresh"] is False
    assert body["rewrite"] is None


def test_state_with_a_version_that_is_not_an_integer_is_a_first_ingest(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    cache_root.mkdir()
    (cache_root / "manifest.json").write_text(json.dumps({"cache_version": "2", "run_dir": "x"}))
    app, token = _app_for(run_dir, cache_root)

    assert _state(app, token)["rewrite"] is None


def test_state_of_a_current_cache_has_no_rewrite(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.empty(str(run_dir))
    for planned in _planned_for(run_dir, layout):
        sources = [SourceFingerprint.of(Path(s)) for s in planned.sources]
        _mark_ok_with_file(manifest, layout, planned.name, sources=sources)
    manifest.save(layout)
    app, token = _app_for(run_dir, cache_root)

    body = _state(app, token)

    assert body["fresh"] is True
    assert body["rewrite"] is None


def test_after_the_one_rewrite_the_state_is_fresh_with_no_rewrite(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    _write_old_manifest(cache_root, run_dir, version=2)

    with mock.patch.object(runner_module, "ingest_run", _ingest_that_leaves_a_fresh_cache):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            before = client.get("/api/run/ingest/state", headers={"x-pesto-token": token}).json()
            assert before["rewrite"]["found"] == 2

            assert client.post("/api/run/ingest", headers={"x-pesto-token": token}).status_code == 202
            _drain_events(client, token)

            after = client.get("/api/run/ingest/state", headers={"x-pesto-token": token}).json()

    assert after["fresh"] is True
    assert after["rewrite"] is None


def test_the_folder_in_the_state_has_the_home_directory_shortened(tmp_path, monkeypatch):
    run_dir = _make_run(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "somewhere" / "cache"
    _write_old_manifest(cache_root, run_dir, version=2)
    app, token = _app_for(run_dir, cache_root)

    folder = _state(app, token)["rewrite"]["folder"]

    assert folder == "~/somewhere/cache"
    assert str(tmp_path) not in folder


def test_the_rewrite_carries_free_space_and_the_old_cache_size(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    _write_old_manifest(cache_root, run_dir, version=2, cache_bytes=4096)
    app, token = _app_for(run_dir, cache_root)

    rewrite = _state(app, token)["rewrite"]

    assert isinstance(rewrite["free_bytes"], int)
    assert rewrite["free_bytes"] > 0
    assert rewrite["old_cache_bytes"] == 4096


def test_the_rewrite_says_so_when_the_old_cache_size_was_not_recorded(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    _write_old_manifest(cache_root, run_dir, version=2, cache_bytes=None)
    app, token = _app_for(run_dir, cache_root)

    rewrite = _state(app, token)["rewrite"]

    assert rewrite["old_cache_bytes"] is None
    assert isinstance(rewrite["free_bytes"], int)


def test_the_rewrite_reports_the_free_space_the_disk_answers_with(tmp_path, monkeypatch):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "cache"
    _write_old_manifest(cache_root, run_dir, version=2)
    monkeypatch.setattr(
        "pesto.api.ingest.shutil.disk_usage", lambda path: SimpleNamespace(total=100, used=93, free=7)
    )
    app, token = _app_for(run_dir, cache_root)

    assert _state(app, token)["rewrite"]["free_bytes"] == 7


def test_the_estimate_and_the_rewrite_measure_free_space_the_same_way(tmp_path):
    run_dir = _make_run(tmp_path)
    cache_root = tmp_path / "not-yet" / "cache"
    app, token = _app_for(run_dir, cache_root)

    estimate = _client(app).get("/api/run/ingest/estimate", headers={"x-pesto-token": token}).json()

    assert estimate["cache_root_exists"] is False
    assert estimate["free_bytes"] > 0


def test_the_state_carries_a_twelve_character_run_id_that_does_not_change(tmp_path):
    run_dir = _make_run(tmp_path)
    app, token = _app_for(run_dir, tmp_path / "cache")

    first = _state(app, token)
    second = _state(app, token)

    assert len(first["run_id"]) == 12
    assert first["run_id"] == second["run_id"]
    assert first["run_id"] == run_id_for(run_dir)


def test_two_runs_have_different_run_ids_in_the_state(tmp_path):
    run_a = _make_run(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    run_b = _make_run(other)

    id_a = _state(*_app_for(run_a, tmp_path / "cache-a"))["run_id"]
    id_b = _state(*_app_for(run_b, tmp_path / "cache-b"))["run_id"]

    assert id_a != id_b


def test_an_old_cache_in_an_unwritable_folder_refuses_the_start_with_409(tmp_path, monkeypatch):
    run_dir = _make_run(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "somewhere" / "cache"
    _write_old_manifest(cache_root, run_dir, version=2)
    monkeypatch.setattr("pesto.api.ingest.probe_writable", lambda folder: False)
    app, token = _app_for(run_dir, cache_root)

    with _client(app) as client:
        state = client.get("/api/run/ingest/state", headers={"x-pesto-token": token}).json()
        response = client.post("/api/run/ingest", headers={"x-pesto-token": token})

    assert state["rewrite"]["writable"] is False
    assert response.status_code == 409
    body = response.json()
    assert body["title"] == "the cache is out of date and cannot be rewritten here"
    assert body["folder"] == "~/somewhere/cache"
    assert body["detail"] == (
        "the cache was made at cache version 2 and pesto cannot write to its folder; "
        "open the run again with --cache-dir set to a folder that can be written"
    )
    assert str(tmp_path) not in response.text
    assert getattr(app.state, "ingest", None) is None


def test_a_cache_from_a_newer_pesto_is_refused_not_overwritten(tmp_path, monkeypatch):
    run_dir = _make_run(tmp_path, iterations=(0,))
    monkeypatch.setenv("HOME", str(tmp_path))
    cache_root = tmp_path / "somewhere" / "cache"
    newer = CACHE_VERSION + 1
    _write_old_manifest(cache_root, run_dir, version=newer)
    before = (cache_root / "manifest.json").read_bytes()

    with mock.patch.object(runner_module, "ingest_run", _ingest_that_leaves_a_fresh_cache):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            response = client.post("/api/run/ingest", headers={"x-pesto-token": token})

    assert response.status_code == 409
    body = response.json()
    assert body["title"] == "the cache was made by a newer pesto"
    assert body["detail"] == (
        f"the cache was made at cache version {newer} and this pesto writes version "
        f"{CACHE_VERSION}; rewriting it would throw away the newer one. Open the run with "
        "that newer pesto, or open it again with --cache-dir set to another folder"
    )
    assert body["folder"] == "~/somewhere/cache"
    assert (cache_root / "manifest.json").read_bytes() == before
    assert getattr(app.state, "ingest", None) is None


def test_an_old_cache_in_a_writable_folder_still_starts(tmp_path):
    run_dir = _make_run(tmp_path, iterations=(0,))
    cache_root = tmp_path / "cache"
    _write_old_manifest(cache_root, run_dir, version=2)

    with mock.patch.object(runner_module, "ingest_run", _ingest_that_leaves_a_fresh_cache):
        app, token = _app_for(run_dir, cache_root)
        with _client(app) as client:
            response = client.post("/api/run/ingest", headers={"x-pesto-token": token})
            _drain_events(client, token)

    assert response.status_code == 202


def test_an_unwritable_folder_with_no_old_cache_does_not_refuse_the_start(tmp_path, monkeypatch):
    run_dir = _make_run(tmp_path, iterations=(0,))
    monkeypatch.setattr("pesto.api.ingest.probe_writable", lambda folder: False)

    with mock.patch.object(runner_module, "ingest_run", _ingest_that_leaves_a_fresh_cache):
        app, token = _app_for(run_dir, tmp_path / "cache")
        with _client(app) as client:
            response = client.post("/api/run/ingest", headers={"x-pesto-token": token})
            _drain_events(client, token)

    assert response.status_code == 202


def test_a_folder_outside_the_home_directory_shows_only_its_last_two_parts(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    elsewhere = tmp_path / "Scratch" / "cache"

    assert _display_folder(elsewhere) == "…/Scratch/cache"


def test_a_short_folder_outside_the_home_directory_still_hides_its_root(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))

    assert _display_folder(Path("/cache")) == "…/cache"
    assert _display_folder(Path("/Volumes/cache")) == "…/cache"


def test_the_state_never_sends_an_absolute_cache_folder(tmp_path, monkeypatch):
    run_dir = _make_run(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    cache_root = tmp_path / "Scratch" / "cache"
    _write_old_manifest(cache_root, run_dir, version=2)
    app, token = _app_for(run_dir, cache_root)

    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})

    assert response.json()["rewrite"]["folder"] == "…/Scratch/cache"
    assert str(tmp_path) not in response.text


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Every file and folder under ``root`` with its size and mtime, so a
    test can prove nothing under it was written, created or touched."""
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
    }


def test_the_state_route_lists_obs_index_and_an_observation_edit_makes_only_it_stale(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    cache_root = tmp_path / "cache"
    before = _snapshot(run_dir)

    runner_module.ingest_run(run_dir, cache_root=cache_root)
    index = load_obs_index(CacheLayout(root=cache_root))

    assert not isinstance(index, ReadFailure), index
    assert _snapshot(run_dir) == before

    app, token = _app_for(run_dir, cache_root)
    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    by_name = {a["name"]: a for a in response.json()["artifacts"]}
    assert by_name["obs_index"]["kind"] == "obs_index"
    assert by_name["obs_index"]["state"] == "ok"
    assert by_name["obs_index"]["stale"] is False
    assert _snapshot(run_dir) == before

    run.obs_data_path.write_text(run.obs_data_path.read_text() + "\n")

    response = _client(app).get("/api/run/ingest/state", headers={"x-pesto-token": token})
    by_name = {a["name"]: a for a in response.json()["artifacts"]}
    assert by_name["obs_index"]["stale"] is True
    assert by_name["grid"]["stale"] is False
