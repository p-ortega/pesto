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
    for key in ("reopen_seconds", "slider_fetch_p95_ms", "slider_no_fetch_p95_ms"):
        assert _number(limits[key])
        assert limits[key] == expected[key]


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
    assert body["observations"]["ingest"] != "not implemented in M0"
    assert body["observations"]["ingest"]
    assert body["cold_read"]["label"] in ("cold", "not proven cold", "not measured")
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
