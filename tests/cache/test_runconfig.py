"""What pesto found about measurement noise, and what decided it.

Covers every way the measurement-noise fact can be decided, reading each
case through ``discover`` and ``read_control`` rather than constructing
``RunLayout``/``ControlTables`` by hand, so the fact must survive the real
readers.
"""

from __future__ import annotations

import pytest

from pesto.cache.runconfig import describe_noise
from pesto.ingest.control import read_control
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure

from ingest.fixtures import write_control_file


def _build_control(
    tmp_path,
    case: str = "case",
    pestpp_options: dict | None = None,
    obs_meta: tuple[str, ...] | None = None,
    standard_deviation_header: str | None = None,
    noise_ensemble: bool = False,
):
    """Write a control file plus (optionally) a noise ensemble file
    matching discover's naming convention, then read both back through the
    real readers -- never a hand-built RunLayout or ControlTables."""
    run_dir = tmp_path / f"run-{case}"
    run_dir.mkdir()
    pst_path, _ = write_control_file(
        run_dir / f"{case}.pst",
        par_names=["par0", "par1"],
        obs_names=["obs0", "obs1"],
        noptmax=3,
        pestpp_options=pestpp_options,
        obs_meta=obs_meta,
        standard_deviation_header=standard_deviation_header,
    )
    if noise_ensemble:
        (run_dir / f"{case}.obs+noise.jcb").write_bytes(b"placeholder, discover matches by name only")

    run = discover(run_dir)
    tables = read_control(pst_path)
    assert not isinstance(tables, ReadFailure)
    return run, tables


def test_noise_ensemble_on_disk_yields_found_by_ensemble(tmp_path):
    run, tables = _build_control(tmp_path, noise_ensemble=True)

    fact = describe_noise(run, tables)

    assert fact.has_noise is True
    assert fact.decided_by == "noise_ensemble"
    assert any("obs+noise" in item for item in fact.evidence)


def test_ies_no_noise_yields_no_noise(tmp_path):
    run, tables = _build_control(tmp_path, pestpp_options={"ies_no_noise": "true"})

    fact = describe_noise(run, tables)

    assert fact.has_noise is False
    assert fact.decided_by == "ies_no_noise"
    assert fact.evidence == ("ies_no_noise=true",)


def test_standard_deviation_column_yields_found(tmp_path):
    # Default obs_meta already carries "standard_deviation", written clean.
    run, tables = _build_control(tmp_path)

    fact = describe_noise(run, tables)

    assert fact.has_noise is True
    assert fact.decided_by == "standard_deviation_column"


def test_standard_deviation_column_stripped_header_differs_in_evidence(tmp_path):
    clean_run, clean_tables = _build_control(tmp_path, case="clean")
    stripped_run, stripped_tables = _build_control(
        tmp_path, case="stripped", standard_deviation_header=" "
    )

    clean_fact = describe_noise(clean_run, clean_tables)
    stripped_fact = describe_noise(stripped_run, stripped_tables)

    assert clean_fact.has_noise is True
    assert stripped_fact.has_noise is True
    assert clean_fact.evidence != stripped_fact.evidence
    assert any("stripped" in item for item in stripped_fact.evidence)


def test_no_evidence_at_all_yields_undetermined_not_false(tmp_path):
    run, tables = _build_control(tmp_path, obs_meta=())

    fact = describe_noise(run, tables)

    assert fact.has_noise is None
    assert fact.decided_by == "undetermined"
    assert len(fact.evidence) >= 1


def test_ies_no_noise_and_noise_ensemble_together_control_file_wins(tmp_path):
    run, tables = _build_control(
        tmp_path, pestpp_options={"ies_no_noise": "true"}, noise_ensemble=True
    )

    fact = describe_noise(run, tables)

    assert fact.has_noise is False
    assert fact.decided_by == "ies_no_noise"
    assert any("obs+noise" in note for note in fact.notes)


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"pestpp_options": {"ies_no_noise": "true"}},
        {"noise_ensemble": True},
        {"obs_meta": ()},
        {"standard_deviation_header": " "},
    ],
)
def test_decided_by_is_never_empty(tmp_path, kwargs):
    run, tables = _build_control(tmp_path, **kwargs)

    fact = describe_noise(run, tables)

    assert fact.decided_by != ""
