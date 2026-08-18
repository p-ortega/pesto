"""Proof that the per-parameter summary agrees with a modeller's own
``numpy`` session -- the D-13 disagreement 04-CONTEXT.md exists to prevent.

Every test builds its own control table and ensemble array in-process, so
the suite is green on a fresh clone with no benchmark data present.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from pesto.ingest.aggregate import PERCENTILES, align_to_control, summarise
from pesto.ingest.control import ControlTables
from pesto.ingest.ensfile import EnsembleData

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
