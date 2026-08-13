"""End-to-end proof that a run directory reads to realization-major float32.

Drives ``discover -> read_control -> read_ensemble`` on a synthetic run
directory built with pyemu's own control-file and dense-matrix writers, and
proves READ-04 (names come from inside the file, never renumbered) plus the
per-artifact failure isolation D-06 promises: a corrupt ensemble file costs
one artifact, and the rest of the run still reads.
"""

from __future__ import annotations

import numpy as np
import pyemu
import pytest

from pesto.ingest.control import ControlTables, read_control
from pesto.ingest.discover import discover
from pesto.ingest.ensfile import EnsembleData, read_ensemble
from pesto.ingest.failures import ReadFailure

_REAL_NAMES = ["base", "34", "35", "176"]


def _write_synthetic_run(tmp_path, case="case", n_par=5, n_obs=3, noptmax=-1):
    """Build a synthetic pestpp-ies-shaped run directory under ``tmp_path``.

    The control file is written with ``pyemu.Pst.from_par_obs_names`` and
    ``.write(..., version=2)`` -- verified to produce a keyword-format
    control file with external parameter and observation data sections
    whose shape matches real benchmark control files. The ensemble is
    written beside it as ``{case}.0.par.bin`` with
    ``pyemu.Matrix.write_dense``, using realization names chosen so a test
    can prove READ-04.
    """
    par_names = [f"par{i}" for i in range(n_par)]
    obs_names = [f"obs{i}" for i in range(n_obs)]
    pst = pyemu.Pst.from_par_obs_names(par_names=par_names, obs_names=obs_names)
    pst.control_data.noptmax = noptmax
    pst_path = tmp_path / f"{case}.pst"
    pst.write(str(pst_path), version=2)

    data = np.arange(len(_REAL_NAMES) * n_par, dtype=np.float64).reshape(len(_REAL_NAMES), n_par)
    ens_path = tmp_path / f"{case}.0.par.bin"
    pyemu.Matrix.write_dense(
        str(ens_path), row_names=_REAL_NAMES, col_names=par_names, data=data, close=True
    )
    return pst_path, ens_path, par_names


def test_a_run_directory_reads_end_to_end_to_realization_major_float32(tmp_path):
    pst_path, ens_path, par_names = _write_synthetic_run(tmp_path)

    layout = discover(tmp_path)
    assert layout.pst_path == pst_path
    assert layout.case == "case"
    assert layout.par_ens[0] == ens_path

    tables = read_control(layout.pst_path)
    assert isinstance(tables, ControlTables)

    record = read_ensemble(layout.par_ens[0], tables)
    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert record.values.shape == (len(_REAL_NAMES), len(par_names))
    assert record.real_names == tuple(_REAL_NAMES)
    assert record.real_names[1] == "34"
    assert record.orientation_decided_by == "dimensions"

    expected = np.arange(len(_REAL_NAMES) * len(par_names), dtype=np.float32).reshape(
        len(_REAL_NAMES), len(par_names)
    )
    assert np.array_equal(record.values, expected)


def test_a_corrupt_ensemble_file_costs_one_artifact_not_the_whole_run(tmp_path):
    _, ens_path, _ = _write_synthetic_run(tmp_path)
    ens_path.write_bytes(b"not a real ensemble file, just some junk bytes")

    layout = discover(tmp_path)
    result = read_ensemble(layout.par_ens[0])

    assert isinstance(result, ReadFailure)
    assert result.name == ens_path.name
    assert result.reason

    tables = read_control(layout.pst_path)
    assert isinstance(tables, ControlTables)


@pytest.mark.slow
def test_the_same_path_reads_a_real_pestpp_ies_run(forecast_run):
    """The identical tracer path against a real benchmark directory: finds
    the control file, reports the real ``noptmax``, and returns realization
    names taken from inside the file rather than stringified indices
    (READ-04, stated as a real behaviour rather than a tautology)."""
    layout = discover(forecast_run)
    assert layout.case == "escondida"
    assert layout.noptmax == -1
    assert 0 in layout.par_ens
    assert layout.par_ens[0].name == "escondida.0.par.bin"

    tables = read_control(layout.pst_path)
    assert isinstance(tables, ControlTables)
    assert len(tables.par) > 0
    for column in ("pargp", "parlbnd", "parubnd", "partrans"):
        assert column in tables.par.columns

    record = read_ensemble(layout.par_ens[0], tables)
    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert record.values.shape[1] == len(tables.par)
    assert record.orientation_decided_by == "dimensions"
    assert len(record.real_names) > 0
    assert record.real_names != tuple(str(i) for i in range(len(record.real_names)))


@pytest.mark.slow
def test_reading_a_real_run_never_writes_to_it(forecast_run):
    """The mechanical form of this plan's safety prohibition: a run
    directory is somebody's finished calibration output, and pesto's only
    relationship with it is reading. Snapshot every entry directly inside
    the run directory before the tracer path runs, and assert nothing was
    created, removed, resized or re-timestamped afterwards."""
    before = {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in forecast_run.iterdir()
    }

    layout = discover(forecast_run)
    tables = read_control(layout.pst_path)
    read_ensemble(layout.par_ens[0], tables)

    after = {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in forecast_run.iterdir()
    }

    assert after == before
