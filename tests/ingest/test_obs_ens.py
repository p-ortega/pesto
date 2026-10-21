"""obs_ens/K: each selected iteration's observation ensemble, stored by name.

The tracer ingests a generated run with hash-ordered observation columns and
checks every stored number against what the generator wrote for that
observation name. The later tests pin each way a read can fail.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import threading
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

import pesto.ingest.obsens as obsens
import pesto.ingest.obsread as obsread
import pesto.ingest.runner as runner
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.obsens import load_obs_ensemble, write_obs_ensemble
from pesto.ingest.obsindex import load_obs_index, write_obs_index
from pesto.ingest.obsread import read_obs_file
from pesto.ingest.runner import ingest_run, plan_artifacts
from pesto.ingest.tables import load_control_table

from . import fixtures
from .fixtures import _ENSEMBLE_WRITERS
from .obs_fixtures import make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)

REAL_NAMES = ["34", "base", "35", "176"]

# Taken at import time, before any fixture swaps the runner's isolation out.
_REAL_RUN_ISOLATED = runner._run_isolated


def _ingest(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, **kwargs)
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root)


def _snapshot(root):
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
    }


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_every_stored_observation_row_equals_the_values_written_for_that_name(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, hash_ordered=True, real_names=REAL_NAMES)
    before = _snapshot(run_dir)
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)

    manifest = Manifest.load(layout)
    assert manifest.artifacts["obs_ens/0"].state == "ok"
    assert manifest.artifacts["obs_ens/1"].state == "ok"

    index = load_obs_index(layout)
    assert not isinstance(index, ReadFailure), index
    for iteration in (0, 1):
        stored = load_obs_ensemble(iteration, layout)
        assert not isinstance(stored, ReadFailure), stored
        assert stored.values.dtype == np.float32
        assert stored.values.shape == (len(run.obs_names), 4)
        by_name = {
            run.obs_names[int(control_row)]: stored.values[position]
            for position, control_row in enumerate(index.order)
        }
        assert sorted(by_name) == sorted(run.obs_names)
        for control_row, obs_name in enumerate(run.obs_names):
            expected = run.values[iteration][:, control_row].astype(np.float32)
            np.testing.assert_array_equal(by_name[obs_name], expected)
    assert _snapshot(run_dir) == before


def test_one_site_is_one_unbroken_slice_of_the_stored_rows(tmp_path, in_process):
    run, layout = _ingest(tmp_path, hash_ordered=True, real_names=REAL_NAMES)
    index = load_obs_index(layout)
    stored = load_obs_ensemble(0, layout)

    for site in index.sites.itertuples():
        rows = stored.values[site.start : site.start + site.count]
        control_rows = index.order[site.start : site.start + site.count]
        expected = run.values[0][:, control_rows].T.astype(np.float32)
        np.testing.assert_array_equal(rows, expected)


def test_the_realization_index_keeps_the_names_as_read_in_file_order(tmp_path, in_process):
    _run, layout = _ingest(tmp_path, hash_ordered=True, real_names=REAL_NAMES)

    reals = json.loads(layout.obs_reals(0).read_text())

    assert reals["names"] == REAL_NAMES
    stored = load_obs_ensemble(0, layout)
    assert list(stored.real_names) == REAL_NAMES


def test_the_state_route_reports_obs_available_once_obs_index_and_obs_ens_are_ok(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)

    app, token = create_app()
    app.state.initial_run_dir = str(run_dir)
    app.state.cache_root = str(cache_root)
    client = TestClient(app, base_url="http://127.0.0.1")
    response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})

    body = response.json()
    assert body["capabilities"]["obs"] == {"available": True, "blocked_by": []}
    names = [a["name"] for a in body["artifacts"]]
    assert "obs_ens/0" in names and "obs_ens/1" in names


def test_obs_ens_is_planned_after_the_parameter_artifacts_and_needs_obs_index(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    planned = plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "cache"))

    names = [a.name for a in planned]
    assert names.index("obs_ens/0") > names.index("par_agg/1")
    by_name = {a.name: a for a in planned}
    assert by_name["obs_ens/0"].needs == ("obs_index",)
    assert by_name["obs_ens/0"].sources[0].endswith("case.0.obs.jcb")
    assert by_name["control"].needs == ()


# ---------------------------------------------------------------------------
# refused alone
# ---------------------------------------------------------------------------


def _states(layout):
    return dict(Manifest.load(layout).artifacts)


def _obs_ens_files(layout, iteration):
    return [
        layout.obs_ens(iteration),
        layout.obs_ens_meta(iteration),
        layout.obs_reals(iteration),
    ]


def test_a_file_that_does_not_fit_fails_alone_and_every_parameter_artifact_finishes(
    tmp_path, in_process, monkeypatch
):
    monkeypatch.setattr(
        obsread,
        "memory_budget",
        lambda: obsread.MemoryBudget(bytes=1024, physical_bytes=None, fraction=0.6, note="test"),
    )

    _run, layout = _ingest(tmp_path)

    states = _states(layout)
    for iteration in (0, 1):
        failed = states[f"obs_ens/{iteration}"]
        assert failed.state == "failed"
        assert failed.reason.startswith(
            f"obs_ens/{iteration}: reading case.{iteration}.obs.jcb would need about"
        )
        assert not any(path.exists() for path in _obs_ens_files(layout, iteration))
    for name in ("control", "obs_index", "par_ens/0", "par_agg/0", "par_ens/1", "par_agg/1", "config"):
        assert states[name].state == "ok", name


def test_a_file_missing_one_control_name_fails_with_the_counts_and_writes_nothing(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    writer, _ext = _ENSEMBLE_WRITERS["jcb"]
    writer(run.obs_ens[0], run.values[0][:, :-1], run.real_names, run.obs_names[:-1])
    cache_root = tmp_path / "cache"

    ingest_run(run_dir, cache_root=cache_root)

    layout = CacheLayout(root=cache_root)
    states = _states(layout)
    n = len(run.obs_names)
    assert states["obs_ens/0"].state == "failed"
    assert f"matched {n - 1} of {n}" in states["obs_ens/0"].reason
    assert not any(path.exists() for path in _obs_ens_files(layout, 0))
    assert states["obs_ens/1"].state == "ok"


def test_a_worker_killed_while_reading_an_observation_file_leaves_a_named_failed_row(
    tmp_path, in_process, monkeypatch
):
    in_process_call = runner._run_isolated
    real_dispatch = runner._dispatch

    def _dispatch(artifact, *args):
        if artifact.kind == "obs_ens":
            return fixtures.signal_worker, ()
        return real_dispatch(artifact, *args)

    def _only_the_killed_ones_get_a_process(fn, *args):
        if fn is fixtures.signal_worker:
            return _REAL_RUN_ISOLATED(fn, *args)
        return in_process_call(fn, *args)

    monkeypatch.setattr(runner, "_dispatch", _dispatch)
    monkeypatch.setattr(runner, "_run_isolated", _only_the_killed_ones_get_a_process)

    _run, layout = _ingest(tmp_path)

    states = _states(layout)
    reason = states["obs_ens/0"].reason
    assert reason.startswith("obs_ens/0: the worker reading")
    assert "case.0.obs.jcb" in reason
    for name, artifact in states.items():
        if not name.startswith("obs_ens/"):
            assert artifact.state == "ok", name


def test_obs_ens_fails_by_name_when_obs_index_failed(tmp_path, in_process, monkeypatch):
    monkeypatch.setattr(
        runner,
        "_write_obs_index_artifact",
        lambda cache_root: ReadFailure(
            name="obs_index", path="x", reason="the index would not build"
        ),
    )

    _run, layout = _ingest(tmp_path)

    states = _states(layout)
    assert states["obs_index"].state == "failed"
    for iteration in (0, 1):
        assert states[f"obs_ens/{iteration}"].state == "failed"
        assert states[f"obs_ens/{iteration}"].reason == (
            f"obs_ens/{iteration} depends on obs_index, which failed: the index would not build"
        )
    assert states["par_ens/0"].state == "ok"


def test_a_failing_sidecar_write_removes_the_payload_and_the_realization_index(
    tmp_path, in_process, monkeypatch
):
    real_write = obsens.write_atomic_text

    def _fail_on_the_sidecar(target, payload):
        if Path(target).name == "obs_0.json":
            raise OSError("no space left on device")
        return real_write(target, payload)

    monkeypatch.setattr(obsens, "write_atomic_text", _fail_on_the_sidecar)

    _run, layout = _ingest(tmp_path)

    states = _states(layout)
    failed = states["obs_ens/0"]
    assert failed.state == "failed"
    assert "no space left on device" in failed.reason
    assert "cleaned up 2 file(s)" in failed.reason
    assert not any(path.exists() for path in _obs_ens_files(layout, 0))
    assert not list(layout.ens.glob(".ingest-*"))
    assert states["obs_ens/1"].state == "ok"


def test_a_failing_payload_write_leaves_no_obs_ens_file_under_its_final_name(
    tmp_path, in_process, monkeypatch
):
    def _fail(target, write_fn):
        raise OSError("disk went away")

    monkeypatch.setattr(obsens, "write_atomic_bytes", _fail)

    _run, layout = _ingest(tmp_path)

    failed = _states(layout)["obs_ens/0"]
    assert failed.state == "failed"
    assert failed.reason.startswith("obs_ens/0: failed to write the observation ensemble")
    assert not any(path.exists() for path in _obs_ens_files(layout, 0))


def test_a_file_with_no_name_match_is_refused_rather_than_stored_by_position(
    tmp_path, in_process
):
    _run, layout = _ingest(tmp_path)
    index = load_obs_index(layout)
    unmatched = EnsembleData(
        values=np.zeros((2, 3), dtype=np.float32),
        real_names=("a", "b"),
        entity_names=("x", "y", "z"),
        source_path=Path("case.0.obs.jcb"),
        on_disk_format="jcb",
        orientation="rows",
        orientation_decided_by="test",
        contiguous=True,
        permutation=None,
        hash_ordered=False,
        notes=(),
    )

    result = write_obs_ensemble(unmatched, index, 0, layout)

    assert isinstance(result, ReadFailure)
    assert "refusing rather than falling back to file row position" in result.reason


def test_a_cancel_after_the_first_obs_ens_keeps_it_recorded_and_never_starts_the_next(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir)
    cache_root = tmp_path / "cache"
    stop = threading.Event()

    def _watch(progress):
        if progress.artifact == "obs_ens/0" and progress.state == "ok":
            stop.set()

    ingest_run(run_dir, cache_root=cache_root, on_progress=_watch, cancel=stop)

    states = _states(CacheLayout(root=cache_root))
    assert states["obs_ens/0"].state == "ok"
    assert "obs_ens/1" not in states


def test_a_load_against_a_rebuilt_obs_index_with_a_different_order_is_refused(
    tmp_path, in_process
):
    _run, layout = _ingest(tmp_path)
    index = load_obs_index(layout)
    reversed_order = index.order[::-1].copy()
    other = dataclasses.replace(
        index,
        order=reversed_order,
        order_digest=hashlib.sha256(reversed_order.astype("<i4").tobytes()).hexdigest(),
    )
    written = write_obs_index(other, layout)
    assert not isinstance(written, ReadFailure), written

    result = load_obs_ensemble(0, layout)

    assert isinstance(result, ReadFailure)
    assert "different obs_index" in result.reason
    assert result.reason.startswith("obs_ens/0:")


def test_a_file_with_one_realization_is_stored_with_n_real_one(tmp_path, in_process):
    run, layout = _ingest(tmp_path, n_real=1)

    stored = load_obs_ensemble(0, layout)

    assert not isinstance(stored, ReadFailure), stored
    assert stored.values.shape == (len(run.obs_names), 1)
    sidecar = json.loads(layout.obs_ens_meta(0).read_text())
    assert sidecar["shape"] == [len(run.obs_names), 1]
    assert len(sidecar["real_names"]) == 1


def test_a_nan_in_the_file_is_counted_in_the_sidecar_and_kept_as_nan(tmp_path, in_process):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    values = run.values[0].copy()
    values[1, 2] = np.nan
    writer, _ext = _ENSEMBLE_WRITERS["jcb"]
    writer(run.obs_ens[0], values, run.real_names, run.obs_names)
    cache_root = tmp_path / "cache"

    ingest_run(run_dir, cache_root=cache_root)

    layout = CacheLayout(root=cache_root)
    stored = load_obs_ensemble(0, layout)
    assert not isinstance(stored, ReadFailure), stored
    assert stored.n_nan == 1
    index = load_obs_index(layout)
    position = int(np.flatnonzero(index.order == 2)[0])
    assert np.isnan(stored.values[position, 1])


def test_a_block_size_smaller_than_the_index_gives_the_same_stored_values(tmp_path, in_process):
    run, layout = _ingest(tmp_path, hash_ordered=True, real_names=REAL_NAMES)
    whole = np.array(load_obs_ensemble(0, layout).values)
    table, _notes = load_control_table(layout, "obs", columns=["obsnme"])
    data = read_obs_file(run.obs_ens[0], table.column("obsnme").to_pylist(), artifact="obs_ens/0")
    index = load_obs_index(layout)

    written = write_obs_ensemble(data, index, 0, layout, block_rows=2)

    assert written.name == "obs_ens/0"
    np.testing.assert_array_equal(np.array(load_obs_ensemble(0, layout).values), whole)


# ---------------------------------------------------------------------------
# real runs (slow; skipped when the benchmark folder is absent)
# ---------------------------------------------------------------------------


@pytest.mark.slow
@pytest.mark.parametrize("run_fixture", ["hm_run", "pl253_run"])
def test_a_real_runs_first_observation_file_is_stored_by_name_and_the_run_is_untouched(
    request, tmp_path, run_fixture
):
    from pesto.ingest.control import read_control
    from pesto.ingest.tables import write_control
    from pesto.warm import load_pyemu

    run_dir = request.getfixturevalue(run_fixture)
    before = _snapshot(run_dir)
    run = discover(run_dir)
    first = sorted(k for k in run.obs_ens if isinstance(k, int))[0]
    source = run.obs_ens[first]

    tables = read_control(run.pst_path)
    assert not isinstance(tables, ReadFailure), tables
    layout = CacheLayout(root=tmp_path / "cache")
    layout.ensure()
    assert not isinstance(write_control(tables, layout), ReadFailure)
    built = runner._write_obs_index_artifact(str(layout.root))
    assert not isinstance(built, ReadFailure), built

    result = runner._write_obs_ens_artifact(str(source), str(layout.root), first)
    assert not isinstance(result, ReadFailure), result

    stored = load_obs_ensemble(first, layout)
    assert not isinstance(stored, ReadFailure), stored
    index = load_obs_index(layout)
    loaded = load_control_table(layout, "obs", columns=["obsnme"])
    control_names = loaded[0].column("obsnme").to_pylist()
    row_of = {name: i for i, name in enumerate(control_names)}
    position_of = np.empty(index.n_obs, dtype=np.int64)
    position_of[index.order] = np.arange(index.n_obs)

    matrix = load_pyemu().Matrix.from_binary(str(source))
    rows, cols = list(matrix.row_names), list(matrix.col_names)
    known = set(control_names)
    on_columns = len(known & set(cols)) > len(known & set(rows))
    obs_axis, real_axis = (cols, rows) if on_columns else (rows, cols)
    assert list(stored.real_names) == real_axis

    rng = np.random.default_rng(0)
    for name in rng.choice(np.array(control_names), size=20, replace=False):
        file_index = obs_axis.index(str(name))
        column = matrix.x[:, file_index] if on_columns else matrix.x[file_index, :]
        np.testing.assert_array_equal(
            stored.values[position_of[row_of[str(name)]]], column.astype(np.float32)
        )
    assert _snapshot(run_dir) == before
