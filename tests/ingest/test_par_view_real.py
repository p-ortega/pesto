"""The parameter view and the setup facts, checked against the real benchmark runs.

Every test here is slow and runs against whichever benchmark runs are present;
each skips when its folder is absent. Every ingest writes to a cache under
``tmp_path``, and a snapshot of the run folder is compared before and after,
because a run folder is a scientist's finished output and must never be written.

Nothing below asserts what a local folder happens to hold. Each check is a
relationship that holds for any run, and a run that cannot show the
relationship skips with the reason.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.recfile import RecFacts, read_rec
from pesto.ingest.runopts import ControlOptions, scan_options

pytestmark = pytest.mark.slow

RUN_FIXTURES = ("hm_run", "pl253_run", "forecast_run", "restarted_run")


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


# ---------------------------------------------------------------------------
# reading only: no ingest, so seconds
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_the_run_record_reads_cleanly_and_leaves_the_run_folder_untouched(
    request: pytest.FixtureRequest, run_fixture: str
):
    run_dir = request.getfixturevalue(run_fixture)
    before = _snapshot(run_dir)

    run = discover(run_dir)
    if run.rec is None:
        assert _snapshot(run_dir) == before
        pytest.skip(f"{run_fixture} has no run record (case.rec), so there is nothing to read")
    facts = read_rec(run.rec)

    assert not isinstance(facts, ReadFailure), facts
    assert isinstance(facts, RecFacts)
    assert _snapshot(run_dir) == before, "reading the run record changed the run folder"


@pytest.mark.parametrize("run_fixture", RUN_FIXTURES)
def test_the_control_file_reads_cleanly_to_its_options_and_leaves_the_run_folder_untouched(
    request: pytest.FixtureRequest, run_fixture: str
):
    run_dir = request.getfixturevalue(run_fixture)
    before = _snapshot(run_dir)

    run = discover(run_dir)
    options = scan_options(run.pst_path)

    assert not isinstance(options, ReadFailure), options
    assert isinstance(options, ControlOptions)
    assert _snapshot(run_dir) == before, "reading the control file options changed the run folder"
