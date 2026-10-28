"""GET /api/run/link/cell: what a clicked cell holds, read back through a real app from a
cache made by ingesting a generated run on a real vertex grid (three cells, one layer)."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import pesto.ingest.runner as runner
from ingest.obs_fixtures import DEFAULT_SITES, GRID_SITES, SiteSpec
from pesto.api import link, linkcache
from pesto.api.fields import contributors
from pesto.ingest.mesh import load_mesh
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.parcell import load_par_cell, write_par_cell
from pesto.ingest.ppfactors import PpGroup, PpIndex, write_pp_index
from pesto.model import GroupResolution, ParCells

from .obs_helpers import open_obs_run, site_id
from .test_fields_compute import FAC

GRID_RUN = {"grid": True, "sites": DEFAULT_SITES + GRID_SITES, "iterations": (0,), "n_real": 4}
NO_PLACED_SITES = {"grid": True, "sites": DEFAULT_SITES, "iterations": (0,), "n_real": 4}
ICPL_A = "oname:hds_otype:lst_usecol:icpl-a"


@pytest.fixture
def in_process(monkeypatch):
    """Run every worker in this process, with the real adapter."""

    def _call(fn, *args):
        try:
            return True, fn(*args)
        except Exception as exc:
            return False, exc

    monkeypatch.setattr(runner, "_run_isolated", _call)


def _layout(client) -> CacheLayout:
    return CacheLayout(root=Path(client.pesto_app.state.cache_root))


def _place_pars(client, cells: dict[str, tuple[int, int]], pargp: dict[str, str] | None = None) -> None:
    """Rewrite par_cell so the named parameters sit on (cell, layer); the rest stay unmapped.
    Every parameter is in group "pargp" unless ``pargp`` names another."""
    layout = _layout(client)
    names = load_par_cell(layout).parnme
    cell = np.array([cells.get(n, (-1, -1))[0] for n in names], dtype=np.int32)
    layer = np.array([cells.get(n, (-1, -1))[1] for n in names], dtype=np.int32)
    placed = ParCells(
        cell=cell,
        layer=layer,
        parnme=names,
        groups=(GroupResolution(group="pargp", rule="test", mapped=len(cells), total=len(names)),),
        summary="test placement",
        notes=(),
    )
    groups = pargp or {}
    par = pd.DataFrame({"parnme": list(names), "pargp": [groups.get(n, "pargp") for n in names]})
    written = write_par_cell(placed, par, layout)
    assert not hasattr(written, "reason"), written


def _get(client, **query):
    return client.get("/api/run/link/cell", params=query)


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Every file and folder under ``root`` with its size and mtime."""
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
    }


# ---- Task 1: the clicked cell's own parameters and sites ----


def test_a_cell_with_a_site_and_parameters_names_them_by_site_id_and_parnme(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par2": (0, 0), "par0": (0, 0), "par1": (1, 0)})

    body = _get(client, layer=0, cells="0").json()

    assert body["layer"] == 0
    assert body["cells"] == [0]
    clicked = [s for s in body["sites"] if s["in_clicked_cell"]]
    assert [s["site_id"] for s in clicked] == [site_id(client.pesto_app.state.cache_root, ICPL_A)]
    assert clicked[0]["site"] == ICPL_A
    assert clicked[0]["group"] == "gw_icpl"
    assert (clicked[0]["layer"], clicked[0]["cell"]) == (0, 0)
    # Control order, not the order they were placed in.
    assert [p["parnme"] for p in body["pars"]] == ["par0", "par2"]
    assert all(p["kind"] == "cell" and p["weights"] == [] and p["cell"] == 0 for p in body["pars"])
    assert body["pars"][0]["pargp"] == "pargp"
    assert body["pars"][0]["rule"] == "sets this cell (par_cell)"
    assert body["pars_total"] == 2
    assert body["par_notes"] == []
    assert body["reasons"]["pars"] is None


def test_several_cells_come_back_ascending_and_without_repeats(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (0, 0), "par1": (1, 0)})

    body = _get(client, layer=0, cells="1,0,1").json()

    assert body["cells"] == [0, 1]
    assert [p["parnme"] for p in body["pars"]] == ["par0", "par1"]


