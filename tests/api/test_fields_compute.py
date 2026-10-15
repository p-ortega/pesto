"""Field computation against pyemu's own fac2real as the oracle, the
by-name value read from both ensemble blocks, the memo and the readout's
contributors."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pesto.api.fields import compute_field, contributors, memo_field, point_values, stat_values
from pesto.cache.layout import CacheLayout
from pesto.ingest.aggregate import write_par_agg
from pesto.ingest.control import ControlTables
from pesto.ingest.ensembles import load_stored, write_par_ensemble
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.failures import ReadFailure
from pesto.ingest.ppfactors import PpGroup
from pesto.model import GridShape, GroupResolution, ParCells

FAC = """pp.dat
zone.dat
1 5
2
pp0
pp1
1 0 2 0.0 1 1.0 2 0.0
2 0 2 0.0 1 0.75 2 0.25
3 0 2 0.0 1 0.5
 2 0.5
5 0 2 0.0 1 0.0 2 1.0
"""
FAC_LOG = FAC.replace(" 0 2 0.0", " 1 2 0.0")
SHAPE = GridShape(ncpl=5, nlay=1, nrow=None, ncol=None)
NAMES = ["q", "p8", "r", "p9"]  # pilot points not first and not contiguous
GROUPS = ["G1", "G4", "G1", "G4"]
REALS = ("base", "34", "x")


def _group(run: Path, fac: str = FAC) -> PpGroup:
    (run / "g.fac").write_text(fac)
    return PpGroup(
        group="G4", layer=0, factor_file="g.fac", format="text",
        parnames=("p8", "p9"), pp_names=("pp0", "pp1"), log_space=(fac is FAC_LOG), n_cells=4,
    )


def _stored(tmp_path: Path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    values = np.array([[1, 10, 3, 20], [2, 30, 4, 40], [5, 0.1, 6, 1000]], dtype=np.float32)
    data = EnsembleData(
        values=values, real_names=REALS, entity_names=tuple(NAMES), source_path=Path("c.0.par.jcb"),
        on_disk_format="dense", orientation="realization_major", orientation_decided_by="dimensions",
        contiguous=True, permutation=tuple(range(4)), hash_ordered=False, notes=(),
    )
    tables = ControlTables(
        par=pd.DataFrame({"parnme": NAMES, "pargp": GROUPS, "partrans": ["none"] * 4, "parlbnd": [0.0] * 4, "parubnd": [1e3] * 4}),
        obs=pd.DataFrame({"obsnme": [], "obgnme": [], "weight": []}),
        par_groups=("G1", "G4"), obs_groups=(), source_path=Path("c.pst"), notes=(), ambiguities=(),
    )
    cells = ParCells(
        cell=np.array([0, -1, 1, -1], dtype=np.int32), layer=np.zeros(4, dtype=np.int32), parnme=tuple(NAMES),
        groups=(GroupResolution("G1", "test", 2, 2), GroupResolution("G4", "unmapped", 0, 2)), summary="", notes=(),
    )
    written = write_par_ensemble(
        data, tables, mappable=frozenset({"G1"}), iteration=0, layout=layout, cells=cells
    )
    assert not isinstance(written, ReadFailure)
    assert not isinstance(write_par_agg(data, tables, 0, layout), ReadFailure)
    return layout, load_stored(0, layout)


def test_point_values_are_read_by_name_from_the_nomap_block(tmp_path):
    _, stored = _stored(tmp_path)
    assert point_values(stored, ("p8", "p9"), "34").tolist() == [30.0, 40.0]
    assert point_values(stored, ("p9", "p8"), "base").tolist() == [20.0, 10.0]


def test_point_values_are_read_by_name_from_the_map_block_too(tmp_path):
    _, stored = _stored(tmp_path)
    assert point_values(stored, ("r", "q"), "x").tolist() == [6.0, 5.0]


def test_an_unknown_name_or_realization_is_a_named_refusal(tmp_path):
    _, stored = _stored(tmp_path)
    assert "nope" in point_values(stored, ("nope",), "base").reason
    assert isinstance(point_values(stored, ("p8",), "99"), ReadFailure)


def test_stat_values_come_from_the_aggregate_by_name(tmp_path):
    layout, stored = _stored(tmp_path)
    mean = stat_values(layout, 0, ("p8", "p9"), stored, "mean")
    assert np.allclose(mean, [(10 + 30 + 0.1) / 3, (20 + 40 + 1000) / 3], rtol=1e-5)


def test_compute_field_matches_pyemu_fac2real(tmp_path):
    pyemu = pytest.importorskip("pyemu")
    group = _group(tmp_path)
    values = np.array([10.0, 20.0])
    field = compute_field(tmp_path, group, values, SHAPE)
    expected = pyemu.utils.geostats.fac2real(
        pp_file=pd.DataFrame({"name": ["pp0", "pp1"], "parval1": values}),
        factors_file=str(tmp_path / "g.fac"), try_ppu=False, fill_value=np.nan,
    ).reshape(-1)
    assert field.dtype == np.float32 and field.shape == (5,)
    assert np.allclose(field[[0, 1, 2, 4]], expected[[0, 1, 2, 4]])
    assert np.isnan(field[3])  # cell 4 has no factors
    assert field[2] == pytest.approx(15.0)  # the wrapped line interpolates like the others


def test_compute_field_interpolates_in_log_space_when_the_factors_say_so(tmp_path):
    group = _group(tmp_path, FAC_LOG)
    field = compute_field(tmp_path, group, np.array([10.0, 1000.0]), SHAPE)
    assert field[2] == pytest.approx(100.0)  # 10 ** mean(log10 10, log10 1000)


def test_compute_field_refuses_a_cell_count_that_does_not_fit_the_grid(tmp_path):
    group = _group(tmp_path)
    result = compute_field(tmp_path, group, np.array([1.0, 2.0]), GridShape(ncpl=3, nlay=1, nrow=None, ncol=None))
    assert isinstance(result, ReadFailure) and "3" in result.reason


def test_memo_field_computes_once_and_reads_back_after(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    calls = []

    def compute():
        calls.append(1)
        return np.array([1.0, np.nan], dtype=np.float32)

    first = memo_field(layout, "G4", 0, "tag1", "base", compute)
    second = memo_field(layout, "G4", 0, "tag1", "base", compute)
    assert len(calls) == 1 and np.array_equal(first, second, equal_nan=True)
    memo_field(layout, "G4", 0, "tag2", "base", compute)
    assert len(calls) == 2  # a new tag misses
    assert layout.pp_field("G4", 0, "tag1", "base").is_file()


def test_contributors_name_the_points_behind_a_cell_largest_weight_first(tmp_path):
    group = _group(tmp_path)
    assert contributors(tmp_path, group, 1) == [("p8", 0.75), ("p9", 0.25)]
    assert contributors(tmp_path, group, 2) == [("p8", 0.5), ("p9", 0.5)]
    assert contributors(tmp_path, group, 3) == []


def test_compute_field_applies_a_binary_factor_file_through_pypestutils(tmp_path):
    pytest.importorskip("pypestutils")
    from pypestutils.pestutilslib import PestUtilsLib

    PestUtilsLib().calc_kriging_factors_2d(
        np.array([1.5, 4.5]), np.array([0.5, 0.5]), 1,
        np.arange(6) + 0.5, np.full(6, 0.5), 1,
        "exp", "ordinary", 10.0, 1.0, 0.0, 100.0, 2, 1,
        str(tmp_path / "factors.b.layer0.bin"), "binary",
    )
    group = PpGroup(
        group="B", layer=0, factor_file="factors.b.layer0.bin", format="binary",
        parnames=("q1", "q2"), pp_names=("pa", "pb"), log_space=False, n_cells=6,
    )
    field = compute_field(tmp_path, group, np.array([10.0, 20.0]), GridShape(ncpl=6, nlay=1, nrow=None, ncol=None))
    assert not isinstance(field, ReadFailure), field
    assert field.dtype == np.float32 and field.shape == (6,)
    assert np.all((field >= 10.0 - 1e-4) & (field <= 20.0 + 1e-4))
    assert field[1] == pytest.approx(10.0, abs=1e-3) and field[4] == pytest.approx(20.0, abs=1e-3)
    assert field[1] < field[2] < field[3] < field[4]
