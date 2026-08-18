"""A worker that dies without raising costs its own artifact and nothing
else -- the poisoned-shared-pool regression the M0 reference implementation
never tested (RESEARCH.md Pitfall 1) -- and every way a worker can fail
produces a sentence naming the artifact and what happened.

Also covers the retry rule for a failed artifact (a failed artifact stays
failed until its source changes), the guard against two artifacts ever
writing to the same output path, the whole-run artifact plan
(``plan_artifacts``), skipping what is already fresh, the pre-ingest size
estimate (``estimate_bytes``), and the cancel signal.
"""

from __future__ import annotations

import builtins
import json
import multiprocessing
import threading

import numpy as np
import pandas as pd
import pytest

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.cache.runconfig import load_config
from pesto.ingest.discover import discover
from pesto.ingest.ensembles import load_stored
from pesto.ingest.failures import ReadFailure
from pesto.ingest.runner import (
    BytesEstimate,
    PlannedArtifact,
    Progress,
    _reason_for,
    _run_isolated,
    _should_retry,
    estimate_bytes,
    ingest_run,
    plan_artifacts,
)
from pesto.ingest.tables import load_control_tables

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

    # Only the two artifact kinds that read the corrupted ensemble files
    # are affected -- control, grid and config depend on other sources and
    # are free to succeed.
    ensemble_dependent = {
        name: artifact.state
        for name, artifact in manifest.artifacts.items()
        if name.startswith("par_ens/") or name.startswith("par_agg/")
    }
    assert ensemble_dependent == {
        "par_ens/0": "failed",
        "par_ens/1": "failed",
        "par_agg/0": "failed",
        "par_agg/1": "failed",
    }


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

    # The synthetic fixture's grid file is a placeholder flopy cannot parse,
    # so "grid" fails on the first run and is a declined retry (unchanged
    # source) on the second -- one "skipped" row instead of a "started" and
    # a "failed" row. The row *count* legitimately differs for that
    # artifact; the *sequence of distinct artifacts* must not.
    def _distinct_in_order(rows: list[Progress]) -> list[str]:
        seen: list[str] = []
        for row in rows:
            if not seen or seen[-1] != row.artifact:
                seen.append(row.artifact)
        return seen

    assert _distinct_in_order(first_rows) == _distinct_in_order(second_rows)


# ---------------------------------------------------------------------------
# Task 1: the whole list of artifacts, each in its own process
# ---------------------------------------------------------------------------


