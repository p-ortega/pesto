"""Proof that the per-parameter summary agrees with a modeller's own
``numpy`` session, and that the at-bounds fraction agrees with pestpp-ies's
own rule -- the two disagreements 04-CONTEXT.md D-13/D-12 exist to prevent.

Every synthetic test builds its own control table and ensemble array
in-process, so the suite is green on a fresh clone with no benchmark data
present. The one ``@pytest.mark.slow`` test at the bottom additionally
checks pesto's own at-bounds figure against a real benchmark run's own
``pcs.csv`` group counts.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, Manifest, WrittenArtifact
from pesto.ingest.aggregate import (
    PERCENTILES,
    align_to_control,
    at_bounds_fraction,
    summarise,
    write_par_agg,
)
from pesto.ingest.control import ControlTables
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.failures import ReadFailure

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _control_tables(
    names: list[str],
    groups: list[str],
    lower: list[float] | None = None,
    upper: list[float] | None = None,
    partrans: list[str] | None = None,
) -> ControlTables:
    n = len(names)
    return ControlTables(
        par=pd.DataFrame(
            {
                "parnme": names,
                "pargp": groups,
                "parlbnd": lower if lower is not None else [0.0] * n,
                "parubnd": upper if upper is not None else [100.0] * n,
                "partrans": partrans if partrans is not None else ["none"] * n,
            }
        ),
        obs=pd.DataFrame({"obsnme": [], "obgnme": [], "weight": []}),
        par_groups=tuple(dict.fromkeys(groups)),
        obs_groups=(),
        source_path=Path("case.pst"),
        notes=(),
        ambiguities=(),
    )


def _ensemble_data(
    values,
    real_names: list[str],
    entity_names: list[str],
    permutation: tuple[int, ...] | None = None,
    notes: tuple[str, ...] = (),
) -> EnsembleData:
    return EnsembleData(
        values=np.asarray(values, dtype=np.float32),
        real_names=tuple(real_names),
        entity_names=tuple(entity_names),
        source_path=Path("case.0.par.jcb"),
        on_disk_format="dense",
        orientation="realization_major",
        orientation_decided_by="dimensions",
        contiguous=True,
        permutation=permutation,
        hash_ordered=False,
        notes=tuple(notes),
    )


# ---------------------------------------------------------------------------
# summarise: agreement with numpy.percentile / numpy.nanpercentile
# ---------------------------------------------------------------------------


def test_percentiles_match_numpy_percentile_on_the_all_valid_path():
    rng = np.random.default_rng(12345)
    n_real, n_par = 37, 12  # not a multiple of twenty -- every virtual index
    # this ensemble computes has a fractional part, for every percentile.
    values = rng.normal(size=(n_real, n_par)).astype(np.float32)
    names = [f"par{i}" for i in range(n_par)]

    df, notes = summarise(values, names)

    assert notes == []
    for p in PERCENTILES:
        expected = np.percentile(values, p, axis=0)
        np.testing.assert_allclose(df[f"q{p:02d}"].to_numpy(), expected, rtol=1e-5)


def test_percentiles_match_nanpercentile_when_ten_percent_of_values_are_missing():
    rng = np.random.default_rng(999)
    n_real, n_par = 37, 12
    values = rng.normal(size=(n_real, n_par)).astype(np.float32)
    missing = rng.random(size=values.shape) < 0.10
    values[missing] = np.nan
    # Guard the fixed seed's assumption: every column still has at least
    # two valid values, or this test would silently stop exercising the
    # missing-value path it exists to prove.
    assert (np.isfinite(values).sum(axis=0) >= 2).all()
    names = [f"par{i}" for i in range(n_par)]

    df, notes = summarise(values, names)

    for p in PERCENTILES:
        expected = np.nanpercentile(values, p, axis=0)
        np.testing.assert_allclose(df[f"q{p:02d}"].to_numpy(), expected, rtol=1e-5)


def test_summarise_calls_partition_exactly_once_on_the_all_valid_path(monkeypatch):
    calls = {"partition": 0}
    real_partition = np.partition

    def counting_partition(*args, **kwargs):
        calls["partition"] += 1
        return real_partition(*args, **kwargs)

    def _forbidden(*args, **kwargs):
        raise AssertionError("summarise must not call a percentile/quantile function")

    monkeypatch.setattr(np, "partition", counting_partition)
    monkeypatch.setattr(np, "percentile", _forbidden)
    monkeypatch.setattr(np, "quantile", _forbidden)
    monkeypatch.setattr(np, "nanpercentile", _forbidden)
    monkeypatch.setattr(np, "nanquantile", _forbidden)

    rng = np.random.default_rng(7)
    values = rng.normal(size=(37, 12)).astype(np.float32)
    names = [f"par{i}" for i in range(12)]

    summarise(values, names)

    assert calls["partition"] == 1


def test_summarise_never_calls_a_percentile_or_quantile_function_on_the_missing_value_path(
    monkeypatch,
):
    def _forbidden(*args, **kwargs):
        raise AssertionError("summarise must not call a percentile/quantile function")

    monkeypatch.setattr(np, "percentile", _forbidden)
    monkeypatch.setattr(np, "quantile", _forbidden)
    monkeypatch.setattr(np, "nanpercentile", _forbidden)
    monkeypatch.setattr(np, "nanquantile", _forbidden)

    rng = np.random.default_rng(1)
    values = rng.normal(size=(37, 12)).astype(np.float32)
    missing = rng.random(size=values.shape) < 0.10
    values[missing] = np.nan
    names = [f"par{i}" for i in range(12)]

    summarise(values, names)  # must not raise


# ---------------------------------------------------------------------------
# summarise: degenerate columns
# ---------------------------------------------------------------------------


def test_fully_missing_parameter_yields_n_valid_zero_and_a_note():
    values = np.array([[1.0, np.nan], [2.0, np.nan], [3.0, np.nan]], dtype=np.float32)
    names = ["good", "bad"]

    df, notes = summarise(values, names)

    row = df[df["parnme"] == "bad"].iloc[0]
    assert row["n_valid"] == 0
    for col in ("mean", "std", "min", "max", "q05", "q25", "q50", "q75", "q95"):
        assert np.isnan(row[col])
    assert any("bad" in note for note in notes)


def test_single_valid_realization_gives_that_value_and_a_missing_std():
    values = np.array([[1.0, 5.0], [np.nan, 5.0], [np.nan, 5.0]], dtype=np.float32)
    names = ["p0", "p1"]

    df, notes = summarise(values, names)

    row = df[df["parnme"] == "p0"].iloc[0]
    assert row["n_valid"] == 1
    for col in ("mean", "min", "max", "q05", "q25", "q50", "q75", "q95"):
        assert row[col] == 1.0
    assert np.isnan(row["std"])


# ---------------------------------------------------------------------------
# align_to_control: control-file order, ties, and a name absent from the
# ensemble
# ---------------------------------------------------------------------------


def test_control_parameter_absent_from_ensemble_gets_a_row_of_nan_and_a_note():
    tables = _control_tables(["par0", "par1", "par2"], ["G1", "G1", "G1"])
    data = _ensemble_data(
        values=[[1.0, 2.0], [3.0, 4.0]],
        real_names=["r0", "r1"],
        entity_names=["par0", "par2"],  # par1 is absent from this ensemble file
    )

    values, control_names, notes = align_to_control(data, tables)

    assert control_names == ("par0", "par1", "par2")
    assert values.shape == (2, 3)
    assert np.array_equal(values[:, 0], np.array([1.0, 3.0], dtype=np.float32))
    assert np.isnan(values[:, 1]).all()
    assert np.array_equal(values[:, 2], np.array([2.0, 4.0], dtype=np.float32))
    assert any("par1" in note for note in notes)


def test_rows_come_out_in_control_file_order_and_ties_keep_their_positions():
    tables = _control_tables(["parB", "parA", "parC"], ["G1", "G1", "G1"])
    data = _ensemble_data(
        values=[[9.0, 9.0, 1.0]],  # parB and parA hold the same value
        real_names=["r0"],
        entity_names=["parB", "parA", "parC"],
    )

    values, control_names, notes = align_to_control(data, tables)
    assert notes == []
    df, _ = summarise(values, control_names)

    assert list(df["parnme"]) == ["parB", "parA", "parC"]
    assert df.loc[df["parnme"] == "parB", "mean"].iloc[0] == 9.0
    assert df.loc[df["parnme"] == "parA", "mean"].iloc[0] == 9.0


# ---------------------------------------------------------------------------
# align_to_control: identity is exact string equality, never a folded match
# ---------------------------------------------------------------------------


def test_a_name_differing_only_in_letter_case_does_not_join_and_names_the_near_match():
    tables = _control_tables(["ParA", "par1"], ["G1", "G1"])
    data = _ensemble_data(
        values=[[1.0, 2.0]],
        real_names=["r0"],
        entity_names=["para", "par1"],  # "para" differs from "ParA" only in case
    )

    values, control_names, notes = align_to_control(data, tables)

    assert control_names == ("ParA", "par1")
    assert values.shape == (1, 2)
    assert np.isnan(values[:, 0]).all()
    assert np.array_equal(values[:, 1], np.array([2.0], dtype=np.float32))
    assert any("'ParA'" in note and "'para'" in note for note in notes)

    df, _ = summarise(values, control_names)
    assert len(df) == 2
    assert list(df["parnme"]) == ["ParA", "par1"]


def test_a_name_differing_only_in_leading_whitespace_does_not_join_and_names_the_near_match():
    tables = _control_tables([" par0", "par1"], ["G1", "G1"])
    data = _ensemble_data(
        values=[[1.0, 2.0]],
        real_names=["r0"],
        entity_names=["par0", "par1"],
    )

    values, control_names, notes = align_to_control(data, tables)

    assert control_names == (" par0", "par1")
    assert np.isnan(values[:, 0]).all()
    assert np.array_equal(values[:, 1], np.array([2.0], dtype=np.float32))
    assert any("par0" in note for note in notes)


def test_a_genuinely_absent_parameter_gets_no_near_match_wording():
    tables = _control_tables(["par0", "par1"], ["G1", "G1"])
    data = _ensemble_data(
        values=[[1.0]],
        real_names=["r0"],
        entity_names=["par0"],  # par1 has no counterpart under any spelling
    )

    _values, _control_names, notes = align_to_control(data, tables)

    par1_notes = [n for n in notes if "par1" in n]
    assert len(par1_notes) == 1
    assert "matches only after folding" not in par1_notes[0]


# ---------------------------------------------------------------------------
# at_bounds_fraction: pestpp-ies's own one-percent, upper-first rule
# ---------------------------------------------------------------------------


def test_value_at_the_exact_tolerance_boundary_is_not_counted_but_one_step_above_is():
    upper = 100.0
    boundary = upper - 0.01 * abs(upper)
    just_above = np.nextafter(boundary, np.inf)

    values = np.array([[boundary], [just_above]], dtype=np.float64)
    lower = np.array([0.0])
    upper_arr = np.array([upper])
    log_mask = np.array([False])

    fraction, _ = at_bounds_fraction(values, lower, upper_arr, log_mask)

    assert fraction[0] == pytest.approx(0.5)  # exactly one of the two rows counted


def test_value_satisfying_both_the_upper_and_lower_test_counts_once_at_the_upper_bound():
    lower = np.array([99.0])
    upper = np.array([100.0])
    log_mask = np.array([False])
    # 99.5 is both > 100 - 1% (upper test) and < 99 + 1% (lower test).
    values = np.array([[99.5]], dtype=np.float64)

    fraction, _ = at_bounds_fraction(values, lower, upper, log_mask)

    assert fraction[0] == pytest.approx(1.0)


def test_log_transformed_parameter_uses_log_space_and_differs_from_native_space():
    lower = np.array([1.0])
    upper = np.array([1000.0])
    values = np.array([[950.0]], dtype=np.float64)

    frac_log, _ = at_bounds_fraction(values, lower, upper, np.array([True]))
    frac_native, _ = at_bounds_fraction(values, lower, upper, np.array([False]))

    assert frac_log[0] == pytest.approx(1.0)
    assert frac_native[0] == pytest.approx(0.0)
    assert frac_log[0] != frac_native[0]


def test_log_transformed_parameter_with_a_zero_lower_bound_yields_a_missing_value_and_a_note():
    lower = np.array([0.0])
    upper = np.array([100.0])
    values = np.array([[50.0]], dtype=np.float64)
    names = ["par_log0"]

    fraction, notes = at_bounds_fraction(values, lower, upper, np.array([True]), names=names)

    assert np.isnan(fraction[0])
    assert any("par_log0" in note for note in notes)


def test_parameter_with_no_valid_realizations_yields_a_missing_at_bounds_value():
    values = np.array([[np.nan], [np.nan]], dtype=np.float64)
    lower = np.array([0.0])
    upper = np.array([10.0])
    log_mask = np.array([False])

    fraction, _ = at_bounds_fraction(values, lower, upper, log_mask)

    assert np.isnan(fraction[0])


def test_a_fixed_parameter_sitting_at_a_bound_yields_a_missing_value_and_a_note():
    """A fixed parameter can genuinely sit at a bound in every realization
    without pestpp-ies ever reporting it in ``case.N.pcs.csv`` --
    ``ParChangeSummarizer::update`` only iterates its adjustable
    parameters. Discovered against a real benchmark's own file, where a
    fixed-only parameter group sits at its bound in every realization but
    the file's own count for that group is genuinely zero."""
    lower = np.array([1.0])
    upper = np.array([100.0])
    log_mask = np.array([False])
    values = np.array([[100.0], [100.0]], dtype=np.float64)  # every realization at the bound
    adjustable_mask = np.array([False])  # fixed

    fraction, notes = at_bounds_fraction(
        values, lower, upper, log_mask, adjustable_mask=adjustable_mask
    )

    assert np.isnan(fraction[0])
    assert any("fixed or tied" in note for note in notes)


