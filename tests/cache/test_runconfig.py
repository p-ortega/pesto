"""What pesto found about measurement noise, and the run's facts on disk.

Task 1 covers every way the measurement-noise fact can be decided, reading
each case through ``discover`` and ``read_control`` rather than constructing
``RunLayout``/``ControlTables`` by hand, so the fact must survive the real
readers. Task 2 covers ``config.json`` itself: what ``build_config`` records,
and every way ``load_config`` can meet an unreadable file.
"""

from __future__ import annotations

import json

import pytest

from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import WrittenArtifact
from pesto.cache.runconfig import build_config, describe_noise, load_config, write_config
from pesto.ingest.control import read_control
from pesto.ingest.discover import discover
from pesto.ingest.ensfile import read_ensemble
from pesto.ingest.failures import ReadFailure

from ingest.fixtures import make_run, sample_values, write_control_file, write_csv_ensemble


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


# ---------------------------------------------------------------------------
# Task 1: the measurement-noise fact, and what decided it
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Task 2: the run's facts on disk, and a reader that never half-answers
# ---------------------------------------------------------------------------


class _FakeAdapter:
    """A minimal stand-in for SpatialAdapter -- build_config only ever
    calls ``.crs()``, so nothing else needs implementing."""

    def __init__(self, crs_value):
        self._crs_value = crs_value

    def crs(self):
        return self._crs_value


def _ensemble_data_for(tables, real_names, entity_names, path):
    # CSV, not JCB: pyemu's binary writers silently lower-case row/col
    # names on their way through, which would hide the exact-case
    # "base"-vs-"Base" distinction this helper exists to test.
    values = sample_values(len(real_names), len(entity_names))
    written = write_csv_ensemble(path, values, list(real_names), list(entity_names))
    data = read_ensemble(written, tables)
    assert not isinstance(data, ReadFailure)
    return data


def test_build_config_records_facts_from_all_inputs(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    synth = make_run(run_dir)  # default 4 realizations, including "base"
    run = discover(run_dir)
    tables = read_control(synth.pst_path)
    assert not isinstance(tables, ReadFailure)
    first = read_ensemble(synth.par_ens[0], tables)
    assert not isinstance(first, ReadFailure)
    adapter = _FakeAdapter("EPSG:26910")

    config = build_config(run, tables, first, adapter)

    assert config.n_par == len(tables.par)
    assert config.n_real == len(synth.real_names)
    assert config.base_realization is True
    assert config.n_iterations == len(run.iterations)
    assert config.noptmax == run.noptmax
    assert config.first_iteration == min(run.iterations)
    assert config.last_iteration == max(run.iterations)
    assert config.projection == "EPSG:26910"
    assert config.projection_known is True


def test_build_config_no_adapter_projection_unknown_with_note(tmp_path):
    run, tables = _build_control(tmp_path)

    config = build_config(run, tables, None, None)

    assert config.projection is None
    assert config.projection_known is False
    assert any("grid file" in note for note in config.notes)


def test_build_config_adapter_read_failure_projection_unknown(tmp_path):
    run, tables = _build_control(tmp_path)
    failure = ReadFailure(name="grid.grb", path="grid.grb", reason="could not parse grid.grb")
    adapter = _FakeAdapter(failure)

    config = build_config(run, tables, None, adapter)

    assert config.projection is None
    assert config.projection_known is False
    assert any("could not parse grid.grb" in note for note in config.notes)


def test_build_config_adapter_no_projection_is_known(tmp_path):
    run, tables = _build_control(tmp_path)
    adapter = _FakeAdapter(None)

    config = build_config(run, tables, None, adapter)

    assert config.projection is None
    assert config.projection_known is True


def test_build_config_capital_base_is_not_lowercase_base(tmp_path):
    run, tables = _build_control(tmp_path)
    first = _ensemble_data_for(
        tables, ["Base", "34", "35"], ["par0", "par1"], tmp_path / "case.0.par.csv"
    )

    config = build_config(run, tables, first, None)

    assert config.base_realization is False


def test_build_config_no_first_ensemble_leaves_counts_unknown(tmp_path):
    run, tables = _build_control(tmp_path)

    config = build_config(run, tables, None, None)

    assert config.n_real is None
    assert config.base_realization is None


def test_write_config_key_set_carries_no_ingest_facts(tmp_path):
    run, tables = _build_control(tmp_path)
    config = build_config(run, tables, None, None)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_config(config, layout)

    assert isinstance(result, WrittenArtifact)
    data = json.loads(layout.config.read_text())
    assert set(data.keys()).isdisjoint({"ingest_seconds", "cache_bytes", "ingested_at"})


def test_load_config_on_literal_null_states_nothing(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    layout.config.write_text("null")

    config = load_config(layout)

    assert config.n_par is None
    assert config.noise.has_noise is None


def test_load_config_on_wrong_version_states_nothing(tmp_path):
    run, tables = _build_control(tmp_path)
    config = build_config(run, tables, None, None)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    write_config(config, layout)

    payload = json.loads(layout.config.read_text())
    payload["cache_version"] = CACHE_VERSION + 1
    layout.config.write_text(json.dumps(payload))

    loaded = load_config(layout)

    assert loaded.n_par is None
    assert loaded.run_dir == ""


def test_load_config_on_absent_file_states_nothing(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    config = load_config(layout)

    assert config.n_par is None
    assert config.noise.decided_by == "undetermined"


def test_load_config_on_garbage_text_states_nothing(tmp_path):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    layout.config.write_text("not json at all {{{")

    config = load_config(layout)

    assert config.n_par is None


def test_load_config_round_trips_the_written_record(tmp_path):
    run, tables = _build_control(tmp_path, pestpp_options={"ies_no_noise": "true"})
    first = _ensemble_data_for(
        tables, ["base", "34"], ["par0", "par1"], tmp_path / "case.0.par.csv"
    )
    adapter = _FakeAdapter("EPSG:26910")
    config = build_config(run, tables, first, adapter)
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    write_config(config, layout)
    loaded = load_config(layout)

    assert loaded == config
