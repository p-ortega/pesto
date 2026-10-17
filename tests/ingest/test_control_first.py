"""The control file is parsed once, first, by the control worker alone.

Every other worker reads the cached control table, and a worker that needs
a table control did not leave fails by name instead of running on nothing.

Most tests here run the ingest in this process (``_run_isolated`` replaced
by a plain call) with a stand-in grid adapter, so the grid file need not be
a real ``.grb`` and ``read_control`` can be counted or forced to fail.
"""

from __future__ import annotations

import inspect
import json
import threading

import numpy as np
import pandas as pd
import pytest

import pesto.ingest.runner as runner
import pesto.model.mf6 as mf6_module
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest, WrittenArtifact
from pesto.ingest.control import read_control
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.runner import Progress, ingest_run, plan_artifacts
from pesto.ingest.tables import load_control_tables, write_control
from pesto.model import GridShape, GroupResolution, ParCells, fan_polygons

from .fixtures import make_run, write_control_file


class _StubAdapter:
    """A grid of two cells that places the first parameter group on them and
    leaves every other group unplaced."""

    def __init__(self, grb_path):
        self.grb_path = grb_path

    def grid_mesh(self):
        verts = np.array([[0.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0, 1.0], [2.0, 0.0], [2.0, 1.0]])
        return fan_polygons(verts, [[0, 2, 3, 1], [2, 4, 5, 3]], nlay=1, crs=None)

    def grid_shape(self):
        return GridShape(ncpl=2, nlay=1, nrow=None, ncol=None)

    def idomain(self):
        return None

    def crs(self):
        return None

    def locate_par(self, par):
        names = tuple(str(v) for v in par.index)
        n = len(names)
        group_of = list(par["pargp"].astype(str))
        placed = sorted(set(group_of))[0]
        cell = np.full(n, -1, dtype=np.int32)
        layer = np.full(n, -1, dtype=np.int32)
        for row, group in enumerate(group_of):
            if group == placed:
                cell[row] = row % 2
                layer[row] = 0
        groups = tuple(
            GroupResolution(
                group=g,
                rule="stub" if g == placed else "unmapped",
                mapped=int((cell[[i for i, x in enumerate(group_of) if x == g]] >= 0).sum()),
                total=group_of.count(g),
            )
            for g in sorted(set(group_of))
        )
        return ParCells(
            cell=cell,
            layer=layer,
            parnme=names,
            groups=groups,
            summary="stub placed the first group",
            notes=("stub note",),
            point_xy=None,
        )


@pytest.fixture
def in_process(monkeypatch):
    """Run every worker in this process against the stand-in adapter."""

    def _call(fn, *args):
        try:
            return True, fn(*args)
        except Exception as exc:
            return False, exc

    monkeypatch.setattr(runner, "_run_isolated", _call)
    monkeypatch.setattr(mf6_module, "Mf6Adapter", _StubAdapter)


@pytest.fixture
def count_control_reads(monkeypatch):
    calls: list[str] = []
    real = runner.read_control

    def _counting(path):
        calls.append(str(path))
        return real(path)

    monkeypatch.setattr(runner, "read_control", _counting)
    return calls