def test_a_cell_no_parameter_sets_says_so(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    body = _get(client, layer=0, cells="2").json()

    assert body["pars"] == []
    assert body["pars_total"] == 0
    assert body["reasons"]["pars"] == "no parameter sets this cell on layer 0"


def test_a_cell_with_no_site_says_so(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **NO_PLACED_SITES)

    body = _get(client, layer=0, cells="0").json()

    assert body["sites"] == []
    assert body["sites_total"] == 0
    assert body["reasons"]["sites"] == "no observation site in this cell or its neighbours on layer 0"
    assert body["site_counts"]["unplaced_in_run"] == 3


def test_a_pilot_point_parameter_is_marked_as_one(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (0, 0), "par1": (0, 0)})
    layout = _layout(client)
    group = PpGroup(
        group="pargp", layer=0, factor_file="pp.fac", format="text", parnames=("par1",),
        pp_names=("pp1",), log_space=False, n_cells=3,
    )
    write_pp_index(PpIndex(groups=(group,), not_interpolable=()), layout)
    manifest = Manifest.load(layout)
    manifest.mark_ok("pp_factors", [])
    manifest.save(layout)

    body = _get(client, layer=0, cells="0").json()

    assert [(p["parnme"], p["kind"]) for p in body["pars"]] == [("par0", "cell"), ("par1", "pilot_point")]
    # No run folder is open here, so the factors behind the cell cannot be read.
    assert body["par_notes"] == ["group pargp: the run directory is not open, so pilot-point factors cannot be read"]


