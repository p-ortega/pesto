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