# ---------------------------------------------------------------------------
# write_par_agg: the table on disk
# ---------------------------------------------------------------------------


def test_write_par_agg_writes_a_parquet_table_in_control_file_order(tmp_path):
    names = ["par0", "par1", "par2"]
    tables = _control_tables(names, ["G1", "G1", "G2"])
    data = _ensemble_data(
        values=[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]],
        real_names=["r0", "r1"],
        entity_names=names,
    )
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_agg(data, tables, iteration=0, layout=layout)

    assert isinstance(result, WrittenArtifact)
    assert isinstance(result.files[0], CacheFile)
    target = layout.par_agg(0)
    assert target.exists()

    df = pd.read_parquet(target)
    assert list(df["parnme"]) == names
    expected_columns = [
        "parnme",
        "pargp",
        "mean",
        "std",
        "min",
        "max",
        "q05",
        "q25",
        "q50",
        "q75",
        "q95",
        "n_valid",
        "at_bounds",
    ]
    assert list(df.columns) == expected_columns


def test_write_par_agg_returns_a_read_failure_and_leaves_no_temp_file_when_the_write_raises(
    tmp_path, monkeypatch
):
    names = ["par0"]
    tables = _control_tables(names, ["G1"])
    data = _ensemble_data(values=[[1.0]], real_names=["r0"], entity_names=names)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    def _raise(self, *args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(pd.DataFrame, "to_parquet", _raise)

    result = write_par_agg(data, tables, iteration=0, layout=layout)

    assert isinstance(result, ReadFailure)
    assert not layout.par_agg(0).exists()
    assert list(layout.agg.glob(".ingest-*")) == []


# ---------------------------------------------------------------------------
# write_par_agg: the notes sidecar beside the table
# ---------------------------------------------------------------------------


def test_write_par_agg_writes_a_notes_sidecar_holding_every_note_in_full(tmp_path):
    names = ["par0", "par1"]
    tables = _control_tables(names, ["G1", "G1"])
    tables = replace(tables, par=tables.par.drop(columns=["pargp"]))
    data = _ensemble_data(values=[[1.0, 2.0]], real_names=["r0"], entity_names=names)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_agg(data, tables, iteration=0, layout=layout)

    assert isinstance(result, WrittenArtifact)
    assert any("pargp" in note for note in result.notes)
    assert len(result.files) == 2

    notes_path = layout.par_agg_notes(0)
    assert notes_path.exists()
    payload = json.loads(notes_path.read_text())
    assert payload["cache_version"] == CACHE_VERSION
    assert payload["iteration"] == 0
    assert payload["n_par"] == 2
    assert payload["notes"] == list(result.notes)


def test_write_par_agg_with_no_notes_still_writes_an_empty_notes_sidecar(tmp_path):
    names = ["par0", "par1", "par2"]
    tables = _control_tables(names, ["G1", "G1", "G2"])
    data = _ensemble_data(
        values=[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]],
        real_names=["r0", "r1"],
        entity_names=names,
    )
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_agg(data, tables, iteration=0, layout=layout)

    assert result.notes == ()
    payload = json.loads(layout.par_agg_notes(0).read_text())
    assert payload["notes"] == []