def test_an_unreadable_pp_factors_is_named_in_a_note_never_skipped(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par1": (0, 0)})
    layout = _layout(client)
    layout.pp_index.parent.mkdir(parents=True, exist_ok=True)
    layout.pp_index.write_text("not json")
    manifest = Manifest.load(layout)
    manifest.mark_ok("pp_factors", [])
    manifest.save(layout)

    body = _get(client, layer=0, cells="0").json()

    assert [p["kind"] for p in body["pars"]] == ["cell"]
    assert len(body["par_notes"]) == 1
    note = body["par_notes"][0]
    assert note.startswith("pp_factors could not be read: ")
    assert note.endswith("so pilot points are listed as plain parameters")
    assert str(tmp_path) not in note


def test_no_run_open_is_409(tmp_path):
    from .obs_helpers import open_cache

    client = open_cache(tmp_path / "cache")
    client.pesto_app.state.cache_root = None

    assert _get(client, layer=0, cells="0").status_code == 409


@pytest.mark.parametrize(
    ("query", "says"),
    [
        ({"layer": 0, "cells": "1,x"}, "whole numbers"),
        ({"layer": 0, "cells": ""}, "whole numbers"),
        ({"layer": 0, "cells": ",".join(["0"] * 51)}, "at most 50"),
        ({"layer": 0, "cells": "3"}, "3 cells per layer"),
        ({"layer": 0, "cells": "-1"}, "3 cells per layer"),
        ({"layer": 1, "cells": "0"}, "1 layer"),
    ],
)
def test_a_cell_list_or_layer_it_cannot_use_is_422_with_the_reason(tmp_path, in_process, query, says):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    response = _get(client, **query)

    assert response.status_code == 422
    assert says in response.json()["detail"]


def test_an_extra_query_field_is_422(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    assert _get(client, layer=0, cells="0", site=1).status_code == 422


def test_the_route_leaves_the_run_and_the_cache_untouched(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (0, 0)})
    cache_root = Path(client.pesto_app.state.cache_root)
    run_before = _snapshot(run.root)
    cache_before = _snapshot(cache_root)

    for cells in ("0", "1,2", "2"):
        assert _get(client, layer=0, cells=cells).status_code == 200

    assert _snapshot(run.root) == run_before
    assert _snapshot(cache_root) == cache_before


# ---- Task 2: the first ring, the order, the cap and the counts ----

ICPL_B = "oname:hds_otype:lst_usecol:icpl-b"
XY_C = "oname:hds_otype:lst_usecol:xy-c"


def _ids(client, *names: str) -> list[int]:
    return [site_id(client.pesto_app.state.cache_root, n) for n in names]


def test_the_ring_on_a_three_by_three_grid_holds_edge_and_corner_neighbours():
    # Nine unit squares, each with its own four corners, as the mesh stores them.
    positions, cell_index = [], []
    for row in range(3):
        for col in range(3):
            positions += [(col, row), (col + 1, row), (col + 1, row + 1), (col, row + 1)]
            cell_index += [row * 3 + col] * 4
    table = linkcache.build_neighbours(np.array(positions, dtype=np.float32), np.array(cell_index), 9)

    assert table.ring([0]).tolist() == [1, 3, 4]
    assert table.ring([4]).tolist() == [0, 1, 2, 3, 5, 6, 7, 8]
    assert table.ring([0, 8]).tolist() == [1, 3, 4, 5, 7]


def test_the_ring_on_the_fixture_grid_is_symmetric_and_never_holds_the_cell(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    state = client.pesto_app.state
    table = linkcache.cell_neighbours(state, state.cache_root)
    n = load_mesh(_layout(client)).n_cells

    rings = {c: set(table.ring([c]).tolist()) for c in range(n)}

    # Cell 0 is the corner square: it touches cell 1 only.
    assert rings[0] == {1}
    assert rings[1] == {0, 2}
    for a in range(n):
        assert a not in rings[a]
        for b in range(n):
            assert (b in rings[a]) == (a in rings[b])


def test_two_clicked_cells_give_their_ring_as_one_union_without_either(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    body = _get(client, layer=0, cells="2,0").json()

    assert body["cells"] == [0, 2]
    assert body["ring"] == [1]
    assert body["ring_rule"] == "a neighbouring cell shares at least one corner with a clicked cell"


def test_sites_come_clicked_cell_first_then_nearest_first_and_the_same_every_time(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    first = _get(client, layer=0, cells="1").json()
    second = _get(client, layer=0, cells="1").json()

    # xy-c sits in cell 1; cell 0's centre is nearer cell 1's centre than cell 2's is.
    assert [s["site_id"] for s in first["sites"]] == _ids(client, XY_C, ICPL_A, ICPL_B)
    assert [s["in_clicked_cell"] for s in first["sites"]] == [True, False, False]
    assert first["sites"] == second["sites"]
    assert first["sites_total"] == 3
    assert first["sites_cap"] == 50


def test_a_site_of_unknown_layer_in_reach_is_included_and_counted(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    body = _get(client, layer=0, cells="2").json()

    assert body["sites"][0]["site_id"] == _ids(client, ICPL_B)[0]
    assert body["sites"][0]["layer"] == -1
    assert body["site_counts"] == {"unknown_layer_included": 1, "other_layer_left_out": 0, "unplaced_in_run": 3}


def test_a_site_on_another_layer_in_the_same_cell_is_left_out_and_counted(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    path = _layout(client).grid / "obs_cell.parquet"
    frame = pd.read_parquet(path)
    frame.loc[frame["site"] == ICPL_A, "layer"] = 1
    frame.to_parquet(path)

    body = _get(client, layer=0, cells="0").json()

    assert _ids(client, ICPL_A)[0] not in [s["site_id"] for s in body["sites"]]
    assert body["site_counts"]["other_layer_left_out"] == 1


def test_sixty_sites_in_reach_return_fifty_and_say_sixty(tmp_path, in_process):
    many = tuple(
        SiteSpec(
            "gw_many", f"oname:hds_otype:lst_usecol:many-{i:02d}", (None,), "none",
            extras={"icpl": "0", "layer": "0"},
        )
        for i in range(60)
    )
    client, _ = open_obs_run(tmp_path, grid=True, sites=many, iterations=(0,), n_real=4)

    body = _get(client, layer=0, cells="0").json()

    assert len(body["sites"]) == 50
    assert body["sites_total"] == 60
    assert body["sites_cap"] == 50
    ids = [s["site_id"] for s in body["sites"]]
    assert ids == sorted(ids)


def test_more_parameters_than_the_cap_are_counted_and_noted(tmp_path, in_process, monkeypatch):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (0, 0), "par1": (0, 0), "par2": (0, 0)})
    monkeypatch.setattr(link, "PARS_CAP", 2)

    body = _get(client, layer=0, cells="0").json()

    assert [p["parnme"] for p in body["pars"]] == ["par0", "par1"]
    assert body["pars_total"] == 3
    assert body["par_notes"] == [
        "3 parameters set this cell on layer 0; the first 2 are listed, by parameter group, "
        "direct parameters in control-file order and then pilot points by largest factor"
    ]


def test_a_failed_placement_is_not_served_from_files_an_older_ingest_left(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (0, 0)})
    layout = _layout(client)
    manifest = Manifest.load(layout)
    manifest.mark_failed("par_cell", "the control file could not be read")
    manifest.mark_failed("obs_cell", "the grid could not be read")
    manifest.save(layout)

    body = _get(client, layer=0, cells="0").json()

    assert body["pars"] == [] and body["sites"] == []
    assert body["reasons"] == {"pars": "the control file could not be read", "sites": "the grid could not be read"}


def test_a_failed_pp_factors_is_noted_with_its_reason_and_not_read(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par1": (0, 0)})
    _pp_group(client, run)
    layout = _layout(client)
    manifest = Manifest.load(layout)
    manifest.mark_failed("pp_factors", "the factor file was not found")
    manifest.save(layout)

    body = _get(client, layer=0, cells="0").json()

    assert [p["kind"] for p in body["pars"]] == ["cell"]
    assert "pp_factors could not be read: the factor file was not found, so pilot points are listed as plain parameters" in body["par_notes"]


def test_a_run_with_no_observation_placement_says_so(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    layout = _layout(client)
    manifest = Manifest.load(layout)
    del manifest.artifacts["obs_cell"]
    manifest.save(layout)

    body = _get(client, layer=0, cells="0").json()

    assert body["sites"] == []
    assert body["reasons"]["sites"] == "no observation placement was ingested for this run"


def test_the_neighbour_table_is_built_once_and_again_after_the_grid_is_rewritten(
    tmp_path, in_process, monkeypatch
):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    built = []
    original = linkcache.build_neighbours

    def counted(*args):
        built.append(1)
        return original(*args)

    monkeypatch.setattr(linkcache, "build_neighbours", counted)

    _get(client, layer=0, cells="0")
    _get(client, layer=0, cells="1")
    assert len(built) == 1

    layout = _layout(client)
    grid_file = layout.root / Manifest.load(layout).artifacts["grid"].files[0].path
    stamp = grid_file.stat().st_mtime_ns + 1_000_000_000
    os.utime(grid_file, ns=(stamp, stamp))
    _get(client, layer=0, cells="0")
    assert len(built) == 2


# ---- 11-09 Task 1: the pilot points behind a clicked cell ----

BINARY_NOTE = "group G4: g.fac is a binary factor file, and pesto lists the points behind a cell only from text factor files"


def _pp_group(client, run, *, fmt: str = "text", parnames=("par1", "par2"), fac: str | None = FAC) -> PpGroup:
    """Record one pilot-point group G4 on layer 0 whose factor file g.fac sits in the run
    folder, and open the run folder the way the launcher does."""
    if fac is not None:
        (run.root / "g.fac").write_text(fac)
    layout = _layout(client)
    group = PpGroup(
        group="G4", layer=0, factor_file="g.fac", format=fmt, parnames=tuple(parnames),
        pp_names=("pp0", "pp1"), log_space=False, n_cells=3,
    )
    write_pp_index(PpIndex(groups=(group,), not_interpolable=()), layout)
    manifest = Manifest.load(layout)
    manifest.mark_ok("pp_factors", [])
    manifest.save(layout)
    client.pesto_app.state.initial_run_dir = str(run.root)
    return group


def _points(body) -> list[tuple[str, list[dict]]]:
    return [(p["parnme"], p["weights"]) for p in body["pars"] if p["rule"] == link.FACTOR_RULE]


def test_a_cell_click_lists_the_points_contributors_names_with_their_weights(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {})
    group = _pp_group(client, run)

    body = _get(client, layer=0, cells="1").json()

    expected = [(name, w) for name, w in contributors(run.root, group, 1) if w != 0]
    assert [(n, ws[0]["weight"]) for n, ws in _points(body)] == expected
    assert expected == [("par1", 0.75), ("par2", 0.25)]
    assert all(p["kind"] == "pilot_point" for p in body["pars"])
    assert all(ws == [{"cell": 1, "weight": w}] for (_, ws), (_, w) in zip(_points(body), expected))
    assert body["par_notes"] == []
    assert body["reasons"]["pars"] is None


def test_a_point_reaching_two_clicked_cells_carries_two_weights_and_a_zero_weight_is_left_out(
    tmp_path, in_process
):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {})
    _pp_group(client, run)

    both = dict(_points(_get(client, layer=0, cells="0,1").json()))
    alone = dict(_points(_get(client, layer=0, cells="0").json()))

    assert both["par1"] == [{"cell": 0, "weight": 1.0}, {"cell": 1, "weight": 0.75}]
    # par2's factor on cell 0 is 0.0 in the file.
    assert both["par2"] == [{"cell": 1, "weight": 0.25}]
    assert list(alone) == ["par1"]


def test_a_parameter_that_is_direct_and_a_point_with_a_factor_appears_once(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par1": (1, 0)})
    _pp_group(client, run)

    body = _get(client, layer=0, cells="1").json()

    rows = [p for p in body["pars"] if p["parnme"] == "par1"]
    assert len(rows) == 1
    assert rows[0]["kind"] == "pilot_point"
    assert rows[0]["rule"] == "sets this cell (par_cell); pilot-point factor on this cell"
    assert rows[0]["weights"] == [{"cell": 1, "weight": 0.75}]
    assert body["pars_total"] == 2


def test_rows_are_grouped_by_pargp_direct_first_then_points_by_largest_weight(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(
        client,
        {"par0": (1, 0), "par3": (1, 0)},
        pargp={"par0": "gpp", "par1": "gpp", "par2": "gpp", "par3": "other"},
    )
    # pp0 is par2 here, so the larger weight belongs to the later name.
    _pp_group(client, run, parnames=("par2", "par1"))

    body = _get(client, layer=0, cells="1").json()

    assert [(p["parnme"], p["pargp"]) for p in body["pars"]] == [
        ("par0", "gpp"), ("par2", "gpp"), ("par1", "gpp"), ("par3", "other"),
    ]
    assert body["pars_total"] == 4


def test_the_cap_counts_point_rows_too(tmp_path, in_process, monkeypatch):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (1, 0)})
    _pp_group(client, run)
    monkeypatch.setattr(link, "PARS_CAP", 2)

    body = _get(client, layer=0, cells="1").json()

    assert [p["parnme"] for p in body["pars"]] == ["par0", "par1"]
    assert body["pars_total"] == 3
    assert body["par_notes"][-1].startswith("3 parameters set this cell on layer 0; the first 2 are listed")


def test_a_binary_group_is_named_in_a_note_and_its_point_in_the_cell_is_still_listed(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par1": (1, 0)})
    _pp_group(client, run, fmt="binary")

    body = _get(client, layer=0, cells="1").json()

    assert body["par_notes"] == [BINARY_NOTE]
    assert [(p["parnme"], p["kind"], p["weights"]) for p in body["pars"]] == [("par1", "pilot_point", [])]


def test_the_factor_file_is_scanned_once_and_again_after_it_changes(tmp_path, in_process, monkeypatch):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {})
    _pp_group(client, run)
    scans = []
    original = linkcache.scan_factor_file

    def counted(*args):
        scans.append(1)
        return original(*args)

    monkeypatch.setattr(linkcache, "scan_factor_file", counted)

    _get(client, layer=0, cells="0")
    _get(client, layer=0, cells="1")
    assert len(scans) == 1

    fac = run.root / "g.fac"
    st = fac.stat()
    os.utime(fac, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
    _get(client, layer=0, cells="1")
    assert len(scans) == 2
    held = [k for k in client.pesto_app.state.obs_memo if "pp_index" in k]
    assert len(held) == 1


def test_an_unreadable_factor_file_is_noted_and_the_direct_rows_still_answer(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (1, 0)})
    _pp_group(client, run, fac=None)

    body = _get(client, layer=0, cells="1").json()

    assert [p["parnme"] for p in body["pars"]] == ["par0"]
    assert body["par_notes"] == ["group G4: could not read g.fac: No such file or directory"]


def test_a_factor_file_naming_a_point_it_never_listed_is_noted(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {})
    _pp_group(client, run, fac=FAC.replace("1 0 2 0.0 1 1.0 2 0.0", "1 0 2 0.0 1 1.0 3 0.5"))

    body = _get(client, layer=0, cells="1").json()

    assert body["pars"] == []
    assert body["par_notes"] == [
        "group G4: could not read g.fac: a cell line names a point outside the 2 points the file lists"
    ]


def test_without_an_open_run_folder_the_points_are_noted_not_dropped(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (1, 0)})
    _pp_group(client, run)
    client.pesto_app.state.initial_run_dir = None

    body = _get(client, layer=0, cells="1").json()

    assert [p["parnme"] for p in body["pars"]] == ["par0"]
    assert body["par_notes"] == ["group G4: the run directory is not open, so pilot-point factors cannot be read"]


def test_the_scan_builds_both_tables_from_a_factor_file_with_lines_that_run_on(tmp_path):
    group = PpGroup(
        group="G4", layer=0, factor_file="g.fac", format="text", parnames=("p8", "p9"),
        pp_names=("pp0", "pp1"), log_space=False, n_cells=4,
    )
    (tmp_path / "g.fac").write_text(FAC)

    index = linkcache.scan_factor_file(tmp_path / "g.fac", group)

    assert [index.points_on(c)[0].tolist() for c in range(6)] == [[0], [0, 1], [0, 1], [], [1], []]
    assert index.points_on(2)[1].tolist() == [0.5, 0.5]
    assert index.cells_of(0).tolist() == [0, 1, 2]
    assert index.cells_of(1).tolist() == [1, 2, 4]


def test_a_pilot_point_click_leaves_the_run_and_the_cache_untouched(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (1, 0)})
    _pp_group(client, run)
    cache_root = Path(client.pesto_app.state.cache_root)
    run_before = _snapshot(run.root)
    cache_before = _snapshot(cache_root)

    for cells in ("0", "1,2", "2"):
        assert _get(client, layer=0, cells=cells).status_code == 200

    assert _snapshot(run.root) == run_before
    assert _snapshot(cache_root) == cache_before
