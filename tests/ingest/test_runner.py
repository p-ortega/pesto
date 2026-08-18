"""A worker that dies without raising costs its own artifact and nothing
else -- the poisoned-shared-pool regression the M0 reference implementation
never tested (RESEARCH.md Pitfall 1) -- and every way a worker can fail
produces a sentence naming the artifact and what happened.
"""

from __future__ import annotations

import multiprocessing

from pesto.ingest.runner import Progress, _reason_for, _run_isolated, ingest_run

from . import fixtures
from .fixtures import make_run, write_corrupt_ensemble


def _ok_worker(value):
    """A trivial, module-level, picklable worker that just returns its
    argument -- stands in for a healthy artifact alongside a crashing one
    in the poisoned-pool regression below."""
    return value


def _raising_worker(*args):
    """A module-level, picklable worker that raises instead of dying, for
    the raising-worker branch of ``_reason_for``."""
    raise ValueError("bad bytes at offset 4")


# ---------------------------------------------------------------------------
# Task 1: the poisoned-pool regression and the failure-reason vocabulary
# ---------------------------------------------------------------------------


def test_a_crashed_worker_costs_only_its_own_artifact():
    jobs = [
        ("a", _ok_worker, ("a",)),
        ("b", _ok_worker, ("b",)),
        ("c", fixtures.crash_worker, ()),
        ("d", _ok_worker, ("d",)),
    ]
    results = {}
    for name, fn, args in jobs:
        results[name] = _run_isolated(fn, *args)

    assert results["a"] == (True, "a")
    assert results["b"] == (True, "b")
    assert results["c"][0] is False
    assert results["d"] == (True, "d")


def test_crashed_worker_reason_names_the_artifact_and_says_no_result():
    ok, exc = _run_isolated(fixtures.crash_worker)
    assert ok is False

    reason = _reason_for("par_ens/2", "case.2.par.jcb", exc)

    assert "par_ens/2" in reason
    assert "exited without returning" in reason
    assert reason != repr(exc)


def test_signal_killed_worker_reason_names_the_signal():
    ok, exc = _run_isolated(fixtures.signal_worker)
    assert ok is False

    reason = _reason_for("par_ens/0", "case.0.par.jcb", exc)

    assert "signal" in reason.lower()
    assert "9" in reason
    assert "par_ens/0" in reason


def test_signal_and_crash_reasons_differ_in_wording():
    _, signal_exc = _run_isolated(fixtures.signal_worker)
    _, crash_exc = _run_isolated(fixtures.crash_worker)

    signal_reason = _reason_for("par_ens/0", "case.0.par.jcb", signal_exc)
    crash_reason = _reason_for("par_ens/0", "case.0.par.jcb", crash_exc)

    assert signal_reason != crash_reason
    assert "signal" in signal_reason.lower()
    assert "signal" not in crash_reason.lower()


def test_raising_worker_reason_names_artifact_file_and_message():
    ok, exc = _run_isolated(_raising_worker)
    assert ok is False

    reason = _reason_for("par_ens/1", "case.1.par.jcb", exc)

    assert "par_ens/1" in reason
    assert "case.1.par.jcb" in reason
    assert "bad bytes at offset 4" in reason
    assert reason != repr(exc)


def test_run_isolated_pool_does_not_outlive_the_call():
    ok, result = _run_isolated(_ok_worker, "x")

    assert ok is True
    assert result == "x"
    assert multiprocessing.active_children() == []


def test_every_corrupt_ensemble_kind_fails_to_read(tmp_path):
    from pesto.ingest.ensfile import read_ensemble
    from pesto.ingest.failures import ReadFailure

    for kind in ("truncated_header", "garbage", "header_lies", "empty"):
        path = write_corrupt_ensemble(tmp_path / f"corrupt_{kind}.jcb", kind)
        result = read_ensemble(path)
        assert isinstance(result, ReadFailure), kind


def test_ingest_run_with_every_ensemble_file_corrupt_has_no_ok_artifacts(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0, 1))
    for path in run.par_ens.values():
        write_corrupt_ensemble(path, "truncated_header")

    manifest = ingest_run(run_dir, cache_root=cache_root)

    par_states = {
        name: artifact.state
        for name, artifact in manifest.artifacts.items()
        if name.startswith("par_ens/")
    }
    assert par_states == {"par_ens/0": "failed", "par_ens/1": "failed"}
    for artifact in manifest.artifacts.values():
        assert artifact.state != "ok"
