"""Prove every generated fixture shape before anything is tested against it.

This is test infrastructure being tested, and it earns its place for one
reason: if the generator is wrong, every reader test in this phase's other
plans is green against a lie. Every test here stays free of the ``slow``
marker -- none of it touches data outside ``tmp_path``.
"""

from __future__ import annotations

import csv

import numpy as np
import pyemu
import pytest

from .fixtures import (
    MISSING_FILE,
    control_ordered_names,
    hash_ordered_names,
    make_run,
    sample_values,
    survivor_names,
    write_control_file,
    write_csv_ensemble,
    write_dense_ensemble,
    write_jcb_ensemble,
    write_legacy_jcb_ensemble,
    write_variable_major_csv_ensemble,
)


def _read_header_triplet(path):
    with open(path, "rb") as f:
        header = np.fromfile(f, pyemu.Matrix.binary_header_dt, 1)[0]
    return int(header["itemp1"]), int(header["itemp2"]), int(header["icount"])


def _read_csv_grid(path):
    """A plain list-of-lists read of a CSV file, no pandas needed here."""
    with open(path, newline="") as f:
        return list(csv.reader(f))


# ---------------------------------------------------------------------------
# Header dialect, asserted from the file's own bytes
# ---------------------------------------------------------------------------


def test_dense_header_has_a_zero_first_value_and_matching_second_and_third(tmp_path):
    values = sample_values(3, 4)
    path = write_dense_ensemble(
        tmp_path / "d.bin", values, survivor_names()[:3], control_ordered_names("p", 4)
    )

    itemp1, itemp2, icount = _read_header_triplet(path)

    assert itemp1 == 0
    assert itemp2 == icount


def test_modern_coo_header_first_value_is_positive(tmp_path):
    values = sample_values(3, 4)
    path = write_jcb_ensemble(
        tmp_path / "j.jcb", values, survivor_names()[:3], control_ordered_names("p", 4)
    )

    itemp1, _, _ = _read_header_triplet(path)

    assert itemp1 > 0


def test_legacy_coo_header_first_value_is_negative(tmp_path):
    values = sample_values(3, 4)
    path = write_legacy_jcb_ensemble(
        tmp_path / "l.jcb", values, survivor_names()[:3], control_ordered_names("p", 4)
    )

    itemp1, _, _ = _read_header_triplet(path)

    assert itemp1 < 0


# ---------------------------------------------------------------------------
# Round trip: each writer returns to the values it was written from
# ---------------------------------------------------------------------------


def test_dense_ensemble_round_trips_exactly(tmp_path):
    values = sample_values(4, 5)
    real_names = survivor_names()
    entity_names = control_ordered_names("p", 5)
    path = write_dense_ensemble(tmp_path / "d.bin", values, real_names, entity_names)

    matrix = pyemu.Matrix.from_binary(str(path))

    assert np.array_equal(matrix.x.astype(np.float32), values.astype(np.float32))
    assert [n.lower() for n in real_names] == list(matrix.row_names)
    assert [n.lower() for n in entity_names] == list(matrix.col_names)


def test_modern_jcb_ensemble_round_trips_exactly(tmp_path):
    values = sample_values(4, 5, seed=1)
    real_names = survivor_names()
    entity_names = control_ordered_names("p", 5)
    path = write_jcb_ensemble(tmp_path / "j.jcb", values, real_names, entity_names)

    matrix = pyemu.Matrix.from_binary(str(path))

    assert np.array_equal(matrix.x.astype(np.float32), values.astype(np.float32))
    assert [n.lower() for n in real_names] == list(matrix.row_names)
    assert [n.lower() for n in entity_names] == list(matrix.col_names)


def test_legacy_jcb_ensemble_round_trips_exactly(tmp_path):
    values = sample_values(4, 5, seed=2)
    real_names = survivor_names()
    entity_names = control_ordered_names("p", 5)
    path = write_legacy_jcb_ensemble(tmp_path / "l.jcb", values, real_names, entity_names)

    matrix = pyemu.Matrix.from_binary(str(path))

    assert np.array_equal(matrix.x.astype(np.float32), values.astype(np.float32))
    assert [n.lower() for n in real_names] == list(matrix.row_names)
    assert [n.lower() for n in entity_names] == list(matrix.col_names)


def test_csv_ensemble_round_trips_exactly(tmp_path):
    values = sample_values(4, 3, seed=3)
    real_names = survivor_names()
    entity_names = control_ordered_names("p", 3)
    path = write_csv_ensemble(tmp_path / "c.csv", values, real_names, entity_names)

    rows = _read_csv_grid(path)
    header, data_rows = rows[0], rows[1:]

    assert header[1:] == entity_names
    read_real_names = [row[0] for row in data_rows]
    read_values = np.array([[float(x) for x in row[1:]] for row in data_rows])

    assert read_real_names == real_names
    assert np.array_equal(read_values.astype(np.float32), values.astype(np.float32))


def test_variable_major_csv_is_genuinely_transposed_on_disk(tmp_path):
    values = sample_values(4, 3, seed=4)
    real_names = survivor_names()
    entity_names = control_ordered_names("p", 3)
    path = write_variable_major_csv_ensemble(tmp_path / "vm.csv", values, real_names, entity_names)

    rows = _read_csv_grid(path)
    header, data_rows = rows[0], rows[1:]

    # The point of this shape: the first *data* column header is a
    # realization name, not an entity name -- proving the file is
    # transposed on disk and not merely relabelled.
    assert header[1:] == real_names
    read_entity_names = [row[0] for row in data_rows]
    read_values = np.array([[float(x) for x in row[1:]] for row in data_rows])

    assert read_entity_names == entity_names
    # read_values is (n_entity, n_real); transpose back to compare against
    # the realization-major values it was written from.
    assert np.array_equal(read_values.T.astype(np.float32), values.astype(np.float32))


