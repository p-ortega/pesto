"""GET /api/run/link/par and /link/sites: where a selected parameter or site is, read back
through a real app from a cache made by ingesting a generated run on a three-cell grid."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ingest.fixtures import survivor_names
from pesto.api import link
from pesto.cache.manifest import Manifest
from pesto.ingest.parcell import write_par_cell
from pesto.model import GroupResolution, ParCells

from .obs_helpers import HEAD_SITE, open_obs_run, site_id
from .test_fields_compute import FAC
from .test_link_routes import (  # noqa: F401
    BINARY_NOTE, GRID_RUN, _layout, _place_pars, _pp_group, _snapshot, in_process,
)

BINARY_REASON = BINARY_NOTE.removeprefix("group G4: ")


def _par(client, *names):
    return client.get("/api/run/link/par", params={"names": json.dumps(list(names))})


def _write_pars(client, rows: list[tuple[str, int, int]]) -> None:
    """Replace par_cell with these (name, cell, layer) rows, all in group "pargp"."""
    names = tuple(r[0] for r in rows)
    placed = ParCells(
        cell=np.array([r[1] for r in rows], dtype=np.int32),
        layer=np.array([r[2] for r in rows], dtype=np.int32),
        parnme=names,
        groups=(GroupResolution(group="pargp", rule="test", mapped=len(rows), total=len(rows)),),
        summary="test placement",
        notes=(),
    )
    par = pd.DataFrame({"parnme": list(names), "pargp": ["pargp"] * len(names)})
    written = write_par_cell(placed, par, _layout(client))
    assert not hasattr(written, "reason"), written


# ---- Task 2: /link/par ----


def test_a_text_factor_pilot_point_sets_every_cell_with_a_non_zero_factor(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par1": (0, 0)})
    _pp_group(client, run)

    body = _par(client, "par1").json()

    assert body["pars"] == [
        {
            "parnme": "par1", "pargp": "pargp", "kind": "pilot_point", "layer": 0, "cell": 0,
            "cells": [0, 1, 2], "n_cells": 3, "cells_capped": False, "reason": None,
        }
    ]
    assert body["unknown"] == []


def test_a_point_never_reaching_a_cell_says_so(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par2": (2, 0)})
    # pp1 (par2) has no non-zero factor anywhere once its two weights are zero.
    fac = FAC.replace("2 0 2 0.0 1 0.75 2 0.25", "2 0 2 0.0 1 1.0 2 0.0")
    fac = fac.replace("3 0 2 0.0 1 0.5\n 2 0.5", "3 0 2 0.0 1 1.0\n 2 0.0")
    _pp_group(client, run, fac=fac.replace("5 0 2 0.0 1 0.0 2 1.0", "5 0 2 0.0 1 1.0 2 0.0"))

    row = _par(client, "par2").json()["pars"][0]

    assert (row["cells"], row["n_cells"]) == ([], 0)
    assert row["reason"] == "no cell has a non-zero factor from this pilot point in g.fac"


def test_a_grid_parameter_sets_its_cell_and_an_unplaced_one_says_why(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (2, 0)})

    placed, unplaced = _par(client, "par0", "par3").json()["pars"]

    assert (placed["kind"], placed["cell"], placed["layer"], placed["cells"]) == ("cell", 2, 0, [2])
    assert (placed["n_cells"], placed["cells_capped"], placed["reason"]) == (1, False, None)
    assert (unplaced["kind"], unplaced["cell"], unplaced["layer"], unplaced["cells"]) == ("unplaced", -1, -1, [])
    assert unplaced["n_cells"] == 0
    assert unplaced["reason"] == "no cell is recorded for this parameter: test"


def test_a_binary_group_point_sets_only_its_own_cell_and_says_why(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par1": (1, 0)})
    _pp_group(client, run, fmt="binary")

    row = _par(client, "par1").json()["pars"][0]

    assert (row["kind"], row["cells"], row["n_cells"], row["cells_capped"]) == ("pilot_point", [1], 1, False)
    assert row["reason"] == BINARY_REASON


def test_without_an_open_run_folder_a_point_sets_its_own_cell_with_the_reason(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par1": (1, 0)})
    _pp_group(client, run)
    client.pesto_app.state.initial_run_dir = None

    row = _par(client, "par1").json()["pars"][0]

    assert row["cells"] == [1]
    assert row["reason"] == link.NO_RUN_DIR


def test_a_point_reaching_more_cells_than_the_outline_cap_is_cut_and_says_so(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {})
    n = link.OUTLINE_MAX_CELLS + 5
    lines = "".join(f"{node} 0 1 0.0 1 1.0\n" for node in range(1, n + 1))
    _pp_group(client, run, fac="pp.dat\nzone.dat\n1 5\n2\npp0\npp1\n" + lines)

    row = _par(client, "par1").json()["pars"][0]

    assert row["cells"] == list(range(link.OUTLINE_MAX_CELLS))
    assert row["n_cells"] == n
    assert row["cells_capped"] is True


def test_answers_follow_the_names_as_given_and_unknown_names_are_listed(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (0, 0)})

    body = _par(client, "par2", "nope", "par0", "../../g.fac").json()

    assert [p["parnme"] for p in body["pars"]] == ["par2", "par0"]
    # A name that looks like a path is only a name that is not in the run.
    assert body["unknown"] == ["nope", "../../g.fac"]


def test_a_name_with_a_comma_and_spaces_is_matched_exactly(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    _write_pars(client, [("a,b c", 1, 0), ("a", 2, 0)])

    exact = _par(client, "a,b c").json()
    split = _par(client, "b c").json()

    assert [(p["parnme"], p["cells"]) for p in exact["pars"]] == [("a,b c", [1])]
    assert split["pars"] == [] and split["unknown"] == ["b c"]


@pytest.mark.parametrize(
    ("names", "says"),
    [
        ("par0", "a JSON list of parameter names"),
        ('{"a": 1}', "a JSON list of parameter names"),
        ("[1, 2]", "a JSON list of parameter names"),
        ("[]", "at least one"),
        (json.dumps([f"par{i}" for i in range(51)]), "at most 50"),
    ],
)
def test_names_it_cannot_use_are_422_with_the_reason(tmp_path, in_process, names, says):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    response = client.get("/api/run/link/par", params={"names": names})

    assert response.status_code == 422
    assert says in response.json()["detail"]


def test_a_run_with_no_parameter_placement_lists_every_name_unknown_with_the_reason(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    layout = _layout(client)
    manifest = Manifest.load(layout)
    del manifest.artifacts["par_cell"]
    manifest.save(layout)

    body = _par(client, "par0").json()

    assert body["pars"] == [] and body["unknown"] == ["par0"]
    assert body["reason"] == "no parameter placement was ingested for this run"


def test_a_placement_the_last_ingest_failed_is_not_read_for_names(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    layout = _layout(client)
    manifest = Manifest.load(layout)
    manifest.mark_failed("par_cell", "the control file could not be read")
    manifest.save(layout)

    body = _par(client, "par0").json()

    assert body["pars"] == [] and body["unknown"] == ["par0"]
    assert body["reason"] == "the control file could not be read"


# ---- Task 3: /link/sites ----

ICPL_A = "oname:hds_otype:lst_usecol:icpl-a"
ICPL_B = "oname:hds_otype:lst_usecol:icpl-b"
XY_C = "oname:hds_otype:lst_usecol:xy-c"


def _ids(client, *names):
    return [site_id(client.pesto_app.state.cache_root, n) for n in names]


def _sites(client, ids, iteration=0):
    return client.get("/api/run/link/sites", params={"sites": ",".join(str(i) for i in ids), "iteration": iteration})


def test_each_site_comes_back_where_it_is_in_the_order_asked(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    ids = _ids(client, XY_C, HEAD_SITE, ICPL_A)

    body = _sites(client, ids).json()

    assert body["iteration"] == 0
    assert [(s["site_id"], s["site"], s["group"]) for s in body["sites"]] == [
        (ids[0], XY_C, "gw_xy"), (ids[1], HEAD_SITE, "gw_head"), (ids[2], ICPL_A, "gw_icpl"),
    ]
    assert [(s["layer"], s["cell"], s["placed"]) for s in body["sites"]] == [(0, 1, True), (-1, -1, False), (0, 0, True)]
    assert all(s["has_value"] is True for s in body["sites"])
    assert body["value_reason"] is None
    assert body["value_rule"] == (
        "a site has a value when at least one of its observations has a usable ensemble mean in this iteration"
    )
    assert body["unknown"] == []


def test_a_site_of_unknown_layer_with_a_cell_is_placed(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    row = _sites(client, _ids(client, ICPL_B)).json()["sites"][0]

    assert (row["layer"], row["cell"], row["placed"]) == (-1, 2, True)


def test_a_site_whose_every_mean_is_a_sentinel_has_no_value(tmp_path, in_process):
    dry = {0: [(ICPL_B, name) for name in survivor_names()]}
    client, _ = open_obs_run(tmp_path, **GRID_RUN, sentinel_values=dry)

    body = _sites(client, _ids(client, ICPL_B, ICPL_A)).json()

    assert [s["has_value"] for s in body["sites"]] == [False, True]
    assert body["value_reason"] is None


def test_an_iteration_with_no_statistics_gives_every_site_a_null_value_with_the_reason(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    body = _sites(client, _ids(client, ICPL_A, HEAD_SITE), iteration=3).json()

    assert [s["has_value"] for s in body["sites"]] == [None, None]
    assert body["value_reason"] == "no observation statistics for iteration 3"
    # Where each site is does not depend on the iteration.
    assert [s["cell"] for s in body["sites"]] == [0, -1]


def test_an_unknown_site_id_is_listed(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    known = _ids(client, ICPL_A)[0]

    body = _sites(client, [99_999, known]).json()

    assert [s["site_id"] for s in body["sites"]] == [known]
    assert body["unknown"] == [99_999]


@pytest.mark.parametrize(
    ("sites", "says"),
    [
        (",".join(["1"] * 201), "at most 200"),
        ("1,x", "whole numbers"),
        ("", "whole numbers"),
    ],
)
def test_site_ids_it_cannot_use_are_422_with_the_reason(tmp_path, in_process, sites, says):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)

    response = client.get("/api/run/link/sites", params={"sites": sites, "iteration": 0})

    assert response.status_code == 422
    assert says in response.json()["detail"]


def test_a_run_with_no_observation_placement_lists_every_id_unknown_with_the_reason(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    layout = _layout(client)
    manifest = Manifest.load(layout)
    del manifest.artifacts["obs_cell"]
    manifest.save(layout)

    body = _sites(client, [1]).json()

    assert body["sites"] == [] and body["unknown"] == [1]
    assert body["reason"] == "no observation placement was ingested for this run"


def test_a_site_placement_the_last_ingest_failed_is_not_read_for_ids(tmp_path, in_process):
    client, _ = open_obs_run(tmp_path, **GRID_RUN)
    layout = _layout(client)
    manifest = Manifest.load(layout)
    manifest.mark_failed("obs_cell", "the grid could not be read")
    manifest.save(layout)

    body = _sites(client, [1]).json()

    assert body["sites"] == [] and body["unknown"] == [1]
    assert body["reason"] == "the grid could not be read"


def test_every_link_route_leaves_the_run_and_the_cache_untouched(tmp_path, in_process):
    client, run = open_obs_run(tmp_path, **GRID_RUN)
    _place_pars(client, {"par0": (1, 0), "par1": (0, 0)})
    _pp_group(client, run)
    cache_root = Path(client.pesto_app.state.cache_root)
    run_before = _snapshot(run.root)
    cache_before = _snapshot(cache_root)

    assert client.get("/api/run/link/cell", params={"layer": 0, "cells": "0,1"}).status_code == 200
    assert _par(client, "par1", "par0", "nope").status_code == 200
    assert _sites(client, _ids(client, ICPL_A, ICPL_B, HEAD_SITE)).status_code == 200
    assert _sites(client, _ids(client, ICPL_A), iteration=3).status_code == 200

    assert _snapshot(run.root) == run_before
    assert _snapshot(cache_root) == cache_before
