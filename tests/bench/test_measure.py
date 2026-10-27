"""The measuring functions behind `pesto bench`, with a fake ingest standing in
for the real one so nothing here costs a worker process."""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import replace
from pathlib import Path

import pytest
from ingest.fixtures import make_run
from ingest.obs_fixtures import make_obs_run

from pesto.bench import measure
from pesto.bench.measure import (
    COLD_RESIDENT_LIMIT,
    cache_size,
    page_residency,
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
from pesto.cache.manifest import SourceFingerprint
from pesto.ingest import runner
from pesto.ingest.runner import Progress, ingest_run


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


def test_the_table_ends_by_naming_where_cell_picking_is_measured_and_its_limits() -> None:
    lines = format_table(_result_with_wall(0.5)).splitlines()
    assert lines[-2] == (
        "Reopen and slider delay are measured by the browser check, "
        "and ingest growth by tests/perf."
    )
    assert lines[-1] == (
        "Cell picking is measured by frontend/tests/picking-scale.test.ts: "
        "index build at or under 1000 ms, warm pick p95 at or under 1 ms."
    )


def test_the_json_carries_the_two_pick_limits() -> None:
    limits = result_to_dict(_result_with_wall(0.5))["speed_limits"]
    assert limits["pick_index_build_ms"] == 1000.0
    assert limits["pick_p95_ms"] == 1.0


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


def test_source_reads_count_an_observation_file_for_the_artifact_that_reads_it(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    reads = {r.name: r for r in source_reads(run_dir, tmp_path / "cache")}
    # obs_ens/0 reads the file; obs_agg/0 needs obs_ens/0 and reads the cache.
    assert reads["case.0.obs.jcb"].reads_implied == 2
    assert reads["case.1.obs.jcb"].reads_implied == 2
    # A parameter ensemble is still named by two artifacts that each read it.
    assert reads["case.0.par.jcb"].reads_implied == 4
    assert "reads the cache" in measure.source_reads_note()


def test_source_reads_count_the_obs_noise_file_for_noise_agg_alone(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True)
    reads = {r.name: r for r in source_reads(run_dir, tmp_path / "cache")}
    # obs_agg builds on noise_agg and config reuses its checksum, so neither reads the file again.
    assert reads["case.obs+noise.jcb"].reads_implied == 2
    assert reads["case.0.par.jcb"].reads_implied == 4
    assert reads["case.1.par.jcb"].reads_implied == 4


def _run_in_process(fn, *args):
    try:
        return True, fn(*args)
    except Exception as exc:
        return False, exc


def test_source_reads_agree_with_the_checksums_a_real_ingest_takes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True)
    cache_dir = tmp_path / "cache"
    hashed: list[str] = []
    real = SourceFingerprint.of

    def _counting(path: Path) -> SourceFingerprint:
        hashed.append(path.name)
        return real(path)

    monkeypatch.setattr(SourceFingerprint, "of", staticmethod(_counting))
    # Workers run in this process here, so the real ingest stays quick.
    monkeypatch.setattr(runner, "_run_isolated", _run_in_process)

    ingest_run(run_dir, cache_root=cache_dir)

    reads = {r.name: r.reads_implied for r in source_reads(run_dir, cache_dir)}
    assert reads
    # Each implied read is a worker read plus a checksum read, so the checksums are half.
    for name, implied in reads.items():
        assert hashed.count(name) == implied // 2, name


def test_source_reads_count_a_file_control_lists_for_control_alone(tmp_path: Path) -> None:
    run_dir = _small_run(tmp_path)
    reads = {r.name: r for r in source_reads(run_dir, tmp_path / "cache")}
    # Every other artifact takes these from the cached control table and
    # control's recorded checksum, so only control reads them.
    assert (run_dir / "case.par_data.csv").exists()
    assert reads["case.par_data.csv"].reads_implied == 2
    assert reads["case.pst"].reads_implied == 2
    assert reads["case.0.par.jcb"].reads_implied == 4


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


def test_read_floor_and_the_page_check_skip_a_missing_path_and_name_it(tmp_path: Path) -> None:
    real = tmp_path / "real.bin"
    real.write_bytes(b"x" * 1000)
    gone = tmp_path / "gone.bin"
    floor = read_floor([gone, real])
    assert floor.bytes == 1000
    assert "1 planned source file(s) were not found and were skipped: gone.bin" in floor.note
    cache = page_residency([gone, real], probe=lambda path: 0)
    assert cache.source_bytes == 1000 and cache.files == 1
    assert cache.missing == ["gone.bin"]
    assert "gone.bin" in cache.note


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


def snapshot(folder: Path) -> dict[str, tuple[bool, int, int]]:
    state = {}
    for path in sorted(folder.rglob("*")):
        stat = path.stat()
        state[str(path.relative_to(folder))] = (path.is_dir(), stat.st_size, stat.st_mtime_ns)
    return state


def _file(tmp_path: Path, name: str = "a") -> Path:
    path = tmp_path / name
    path.write_bytes(b"x" * 10)
    return path


def test_the_bench_code_never_calls_another_program() -> None:
    import re

    source_dir = Path(measure.__file__).parent
    found = [
        path.name
        for path in source_dir.glob("*.py")
        if re.search(r"subprocess|os\.system|Popen", path.read_text())
    ]
    assert found == []


def _sized_row(artifact: str, state: str, seconds: float, source_bytes: int) -> Progress:
    return Progress(
        artifact=artifact,
        state=state,
        index=0,
        total=3,
        source_bytes=source_bytes,
        written_bytes=0,
        seconds=seconds,
    )


def _obs_run_rows(started_ok: list[str], blocked: list[str]) -> list[Progress]:
    rows: list[Progress] = []
    for name in started_ok:
        rows += [_sized_row(name, "started", 0.0, 1), _sized_row(name, "ok", 1.0, 1)]
    # A row blocked by a failed dependency is "failed" with no "started" row before it.
    rows += [_sized_row(name, "failed", 1.0, 1) for name in blocked]
    return rows


def test_the_read_figure_counts_each_source_file_once_for_artifacts_that_started(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    cache = tmp_path / "cache"
    # The control file and its tables are listed by many artifacts, the grid file by several,
    # case.0.obs.jcb by obs_ens/0 and obs_agg/0 (which reads the cache), and par_ens/1 never started.
    names = ["control", "grid", "par_ens/0", "obs_ens/0", "obs_agg/0"]
    rows = _obs_run_rows(names, blocked=["par_ens/1"])
    timing = time_ingest(run_dir, cache, "as found", _fake_ingest(rows))

    read = [
        "case.pst", "case.pargp_data.csv", "case.par_data.csv", "case.obs_data.csv",
        "case.tplfile_data.csv", "case.insfile_data.csv", "coarse.disv.grb",
        "case.0.par.jcb", "case.0.obs.jcb",
    ]
    total = sum(os.stat(run_dir / name).st_size for name in read)
    assert timing.read_mb_per_second == pytest.approx(total / 1e6 / 6.0)


def test_an_artifact_that_only_reads_the_cache_adds_no_bytes(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    cache = tmp_path / "cache"
    with_agg = time_ingest(
        run_dir, cache, "a", _fake_ingest(_obs_run_rows(["control", "obs_ens/0", "obs_agg/0"], []))
    )
    without = time_ingest(
        run_dir, cache, "a", _fake_ingest(_obs_run_rows(["control", "obs_ens/0"], []))
    )
    # One more worker second for obs_agg/0 and not one more byte.
    assert with_agg.read_mb_per_second == pytest.approx(without.read_mb_per_second * 2 / 3)


def test_a_missing_source_file_is_left_out_of_the_read_figure_and_named(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    (run_dir / "case.par_data.csv").unlink()
    rows = _obs_run_rows(["control"], [])
    timing = time_ingest(run_dir, tmp_path / "cache", "as found", _fake_ingest(rows))
    kept = ["case.pst", "case.pargp_data.csv", "case.obs_data.csv", "case.tplfile_data.csv", "case.insfile_data.csv"]
    assert timing.read_mb_per_second == pytest.approx(sum(os.stat(run_dir / n).st_size for n in kept) / 1e6 / 1.0)
    assert any("1 planned source file(s) were not found and were skipped: case.par_data.csv" in n for n in timing.notes)


def test_the_read_figure_is_not_measured_and_says_why_when_the_plan_cannot_be_made() -> None:
    rows = [_sized_row("a", "started", 0.0, 1), _sized_row("a", "ok", 1.0, 1)]
    timing = time_ingest(Path("no-such-run"), Path("cache"), "as found", _fake_ingest(rows))
    assert timing.read_mb_per_second is None
    assert any("source read figure is not measured" in n for n in timing.notes)


def test_read_rate_is_none_when_no_worker_ran() -> None:
    rows = [_sized_row("a", "skipped", 0.0, 4_000_000)]
    timing = time_ingest(Path("run"), Path("cache"), "warm", _fake_ingest(rows))
    assert timing.read_mb_per_second is None


def test_the_table_prints_the_read_rate_on_each_ingest_line() -> None:
    result = _result_with_wall(0.5)
    result = replace(result, ingests=[replace(result.ingests[0], read_mb_per_second=1234.0)])
    line = next(x for x in format_table(result).splitlines() if x.startswith("Ingest, as found"))
    assert "source read 1,234 MB/s" in line


def _sized(tmp_path: Path, name: str, size: int) -> Path:
    path = tmp_path / name
    path.write_bytes(b"x" * size)
    return path


def test_a_probe_that_finds_nothing_in_memory_labels_the_files_cold_with_the_amount(tmp_path: Path) -> None:
    files = [_sized(tmp_path, "a.bin", 4000), _sized(tmp_path, "b.bin", 6000)]
    cache = page_residency(files, probe=lambda path: 0)
    assert cache.label == "cold"
    assert (cache.source_bytes, cache.resident_bytes, cache.resident_fraction) == (10000, 0, 0.0)
    assert cache.files == 2 and cache.missing == []
    assert "0.00%" in cache.note and "before the as-found ingest" in cache.note


def test_a_probe_that_finds_pages_in_memory_labels_not_cold_with_the_three_largest(tmp_path: Path) -> None:
    sizes = {"a.bin": 1000, "b.bin": 2000, "c.bin": 3000, "d.bin": 4000, "e.bin": 5000}
    files = [_sized(tmp_path, name, size) for name, size in sizes.items()]
    cache = page_residency(files, probe=lambda path: sizes[path.name] // 2)
    assert cache.label == "not cold"
    assert cache.resident_bytes == 7500 and cache.resident_fraction == pytest.approx(0.5)
    assert [f.name for f in cache.largest_resident] == ["e.bin", "d.bin", "c.bin"]
    assert "50.00%" in cache.note and "e.bin" in cache.note and "b.bin" not in cache.note


def test_every_label_names_sudo_purge_as_the_users_own_step(tmp_path: Path) -> None:
    source = _sized(tmp_path, "a.bin", 100)
    for probe in (lambda path: 0, lambda path: 100):
        note = page_residency([source], probe=probe).note
        assert "sudo purge" in note and "pesto never runs it" in note
    assert "sudo purge" in page_residency([], probe=lambda path: 0).note


def test_the_table_has_one_as_found_cache_line_and_its_note(tmp_path: Path) -> None:
    cache = page_residency([_sized(tmp_path, "a.bin", 3000)], probe=lambda path: 0)
    table = format_table(replace(_result_with_wall(0.5), as_found_cache=cache))
    lines = [line for line in table.splitlines() if "As-found cache:" in line]
    assert len(lines) == 1
    assert "cold" in lines[0] and "0.00%" in lines[0] and cache.method in lines[0]
    assert f"  note: {cache.note}" in table.splitlines()
    assert "Cold read:" not in table


def test_the_limit_is_one_percent_and_exactly_one_percent_is_cold(tmp_path: Path) -> None:
    assert COLD_RESIDENT_LIMIT == 0.01
    source = _sized(tmp_path, "a.bin", 10_000)
    assert page_residency([source], probe=lambda path: 100).label == "cold"
    assert page_residency([source], probe=lambda path: 101).label == "not cold"
    assert page_residency([source], probe=lambda path: 101).resident_fraction == pytest.approx(0.0101)


def test_zero_source_bytes_is_not_measured_with_the_reason(tmp_path: Path) -> None:
    cache = page_residency([], probe=lambda path: pytest.fail("nothing to probe"))
    assert cache.label == "not measured" and cache.source_bytes == 0
    assert cache.resident_bytes is None and cache.resident_fraction is None
    assert "zero bytes" in cache.note


def test_a_missing_file_and_an_empty_file_are_skipped_and_named(tmp_path: Path) -> None:
    real = _sized(tmp_path, "real.bin", 500)
    empty = _sized(tmp_path, "empty.bin", 0)
    probed: list[str] = []

    def probe(path: Path) -> int:
        probed.append(path.name)
        return 0

    cache = page_residency([tmp_path / "gone.bin", empty, real], probe=probe)
    assert probed == ["real.bin"]
    assert cache.files == 1 and cache.source_bytes == 500
    assert cache.missing == ["gone.bin", "empty.bin"]
    assert "gone.bin (not found)" in cache.note and "empty.bin (empty)" in cache.note
    assert cache.label == "cold"


def test_a_probe_that_raises_gives_not_measured_with_the_error_text(tmp_path: Path) -> None:
    def probe(path: Path) -> int:
        raise OSError(5, "input/output error on the archive")

    cache = page_residency([_sized(tmp_path, "a.bin", 100)], probe=probe)
    assert cache.label == "not measured"
    assert cache.resident_bytes is None
    assert "input/output error on the archive" in cache.note
    assert cache.label != "cold"


def test_without_ctypes_or_mincore_the_label_is_not_measured_and_the_method_says_why(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import ctypes
    import ctypes.util
    from types import SimpleNamespace

    source = _sized(tmp_path, "a.bin", 100)
    monkeypatch.setattr(ctypes.util, "find_library", lambda name: None)

    def no_libc(name, *args, **kwargs):
        raise OSError("no C library here")

    monkeypatch.setattr(ctypes, "CDLL", no_libc)
    cache = page_residency([source])
    assert cache.label == "not measured"
    assert "no C library here" in cache.method and "not available" in cache.method

    monkeypatch.setattr(ctypes, "CDLL", lambda name, *args, **kwargs: SimpleNamespace())
    cache = page_residency([source])
    assert cache.label == "not measured" and "no mincore call" in cache.method


@pytest.mark.skipif(
    not sys.platform.startswith(("darwin", "linux")), reason="mincore is checked on macOS and Linux"
)
def test_the_real_page_check_sees_a_file_just_written_and_leaves_it_untouched(tmp_path: Path) -> None:
    source = tmp_path / "fresh.bin"
    source.write_bytes(os.urandom(1_000_000))
    before = (source.read_bytes(), source.stat().st_mtime_ns)
    cache = page_residency([source])
    assert cache.label != "not measured", cache.note
    assert cache.resident_bytes is not None and 0 < cache.resident_bytes <= 1_000_000
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before


def test_the_json_schema_is_version_2() -> None:
    from pesto.bench.report import SCHEMA_VERSION

    assert SCHEMA_VERSION == 2
    assert result_to_dict(_result_with_wall(0.5))["schema_version"] == 2