# ---------------------------------------------------------------------------
# The sparse-writer subtlety: exact zeros are dropped, then reconstructed
# ---------------------------------------------------------------------------


def test_modern_coo_drops_exact_zeros_and_from_binary_reconstructs_them(tmp_path):
    values = sample_values(3, 3, seed=5)
    values[1, 1] = 0.0
    real_names = survivor_names()[:3]
    entity_names = control_ordered_names("p", 3)
    path = write_jcb_ensemble(tmp_path / "j.jcb", values, real_names, entity_names)

    _, _, icount = _read_header_triplet(path)
    matrix = pyemu.Matrix.from_binary(str(path))

    assert icount < values.size
    assert matrix.x[1, 1] == 0.0
    assert np.array_equal(matrix.x, values)


def test_legacy_coo_drops_exact_zeros_and_from_binary_reconstructs_them(tmp_path):
    values = sample_values(3, 3, seed=6)
    values[0, 2] = 0.0
    real_names = survivor_names()[:3]
    entity_names = control_ordered_names("p", 3)
    path = write_legacy_jcb_ensemble(tmp_path / "l.jcb", values, real_names, entity_names)

    _, _, icount = _read_header_triplet(path)
    matrix = pyemu.Matrix.from_binary(str(path))

    assert icount < values.size
    assert matrix.x[0, 2] == 0.0
    assert np.array_equal(matrix.x, values)


# ---------------------------------------------------------------------------
# Control-file round trip
# ---------------------------------------------------------------------------


def test_control_file_round_trips_negative_noptmax_options_and_metadata(tmp_path):
    par_names = control_ordered_names("p", 3)
    obs_names = control_ordered_names("o", 2)
    path, obs_data_path = write_control_file(
        tmp_path / "case.pst",
        par_names=par_names,
        obs_names=obs_names,
        noptmax=-1,
        pestpp_options={"ies_parameter_ensemble": "prior_pe.jcb"},
    )

    reloaded = pyemu.Pst(str(path))

    assert reloaded.control_data.noptmax == -1
    assert reloaded.pestpp_options.get("ies_parameter_ensemble") == "prior_pe.jcb"
    assert "id" in reloaded.observation_data.columns
    assert "standard_deviation" in reloaded.observation_data.columns
    assert obs_data_path.exists()


def test_leading_space_header_misses_exact_lookup_but_stripped_lookup_finds_it(tmp_path):
    par_names = control_ordered_names("p", 2)
    obs_names = control_ordered_names("o", 2)
    _, obs_data_path = write_control_file(
        tmp_path / "case.pst",
        par_names=par_names,
        obs_names=obs_names,
        standard_deviation_header=" ",
    )

    header_line = obs_data_path.read_text().splitlines()[0]
    columns = header_line.split(",")

    assert "standard_deviation" not in columns
    assert " standard_deviation" in columns
    assert any(c.strip() == "standard_deviation" for c in columns)


def test_leading_space_header_leaves_data_rows_untouched(tmp_path):
    par_names = control_ordered_names("p", 2)
    obs_names = control_ordered_names("o", 2)

    _, plain_obs_csv = write_control_file(
        tmp_path / "plain.pst", par_names=par_names, obs_names=obs_names
    )
    _, switched_obs_csv = write_control_file(
        tmp_path / "switched.pst",
        par_names=par_names,
        obs_names=obs_names,
        standard_deviation_header=" ",
    )

    plain_rows = plain_obs_csv.read_text().splitlines()[1:]
    switched_rows = switched_obs_csv.read_text().splitlines()[1:]

    assert plain_rows == switched_rows


# ---------------------------------------------------------------------------
# make_run's inventory
# ---------------------------------------------------------------------------


def test_make_run_inventory_contains_every_expected_file(tmp_path):
    run = make_run(tmp_path, noptmax=-1, iterations=(0,))

    expected_names = {
        "case.pst",
        "case.0.par.jcb",
        "case.0.obs.jcb",
        "case.phi.actual.csv",
        "case.phi.meas.csv",
        "case.phi.regul.csv",
        "case.phi.composite.csv",
        "case.phi.group.csv",
        "case.phi.lambda.csv",
        "case.0.pdc.csv",
        "case.0.pcs.csv",
        "case.0.reinflate.pcs.csv",
        "coarse.disv.grb",
        "factors.coarse.boundary.layer10.bin",
        "case.adjusted.weights.bin",
    }
    existing_names = {p.name for p in tmp_path.iterdir()}

    assert expected_names <= existing_names
    assert run.case == "case"
    assert run.pst_path.exists()


def test_make_run_missing_file_sentinel_names_but_does_not_create(tmp_path):
    run = make_run(tmp_path, starting_par_en=MISSING_FILE, iterations=(0,))

    assert run.starting_par_en is not None
    assert not run.starting_par_en.exists()

    pst_text = run.pst_path.read_text()
    assert "ies_parameter_ensemble" in pst_text


def test_make_run_writes_the_grid_file_without_a_case_prefix(tmp_path):
    run = make_run(tmp_path, case="escondida", iterations=(0,))

    assert run.grid_path.name == "coarse.disv.grb"
    assert not run.grid_path.name.startswith("escondida")
    assert run.grid_path.exists()


def test_hash_ordered_names_permutation_is_neither_control_nor_sorted_order(tmp_path):
    control = control_ordered_names("p", 50)
    hashed = hash_ordered_names("p", 50)

    assert hashed != control
    assert hashed != sorted(control)
    assert set(hashed) == set(control)
    assert hash_ordered_names("p", 50) == hashed
