"""Tests for ``src/pesto/ingest/ensfile.py``.

Every on-disk ensemble shape pestpp-ies writes -- dense ``.bin``, modern and
legacy ``.jcb``, realization-major and variable-major CSV -- must read to
identical realization-major float32 values, with orientation decided
honestly (dimensions first, names second, refusal when neither decides) and
unreadable files failing named rather than raising. Every fixture comes from
``tests/ingest/fixtures.py``; nothing here reads data outside ``tmp_path``.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pesto.ingest.control import ControlTables, read_control
from pesto.ingest.discover import discover
from pesto.ingest.ensfile import EnsembleData, read_ensemble, sniff
from pesto.ingest.failures import ReadFailure

from . import fixtures


def _control_tables(entity_names: list[str]) -> ControlTables:
    """A minimal ``ControlTables`` carrying only what ``read_ensemble``'s
    orientation decision needs: ``par["parnme"]`` in control-file order."""
    return ControlTables(
        par=pd.DataFrame({"parnme": list(entity_names)}),
        obs=pd.DataFrame({"obsnme": []}),
        par_groups=(),
        obs_groups=(),
        source_path=Path("unused.pst"),
        notes=(),
        ambiguities=(),
    )


# ---------------------------------------------------------------------------
# Task 1: every on-disk shape reads to realization-major float32
# ---------------------------------------------------------------------------


def test_dense_ensemble_reads_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))
    assert record.real_names == tuple(real_names)
    assert record.entity_names == tuple(entity_names)


def test_modern_jcb_ensemble_reads_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_jcb_ensemble(
        tmp_path / "case.0.par.jcb", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))


def test_legacy_jcb_ensemble_reads_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_legacy_jcb_ensemble(
        tmp_path / "case.0.par.jcb", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))


def test_realization_major_csv_reads_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))
    assert record.real_names == tuple(real_names)
    assert record.entity_names == tuple(entity_names)


def test_variable_major_csv_normalises_to_realization_major_float32(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_variable_major_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.orientation == "variable_major"
    assert record.values.dtype == np.float32
    assert np.array_equal(record.values, values.astype(np.float32))
    assert record.real_names == tuple(real_names)
    assert record.entity_names == tuple(entity_names)


def test_csv_header_whitespace_is_stripped_and_noted(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names, header_prefix=" "
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.entity_names[0] == entity_names[0]
    assert any(entity_names[0] in note for note in record.notes)


def test_sniff_decides_binary_family_from_header_bytes_not_extension(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))

    dense_path = fixtures.write_dense_ensemble(
        tmp_path / "dense.bin", values, real_names, entity_names
    )
    jcb_path = fixtures.write_jcb_ensemble(
        tmp_path / "modern.jcb", values, real_names, entity_names
    )
    legacy_path = fixtures.write_legacy_jcb_ensemble(
        tmp_path / "legacy.jcb", values, real_names, entity_names
    )
    csv_path = fixtures.write_csv_ensemble(tmp_path / "reals.csv", values, real_names, entity_names)
    variable_csv_path = fixtures.write_variable_major_csv_ensemble(
        tmp_path / "vars.csv", values, real_names, entity_names
    )

    assert sniff(dense_path) == "dense"
    assert sniff(jcb_path) == "binary"
    assert sniff(legacy_path) == "binary"
    assert sniff(csv_path) == "csv"
    assert sniff(variable_csv_path) == "csv"

    # Deliberately misnamed: a dense file wearing a .jcb extension still
    # sniffs as dense, proving the decision comes from the header bytes,
    # not the extension.
    misnamed_dense = tmp_path / "actually_dense.jcb"
    misnamed_dense.write_bytes(dense_path.read_bytes())
    assert sniff(misnamed_dense) == "dense"


def test_ensemble_with_nan_reads_successfully_and_notes_it(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    values[0, 0] = np.nan
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert np.isnan(record.values[0, 0])
    assert any("nan" in note.lower() for note in record.notes)


def test_single_realization_ensemble_returns_two_dimensional_shape(tmp_path):
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(1, len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, ["base"], entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.real_names == ("base",)
    assert record.values.shape == (1, len(entity_names))


def test_zero_byte_file_returns_read_failure(tmp_path):
    path = tmp_path / "empty.bin"
    path.write_bytes(b"")

    result = read_ensemble(path)

    assert isinstance(result, ReadFailure)
    assert result.name == "empty.bin"
    assert result.reason


def test_arbitrary_bytes_file_returns_read_failure(tmp_path):
    path = tmp_path / "junk.bin"
    path.write_bytes(b"this is not a real pest ensemble file, just junk bytes here")

    result = read_ensemble(path)

    assert isinstance(result, ReadFailure)
    assert result.name == "junk.bin"
    assert result.reason


# ---------------------------------------------------------------------------
# Task 2: decide which axis is realizations, and refuse when it cannot be
# ---------------------------------------------------------------------------


def test_realization_major_decided_by_dimensions(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 6)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.orientation == "realization_major"
    assert record.orientation_decided_by == "dimensions"


def test_variable_major_decided_by_dimensions_is_a_transposed_view(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_variable_major_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.orientation == "variable_major"
    assert record.orientation_decided_by == "dimensions"
    assert record.contiguous is False
    assert record.values.base is not None
    assert np.array_equal(record.values, values.astype(np.float32))


def test_square_ensemble_is_decided_by_names_never_dimensions(tmp_path):
    entity_names = fixtures.control_ordered_names("par", 4)
    real_names = fixtures.survivor_names()  # also length 4 -- a square ensemble
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.orientation_decided_by == "names"
    assert record.orientation == "realization_major"
    assert record.real_names == tuple(real_names)
    assert record.entity_names == tuple(entity_names)


def test_names_matching_is_case_insensitive_after_stripping(tmp_path):
    # CSV, not binary: pyemu's own binary readers already lower-case names
    # as they read, so a binary fixture would not exercise this module's
    # own case-insensitive comparison. CSV headers are only stripped, never
    # lowered, by ``_read_csv_matrix``, so the upper-cased names on disk
    # here are exactly what the orientation decision has to compare.
    entity_names_control = fixtures.control_ordered_names("par", 4)
    entity_names_on_disk = [name.upper() for name in entity_names_control]
    real_names = fixtures.survivor_names()  # length 4 -- square, forces name matching
    values = fixtures.sample_values(len(real_names), len(entity_names_on_disk))
    path = fixtures.write_csv_ensemble(
        tmp_path / "case.0.par.csv", values, real_names, entity_names_on_disk
    )

    record = read_ensemble(path, _control_tables(entity_names_control))

    assert isinstance(record, EnsembleData)
    assert record.orientation_decided_by == "names"
    assert record.entity_names == tuple(entity_names_on_disk)


def test_ambiguous_counts_and_no_name_match_refuses_with_a_reason(tmp_path):
    entity_names_control = fixtures.control_ordered_names("par", 6)
    real_names = fixtures.control_ordered_names("real", 5)
    entity_names_on_disk = fixtures.control_ordered_names("unrelated", 7)
    values = fixtures.sample_values(len(real_names), len(entity_names_on_disk))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names_on_disk
    )

    result = read_ensemble(path, _control_tables(entity_names_control))

    assert isinstance(result, ReadFailure)
    assert "7" in result.reason
    assert "6" in result.reason


def test_permutation_maps_file_order_onto_control_file_order(tmp_path):
    entity_names_control = fixtures.control_ordered_names("par", 6)
    entity_names_on_disk = fixtures.hash_ordered_names("par", 6)
    real_names = fixtures.control_ordered_names("real", 4)
    values = fixtures.sample_values(len(real_names), len(entity_names_on_disk))
    path = fixtures.write_jcb_ensemble(
        tmp_path / "case.0.par.jcb", values, real_names, entity_names_on_disk
    )

    record = read_ensemble(path, _control_tables(entity_names_control))

    assert isinstance(record, EnsembleData)
    assert record.entity_names == tuple(entity_names_on_disk)
    assert record.permutation is not None
    reordered = np.array(record.entity_names)[list(record.permutation)]
    assert list(reordered) == entity_names_control


def test_read_ensemble_with_no_tables_assumes_realization_major(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 6)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path)

    assert isinstance(record, EnsembleData)
    assert record.orientation_decided_by == "assumed"
    assert record.permutation is None


def test_read_ensemble_never_writes_to_the_source_file(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 6)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )
    before = path.stat()

    tables = _control_tables(entity_names)
    first = read_ensemble(path, tables)
    second = read_ensemble(path, tables)

    after = path.stat()
    assert after.st_size == before.st_size
    assert after.st_mtime_ns == before.st_mtime_ns
    assert isinstance(first, EnsembleData)
    assert isinstance(second, EnsembleData)
    assert first == second


# ---------------------------------------------------------------------------
# Task 2: an observation ensemble gets a straight answer, and two ensemble
# records can be compared
# ---------------------------------------------------------------------------


def test_kind_obs_refuses_naming_the_observation_ensemble_boundary_not_the_parameter_count(
    tmp_path,
):
    real_names = fixtures.control_ordered_names("real", 300)[:5]
    obs_entity_names = fixtures.control_ordered_names("obs", 8)
    values = fixtures.sample_values(len(real_names), len(obs_entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.obs.bin", values, real_names, obs_entity_names
    )
    # A parameter count deliberately different from the observation entity
    # count, so a verdict about parameters would be an obviously wrong
    # diagnosis for this file.
    par_entity_names = fixtures.control_ordered_names("par", 6)

    result = read_ensemble(path, _control_tables(par_entity_names), kind="obs")

    assert isinstance(result, ReadFailure)
    assert "observation ensemble" in result.reason
    assert "does not read observation ensemble values yet" in result.reason
    assert "parameter" not in result.reason.split("does not")[0]


def test_kind_obs_does_not_claim_a_missing_file_was_found(tmp_path):
    """02-REVIEW.md IN-01: the kind="obs" refusal used to say the file "was
    found and named" without ever looking, so a path that is not on disk got
    reported as present. Existence is stated, not assumed."""
    par_entity_names = fixtures.control_ordered_names("par", 6)
    missing = tmp_path / "never-written.obs.bin"
    assert not missing.exists()

    result = read_ensemble(missing, _control_tables(par_entity_names), kind="obs")

    assert isinstance(result, ReadFailure)
    assert "was found" not in result.reason
    assert "is not on disk" in result.reason
    assert str(missing) in result.reason
    # The boundary is still the reason it refused, not a bare missing-file error.
    assert "does not read observation ensemble values yet" in result.reason


def test_kind_obs_refusal_points_at_obs_not_par_for_the_widened_seam(tmp_path):
    """The refusal used to advise passing kind="par" "once observation
    ensemble reading is supported" -- the wrong argument at exactly the
    moment the advice becomes actionable. It names kind="obs"."""
    real_names = fixtures.control_ordered_names("real", 4)
    obs_entity_names = fixtures.control_ordered_names("obs", 8)
    values = fixtures.sample_values(len(real_names), len(obs_entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.obs.bin", values, real_names, obs_entity_names
    )
    par_entity_names = fixtures.control_ordered_names("par", 6)

    result = read_ensemble(path, _control_tables(par_entity_names), kind="obs")

    assert isinstance(result, ReadFailure)
    assert 'kind="obs"' in result.reason
    assert 'kind="par"' not in result.reason


def test_default_kind_names_the_parameter_table_as_what_it_compared_against(tmp_path):
    real_names = fixtures.control_ordered_names("real", 5)
    obs_entity_names = fixtures.control_ordered_names("obs", 8)
    values = fixtures.sample_values(len(real_names), len(obs_entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.obs.bin", values, real_names, obs_entity_names
    )
    par_entity_names = fixtures.control_ordered_names("par", 6)

    result = read_ensemble(path, _control_tables(par_entity_names))

    assert isinstance(result, ReadFailure)
    assert "parameter table" in result.reason
    assert "observation" in result.reason


def test_unrecognised_kind_refuses_naming_the_value_given(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 6)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    result = read_ensemble(path, _control_tables(entity_names), kind="rejected")

    assert isinstance(result, ReadFailure)
    assert "rejected" in result.reason


def test_two_reads_compare_equal_and_one_changed_value_compares_unequal(tmp_path):
    real_names = fixtures.control_ordered_names("real", 4)
    entity_names = fixtures.control_ordered_names("par", 6)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )
    tables = _control_tables(entity_names)

    first = read_ensemble(path, tables)
    second = read_ensemble(path, tables)
    assert isinstance(first, EnsembleData)
    assert isinstance(second, EnsembleData)
    assert first == second

    import dataclasses

    changed_values = first.values.copy()
    changed_values[0, 0] += 1.0
    changed = dataclasses.replace(first, values=changed_values)
    assert first != changed

    assert (first == object()) is False
    with pytest.raises(TypeError):
        hash(first)


# ---------------------------------------------------------------------------
# Task 3: all six shapes are equal, and row 1 is realization 34
# ---------------------------------------------------------------------------


def _permute_columns_by_name(
    values: np.ndarray, source_names: list[str], target_names: list[str]
) -> np.ndarray:
    """Reorder ``values``'s columns from ``source_names`` order into
    ``target_names`` order, by name -- used only to build the hash-ordered
    fixture's on-disk data from the same underlying values as every other
    shape in the six-shape proof."""
    index = {name: i for i, name in enumerate(source_names)}
    order = [index[name] for name in target_names]
    return values[:, order]


def test_all_six_ensemble_shapes_read_to_identical_values(tmp_path):
    real_names = fixtures.survivor_names()
    control_names = fixtures.control_ordered_names("par", 6)
    hash_names = fixtures.hash_ordered_names("par", 6)
    values = fixtures.sample_values(len(real_names), len(control_names))
    hash_values = _permute_columns_by_name(values, control_names, hash_names)

    tables = _control_tables(control_names)

    dense = read_ensemble(
        fixtures.write_dense_ensemble(
            tmp_path / "dense.bin", values, real_names, control_names
        ),
        tables,
    )
    modern_jcb = read_ensemble(
        fixtures.write_jcb_ensemble(tmp_path / "modern.jcb", values, real_names, control_names),
        tables,
    )
    legacy_jcb = read_ensemble(
        fixtures.write_legacy_jcb_ensemble(
            tmp_path / "legacy.jcb", values, real_names, control_names
        ),
        tables,
    )
    csv_real_major = read_ensemble(
        fixtures.write_csv_ensemble(tmp_path / "real_major.csv", values, real_names, control_names),
        tables,
    )
    csv_variable_major = read_ensemble(
        fixtures.write_variable_major_csv_ensemble(
            tmp_path / "variable_major.csv", values, real_names, control_names
        ),
        tables,
    )
    hash_ordered_binary = read_ensemble(
        fixtures.write_jcb_ensemble(
            tmp_path / "hash_ordered.jcb", hash_values, real_names, hash_names
        ),
        tables,
    )

    shapes = {
        "dense": dense,
        "modern_jcb": modern_jcb,
        "legacy_jcb": legacy_jcb,
        "csv_real_major": csv_real_major,
        "csv_variable_major": csv_variable_major,
        "hash_ordered_binary": hash_ordered_binary,
    }
    for name, record in shapes.items():
        assert isinstance(record, EnsembleData), f"{name} failed to read: {record}"

    # The hash-ordered file's entity_names really are in a different order
    # on disk -- proof this is a genuine permutation, not a relabelling
    # that happens not to matter.
    assert hash_ordered_binary.entity_names != dense.entity_names
    assert set(hash_ordered_binary.entity_names) == set(dense.entity_names)
    assert not np.array_equal(hash_ordered_binary.values, values.astype(np.float32))
    assert hash_ordered_binary.permutation is not None
    reordered_hash_values = hash_ordered_binary.values[:, list(hash_ordered_binary.permutation)]
    assert np.array_equal(reordered_hash_values, values.astype(np.float32))

    # Every pair of shapes agrees exactly once each is in control-file
    # order -- the six-shape equality proof this phase is judged on
    # (success criterion 1). Looping over pairs means a failure message
    # names which two shapes disagreed, rather than just "one of them".
    canonical: dict[str, np.ndarray] = {}
    for name, record in shapes.items():
        if record.hash_ordered:
            assert record.permutation is not None
            canonical[name] = record.values[:, list(record.permutation)]
        else:
            canonical[name] = record.values

    shape_names = list(canonical)
    for i in range(len(shape_names)):
        for j in range(i + 1, len(shape_names)):
            a_name, b_name = shape_names[i], shape_names[j]
            assert np.array_equal(canonical[a_name], canonical[b_name]), (
                f"{a_name} disagreed with {b_name}"
            )


def test_realization_names_come_from_the_file_and_row_1_is_34(tmp_path):
    real_names = fixtures.survivor_names()
    entity_names = fixtures.control_ordered_names("par", 5)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.real_names == ("base", "34", "35", "176")
    assert record.real_names[1] == "34"
    assert np.array_equal(record.values[1], values[1].astype(np.float32))
    # The negative half that makes it mean something: not the stringified
    # row positions, which is exactly the failure this phase exists to
    # prevent.
    assert record.real_names != tuple(str(i) for i in range(len(record.real_names)))


def test_duplicate_realization_names_both_survive_in_file_position(tmp_path):
    real_names = ["base", "base", "34", "35"]
    entity_names = fixtures.control_ordered_names("par", 4)
    values = fixtures.sample_values(len(real_names), len(entity_names))
    path = fixtures.write_dense_ensemble(
        tmp_path / "case.0.par.bin", values, real_names, entity_names
    )

    record = read_ensemble(path, _control_tables(entity_names))

    assert isinstance(record, EnsembleData)
    assert record.real_names == ("base", "base", "34", "35")
    assert record.values.shape[0] == 4
    assert np.array_equal(record.values, values.astype(np.float32))


def test_zero_data_row_ensemble_is_empty_record_or_named_failure(tmp_path):
    entity_names = fixtures.control_ordered_names("par", 4)
    values = fixtures.sample_values(0, len(entity_names))
    path = fixtures.write_dense_ensemble(tmp_path / "case.0.par.bin", values, [], entity_names)

    result = read_ensemble(path, _control_tables(entity_names))

    # Honest either-or: this pyemu version, verified this session, returns
    # an empty (0, n_entity) record rather than raising or returning a
    # ReadFailure for a valid header with zero data rows.
    if isinstance(result, EnsembleData):
        assert result.real_names == ()
        assert result.values.shape == (0, len(entity_names))
    else:
        assert isinstance(result, ReadFailure)
        assert result.reason


@pytest.mark.slow
def test_a_real_observation_ensemble_gets_a_straight_answer_both_kinds(pl253_run):
    """02-REVIEW.md CR-01, reproduced against the real run it was found on:
    a 300 (well, 7-iteration) x 236,172 observation ensemble used to be
    refused with a reason blaming the parameter count. This is the first
    test in this file to drive an observation-shaped entity axis against
    real data at all."""
    layout = discover(pl253_run)
    tables = read_control(layout.pst_path)
    assert isinstance(tables, ControlTables)

    obs_path = layout.obs_ens[0]

    boundary_result = read_ensemble(obs_path, tables, kind="obs")
    assert isinstance(boundary_result, ReadFailure)
    assert "observation ensemble" in boundary_result.reason
    assert "does not read observation ensemble values yet" in boundary_result.reason

    default_result = read_ensemble(obs_path, tables)
    assert isinstance(default_result, ReadFailure)
    assert "parameter table" in default_result.reason
    assert "observation ensemble" in default_result.reason
    assert "does not read observation ensemble values yet" in default_result.reason


@pytest.mark.slow
def test_a_real_dense_ensemble_reads_to_float32_with_dimensions_decided_orientation(forecast_run):
    layout = discover(forecast_run)
    tables = read_control(layout.pst_path)
    assert isinstance(tables, ControlTables)

    record = read_ensemble(layout.par_ens[0], tables)

    assert isinstance(record, EnsembleData)
    assert record.values.dtype == np.float32
    assert len(record.entity_names) == len(tables.par)
    assert record.orientation_decided_by == "dimensions"
    assert record.real_names != tuple(str(i) for i in range(len(record.real_names)))


@pytest.mark.slow
def test_two_real_modern_jcb_iterations_join_realizations_by_name_not_position(hm_run):
    layout = discover(hm_run)
    tables = read_control(layout.pst_path)
    assert isinstance(tables, ControlTables)

    record0 = read_ensemble(layout.par_ens[0], tables)
    record1 = read_ensemble(layout.par_ens[1], tables)

    assert isinstance(record0, EnsembleData)
    assert isinstance(record1, EnsembleData)
    assert record0.values.dtype == np.float32
    assert record1.values.dtype == np.float32
    assert record0.real_names
    assert record1.real_names

    # The set of realizations can change between iterations -- comparing
    # them is always by name, never by row position. The two name tuples
    # are recorded distinctly, and any lookup this test makes joins on
    # name via these index maps rather than assuming shared row order.
    index0 = {name: i for i, name in enumerate(record0.real_names)}
    index1 = {name: i for i, name in enumerate(record1.real_names)}
    shared_names = sorted(set(index0) & set(index1))
    assert shared_names
    for name in shared_names:
        assert index0[name] < record0.values.shape[0]
        assert index1[name] < record1.values.shape[0]
