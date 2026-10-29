"""Binary pypestutils factor files: a file whose targets are one layer of grid
cells becomes a group; any other file is refused with the counts."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pesto.ingest.ppfactors import build_pp_index
from pesto.model import GridShape

pytest.importorskip("pypestutils")


def _binary_run(tmp_path):
    from pypestutils.pestutilslib import PestUtilsLib

    lib = PestUtilsLib()
    ecs, ncs = np.array([1.5, 4.5]), np.array([0.5, 0.5])
    ect = np.arange(6) + 0.5
    nct = np.full(6, 0.5)
    lib.calc_kriging_factors_2d(ecs, ncs, 1, ect, nct, 1, "exp", "ordinary", 10.0, 1.0, 0.0, 100.0, 2, 1, str(tmp_path / "factors.m.bnd.layer0.bin"), "binary")
    pd.DataFrame({"ppname": ["pa", "pb"], "x": ecs, "y": ncs, "cond": [1.0, 1.0]}).to_csv(tmp_path / "ppoints.bnd.csv", index=False)
    par = pd.DataFrame(
        {"pargp": ["bnd.cond.layer1"] * 2, "ppname": ["pa", "pb"], "usecol": ["cond", "cond"]},
        index=pd.Index(["q1", "q2"], name="parnme"),
    )
    return par


def test_a_binary_factor_file_whose_targets_are_one_layer_of_cells_becomes_a_group(tmp_path):
    par = _binary_run(tmp_path)
    index = build_pp_index(tmp_path, None, (tmp_path / "factors.m.bnd.layer0.bin",), par, GridShape(ncpl=6, nlay=2, nrow=None, ncol=None))
    (group,) = index.groups
    assert group.format == "binary" and group.layer == 0
    assert group.parnames == ("q1", "q2") and group.n_cells == 6


def test_a_binary_factor_file_whose_targets_are_not_the_grid_is_refused_with_the_counts(tmp_path):
    par = _binary_run(tmp_path)
    index = build_pp_index(tmp_path, None, (tmp_path / "factors.m.bnd.layer0.bin",), par, GridShape(ncpl=9, nlay=2, nrow=None, ncol=None))
    ((_, reason),) = index.not_interpolable
    assert "6" in reason and "9" in reason


def test_a_binary_factor_file_no_group_matches_is_refused_not_dropped(tmp_path):
    par = _binary_run(tmp_path)
    par["pargp"] = ["bnd.cond.layer2"] * 2  # layer index 1, the file says layer0
    index = build_pp_index(tmp_path, None, (tmp_path / "factors.m.bnd.layer0.bin",), par, GridShape(ncpl=6, nlay=2, nrow=None, ncol=None))
    assert index.groups == ()
    ((name, reason),) = index.not_interpolable
    assert name == "factors.m.bnd.layer0.bin"
    assert "no parameter group" in reason
    assert reason.endswith("and its layer 1 (index 0)")


def test_a_points_file_whose_tag_is_only_part_of_a_name_segment_is_not_matched(tmp_path):
    par = _binary_run(tmp_path)
    pd.DataFrame({"ppname": ["pa", "pb", "pc"]}).to_csv(tmp_path / "ppoints.bn.csv", index=False)
    index = build_pp_index(tmp_path, None, (tmp_path / "factors.m.bnd.layer0.bin",), par, GridShape(ncpl=6, nlay=2, nrow=None, ncol=None))
    (group,) = index.groups
    assert group.parnames == ("q1", "q2")


def test_two_points_files_that_both_match_refuse_the_factor_file_naming_both(tmp_path):
    par = _binary_run(tmp_path)
    pd.DataFrame({"ppname": ["pa", "pb"], "cond": [1.0, 1.0]}).to_csv(tmp_path / "ppoints.m.csv", index=False)
    index = build_pp_index(tmp_path, None, (tmp_path / "factors.m.bnd.layer0.bin",), par, GridShape(ncpl=6, nlay=2, nrow=None, ncol=None))
    assert index.groups == ()
    ((name, reason),) = index.not_interpolable
    assert name == "factors.m.bnd.layer0.bin"
    assert "ppoints.bnd.csv" in reason and "ppoints.m.csv" in reason
