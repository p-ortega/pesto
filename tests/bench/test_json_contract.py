"""The JSON keys the browser check reads, pinned on the Python side.

frontend/tests/visual/bench-json.ts reads these paths. If a key here moves,
that reader and its tests must change in the same commit.
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
from pathlib import Path

import pytest
from fixtures.synthetic_run import PP_GROUP, write_synthetic_run

from pesto.bench.cli import main
from pesto.bench.limits import speed_limits_dict
from pesto.ingest.runner import Progress


def _copy_ready_cache(run: Path):
    """A stand-in ingest: copies the fixture's ready-made cache and reports each top-level artifact."""
    ready = run / ".pesto"

    def fake(run_dir, cache_root=None, on_progress=None):
        shutil.copytree(ready, cache_root, dirs_exist_ok=True)
        entries = sorted(ready.iterdir())
        for index, entry in enumerate(entries, start=1):
            size = entry.stat().st_size if entry.is_file() else 1
            for state in ("started", "ok"):
                on_progress(
                    Progress(
                        artifact=entry.name,
                        state=state,
                        index=index,
                        total=len(entries),
                        source_bytes=size,
                        written_bytes=size if state == "ok" else 0,
                        seconds=0.001 if state == "ok" else 0.0,
                    )
                )

    return fake


@pytest.fixture(scope="module")
def bench(tmp_path_factory: pytest.TempPathFactory):
    root = tmp_path_factory.mktemp("contract")
    run = write_synthetic_run(root / "run")
    out = root / "out" / "result.json"
    cache = root / "scratch"

    patcher = pytest.MonkeyPatch()
    patcher.setattr("pesto.bench.cli.ingest_run", _copy_ready_cache(run))
    table = io.StringIO()
    try:
        with contextlib.redirect_stdout(table), contextlib.redirect_stderr(io.StringIO()):
            code = main(
                [str(run), "--cache-dir", str(cache), "--json", str(out), "--values-samples", "20"]
            )
    finally:
        patcher.undo()
    assert code == 0
    return {
        "body": json.loads(out.read_text()),
        "text": out.read_text(),
        "table": table.getvalue(),
        "warm": cache / "ingest-2",
        "run": run,
    }


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def test_run_and_cache_keys(bench) -> None:
    body = bench["body"]
    assert isinstance(body["run"]["path"], str)
    assert isinstance(body["run"]["name"], str) and body["run"]["name"] != ""
    assert isinstance(body["cache"]["warm_dir"], str)
    assert body["cache"]["warm_dir"].endswith("ingest-2")


def test_speed_limit_keys_equal_the_limits_module(bench) -> None:
    limits = bench["body"]["speed_limits"]
    expected = speed_limits_dict()
    for key in ("reopen_seconds", "slider_fetch_p95_ms", "slider_no_fetch_p95_ms", "obs_frame_p95_seconds"):
        assert _number(limits[key])
        assert limits[key] == expected[key]
    assert limits == expected and len(limits) == 10
    assert limits["obs_frame_p95_seconds"] == 0.1


def test_the_obs_frames_block_says_why_when_the_run_has_no_observation_statistics(bench) -> None:
    frames = bench["body"]["server"]["obs_frames"]
    assert frames["summary"] is None
    assert frames["group"] is None and frames["iteration"] is None
    assert frames["notes"] == [
        "obs/frame: this run has no observation statistics, so the frame route is not measured"
    ]
    rows = {row["speed_limit"]: row for row in bench["body"]["verdicts"]}
    row = rows["obs/frame p95"]
    assert row["status"] == "not measured" and row["measured"] is None
    assert row["limit"] == 0.1 and row["note"] == frames["notes"][0]
    assert "obs/frame p95" in bench["table"]


def test_browser_target_keys_and_types(bench) -> None:
    targets = bench["body"]["browser_targets"]
    assert isinstance(targets["iteration"], int) and not isinstance(targets["iteration"], bool)

    heaviest = targets["heaviest"]
    assert isinstance(heaviest["group"], str)
    assert isinstance(heaviest["layer"], int)
    assert isinstance(heaviest["cells"], int)

    pilot = targets["pilot_point"]
    assert pilot["group"] == PP_GROUP
    assert isinstance(pilot["layer"], int)
    assert isinstance(pilot["n_pp"], int)


def test_the_server_and_observation_blocks_are_present(bench) -> None:
    body = bench["body"]
    assert _number(body["server"]["started_seconds"])
    assert len(body["server"]["reopen_share"]["requests"]) >= 10
    assert body["server"]["values"]["realization"]["count"] == 20
    assert body["server"]["values"]["statistic"]["count"] == 20
    assert "not implemented" not in body["observations"]["ingest"]
    assert body["observations"]["ingest"]
    assert "cold_read" not in body and body["schema_version"] == 2
    block = body["as_found_cache"]
    assert block["label"] in ("cold", "not cold", "not measured")
    assert _number(block["source_bytes"]) and block["source_bytes"] > 0
    if block["label"] != "not measured":
        assert _number(block["resident_bytes"]) and _number(block["resident_fraction"])
    assert isinstance(block["files"], int) and isinstance(block["missing"], list)
    assert isinstance(block["largest_resident"], list)
    assert isinstance(block["method"], str) and "sudo purge" in block["note"]
    for ingest in body["ingests"]:
        assert "read_mb_per_second" in ingest
    rows = {row["speed_limit"]: row for row in body["verdicts"]}
    assert rows["grid/values p95, realization"]["status"] in ("pass", "miss")
    assert rows["grid/values p95, statistic"]["status"] in ("pass", "miss")


def test_bench_does_not_warm_the_pilot_point_memo(bench) -> None:
    assert not (bench["warm"] / "grid" / "pp" / "fields").exists()
    assert list(bench["warm"].rglob("fields")) == []


def test_a_field_request_would_leave_a_memo_so_the_check_above_means_something(
    tmp_path: Path,
) -> None:
    from pesto.bench.serve import BenchServer

    run = write_synthetic_run(tmp_path / "run")
    cache = tmp_path / "cache"
    shutil.copytree(run / ".pesto", cache)
    with BenchServer(cache, run) as server:
        timed, _body = server.get(
            f"/api/run/grid/field?iteration=0&group={PP_GROUP}&realization=base"
        )
    assert timed.status == 200
    assert list(cache.rglob("fields")) != []


def test_neither_the_json_nor_the_table_holds_a_token_or_a_url(bench) -> None:
    for text in (bench["text"], bench["table"]):
        assert "token" not in text.lower()
        assert "http://127.0.0.1" not in text


def test_the_section_block_is_recorded_with_no_verdict(bench) -> None:
    section = bench["body"]["server"]["section"]
    assert set(section) == {"n_pieces", "nlay", "quads", "summary", "notes"}
    assert section["summary"] is not None and section["summary"]["count"] == 20
    assert section["notes"] == []
    assert section["quads"] == section["n_pieces"] * section["nlay"]
    verdicts = bench["body"]["verdicts"]
    assert not any("section" in row["speed_limit"] for row in verdicts)
    # The four rows there were before the section was timed; it adds none.
    assert [row["speed_limit"] for row in verdicts] == [
        "cache_ratio",
        "grid/values p95, realization",
        "grid/values p95, statistic",
        "obs/frame p95",
    ]
    assert bench["body"]["speed_limits"] == speed_limits_dict()
    assert any(line.startswith("grid/section") for line in bench["table"].splitlines())
