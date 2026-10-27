"""obs_cell: where every observation site sits on the grid.

The tracer ingests a run with a real vertex grid and checks each site's cell,
layer and rule by site name. The later tests pin the name check, staleness
and every way the artifact can fail.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import pesto.ingest.runner as runner
from pesto.api.app import create_app
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import Manifest, WrittenArtifact
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obscell import ObsCellTable, load_obs_cell, write_obs_cell
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.runner import ingest_run, plan_artifacts
from pesto.model import GroupResolution, ObsCells

from model.mf6_input import write_mf6_obs_input

from .obs_fixtures import GRID_SITES, SiteSpec, make_obs_run

# Taken at import time, before any fixture swaps the runner's isolation out.
_REAL_RUN_ISOLATED = runner._run_isolated

_SITE_A = "oname:hds_otype:lst_usecol:icpl-a"
_SITE_B = "oname:hds_otype:lst_usecol:icpl-b"
_SITE_C = "oname:hds_otype:lst_usecol:xy-c"


@pytest.fixture
def in_process(monkeypatch):
    """Run every worker in this process, with the real adapter."""

    def _call(fn, *args):
        try:
            return True, fn(*args)
        except Exception as exc:
            return False, exc

    monkeypatch.setattr(runner, "_run_isolated", _call)


def _ingest_grid_run(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, grid=True, iterations=(0,), **kwargs)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root), manifest


def _by_site(table: ObsCellTable) -> dict[str, int]:
    return {name: i for i, name in enumerate(table.site)}


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_a_run_with_a_vertex_grid_gets_obs_cell_with_cell_layer_and_rule_by_site_name(
    tmp_path, in_process
):
    run, layout, manifest = _ingest_grid_run(tmp_path)

    assert manifest.artifacts["obs_cell"].state == "ok", manifest.artifacts["obs_cell"].reason
    table = load_obs_cell(layout)
    assert isinstance(table, ObsCellTable)
    at = _by_site(table)

    a, b, c = at[_SITE_A], at[_SITE_B], at[_SITE_C]
    assert (table.cell[a], table.layer[a], table.rule[a]) == (0, 0, "icpl-layer")
    # A blank layer keeps its cell and is stored as -1, never as layer 0.
    assert (table.cell[b], table.layer[b], table.rule[b]) == (2, -1, "icpl-layer")
    assert (table.cell[c], table.rule[c]) == (1, "xyz-host-cell")
    assert np.isfinite(table.x[c]) and np.isfinite(table.y[c])
    assert table.group[a] == "gw_icpl" and table.group[c] == "gw_xy"
    assert table.placed_sites == 3
    assert table.layer_unknown == 1
    assert {g["group"]: g["rule"] for g in table.groups} == {
        "gw_icpl": "icpl-layer",
        "gw_xy": "xyz-host-cell",
    }


def test_the_blank_layer_site_is_never_stored_as_layer_zero(tmp_path, in_process):
    _run, layout, _manifest = _ingest_grid_run(tmp_path)

    frame = pd.read_parquet(layout.obs_cell)

    row = frame[frame["site"] == _SITE_B].iloc[0]
    assert int(row["cell"]) == 2
    assert int(row["layer"]) == -1
    assert frame["layer"].dtype == np.int32 and frame["cell"].dtype == np.int32


def test_sites_are_joined_by_name_in_obs_index_order(tmp_path, in_process):
    _run, layout, _manifest = _ingest_grid_run(tmp_path)

    index = load_obs_index(layout)
    table = load_obs_cell(layout)

    assert table.site == tuple(index.sites["site"])
    assert list(table.site_id) == list(index.sites["site_id"])
    assert table.order_digest == index.order_digest


def test_the_manifest_notes_carry_the_layer_unknown_count_and_the_layer_base_evidence(
    tmp_path, in_process
):
    _run, _layout, manifest = _ingest_grid_run(tmp_path)

    notes = manifest.artifacts["obs_cell"].notes

    assert any("layer unknown" in note and "1" in note for note in notes)
    assert any(note.startswith("layer base") for note in notes)


def test_the_sidecar_holds_the_digest_counts_summary_and_notes(tmp_path, in_process):
    _run, layout, _manifest = _ingest_grid_run(tmp_path)

    raw = json.loads(layout.obs_cell_meta.read_text())

    assert raw["cache_version"] == CACHE_VERSION
    assert raw["order_digest"] == load_obs_index(layout).order_digest
    assert raw["placed_sites"] == 3 and raw["layer_unknown"] == 1
    assert raw["summary"]
    assert raw["notes"]
    assert {g["group"] for g in raw["groups"]} == {"gw_icpl", "gw_xy"}


def test_the_state_route_lists_obs_cell_as_ok(tmp_path, in_process):
    run, layout, _manifest = _ingest_grid_run(tmp_path)

    app, token = create_app()
    app.state.initial_run_dir = str(run.root)
    app.state.cache_root = str(layout.root)
    client = TestClient(app, base_url="http://127.0.0.1")
    body = client.get("/api/run/ingest/state", headers={"x-pesto-token": token}).json()

    states = {a["name"]: a["state"] for a in body["artifacts"]}
    assert states["obs_cell"] == "ok"


def test_grid_sites_fixture_gives_the_three_sites():
    assert [s.site for s in GRID_SITES] == [_SITE_A, _SITE_B, _SITE_C]


# ---------------------------------------------------------------------------
# names are checked, never trusted by position
# ---------------------------------------------------------------------------


def _sites(names, groups=None) -> pd.DataFrame:
    groups = groups or ["g"] * len(names)
    return pd.DataFrame(
        {"site_id": np.arange(len(names)), "site": list(names), "group": groups}
    )


def _obs_cells(names, cell=None, layer=None, groups=None, notes=()) -> ObsCells:
    n = len(names)
    return ObsCells(
        cell=np.array(cell if cell is not None else range(n), dtype=np.int32),
        layer=np.array(layer if layer is not None else [0] * n, dtype=np.int32),
        site=tuple(names),
        groups=groups
        if groups is not None
        else (GroupResolution(group="g", rule="icpl-layer", mapped=n, total=n),),
        summary="a summary sentence",
        notes=tuple(notes),
    )


def test_write_obs_cell_refuses_sites_in_another_order_and_names_the_first_difference(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    cells = _obs_cells(["b", "a", "c"])

    result = write_obs_cell(cells, _sites(["a", "b", "c"]), "digest", layout)

    assert isinstance(result, ReadFailure)
    assert result.name == "obs_cell"
    assert "position 0" in result.reason
    assert "'a'" in result.reason and "'b'" in result.reason
    assert "2 position(s) differ" in result.reason
    assert not (layout.grid / "obs_cell.parquet").exists()
    assert not (layout.grid / "obs_cell.json").exists()


def test_write_obs_cell_refuses_when_the_counts_differ(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")

    result = write_obs_cell(_obs_cells(["a"]), _sites(["a", "b"]), "digest", layout)

    assert isinstance(result, ReadFailure)
    assert "position 1" in result.reason
    assert "'b'" in result.reason and "'<none>'" in result.reason


def test_a_site_with_a_group_the_adapter_did_not_resolve_is_unmapped(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    cells = _obs_cells(["a", "b"], cell=[0, -1], layer=[0, -1])

    written = write_obs_cell(cells, _sites(["a", "b"], ["g", "other"]), "digest", layout)

    assert isinstance(written, WrittenArtifact)
    frame = pd.read_parquet(layout.obs_cell)
    assert list(frame["rule"]) == ["icpl-layer", "unmapped"]
    assert list(frame["cell"]) == [0, -1]


def test_a_failed_sidecar_write_leaves_no_parquet_under_its_final_name(tmp_path, monkeypatch):
    import pesto.ingest.obscell as obscell_module

    def _raise(target, payload):
        raise OSError("disk full")

    monkeypatch.setattr(obscell_module, "write_atomic_text", _raise)
    layout = CacheLayout(root=tmp_path / ".pesto")

    result = write_obs_cell(_obs_cells(["a"]), _sites(["a"]), "digest", layout)

    assert isinstance(result, ReadFailure)
    assert not layout.obs_cell.exists()


def test_the_site_own_x_and_y_are_stored_when_the_adapter_moved_nothing(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    sites = _sites(["a", "b"])
    sites["x"] = ["12.5", None]
    sites["y"] = ["7.25", "not a number"]

    write_obs_cell(_obs_cells(["a", "b"]), sites, "digest", layout)

    frame = pd.read_parquet(layout.obs_cell)
    assert frame["x"].iloc[0] == 12.5 and frame["y"].iloc[0] == 7.25
    assert np.isnan(frame["x"].iloc[1]) and np.isnan(frame["y"].iloc[1])


# ---------------------------------------------------------------------------
# planning and staleness
# ---------------------------------------------------------------------------


def test_obs_cell_is_planned_after_obs_index_and_needs_it(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, grid=True)
    planned = plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "cache"))

    names = [a.name for a in planned]
    by_name = {a.name: a for a in planned}
    assert names.index("obs_cell") == names.index("obs_index") + 1
    assert by_name["obs_cell"].needs == ("obs_index",)
    assert by_name["obs_cell"].kind == "obs_cell"
    assert any(s.endswith(".grb") for s in by_name["obs_cell"].sources)
    assert any(s.endswith(".pst") for s in by_name["obs_cell"].sources)
    assert not any(s.endswith(".grb") for s in by_name["obs_index"].sources)


def test_a_run_with_no_grid_file_plans_no_obs_cell(tmp_path):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir)
    run.grid_path.unlink()

    planned = plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "cache"))

    assert "obs_cell" not in [a.name for a in planned]


def test_editing_the_grid_file_makes_obs_cell_stale_and_leaves_the_obs_files_fresh(
    tmp_path, in_process
):
    run, layout, _manifest = _ingest_grid_run(tmp_path)
    planned = {a.name: a for a in plan_artifacts(discover(run.root), layout)}
    manifest = Manifest.load(layout)
    for name in ("obs_cell", "obs_index", "obs_ens/0"):
        assert manifest.is_stale(name, layout, planned[name].sources) is False, name

    run.grid_path.write_bytes(b"a different grid file\n")

    assert manifest.is_stale("obs_cell", layout, planned["obs_cell"].sources) is True
    assert manifest.is_stale("obs_index", layout, planned["obs_index"].sources) is False
    assert manifest.is_stale("obs_ens/0", layout, planned["obs_ens/0"].sources) is False


def test_obs_cell_fails_by_name_when_obs_index_failed(tmp_path, in_process, monkeypatch):
    monkeypatch.setattr(
        runner,
        "_write_obs_index_artifact",
        lambda cache_root: ReadFailure(
            name="obs_index", path="x", reason="the index would not build"
        ),
    )

    _run, layout, manifest = _ingest_grid_run(tmp_path)

    assert manifest.artifacts["obs_cell"].state == "failed"
    assert manifest.artifacts["obs_cell"].reason == (
        "obs_cell depends on obs_index, which failed: the index would not build"
    )
    assert not layout.obs_cell.exists()


def test_a_grid_file_flopy_cannot_parse_fails_obs_cell_and_leaves_the_obs_files_ok(tmp_path):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, iterations=(0,))
    run.grid_path.write_bytes(b"junk bytes, not a grid" * 4)

    manifest = ingest_run(run_dir, cache_root=tmp_path / "cache")

    assert manifest.artifacts["obs_cell"].state == "failed"
    assert manifest.artifacts["obs_index"].state == "ok"
    assert manifest.artifacts["obs_ens/0"].state == "ok"


# ---------------------------------------------------------------------------
# reading it back
# ---------------------------------------------------------------------------


def test_load_obs_cell_refuses_a_sidecar_from_another_cache_version(tmp_path, in_process):
    _run, layout, _manifest = _ingest_grid_run(tmp_path)
    raw = json.loads(layout.obs_cell_meta.read_text())
    raw["cache_version"] = CACHE_VERSION + 1
    layout.obs_cell_meta.write_text(json.dumps(raw))

    result = load_obs_cell(layout)

    assert isinstance(result, ReadFailure)
    assert "obs_cell.json" in result.reason


def test_load_obs_cell_names_a_missing_file(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = load_obs_cell(layout)

    assert isinstance(result, ReadFailure)
    assert "obs_cell.json" in result.reason


def _swap_in_the_old_cells(tmp_path, second_sites):
    """Ingest a run, keep its obs_cell, re-ingest with other sites, then put
    the old obs_cell files back beside the rebuilt obs_index."""
    run_dir = tmp_path / "run"
    cache_root = tmp_path / "cache"
    make_obs_run(run_dir, grid=True, iterations=(0,))
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    old = (layout.obs_cell.read_bytes(), layout.obs_cell_meta.read_bytes())
    old_digest = load_obs_index(layout).order_digest

    make_obs_run(run_dir, grid=True, iterations=(0,), sites=second_sites)
    ingest_run(run_dir, cache_root=cache_root)
    assert isinstance(load_obs_cell(layout), ObsCellTable)
    layout.obs_cell.write_bytes(old[0])
    layout.obs_cell_meta.write_bytes(old[1])
    return layout, old_digest


def test_load_obs_cell_refuses_cells_built_for_an_obs_index_that_was_since_rebuilt(
    tmp_path, in_process
):
    layout, old_digest = _swap_in_the_old_cells(tmp_path, GRID_SITES[:2])
    assert load_obs_index(layout).order_digest != old_digest

    result = load_obs_cell(layout)

    assert isinstance(result, ReadFailure)
    assert "obs_index" in result.reason and "ingest again" in result.reason


def test_load_obs_cell_refuses_cells_whose_sites_are_in_another_order_even_with_the_same_digest(
    tmp_path, in_process
):
    layout, old_digest = _swap_in_the_old_cells(tmp_path, tuple(reversed(GRID_SITES)))
    # One observation per site, so the observation order alone cannot tell.
    assert load_obs_index(layout).order_digest == old_digest

    result = load_obs_cell(layout)

    assert isinstance(result, ReadFailure)
    assert "position 0" in result.reason and "ingest again" in result.reason


def test_load_obs_cell_names_a_missing_column(tmp_path, in_process):
    _run, layout, _manifest = _ingest_grid_run(tmp_path)
    frame = pd.read_parquet(layout.obs_cell).drop(columns=["layer"])
    frame.to_parquet(layout.obs_cell)

    result = load_obs_cell(layout)

    assert isinstance(result, ReadFailure)
    assert "'layer'" in result.reason


# ---------------------------------------------------------------------------
# the synthetic cache and the run folder
# ---------------------------------------------------------------------------


def test_the_synthetic_cache_holds_an_empty_obs_cell_recorded_ok(tmp_path):
    from fixtures.synthetic_run import write_synthetic_run
    from pesto.cache.layout import for_run

    layout = for_run(write_synthetic_run(tmp_path / "run"))

    assert Manifest.load(layout).artifacts["obs_cell"].state == "ok"
    frame = pd.read_parquet(layout.obs_cell)
    assert len(frame) == 0
    assert list(frame.columns) == [
        "site_id", "site", "group", "cell", "layer", "x", "y", "rule",
    ]
    table = load_obs_cell(layout)
    assert isinstance(table, ObsCellTable)
    assert table.site == () and table.placed_sites == 0


def _snapshot(folder: Path) -> dict[str, tuple[bool, int, int]]:
    state = {}
    for path in sorted(folder.rglob("*")):
        stat = path.stat()
        state[str(path.relative_to(folder))] = (path.is_dir(), stat.st_size, stat.st_mtime_ns)
    root = folder.stat()
    state["."] = (True, root.st_size, root.st_mtime_ns)
    return state


def test_an_ingest_with_obs_cell_changes_nothing_in_the_run_folder(tmp_path, in_process):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, grid=True, iterations=(0,))
    before = _snapshot(run_dir)

    manifest = ingest_run(run_dir, cache_root=tmp_path / "cache")

    assert manifest.artifacts["obs_cell"].state == "ok"
    assert _snapshot(run_dir) == before


# ---------------------------------------------------------------------------
# placement from the model's own MF6 observation input
# ---------------------------------------------------------------------------

_W1 = "oname:hds_otype:lst_usecol:w-1"
_W2 = "oname:hds_otype:lst_usecol:w-2"


def _mf6_sites(*ids: str):
    return tuple(
        SiteSpec("gw_head", f"oname:hds_otype:lst_usecol:{i}", (None,), "none", extras={"id": i})
        for i in ids
    )


def test_sites_named_in_the_mf6_observation_input_are_placed_by_ingest_run(tmp_path, in_process):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, grid=True, iterations=(0,), sites=_mf6_sites("w-1", "w-2"))
    write_mf6_obs_input(
        run_dir, obs_files={"coarse_0.obs": [("W-1", "HEAD", "1 1"), ("W-2", "HEAD", "1 3")]}
    )

    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)

    assert manifest.artifacts["obs_cell"].state == "ok", manifest.artifacts["obs_cell"].reason
    table = load_obs_cell(CacheLayout(root=cache_root))
    assert isinstance(table, ObsCellTable)
    at = _by_site(table)
    assert (table.cell[at[_W1]], table.layer[at[_W1]], table.rule[at[_W1]]) == (0, 0, "mf6-obs")
    assert (table.cell[at[_W2]], table.layer[at[_W2]], table.rule[at[_W2]]) == (2, 0, "mf6-obs")
    assert any("lower-casing" in note for note in table.notes)