def test_plan_artifacts_returns_a_deterministic_order_for_a_two_iteration_run(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    make_run(run_dir, iterations=(0, 1))
    run = discover(run_dir)
    layout = CacheLayout(root=tmp_path / "cache")

    first = plan_artifacts(run, layout)
    second = plan_artifacts(run, layout)

    names = [a.name for a in first]
    assert names == [
        "par_ens/0",
        "par_agg/0",
        "par_ens/1",
        "par_agg/1",
        "control",
        "grid",
        "config",
    ]
    assert [a.name for a in second] == names


def test_plan_artifacts_collapses_the_degenerate_noptmax_case(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    make_run(run_dir, noptmax=0, iterations=(0,))
    run = discover(run_dir)
    layout = CacheLayout(root=tmp_path / "cache")

    planned = plan_artifacts(run, layout)

    par_ens_names = [a.name for a in planned if a.kind == "par_ens"]
    par_agg_names = [a.name for a in planned if a.kind == "par_agg"]
    assert par_ens_names == ["par_ens/0"]
    assert par_agg_names == ["par_agg/0"]


def test_plan_artifacts_names_the_source_files_each_artifact_depends_on(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    make_run(run_dir, iterations=(0, 1))
    run = discover(run_dir)
    layout = CacheLayout(root=tmp_path / "cache")

    planned = {a.name: a for a in plan_artifacts(run, layout)}

    assert set(planned["par_ens/0"].sources) == {str(run.par_ens[0]), str(run.pst_path)}
    assert set(planned["par_agg/0"].sources) == {str(run.par_ens[0]), str(run.pst_path)}
    assert planned["control"].sources == (str(run.pst_path),)
    assert planned["grid"].sources == (str(run.grid),)
    assert set(planned["config"].sources) == {str(run.pst_path), str(run.grid)}


def test_plan_artifacts_with_no_grid_file_plans_no_grid_artifact(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    run_result = make_run(run_dir, iterations=(0,))
    run_result.grid_path.unlink()
    run = discover(run_dir)
    layout = CacheLayout(root=tmp_path / "cache")

    planned = plan_artifacts(run, layout)

    names = [a.name for a in planned]
    assert "grid" not in names
    config = next(a for a in planned if a.name == "config")
    assert config.sources == (str(run.pst_path),)


def test_ingest_run_writes_every_artifact_kind_and_each_reads_back_through_its_own_reader(
    tmp_path,
):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0, 1))

    manifest = ingest_run(run_dir, cache_root=cache_root)

    # The synthetic fixture's grid file is a placeholder, not a real .grb --
    # flopy cannot parse it, so "grid" is the one artifact expected to fail
    # here. Every other kind is independent of the grid file and must
    # succeed.
    for name, artifact in manifest.artifacts.items():
        if name == "grid":
            continue
        assert artifact.state == "ok", (name, artifact.reason)
    assert manifest.artifacts["grid"].state == "failed"

    layout = CacheLayout(root=cache_root)

    stored0 = load_stored(0, layout)
    assert not isinstance(stored0, ReadFailure)
    assert stored0.par_names == tuple(run.par_names)

    stored1 = load_stored(1, layout)
    assert not isinstance(stored1, ReadFailure)

    control = load_control_tables(layout)
    assert not isinstance(control, ReadFailure)
    assert list(control.par["parnme"]) == run.par_names

    config = load_config(layout)
    assert config.n_par == len(run.par_names)
    assert config.n_real == len(run.real_names)

    agg0 = pd.read_parquet(layout.par_agg(0))
    assert len(agg0) == len(run.par_names)
    agg1 = pd.read_parquet(layout.par_agg(1))
    assert len(agg1) == len(run.par_names)


def test_manifest_cache_bytes_equals_the_summed_size_of_every_recorded_file(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    make_run(run_dir, iterations=(0, 1))

    manifest = ingest_run(run_dir, cache_root=cache_root)

    expected = sum(f.bytes for a in manifest.artifacts.values() for f in a.files)
    assert manifest.cache_bytes == expected
    assert manifest.cache_bytes > 0
    assert manifest.ingest_seconds is not None
    assert manifest.ingest_seconds >= 0.0


def test_config_json_never_carries_ingest_seconds_or_cache_bytes(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    make_run(run_dir, iterations=(0, 1))

    ingest_run(run_dir, cache_root=cache_root)

    payload = json.loads((cache_root / "config.json").read_text())
    assert "ingest_seconds" not in payload
    assert "cache_bytes" not in payload


def test_an_unreadable_grid_file_fails_only_the_grid_artifact(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run_result = make_run(run_dir, iterations=(0, 1))
    run_result.grid_path.write_bytes(b"still not a real grid file, just different bytes")

    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert manifest.artifacts["grid"].state == "failed"
    assert manifest.artifacts["grid"].reason
    for name, artifact in manifest.artifacts.items():
        if name != "grid":
            assert artifact.state == "ok", (name, artifact.reason)

# ---------------------------------------------------------------------------
# Task 2: a stat, not a read, decides whether anything needs doing
# ---------------------------------------------------------------------------


def test_second_ingest_on_unchanged_directory_writes_nothing_and_skips_everything(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    make_run(run_dir, iterations=(0, 1))

    ingest_run(run_dir, cache_root=cache_root)

    mtimes_before = {
        p: p.stat().st_mtime_ns
        for p in cache_root.rglob("*")
        if p.is_file() and p.name != "manifest.json"
    }

    rows: list[Progress] = []
    manifest = ingest_run(run_dir, cache_root=cache_root, on_progress=rows.append)

    mtimes_after = {
        p: p.stat().st_mtime_ns
        for p in cache_root.rglob("*")
        if p.is_file() and p.name != "manifest.json"
    }
    assert mtimes_before == mtimes_after
    assert all(r.state == "skipped" for r in rows)
    for name, artifact in manifest.artifacts.items():
        if name != "grid":  # the synthetic fixture's grid always fails
            assert artifact.state == "ok"


def test_touching_one_iterations_ensemble_file_reingests_only_that_iteration(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0, 1))

    ingest_run(run_dir, cache_root=cache_root)

    values = fixtures.sample_values(len(run.real_names), len(run.par_names), seed=77)
    fixtures.write_jcb_ensemble(run.par_ens[1], values, run.real_names, run.par_names)

    rows: list[Progress] = []
    ingest_run(run_dir, cache_root=cache_root, on_progress=rows.append)

    touched = {r.artifact for r in rows if r.state != "skipped"}
    assert touched == {"par_ens/1", "par_agg/1"}



# ---------------------------------------------------------------------------
# Task 3: backing out, and knowing the size before agreeing to it
# ---------------------------------------------------------------------------


def test_estimate_bytes_sizes_every_artifact_without_opening_a_source_file(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    make_run(run_dir, iterations=(0, 1))
    run = discover(run_dir)

    opened: list[str] = []
    real_open = builtins.open

    def _recording_open(file, *args, **kwargs):
        opened.append(str(file))
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", _recording_open)
    try:
        estimate = estimate_bytes(run)
    finally:
        monkeypatch.setattr(builtins, "open", real_open)

    assert opened == []
    assert isinstance(estimate, BytesEstimate)
    assert estimate.total > 0
    names = {name for name, _ in estimate.per_artifact}
    # "control" is deliberately never sized -- a PstFrom-style .pst file's
    # own size carries no signal about its external tables -- so it is
    # named in notes instead of appearing in per_artifact.
    assert names == {"par_ens/0", "par_agg/0", "par_ens/1", "par_agg/1", "grid", "config"}
    assert any("control" in note for note in estimate.notes)


def test_estimate_bytes_never_writes_or_creates_the_cache_root(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    make_run(run_dir, iterations=(0, 1))
    run = discover(run_dir)
    cache_root = tmp_path / "cache"

    estimate_bytes(run)

    assert not cache_root.exists()


def test_a_signal_set_after_the_first_ok_artifact_leaves_the_rest_untouched(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    make_run(run_dir, iterations=(0, 1))

    cancel = threading.Event()

    def _cancel_after_first_ok(row: Progress) -> None:
        if row.state == "ok":
            cancel.set()

    manifest = ingest_run(
        run_dir, cache_root=cache_root, on_progress=_cancel_after_first_ok, cancel=cancel
    )

    ok_names = [name for name, a in manifest.artifacts.items() if a.state == "ok"]
    assert len(ok_names) == 1
    first_ok = ok_names[0]

    second_rows: list[Progress] = []
    second_manifest = ingest_run(run_dir, cache_root=cache_root, on_progress=second_rows.append)

    for name, artifact in second_manifest.artifacts.items():
        if name != "grid":
            assert artifact.state == "ok", (name, artifact.reason)

    redone = [r.artifact for r in second_rows if r.state != "skipped"]
    assert first_ok not in redone


def test_a_signal_set_before_the_first_artifact_writes_nothing(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    make_run(run_dir, iterations=(0, 1))

    cancel = threading.Event()
    cancel.set()

    manifest = ingest_run(run_dir, cache_root=cache_root, cancel=cancel)

    assert manifest.artifacts == {}
    written_files = [
        p for p in cache_root.rglob("*") if p.is_file() and p.name != "manifest.json"
    ]
    assert written_files == []


def test_ingest_run_never_prompts_for_input(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    make_run(run_dir, iterations=(0, 1))

    def _raising_input(*args, **kwargs):
        raise AssertionError("ingest_run must never prompt for input")

    monkeypatch.setattr(builtins, "input", _raising_input)

    ingest_run(run_dir, cache_root=cache_root)


@pytest.mark.slow
def test_a_whole_benchmark_run_ingests_end_to_end_with_the_run_directory_unchanged(
    hm_run, tmp_path
):
    cache_root = tmp_path / "cache"

    before = {p: (p.stat().st_size, p.stat().st_mtime_ns) for p in hm_run.rglob("*") if p.is_file()}

    manifest = ingest_run(hm_run, cache_root=cache_root)

    after = {p: (p.stat().st_size, p.stat().st_mtime_ns) for p in hm_run.rglob("*") if p.is_file()}
    assert before == after

    for name, artifact in manifest.artifacts.items():
        assert artifact.state == "ok", (name, artifact.reason)


@pytest.mark.slow
def test_estimate_bytes_is_within_tolerance_of_a_real_ingest(hm_run, tmp_path):
    cache_root = tmp_path / "cache"
    run = discover(hm_run)

    estimate = estimate_bytes(run)
    manifest = ingest_run(hm_run, cache_root=cache_root)

    actual = sum(f.bytes for a in manifest.artifacts.values() for f in a.files)
    tolerance = 0.5
    assert abs(estimate.total - actual) <= tolerance * actual
