"""Only a first argument of exactly `bench` runs the measuring command; every
other way of starting pesto parses as it always did."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from pesto.cli import main


@pytest.fixture
def served(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    calls: list[dict] = []
    monkeypatch.setattr("pesto.launch.serve", lambda **kwargs: calls.append(kwargs))
    return calls


def test_bench_help_exits_zero_and_names_the_command(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as stop:
        main(["bench", "--help"])
    assert stop.value.code == 0
    out = capsys.readouterr().out
    assert "pesto bench" in out
    assert "--cache-dir" in out
    assert "--json" in out


def test_pesto_help_points_to_the_bench_command(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as stop:
        main(["--help"])
    assert stop.value.code == 0
    out = capsys.readouterr().out
    assert "pesto bench" in out
    assert "./bench" in out


def test_a_run_path_still_goes_to_serve(tmp_path: Path, served: list[dict]) -> None:
    assert main([str(tmp_path)]) == 0
    assert served[0]["run_dir"] == tmp_path


def test_no_browser_alone_still_goes_to_serve(served: list[dict]) -> None:
    assert main(["--no-browser"]) == 0
    assert served[0]["open_browser"] is False
    assert served[0]["run_dir"] is None


def test_a_run_folder_named_bench_is_opened_when_written_with_a_dot_slash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, served: list[dict]
) -> None:
    (tmp_path / "bench").mkdir()
    monkeypatch.chdir(tmp_path)
    assert main(["./bench"]) == 0
    assert served[0]["run_dir"] == Path("./bench")


def test_importing_pesto_cli_does_not_import_the_bench_package() -> None:
    code = "import sys\nimport pesto.cli\nprint('pesto.bench' in sys.modules)\n"
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=30, check=True
    )
    assert result.stdout.strip() == "False"
