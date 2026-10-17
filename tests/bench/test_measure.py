"""The measuring functions behind `pesto bench`, with a fake ingest standing in
for the real one so nothing here costs a worker process."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from ingest.fixtures import make_run

from pesto.bench import measure
from pesto.bench.measure import (
    cache_size,
    machine_facts,
    nearest_rank,
    percentile_summary,
    read_floor,
    run_facts,
    source_files,
    source_reads,
    time_ingest,
)
from pesto.bench.report import (
    BenchResult,
    CacheSize,
    IngestTiming,
    RunFacts,
    format_table,
    result_to_dict,
    verdict,
)
from pesto.ingest.runner import Progress


def _row(artifact: str, state: str, seconds: float = 0.0, index: int = 0) -> Progress:
    return Progress(
        artifact=artifact,
        state=state,
        index=index,
        total=2,
        source_bytes=10,
        written_bytes=5 if state == "ok" else 0,
        seconds=seconds,
    )


def _fake_ingest(rows: list[Progress], pause: float = 0.0):
    def ingest(run_dir, cache_root=None, on_progress=None):
        for row in rows:
            if on_progress is not None:
                on_progress(row)
        time.sleep(pause)

    return ingest


def _small_run(tmp_path: Path) -> Path:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    make_run(run_dir)
    return run_dir


def test_percentile_summary_uses_the_nearest_rank_and_keeps_the_first_sample() -> None:
    summary = percentile_summary([0.010, 0.002, 0.003, 0.004, 0.005])
    assert summary is not None
    assert summary.count == 5
    assert summary.first_seconds == 0.010
    assert summary.p50_seconds == 0.004
    assert summary.p95_seconds == 0.010
    assert summary.max_seconds == 0.010


def test_percentile_summary_of_nothing_is_none() -> None:
    assert percentile_summary([]) is None


def test_nearest_rank_is_the_ceiling_rank_at_the_sizes_that_matter() -> None:
    assert nearest_rank(list(range(1, 21)), 95) == 19
    assert nearest_rank(list(range(1, 301)), 95) == 285
    assert nearest_rank(list(range(1, 301)), 50) == 150
    assert nearest_rank(list(range(1, 6)), 95) == 5


def test_percentile_summary_ranks_the_sorted_samples_whatever_order_they_came_in() -> None:
    summary = percentile_summary([float(n) for n in reversed(range(1, 21))])
    assert summary is not None
    assert summary.first_seconds == 20.0
    assert summary.p50_seconds == 10.0
    assert summary.p95_seconds == 19.0


def test_percentile_summary_of_one_sample_is_that_sample() -> None:
    summary = percentile_summary([7.0])
    assert summary is not None
    assert (summary.p50_seconds, summary.p95_seconds) == (7.0, 7.0)


def test_a_limit_with_nothing_to_measure_is_not_measured_and_never_a_pass() -> None:
    item = verdict("cache_ratio", None, "x", "no source bytes")
    assert item.status == "not measured"
    assert item.note == "no source bytes"
    assert item.measured is None


def test_verdicts_compare_the_unrounded_value() -> None:
    assert verdict("cache_ratio", 1.5000001, "x", "").status == "miss"
    assert verdict("cache_ratio", 1.5, "x", "").status == "pass"


def _result_with_wall(wall: float) -> BenchResult:
    ingest = IngestTiming(
        label="as found",
        cache_dir="c",
        wall_seconds=wall,
        worker_seconds=0.1,
        outside_worker_seconds=wall - 0.1,
        cpu_seconds=None,
        wait_seconds=None,
        artifacts=[],
        notes=[],
    )
    return BenchResult(
        pesto_version="0",
        measured_at="now",
        machine={},
        run=RunFacts("p", "run", [0], [], None, 0, []),
        cache={"parent_dir": "p", "as_found_dir": "a", "warm_dir": "w"},
        ingests=[ingest],
        read_floor=None,
        source_reads=None,
        source_reads_note="",
        cache_size=CacheSize("c", 10, 10, 10, 1.0, []),
        verdicts=[verdict("cache_ratio", 1.0, "x", "")],
    )


def test_the_json_keeps_unrounded_seconds_and_the_table_rounds_them() -> None:
    result = _result_with_wall(0.123456789)
    body = json.loads(json.dumps(result_to_dict(result)))
    assert body["ingests"][0]["wall_seconds"] == 0.123456789
    table = format_table(result)
    assert "0.12 s" in table
    assert "0.123456789" not in table


def test_time_ingest_adds_up_the_workers_own_seconds() -> None:
    rows = [
        _row("par_ens/0", "started", index=0),
        _row("par_ens/0", "ok", 0.010, index=0),
        _row("control", "started", index=1),
        _row("control", "ok", 0.020, index=1),
    ]
    timing = time_ingest(Path("run"), Path("cache"), "as found", _fake_ingest(rows, pause=0.06))
    assert timing.worker_seconds == pytest.approx(0.030)
    assert timing.wall_seconds >= timing.worker_seconds
    assert timing.outside_worker_seconds == pytest.approx(timing.wall_seconds - 0.030)
    assert [a.name for a in timing.artifacts] == ["par_ens/0", "control"]
    assert timing.cpu_seconds is not None
    assert timing.wait_seconds == pytest.approx(timing.wall_seconds - timing.cpu_seconds)
    assert all(isinstance(a.cpu_seconds, float) for a in timing.artifacts)


def test_time_ingest_says_so_when_cpu_time_is_not_available(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(measure, "resource", None)
    rows = [_row("control", "started"), _row("control", "ok", 0.010)]
    timing = time_ingest(Path("run"), Path("cache"), "as found", _fake_ingest(rows))
    assert timing.cpu_seconds is None
    assert timing.wait_seconds is None
    assert all(a.cpu_seconds is None for a in timing.artifacts)
    assert "CPU time is not available on this platform" in timing.notes


def test_time_ingest_notes_artifacts_it_did_not_re_read() -> None:
    rows = [_row("par_ens/0", "skipped"), _row("control", "started"), _row("control", "ok", 0.010)]
    timing = time_ingest(Path("run"), Path("cache"), "warm", _fake_ingest(rows))
    assert "1 artifacts were skipped as fresh, so this ingest did not re-read them" in timing.notes


def test_source_files_lists_each_source_once_with_its_real_size(tmp_path: Path) -> None:
    run_dir = _small_run(tmp_path)
    listed = source_files(run_dir, tmp_path / "cache")
    names = [s.name for s in listed]
    assert len(names) == len(set(names))
    assert "case.pst" in names
    for source in listed:
        assert source.bytes == os.stat(run_dir / source.name).st_size


def test_source_reads_count_a_worker_read_and_a_checksum_read_per_artifact(tmp_path: Path) -> None:
    run_dir = _small_run(tmp_path)
    reads = {r.name: r for r in source_reads(run_dir, tmp_path / "cache")}
    # par_ens and par_agg of one iteration both name its ensemble file.
    assert reads["case.0.par.jcb"].reads_implied == 4
    assert reads["case.0.par.jcb"].bytes == os.stat(run_dir / "case.0.par.jcb").st_size


def test_read_floor_adds_up_the_bytes_and_reports_a_rate(tmp_path: Path) -> None:
    first = tmp_path / "a.bin"
    second = tmp_path / "b.bin"
    first.write_bytes(b"x" * 1000)
    second.write_bytes(b"y" * 2500)
    floor = read_floor([first, second])
    assert floor.bytes == 3500
    assert floor.seconds > 0
    assert floor.mb_per_second is not None and floor.mb_per_second > 0
    assert "3,000 MB/s" in floor.note


def test_machine_facts_name_the_machine_or_say_unknown() -> None:
    facts = machine_facts()
    assert set(facts) == {"platform", "machine", "cpu_count", "memory_bytes", "python"}
    for key in ("platform", "machine", "cpu_count", "python"):
        assert facts[key] not in (None, "")
    assert facts["memory_bytes"] is None or facts["memory_bytes"] > 0


def test_a_run_with_no_observation_ensemble_says_parameters_only(tmp_path: Path) -> None:
    run_dir = _small_run(tmp_path)
    for path in run_dir.glob("*.obs.*"):
        path.unlink()
    facts = run_facts(run_dir)
    assert facts.obs_ensembles == []
    assert "parameters only, observation ensemble not present" in facts.notes


def test_cache_size_divides_bytes_on_disk_by_the_unique_source_bytes(tmp_path: Path) -> None:
    run_dir = _small_run(tmp_path)
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "one.bin").write_bytes(b"z" * 100)
    size = cache_size(run_dir, cache)
    assert size.cache_bytes == 100
    assert size.source_bytes == sum(s.bytes for s in size.sources)
    assert size.ratio == pytest.approx(100 / size.source_bytes)