def _make(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    run = make_run(run_dir, **kwargs)
    return run_dir, run, tmp_path / "cache"


# ---------------------------------------------------------------------------
# plan order
# ---------------------------------------------------------------------------


def test_the_plan_for_a_two_iteration_run_with_a_grid_starts_with_control_then_grid_then_par_cell(
    tmp_path,
):
    run_dir, _, cache_root = _make(tmp_path, iterations=(0, 1))

    planned = plan_artifacts(discover(run_dir), CacheLayout(root=cache_root))

    assert [a.name for a in planned] == [
        "control",
        "grid",
        "par_cell",
        "par_ens/0",
        "par_agg/0",
        "par_ens/1",
        "par_agg/1",
        "config",
    ]


def test_a_run_with_no_grid_file_plans_no_grid_and_no_par_cell(tmp_path):
    run_dir, run, cache_root = _make(tmp_path, iterations=(0,))
    run.grid_path.unlink()

    planned = plan_artifacts(discover(run_dir), CacheLayout(root=cache_root))

    assert [a.name for a in planned] == ["control", "par_ens/0", "par_agg/0", "config"]


def test_pilot_point_factors_come_after_the_iterations_and_before_config(tmp_path):
    run_dir, _, cache_root = _make(tmp_path, iterations=(0,))
    (run_dir / "mult2model_info.csv").write_text("org_file,model_file,fac_file,pp_file\n")
    (run_dir / "g1pp_inst0pp.fac").write_text("x\n")

    names = [a.name for a in plan_artifacts(discover(run_dir), CacheLayout(root=cache_root))]

    assert names == [
        "control",
        "grid",
        "par_cell",
        "par_ens/0",
        "par_agg/0",
        "pp_factors",
        "config",
    ]


# ---------------------------------------------------------------------------
# the control file is parsed once
# ---------------------------------------------------------------------------


def test_the_old_up_front_cell_resolution_is_gone():
    assert hasattr(runner, "_resolve_cells") is False


@pytest.mark.parametrize(
    "worker",
    [
        runner._write_par_ens,
        runner._write_par_agg_artifact,
        runner._write_pp_factors_artifact,
        runner._write_config_artifact,
        runner._write_par_cell_artifact,
        runner.ingest_run,
    ],
)
def test_only_the_control_worker_names_the_control_reader(worker):
    assert "read_control" not in inspect.getsource(worker)


def test_a_whole_ingest_parses_the_control_file_exactly_once(
    tmp_path, in_process, count_control_reads
):
    run_dir, _, cache_root = _make(tmp_path, iterations=(0, 1))

    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert len(count_control_reads) == 1
    for name, artifact in manifest.artifacts.items():
        assert artifact.state == "ok", (name, artifact.reason)
    assert "par_cell" in manifest.artifacts


def test_a_second_ingest_of_an_unchanged_run_parses_nothing(
    tmp_path, in_process, count_control_reads
):
    run_dir, _, cache_root = _make(tmp_path, iterations=(0, 1))
    ingest_run(run_dir, cache_root=cache_root)
    count_control_reads.clear()

    rows: list[Progress] = []
    ingest_run(run_dir, cache_root=cache_root, on_progress=rows.append)

    assert count_control_reads == []
    assert {r.state for r in rows} == {"skipped"}


def test_every_worker_but_control_works_from_the_cache_with_the_control_reader_broken(
    tmp_path, in_process, monkeypatch
):
    run_dir, run, cache_root = _make(tmp_path, iterations=(0, 1))
    ingest_run(run_dir, cache_root=cache_root)
    (run_dir / "mult2model_info.csv").write_text("org_file,model_file,fac_file,pp_file\n")

    def _boom(path):
        raise AssertionError("a worker parsed the control file")

    monkeypatch.setattr(runner, "read_control", _boom)
    root = str(cache_root)
    source = str(run.par_ens[0])

    results = [
        runner._write_par_cell_artifact(str(run.grid_path), root),
        runner._write_par_ens(source, root, 0, None),
        runner._write_par_agg_artifact(source, root, 0),
        runner._write_pp_factors_artifact(str(run_dir), None, root),
        runner._write_config_artifact(str(run_dir), root, 0),
    ]

    for result in results:
        assert isinstance(result, WrittenArtifact), result


def test_workers_that_need_no_observation_rows_load_the_observation_schema_only(
    tmp_path, in_process, monkeypatch
):
    run_dir, run, cache_root = _make(tmp_path, iterations=(0,))
    ingest_run(run_dir, cache_root=cache_root)
    seen: list[str] = []
    real = runner.load_control_tables

    def _spy(layout, obs="full"):
        seen.append(obs)
        return real(layout, obs=obs)

    monkeypatch.setattr(runner, "load_control_tables", _spy)
    root = str(cache_root)
    source = str(run.par_ens[0])

    runner._write_par_cell_artifact(str(run.grid_path), root)
    runner._write_par_ens(source, root, 0, None)
    runner._write_par_agg_artifact(source, root, 0)
    runner._write_pp_factors_artifact(str(run_dir), None, root)
    runner._write_config_artifact(str(run_dir), root, 0)

    assert seen == ["schema"] * 5


def test_a_control_table_with_zero_observation_rows_still_loads_for_the_workers(tmp_path):
    pst_path, _ = write_control_file(tmp_path / "case.pst", ["p0", "p1"], obs_names=[])
    tables = read_control(pst_path)
    layout = CacheLayout(root=tmp_path / ".pesto")
    write_control(tables, layout)

    schema = load_control_tables(layout, obs="schema")

    assert not isinstance(schema, ReadFailure)
    assert "obsnme" in schema.obs.columns
    assert list(schema.par["parnme"]) == ["p0", "p1"]


# ---------------------------------------------------------------------------
# par_cell feeds the ensemble's map block
# ---------------------------------------------------------------------------


def test_the_ensemble_map_block_comes_from_the_cached_par_cell(tmp_path, in_process):
    run_dir, _, cache_root = _make(tmp_path, iterations=(0,))

    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert manifest.artifacts["par_ens/0"].state == "ok"
    layout = CacheLayout(root=cache_root)
    sidecar = json.loads((layout.ens / "par_0.json").read_text())
    assert sidecar["blocks"][0]["n_par"] > 0
    assert not any("cell resolution failed" in n for n in sidecar["notes"])
    frame = pd.read_parquet(layout.grid / "par_cell.parquet")
    assert list(frame["parnme"]) == [f"par{i}" for i in range(len(frame))]


# ---------------------------------------------------------------------------
# dependents of a failed control fail by name
# ---------------------------------------------------------------------------


def test_a_failed_control_fails_every_dependent_by_name_and_leaves_grid_alone(
    tmp_path, in_process, monkeypatch
):
    run_dir, _, cache_root = _make(tmp_path, iterations=(0, 1))
    pst = run_dir / "case.pst"

    def _broken(path):
        return ReadFailure(name="control", path=str(path), reason="the control file is corrupt")

    monkeypatch.setattr(runner, "read_control", _broken)
    rows: list[Progress] = []

    manifest = ingest_run(run_dir, cache_root=cache_root, on_progress=rows.append)

    assert manifest.artifacts["control"].state == "failed"
    for name in ("par_cell", "par_ens/0", "par_agg/0", "par_ens/1", "par_agg/1", "config"):
        artifact = manifest.artifacts[name]
        assert artifact.state == "failed", name
        assert artifact.reason.startswith(f"{name} depends on control, which failed:"), artifact.reason
        assert "the control file is corrupt" in artifact.reason
        assert {s.path for s in artifact.sources} >= {pst.name}
    assert manifest.artifacts["grid"].state == "ok"
    failed_rows = {r.artifact for r in rows if r.state == "failed"}
    assert {"par_cell", "par_ens/0", "config"} <= failed_rows
    assert not any(r.artifact == "par_ens/0" and r.state == "started" for r in rows)


def test_a_dependent_that_is_still_fresh_is_skipped_even_while_control_is_failed(
    tmp_path, in_process
):
    run_dir, _, cache_root = _make(tmp_path, iterations=(0,))
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    manifest = Manifest.load(layout)
    manifest.mark_failed("control", "marked failed by hand", sources=manifest.artifacts["control"].sources)
    manifest.save(layout)

    rows: list[Progress] = []
    second = ingest_run(run_dir, cache_root=cache_root, on_progress=rows.append)

    assert second.artifacts["control"].state == "failed"
    assert second.artifacts["par_cell"].state == "ok"
    assert second.artifacts["par_ens/0"].state == "ok"
    assert {r.state for r in rows} == {"skipped"}


def test_a_dependent_with_no_control_record_says_control_was_not_read(tmp_path):
    manifest = Manifest.empty(str(tmp_path))

    reason = runner._control_failure_reason(manifest, "par_ens/0")

    assert reason == "par_ens/0 depends on control, which failed: it was not read in this ingest"


# ---------------------------------------------------------------------------
# cancel
# ---------------------------------------------------------------------------


def test_a_cancel_after_control_leaves_it_ok_and_the_next_ingest_skips_it(
    tmp_path, in_process, count_control_reads
):
    run_dir, _, cache_root = _make(tmp_path, iterations=(0, 1))
    cancel = threading.Event()

    def _cancel_on_first_ok(row: Progress) -> None:
        if row.state == "ok":
            cancel.set()

    manifest = ingest_run(
        run_dir, cache_root=cache_root, on_progress=_cancel_on_first_ok, cancel=cancel
    )

    assert manifest.artifacts["control"].state == "ok"
    assert set(manifest.artifacts) == {"control"}
    count_control_reads.clear()

    rows: list[Progress] = []
    second = ingest_run(run_dir, cache_root=cache_root, on_progress=rows.append)

    states = {r.artifact: r.state for r in rows if r.state != "started"}
    assert states["control"] == "skipped"
    assert count_control_reads == []
    for name, artifact in second.artifacts.items():
        assert artifact.state == "ok", (name, artifact.reason)
