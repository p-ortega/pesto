"""`pesto bench` end to end on a small synthetic run, and what it refuses or survives."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from ingest.fixtures import make_run

from pesto.bench.limits import speed_limits_dict


def snapshot(folder: Path) -> dict[str, tuple[bool, int, int]]:
    """Every path under the folder with its size and modified time, folders included."""
    state = {}
    for path in sorted(folder.rglob("*")):
        stat = path.stat()
        state[str(path.relative_to(folder))] = (path.is_dir(), stat.st_size, stat.st_mtime_ns)
    root = folder.stat()
    state["."] = (True, root.st_size, root.st_mtime_ns)
    return state


@pytest.mark.slow
def test_pesto_bench_end_to_end_on_a_small_run(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    make_run(run_dir, n_real=4, n_par=20)
    before = snapshot(run_dir)

    script = Path(sys.executable).with_name("pesto")
    result_path = tmp_path / "out" / "result.json"
    done = subprocess.run(
        [
            str(script),
            "bench",
            str(run_dir),
            "--cache-dir",
            str(tmp_path / "scratch"),
            "--json",
            str(result_path),
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )

    assert done.returncode == 0, done.stderr
    body = json.loads(result_path.read_text())
    assert [i["label"] for i in body["ingests"]] == ["as found", "warm (straight after)"]
    assert body["cache"]["warm_dir"].endswith("ingest-2")
    assert body["speed_limits"] == speed_limits_dict()
    assert "Speed limit" in done.stdout
    assert "token" not in done.stdout.lower()
    assert snapshot(run_dir) == before


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    folder = tmp_path / "run"
    folder.mkdir()
    make_run(folder)
    (folder / "sub").mkdir()
    return folder


@pytest.fixture
def ingest_calls(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """A stand-in ingest that drops a marker in its cache folder and records each call."""
    calls: list[Path] = []

    def fake(run, cache_root=None, on_progress=None):
        calls.append(Path(cache_root))
        (Path(cache_root) / "marker.txt").write_text("partial")

    monkeypatch.setattr("pesto.bench.cli.ingest_run", fake)
    return calls


def bench(run: Path, cache: Path, out: Path) -> int:
    from pesto.bench.cli import main

    return main([str(run), "--cache-dir", str(cache), "--json", str(out)])


def test_bench_refuses_a_cache_dir_equal_to_the_run(
    run_dir: Path, tmp_path: Path, ingest_calls: list[Path], capsys: pytest.CaptureFixture[str]
) -> None:
    before = snapshot(run_dir)
    assert bench(run_dir, run_dir, tmp_path / "out.json") == 2
    assert "inside the run folder" in capsys.readouterr().err
    assert ingest_calls == []
    assert snapshot(run_dir) == before


def test_bench_refuses_a_cache_dir_inside_the_run(
    run_dir: Path, tmp_path: Path, ingest_calls: list[Path], capsys: pytest.CaptureFixture[str]
) -> None:
    before = snapshot(run_dir)
    assert bench(run_dir, run_dir / "sub" / "scratch", tmp_path / "out.json") == 2
    assert "inside the run folder" in capsys.readouterr().err
    assert snapshot(run_dir) == before


def test_bench_refuses_a_json_inside_the_run(
    run_dir: Path, tmp_path: Path, ingest_calls: list[Path], capsys: pytest.CaptureFixture[str]
) -> None:
    before = snapshot(run_dir)
    assert bench(run_dir, tmp_path / "scratch", run_dir / "sub" / "out.json") == 2
    assert "--json is inside the run folder" in capsys.readouterr().err
    assert not (tmp_path / "scratch").exists()
    assert snapshot(run_dir) == before


def test_bench_refuses_a_cache_dir_that_is_a_symlink_into_the_run(
    run_dir: Path, tmp_path: Path, ingest_calls: list[Path], capsys: pytest.CaptureFixture[str]
) -> None:
    link = tmp_path / "elsewhere"
    link.symlink_to(run_dir / "sub")
    before = snapshot(run_dir)
    assert bench(run_dir, link, tmp_path / "out.json") == 2
    assert "inside the run folder" in capsys.readouterr().err
    assert ingest_calls == []
    assert snapshot(run_dir) == before


def test_bench_refuses_an_existing_ingest_1_and_deletes_nothing(
    run_dir: Path, tmp_path: Path, ingest_calls: list[Path], capsys: pytest.CaptureFixture[str]
) -> None:
    cache = tmp_path / "scratch"
    (cache / "ingest-1").mkdir(parents=True)
    (cache / "ingest-1" / "earlier.txt").write_text("earlier measurement")
    assert bench(run_dir, cache, tmp_path / "out.json") == 2
    assert "ingest-1" in capsys.readouterr().err
    assert (cache / "ingest-1" / "earlier.txt").read_text() == "earlier measurement"
    assert not (cache / "ingest-2").exists()
    assert ingest_calls == []


def test_bench_refuses_an_existing_ingest_2(
    run_dir: Path, tmp_path: Path, ingest_calls: list[Path], capsys: pytest.CaptureFixture[str]
) -> None:
    cache = tmp_path / "scratch"
    (cache / "ingest-2").mkdir(parents=True)
    assert bench(run_dir, cache, tmp_path / "out.json") == 2
    assert "ingest-2" in capsys.readouterr().err
    assert not (cache / "ingest-1").exists()


def test_bench_refuses_an_existing_json_file_and_leaves_it_as_it_was(
    run_dir: Path, tmp_path: Path, ingest_calls: list[Path], capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "out.json"
    out.write_text("earlier result")
    assert bench(run_dir, tmp_path / "scratch", out) == 2
    assert "already exists" in capsys.readouterr().err
    assert out.read_text() == "earlier result"
    assert not (tmp_path / "scratch").exists()


def test_bench_refuses_a_run_path_that_is_not_a_directory(
    tmp_path: Path, ingest_calls: list[Path], capsys: pytest.CaptureFixture[str]
) -> None:
    assert bench(tmp_path / "missing", tmp_path / "scratch", tmp_path / "out.json") == 2
    assert "not a directory" in capsys.readouterr().err
    assert not (tmp_path / "scratch").exists()


def test_an_interrupted_bench_writes_no_result_and_keeps_what_it_made(
    run_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[Path] = []

    def fake(run, cache_root=None, on_progress=None):
        calls.append(Path(cache_root))
        if len(calls) == 2:
            raise KeyboardInterrupt
        (Path(cache_root) / "marker.txt").write_text("partial")

    monkeypatch.setattr("pesto.bench.cli.ingest_run", fake)
    cache = tmp_path / "scratch"
    out = tmp_path / "out.json"
    before = snapshot(run_dir)

    assert bench(run_dir, cache, out) == 130

    err = capsys.readouterr().err
    assert "no result written" in err
    assert str(cache.resolve()) in err
    assert not out.exists()
    assert (cache / "ingest-1" / "marker.txt").read_text() == "partial"
    assert snapshot(run_dir) == before
    # A rerun into the same folder is refused rather than reusing it.
    assert bench(run_dir, cache, out) == 2


def test_a_bench_that_could_not_finish_names_the_error_and_writes_no_result(
    run_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def fake(run, cache_root=None, on_progress=None):
        raise RuntimeError("the disk went away")

    monkeypatch.setattr("pesto.bench.cli.ingest_run", fake)
    out = tmp_path / "out.json"
    assert bench(run_dir, tmp_path / "scratch", out) == 1
    assert "could not finish: the disk went away" in capsys.readouterr().err
    assert not out.exists()


def test_a_failing_server_stage_still_writes_the_ingest_numbers_and_exits_1(
    run_dir: Path, tmp_path: Path, ingest_calls: list[Path], monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Quiet:
        started_seconds = 0.0

        def __init__(self, *_args: object) -> None: ...
        def __enter__(self) -> "Quiet":
            return self
        def __exit__(self, *_exc: object) -> None: ...

    def boom(_server: object) -> None:
        raise KeyError("group")

    monkeypatch.setattr("pesto.bench.cli.BenchServer", Quiet)
    monkeypatch.setattr("pesto.bench.cli.measure_reopen_share", boom)
    out = tmp_path / "out.json"

    assert bench(run_dir, tmp_path / "scratch", out) == 1

    err = capsys.readouterr().err
    assert "could not finish" in err and "server stage failed" in err
    body = json.loads(out.read_text())
    assert len(body["ingests"]) == 2
    assert body["server"] is None and body["browser_targets"] is None
    assert "KeyError" in body["server_failure"]
    rows = {item["speed_limit"]: item for item in body["verdicts"]}
    for name in ("grid/values p95, realization", "grid/values p95, statistic"):
        assert rows[name]["status"] == "not measured"
        assert "server stage failed" in rows[name]["note"]
    assert any("server stage failed" in note for note in body["notes"])


def _log_run(monkeypatch: pytest.MonkeyPatch, events: list[str], *, ratio: float | None = None):
    """Log the ingests and the read steps in one list; ratio feeds the cold read a fake read pass."""
    from pesto.bench import cli

    real_cold, real_floor = cli.cold_read, cli.read_floor_for
    seen: list[list[Path]] = []

    def cold_spy(files, **kwargs):
        events.append("cold_read")
        seen.append(list(files))
        if ratio is None:
            return real_cold(files, **kwargs)
        pace = lambda _files, which: (1_000_000, 1.0 / ratio if which == "first" else 1.0, "fake pass")
        return real_cold(files, read_pass=pace, **kwargs)

    def floor_spy(run, cache):
        events.append("read_floor")
        return real_floor(run, cache)

    def fake(run, cache_root=None, on_progress=None):
        events.append(f"ingest {Path(cache_root).name}")

    monkeypatch.setattr("pesto.bench.cli.cold_read", cold_spy)
    monkeypatch.setattr("pesto.bench.cli.read_floor_for", floor_spy)
    monkeypatch.setattr("pesto.bench.cli.ingest_run", fake)
    return seen


def test_the_as_found_ingest_is_the_first_call_and_the_read_pass_comes_after_both_ingests(
    run_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pesto.bench import cli
    from pesto.bench.measure import source_paths

    events: list[str] = []
    seen = _log_run(monkeypatch, events)
    result = cli.run_bench(run_dir, tmp_path / "scratch", tmp_path / "out.json", measure_server=False)

    assert events == ["ingest ingest-1", "ingest ingest-2", "cold_read", "read_floor"]
    assert seen[0] == source_paths(run_dir.resolve(), tmp_path.resolve() / "scratch" / "ingest-2")
    assert result.cold_read is not None and result.cold_read.bytes > 0


def test_the_as_found_ingest_says_it_is_the_first_read_and_leaves_sudo_purge_to_the_user(
    run_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pesto.bench import cli

    _log_run(monkeypatch, [])
    result = cli.run_bench(run_dir, tmp_path / "scratch", tmp_path / "out.json", measure_server=False)

    first = " ".join(result.ingests[0].notes)
    assert "the first read of the run's files in this bench" in first
    assert "cold only if nothing had them in memory before" in first
    assert "sudo purge in your own terminal" in first and "pesto never runs it" in first
    assert "just before this ingest" not in first
    assert "first read" not in " ".join(result.ingests[1].notes)


def test_the_cold_read_after_the_ingests_is_never_labelled_cold(
    run_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pesto.bench import cli
    from pesto.bench.report import result_to_dict

    _log_run(monkeypatch, [], ratio=0.3)
    result = cli.run_bench(run_dir, tmp_path / "scratch", tmp_path / "out.json", measure_server=False)

    body = json.loads(json.dumps(result_to_dict(result)))["cold_read"]
    assert body["ratio"] == pytest.approx(0.3)
    assert body["label"] != "cold" and body["proven_cold"] is False
    assert body["note"].startswith("this read ran after both ingests, so its files were likely in memory")


def test_bench_leaves_the_run_folder_as_it_was_with_the_cold_read(
    run_dir: Path, tmp_path: Path, ingest_calls: list[Path]
) -> None:
    from pesto.bench.cli import run_bench

    before = snapshot(run_dir)
    result = run_bench(run_dir, tmp_path / "scratch", tmp_path / "out.json", measure_server=False)
    assert result.cold_read is not None and result.cold_read.bytes > 0
    assert snapshot(run_dir) == before


def test_a_missing_external_table_is_skipped_and_named_and_both_ingests_still_run(
    run_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pesto.bench import cli
    from pesto.bench.report import result_to_dict

    (run_dir / "case.par_data.csv").unlink()
    events: list[str] = []
    _log_run(monkeypatch, events)
    before = snapshot(run_dir)
    result = cli.run_bench(run_dir, tmp_path / "scratch", tmp_path / "out.json", measure_server=False)

    assert events[:2] == ["ingest ingest-1", "ingest ingest-2"]
    body = json.loads(json.dumps(result_to_dict(result)))
    assert "case.par_data.csv" in body["cold_read"]["note"]
    assert "case.par_data.csv" in body["read_floor"]["note"]
    assert any("case.par_data.csv" in note for note in body["notes"])
    assert "case.par_data.csv" not in [f["name"] for f in body["cache_size"]["sources"]]
    assert "case.par_data.csv" not in [r["name"] for r in body["source_reads"]]
    assert snapshot(run_dir) == before


def test_the_bench_modules_use_the_public_name_for_the_source_path_helper() -> None:
    root = Path(__file__).resolve().parents[2]
    text = [path.read_text() for folder in ("src/pesto/bench", "tests/bench") for path in (root / folder).glob("*.py")]
    # The old private name, spelled so this file does not match itself.
    assert not any("_source" + "_paths" in body for body in text)
    assert "source_paths," in (root / "src/pesto/bench/cli.py").read_text()
