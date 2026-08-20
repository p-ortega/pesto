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
from typing import Any
from unittest import mock

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

import pesto.ingest.runner as runner_module
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import CacheFile, Manifest, SourceFingerprint
from pesto.ingest.discover import discover
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
    assert "par_ens/0" in blocked_names


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
