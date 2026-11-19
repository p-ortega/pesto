"""The built-in example run: it writes, discovery finds its files, the real
ingest reads it end to end, and writing it twice gives the same bytes."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pesto import cli
from pesto.cache.layout import CacheLayout
from pesto.example import (
    CASE,
    DROPPED,
    GRID_FILE,
    ITERATIONS,
    N_REAL,
    ensure_example_run,
    example_run_dir,
    write_example_run,
)
from pesto.ingest.discover import discover
from pesto.ingest.obscell import load_obs_cell
from pesto.ingest.obspdc import load_pdc
from pesto.ingest.parcell import load_par_cell
from pesto.ingest.phicheck import load_phi_check
from pesto.ingest.ppfactors import load_pp_index
from pesto.ingest.runner import ingest_run

CONSTANT_GROUPS = {"rchmult", "ghbcondmult", "npfk33mult", "stossmult"}


@pytest.fixture(scope="module")
def example(tmp_path_factory):
    return write_example_run(tmp_path_factory.mktemp("example") / "run")


@pytest.fixture(scope="module")
def ingested(example, tmp_path_factory):
    cache_root = tmp_path_factory.mktemp("example-cache")
    manifest = ingest_run(example, cache_root=cache_root)
    return manifest, CacheLayout(root=cache_root)


def _bytes(folder):
    return {p.relative_to(folder): p.read_bytes() for p in folder.rglob("*") if p.is_file()}


def test_discovery_finds_every_kind_of_file_the_example_writes(example):
    run = discover(example)

    assert run.case == CASE
    assert run.notes == ()
    assert run.noptmax == max(ITERATIONS)
    assert run.iterations == ITERATIONS
    assert sorted(run.par_ens) == list(ITERATIONS)
    assert sorted(run.obs_ens) == list(ITERATIONS)
    assert run.grid == example / GRID_FILE
    assert run.rec is not None and run.noise is not None and run.adjusted_weights is not None
    assert {"actual", "meas"} <= set(run.phi)
    assert 0 in run.pdc
    assert run.pcs_file(max(ITERATIONS)) is not None
    assert run.mult2model is not None
    assert len(run.factor_files) == 4


def test_the_example_is_under_thirty_megabytes(example):
    assert sum(len(content) for content in _bytes(example).values()) < 30e6


def test_writing_the_example_twice_gives_the_same_bytes(example, tmp_path):
    again = write_example_run(tmp_path / "again")
    assert _bytes(again) == _bytes(example)

    write_example_run(again)
    assert _bytes(again) == _bytes(example)


def test_later_iterations_lose_realizations_by_name(example):
    from pesto.warm import load_pyemu

    pyemu = load_pyemu()
    first = pyemu.Matrix.from_binary(str(example / f"{CASE}.0.par.bin")).row_names
    last = pyemu.Matrix.from_binary(str(example / f"{CASE}.{max(ITERATIONS)}.par.bin")).row_names
    gone = {name for names in DROPPED.values() for name in names}

    assert len(first) == N_REAL and "base" in first
    assert set(first) - set(last) == gone


def test_the_real_ingest_reads_the_example_with_nothing_failed(ingested, example):
    manifest, _layout = ingested

    states = {name: artifact.state for name, artifact in manifest.artifacts.items()}
    assert set(states.values()) == {"ok"}, {n: s for n, s in states.items() if s != "ok"}
    for kind in ("control", "grid", "elev", "par_cell", "obs_cell", "noise_agg", "pp_factors", "config"):
        assert kind in states
    for iteration in (min(ITERATIONS), max(ITERATIONS)):
        for kind in ("par_ens", "obs_ens", "pdc", "phi_check"):
            assert f"{kind}/{iteration}" in states
    # Ingest keeps its cache where it was told to, never in the run folder.
    assert not (example / ".pesto").exists()


def test_every_group_is_placed_except_the_constants(ingested):
    _manifest, layout = ingested

    cells = load_par_cell(layout)
    unplaced = {g["group"] for g in cells.groups if g["mapped"] < g["total"]}
    assert unplaced == CONSTANT_GROUPS
    rules = {g["group"]: g["rule"] for g in cells.groups}
    assert rules["npfklayer1gr"] == "ij-name-layer"
    assert rules["npfklayer1pp"] == "xyz-host-cell"

    pp = load_pp_index(layout)
    assert pp.not_interpolable == ()
    assert {g.group for g in pp.groups} == {"npfklayer1pp", "npfklayer2pp", "npfklayer3pp", "stosylayer1pp"}


def test_every_well_is_placed_on_the_grid(ingested):
    _manifest, layout = ingested

    sites = load_obs_cell(layout)
    assert len(sites.site) == 15
    assert sites.placed_sites == 15
    assert sites.layer_unknown == 0
    assert (sites.cell >= 0).all() and set(sites.layer.tolist()) == {0, 1, 2}


def test_phi_in_the_file_agrees_with_phi_from_the_cache(ingested):
    _manifest, layout = ingested

    for iteration in (min(ITERATIONS), max(ITERATIONS)):
        check = load_phi_check(iteration, layout)
        assert check.status == "checked"
        assert check.n_mismatch == 0
        assert check.n_only_in_cache == 0 and check.n_only_in_file == 0
    assert load_phi_check(0, layout).n_compared == N_REAL


def test_the_conflict_file_is_read_and_holds_a_handful_of_rows(ingested):
    _manifest, layout = ingested

    table = load_pdc(0, layout)
    assert table.source == "file"
    assert table.n_unmatched == 0
    assert 3 <= len(table.frame) <= 30


def test_the_posterior_is_narrower_than_the_prior(ingested):
    _manifest, layout = ingested

    prior = pd.read_parquet(layout.par_agg(0))
    posterior = pd.read_parquet(layout.par_agg(max(ITERATIONS)))
    assert np.median(posterior["std"]) < 0.9 * np.median(prior["std"])


def test_example_flag_writes_once_and_serves_that_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    served = []
    monkeypatch.setattr("pesto.launch.serve", lambda **kwargs: served.append(kwargs))

    assert cli.main(["--example", "--no-browser"]) == 0

    run_dir = example_run_dir()
    assert run_dir.is_relative_to(tmp_path / "pesto")
    assert served[0]["run_dir"] == run_dir
    assert (run_dir / f"{CASE}.pst").is_file()
    assert [p.name for p in run_dir.parent.iterdir()] == ["run"]

    # A second launch reuses the folder and rewrites nothing.
    stamp = (run_dir / f"{CASE}.pst").stat().st_mtime_ns
    assert ensure_example_run() == run_dir
    assert (run_dir / f"{CASE}.pst").stat().st_mtime_ns == stamp


def test_example_flag_with_a_path_is_an_error(tmp_path, capsys):
    with pytest.raises(SystemExit) as raised:
        cli.main(["--example", str(tmp_path)])

    assert raised.value.code == 2
    assert "--example" in capsys.readouterr().err
