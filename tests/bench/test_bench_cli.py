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
