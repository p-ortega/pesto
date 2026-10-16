"""Correctness checks that sit beside the speed limits: the answer has to be right before its speed counts."""

from __future__ import annotations

import numpy as np
import pytest
from ingest.fixtures import make_run, sample_values, write_jcb_ensemble

FILE_SHAPES = ("jcb", "legacy_jcb", "dense", "csv", "variable_major_csv")


def _stored_by_name(run_dir, cache_root, par_names):
    """Ingest a run; return realization names and {name: values}, values lined up to par_names by name."""
    from pesto.cache.layout import CacheLayout
    from pesto.ingest.ensembles import load_stored, read_realization_field
    from pesto.ingest.failures import ReadFailure
    from pesto.ingest.runner import ingest_run

    ingest_run(run_dir, cache_root=cache_root)
    stored = load_stored(0, CacheLayout(root=cache_root))
    assert not isinstance(stored, ReadFailure), f"load_stored failed: {stored.reason}"
    assert sorted(stored.par_names) == sorted(par_names), "the stored parameter names differ from the written ones"
    where = {name: i for i, name in enumerate(stored.par_names)}
    by_name = np.array([where[name] for name in par_names])
    values = {}
    for name in stored.real_names:
        field = read_realization_field(stored, name)
        assert not isinstance(field, ReadFailure), f"read of {name!r} failed: {field.reason}"
        values[name] = field[by_name]
    return list(stored.real_names), values


@pytest.mark.slow
def test_every_file_shape_gives_identical_values(tmp_path):
    """The fixture values are exact in float32, so every shape, text ones included, must match bit for bit."""
    results = {}
    written_names = {}
    for shape in FILE_SHAPES:
        run_dir = tmp_path / shape
        run_dir.mkdir()
        run = make_run(run_dir, ensemble_format=shape, n_real=20, n_par=300)
        written_names[shape] = list(run.real_names)
        results[shape] = _stored_by_name(run_dir, tmp_path / f"cache-{shape}", run.par_names)

    first_shape = FILE_SHAPES[0]
    first_names, first_values = results[first_shape]
    source = sample_values(20, 300, seed=0).astype(np.float32)
    for row, name in enumerate(written_names[first_shape]):
        assert np.array_equal(first_values[name], source[row]), f"{first_shape}: {name!r} is not its source row"
    for shape, (names, values) in results.items():
        assert names == written_names[shape], f"{shape}: names or their order changed on ingest"
        assert names == first_names, f"{shape}: lists different realizations than {first_shape}"
        for name in first_names:
            assert np.array_equal(values[name], first_values[name]), (
                f"{shape}: realization {name!r} differs from {first_shape}"
            )


@pytest.mark.slow
def test_dropped_realizations_still_line_up_by_name(tmp_path):
    from pesto.cache.layout import CacheLayout
    from pesto.ingest.ensembles import align_realizations, load_stored, read_realization_field
    from pesto.ingest.failures import ReadFailure
    from pesto.ingest.runner import ingest_run

    run_dir = tmp_path / "run"
    run_dir.mkdir()
    run = make_run(run_dir, n_real=20, n_par=200)

    rng = np.random.default_rng(7)
    kept_rows = [int(i) for i in rng.permutation(20)[:11]]
    kept_names = [run.real_names[i] for i in kept_rows]
    source = sample_values(20, 200, seed=1)
    write_jcb_ensemble(run.par_ens[1], source[kept_rows], kept_names, run.par_names)

    cache_root = tmp_path / "cache"
    ingest_run(run_dir, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    stored0 = load_stored(0, layout)
    stored1 = load_stored(1, layout)
    for stored in (stored0, stored1):
        assert not isinstance(stored, ReadFailure), stored.reason

    alignment = align_realizations(stored0.real_names, stored1.real_names)
    assert set(alignment.names) == set(kept_names)
    assert len(alignment.names) == 11
    assert set(alignment.only_a) == set(run.real_names) - set(kept_names)
    assert len(alignment.only_a) == 9
    assert alignment.only_b == ()
    for name, i_a, i_b in zip(alignment.names, alignment.index_a, alignment.index_b):
        assert stored0.real_names[i_a] == name
        assert stored1.real_names[i_b] == name

    where = {name: i for i, name in enumerate(stored1.par_names)}
    by_name = np.array([where[name] for name in run.par_names])
    for name, row in zip(kept_names, kept_rows):
        got = read_realization_field(stored1, name)
        assert not isinstance(got, ReadFailure), got.reason
        assert np.array_equal(got[by_name], source[row].astype(np.float32)), f"{name!r} does not hold its own row"


def _read_or_skip(path):
    from pesto.ingest.ensfile import read_ensemble
    from pesto.ingest.failures import ReadFailure

    if not path.is_file():
        pytest.skip(f"benchmark file not found: {path}")
    data = read_ensemble(path)
    assert not isinstance(data, ReadFailure), f"could not read {path}: {data.reason}"
    return data


def _shared_rows(a, b, max_real, max_par):
    """Pair realizations and parameters by name; return index arrays for each side."""
    from pesto.ingest.ensembles import align_realizations

    pairs = align_realizations(a.real_names, b.real_names)
    if not pairs.names:
        pytest.fail("cannot judge: the two files share no realization name")
    in_b = {name: i for i, name in enumerate(b.entity_names)}
    shared = [(i, in_b[name]) for i, name in enumerate(a.entity_names) if name in in_b]
    if not shared:
        pytest.fail("cannot judge: the two files share no parameter name")
    shared = shared[:max_par]
    cols_a = np.array([i for i, _ in shared])
    cols_b = np.array([j for _, j in shared])
    rows = list(zip(pairs.index_a, pairs.index_b))[:max_real]
    return pairs, rows, cols_a, cols_b


@pytest.mark.slow
def test_the_two_benchmark_runs_are_refused_a_join(forecast_run, hm_run):
    """Same realization names, different draws: matching names alone must not join two runs."""
    fed_in = _read_or_skip(forecast_run / "pt_pe_forecast.jcb")
    iteration_1 = _read_or_skip(hm_run / "escondida.1.par.jcb")

    _pairs, rows, cols_a, cols_b = _shared_rows(fed_in, iteration_1, max_real=40, max_par=200)
    for row_a, row_b in rows:
        same = np.array_equal(fed_in.values[row_a, cols_a], iteration_1.values[row_b, cols_b])
        assert not same, f"realization {fed_in.real_names[row_a]!r} holds identical values in both files"


@pytest.mark.slow
def test_genuine_ancestry_is_detected_by_values(forecast_run):
    """The forecast's fed-in ensemble and the one it used are the same draws, and the values say so."""
    fed_in = _read_or_skip(forecast_run / "pt_pe_forecast.jcb")
    used = _read_or_skip(forecast_run / "escondida.0.par.bin")

    assert set(fed_in.real_names) == set(used.real_names)
    _pairs, rows, cols_a, cols_b = _shared_rows(fed_in, used, max_real=40, max_par=2000)
    for row_a, row_b in rows:
        assert np.array_equal(fed_in.values[row_a, cols_a], used.values[row_b, cols_b]), (
            f"realization {fed_in.real_names[row_a]!r} differs between the fed-in and used ensembles"
        )