def test_write_par_agg_returns_two_cache_files_each_existing_at_its_recorded_size(tmp_path):
    names = ["par0", "par1"]
    tables = _control_tables(names, ["G1", "G1"])
    data = _ensemble_data(values=[[1.0, 2.0]], real_names=["r0"], entity_names=names)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_agg(data, tables, iteration=0, layout=layout)

    assert len(result.files) == 2
    for cache_file in result.files:
        path = layout.root / cache_file.path
        assert path.exists()
        assert path.stat().st_size == cache_file.bytes


def test_write_par_agg_returns_a_read_failure_when_the_sidecar_write_raises(tmp_path, monkeypatch):
    names = ["par0"]
    tables = _control_tables(names, ["G1"])
    data = _ensemble_data(values=[[1.0]], real_names=["r0"], entity_names=names)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    import pesto.ingest.aggregate as aggregate_module

    def _raise(*args, **kwargs):
        raise RuntimeError("sidecar write boom")

    monkeypatch.setattr(aggregate_module, "write_atomic_text", _raise)

    result = write_par_agg(data, tables, iteration=0, layout=layout)

    assert isinstance(result, ReadFailure)
    assert list(layout.agg.glob(".ingest-*")) == []


def test_the_notes_sidecar_is_recorded_so_truncating_it_makes_the_artifact_read_stale(tmp_path):
    names = ["par0", "par1"]
    tables = _control_tables(names, ["G1", "G1"])
    data = _ensemble_data(values=[[1.0, 2.0]], real_names=["r0"], entity_names=names)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_agg(data, tables, iteration=0, layout=layout)
    manifest = Manifest.empty(str(tmp_path))
    manifest.mark_ok("par_agg/0", [], files=result.files, notes=result.notes)

    assert manifest.is_stale("par_agg/0", layout) is False

    notes_path = layout.par_agg_notes(0)
    notes_path.write_bytes(notes_path.read_bytes()[:5])

    assert manifest.is_stale("par_agg/0", layout) is True


