"""GET /api/run/link/par and /link/sites: where a selected parameter or site is, read back
through a real app from a cache made by ingesting a generated run on a three-cell grid."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from pesto.api import link
from pesto.ingest.parcell import write_par_cell
from pesto.model import GroupResolution, ParCells
from pesto.cache.manifest import Manifest

from .obs_helpers import open_obs_run
from .test_fields_compute import FAC
from .test_link_routes import BINARY_NOTE, GRID_RUN, _layout, _place_pars, _pp_group, in_process  # noqa: F401

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
