"""A worker that dies without raising costs its own artifact and nothing
else -- the poisoned-shared-pool regression the M0 reference implementation
never tested (RESEARCH.md Pitfall 1) -- and every way a worker can fail
produces a sentence naming the artifact and what happened.

Also covers the retry rule for a failed artifact (a failed artifact stays
failed until its source changes) and the guard against two artifacts ever
writing to the same output path.
"""

from __future__ import annotations

import json
import multiprocessing

import numpy as np

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.runner import Progress, _reason_for, _run_isolated, _should_retry, ingest_run

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


def _load_stored(layout: CacheLayout, iteration: int) -> dict:
    """Read a written ``par_ens`` artifact back the way a real reader
    would -- through the sidecar and the two-block payload -- rather than
    checking that a path merely exists."""
    sidecar = json.loads((layout.ens / f"par_{iteration}.json").read_text())
    raw = layout.par_ens(iteration).read_bytes()
    blocks = {}
    for block in sidecar["blocks"]:
        n_real, n_par = block["shape"]
        count = n_real * n_par
        arr = np.frombuffer(raw, dtype="<f4", count=count, offset=block["offset_bytes"])
        blocks[block["name"]] = arr.reshape(block["shape"])
    par_names = (layout.ens / f"par_{iteration}.parnames.txt").read_text().splitlines()
    return {
        "sidecar": sidecar,
        "blocks": blocks,
        "par_names": par_names,
        "real_names": sidecar["real_names"],
    }


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


# ---------------------------------------------------------------------------
# Task 2: a malformed file end to end, and the retry rule
# ---------------------------------------------------------------------------


def test_one_corrupt_iteration_fails_alone_and_the_healthy_one_reads_back(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0, 1))
    write_corrupt_ensemble(run.par_ens[1], "truncated_header")

    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert manifest.artifacts["par_ens/0"].state == "ok"
    assert manifest.artifacts["par_ens/1"].state == "failed"
    assert run.par_ens[1].name in manifest.artifacts["par_ens/1"].reason

    layout = CacheLayout(root=cache_root)
    stored = _load_stored(layout, 0)
    assert stored["real_names"] == run.real_names
    assert stored["par_names"] == run.par_names
    n_real = len(run.real_names)
    n_par = len(run.par_names)
    total_values = sum(block.size for block in stored["blocks"].values())
    assert total_values == n_real * n_par


def test_rerunning_with_nothing_changed_skips_the_failed_artifact(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0, 1))
    write_corrupt_ensemble(run.par_ens[1], "truncated_header")

    ingest_run(run_dir, cache_root=cache_root)

    first_manifest = Manifest.load(CacheLayout(root=cache_root))
    original_reason = first_manifest.artifacts["par_ens/1"].reason

    rows: list[Progress] = []
    manifest = ingest_run(run_dir, cache_root=cache_root, on_progress=rows.append)

    assert manifest.artifacts["par_ens/1"].state == "failed"
    assert manifest.artifacts["par_ens/1"].reason == original_reason

    skipped = [r for r in rows if r.artifact == "par_ens/1"]
    assert len(skipped) == 1
    assert skipped[0].state == "skipped"
    assert skipped[0].reason == original_reason
    assert skipped[0].seconds == 0.0


def test_should_retry_declines_only_an_unchanged_failed_artifact(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0, 1))
    write_corrupt_ensemble(run.par_ens[1], "truncated_header")

    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert _should_retry(manifest, "par_ens/1", run_dir) is False
    assert _should_retry(manifest, "par_ens/0", run_dir) is True
    assert _should_retry(manifest, "par_ens/999", run_dir) is True


def test_replacing_the_corrupt_file_with_a_readable_one_reingests_to_ok(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0, 1))
    write_corrupt_ensemble(run.par_ens[1], "truncated_header")
    ingest_run(run_dir, cache_root=cache_root)

    values = fixtures.sample_values(len(run.real_names), len(run.par_names), seed=42)
    fixtures.write_jcb_ensemble(run.par_ens[1], values, run.real_names, run.par_names)

    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert manifest.artifacts["par_ens/1"].state == "ok"


def test_replacing_the_corrupt_file_with_a_different_corrupt_file_gets_a_fresh_failure(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0, 1))
    write_corrupt_ensemble(run.par_ens[1], "truncated_header")
    first_manifest = ingest_run(run_dir, cache_root=cache_root)
    first_reason = first_manifest.artifacts["par_ens/1"].reason

    write_corrupt_ensemble(run.par_ens[1], "header_lies")

    second_manifest = ingest_run(run_dir, cache_root=cache_root)

    assert second_manifest.artifacts["par_ens/1"].state == "failed"
    assert second_manifest.artifacts["par_ens/1"].reason != first_reason


def test_two_artifacts_never_write_to_the_same_path(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    make_run(run_dir, iterations=(0,))

    manifest = ingest_run(run_dir, cache_root=cache_root, iterations=[0, 0])

    artifact = manifest.artifacts["par_ens/0"]
    assert artifact.state == "failed"
    assert "par_ens/0" in artifact.reason
    assert "same output path" in artifact.reason


def test_progress_row_order_is_identical_across_two_runs(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    make_run(run_dir, iterations=(0, 1))

    first_rows: list[Progress] = []
    ingest_run(run_dir, cache_root=cache_root, on_progress=first_rows.append)

    second_rows: list[Progress] = []
    ingest_run(run_dir, cache_root=cache_root, on_progress=second_rows.append)

    first_names = [r.artifact for r in first_rows]
    second_names = [r.artifact for r in second_rows]
    assert first_names == second_names