# ---------------------------------------------------------------------------
# Slow: agreement with a real benchmark run's own pcs.csv
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_at_bounds_matches_a_real_benchmarks_pcs_csv_group_counts(pl253_run):
    from pesto.ingest.control import read_control
    from pesto.ingest.discover import discover
    from pesto.ingest.ensfile import read_ensemble

    layout = discover(pl253_run)
    tables = read_control(layout.pst_path)
    assert isinstance(tables, ControlTables)

    par_ens_path = layout.par_ensemble(1)
    assert par_ens_path is not None
    data = read_ensemble(par_ens_path, tables)
    assert isinstance(data, EnsembleData)

    values, control_names, _ = align_to_control(data, tables)

    lower = tables.par["parlbnd"].to_numpy(dtype=np.float64)
    upper = tables.par["parubnd"].to_numpy(dtype=np.float64)
    partrans_lower = [str(t).strip().lower() for t in tables.par["partrans"]]
    log_mask = np.array([t == "log" for t in partrans_lower], dtype=bool)
    adjustable_mask = np.array([t not in ("fixed", "tied") for t in partrans_lower], dtype=bool)

    fraction, _ = at_bounds_fraction(
        values, lower, upper, log_mask, names=control_names, adjustable_mask=adjustable_mask
    )

    n_valid = (~np.isnan(values)).sum(axis=0)
    counts = np.zeros(len(fraction), dtype=np.int64)
    countable = (n_valid > 0) & ~np.isnan(fraction)
    counts[countable] = np.round(fraction[countable] * n_valid[countable]).astype(np.int64)

    pargp = tables.par["pargp"].astype(str).to_numpy()
    pesto_counts = pd.Series(counts, index=pargp).groupby(level=0).sum()

    pcs = pd.read_csv(pl253_run / "pl253.1.pcs.csv")
    pcs["expected"] = pcs["num_at_near_lbound"] + pcs["num_at_near_ubound"]

    matched_groups = [g for g in pcs["group"] if g in pesto_counts.index]
    assert matched_groups, "no group from pcs.csv matched any control-file group"

    for group in matched_groups:
        expected = int(pcs.loc[pcs["group"] == group, "expected"].iloc[0])
        assert int(pesto_counts[group]) == expected, (
            f"group {group}: pesto counted {int(pesto_counts[group])}, "
            f"pcs.csv counted {expected}"
        )
