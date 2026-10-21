"""noise_agg: the noise band from the obs+noise ensemble pestpp used.

The tracer ingests a generated run with a ``case.obs+noise.jcb`` and checks
every stored number against numpy on the generator's own values for the
non-base realizations. The later tests pin which file is read, how base is
found and left out, and every refusal.
"""

from __future__ import annotations

import inspect
import json
import os
from pathlib import Path

import numpy as np
import pytest

import pesto.ingest.obsagg as obsagg
import pesto.ingest.runner as runner
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsagg import NOISE_STATS, load_noise_agg, write_noise_agg
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.runner import ingest_run

from .fixtures import _ENSEMBLE_WRITERS, sample_values
from .obs_fixtures import make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)

PERCENTILE_STATS = {"q05": 5, "q25": 25, "q50": 50, "q75": 75, "q95": 95}


def _ingest(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_noise=True, **kwargs)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root), manifest


def _noise_by_name(run, layout):
    """``{observation name: {stat: stored value}}`` read back through the
    index, so a test never assumes the stored order."""
    index = load_obs_index(layout)
    assert not isinstance(index, ReadFailure), index
    stored = load_noise_agg(layout)
    assert not isinstance(stored, ReadFailure), stored
    out = {}
    for position, control_row in enumerate(index.order):
        out[run.obs_names[int(control_row)]] = {
            stat: float(stored.values[row, position]) for row, stat in enumerate(stored.stats)
        }
    return out


def _sidecar(layout):
    return json.loads(layout.noise_agg_meta.read_text())


def _used_rows(run):
    """The generator's values for every realization except base."""
    keep = [i for i, n in enumerate(run.noise_real_names) if n != "base"]
    return run.noise_values[keep]


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_a_run_with_an_obs_noise_file_gets_a_noise_band_without_base(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)

    manifest = Manifest.load(layout)
    assert manifest.artifacts["noise_agg"].state == "ok"
    stored = load_noise_agg(layout)
    assert not isinstance(stored, ReadFailure), stored
    assert stored.stats == NOISE_STATS
    assert stored.values.shape == (len(NOISE_STATS), len(run.obs_names))
    assert stored.values.dtype == np.float32

    stats = _noise_by_name(run, layout)
    used = _used_rows(run)
    assert used.shape[0] == 3
    for control_row, name in enumerate(run.obs_names):
        sim = used[:, control_row]
        got = stats[name]
        np.testing.assert_allclose(got["mean"], np.mean(sim), rtol=1e-6, atol=1e-6)
        np.testing.assert_allclose(got["std"], np.std(sim), rtol=1e-6, atol=1e-6)
        assert got["min"] == sim.min()
        assert got["max"] == sim.max()
        assert got["n_valid"] == 3
        for stat, q in PERCENTILE_STATS.items():
            np.testing.assert_allclose(
                got[stat], np.percentile(sim, q), rtol=1e-6, atol=1e-5, err_msg=f"{name} {stat}"
            )


def test_the_noise_band_is_not_the_one_you_get_with_base_left_in(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)
    stats = _noise_by_name(run, layout)

    differing = 0
    for control_row, name in enumerate(run.obs_names):
        with_base = float(np.mean(run.noise_values[:, control_row]))
        if not np.isclose(stats[name]["mean"], with_base, rtol=1e-6, atol=1e-6):
            differing += 1
    assert differing == len(run.obs_names)


def test_the_sidecar_names_the_source_the_count_used_and_what_happened_to_base(
    tmp_path, in_process
):
    run, layout, _ = _ingest(tmp_path)

    sidecar = _sidecar(layout)
    index = load_obs_index(layout)

    assert sidecar["source"] == "case.obs+noise.jcb"
    assert sidecar["n_real_used"] == 3
    assert sidecar["base"] == "excluded"
    assert sidecar["stats"] == list(NOISE_STATS)
    assert sidecar["order_digest"] == index.order_digest
    assert sidecar["shape"] == [len(NOISE_STATS), len(run.obs_names)]
    stored = load_noise_agg(layout)
    assert (stored.source, stored.n_real_used, stored.base) == ("case.obs+noise.jcb", 3, "excluded")


def _noise_capability(run, layout):
    from fastapi.testclient import TestClient

    from pesto.api.app import create_app

    app, token = create_app()
    app.state.initial_run_dir = str(run.root)
    app.state.cache_root = str(layout.root)
    client = TestClient(app, base_url="http://127.0.0.1")
    response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 200, response.text
    return response.json()["capabilities"]["noise"]


def test_the_noise_capability_is_available_once_noise_agg_is_ok(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)

    assert _noise_capability(run, layout) == {"available": True, "blocked_by": []}


def test_noise_agg_is_planned_before_the_iteration_artifacts_and_needs_obs_index(tmp_path):
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True)

    planned = runner.plan_artifacts(discover(run_dir), CacheLayout(root=tmp_path / "cache"))
    names = [a.name for a in planned]

    assert names.index("noise_agg") < names.index("par_ens/0")
    assert names.index("noise_agg") > names.index("obs_index")
    noise = next(a for a in planned if a.name == "noise_agg")
    obs_index = next(a for a in planned if a.name == "obs_index")
    assert noise.needs == ("obs_index",)
    assert noise.sources[0].endswith("case.obs+noise.jcb")
    assert set(obs_index.sources) <= set(noise.sources)


def test_noise_agg_reads_only_the_noise_file_and_never_names_a_starting_ensemble():
    source = inspect.getsource(obsagg)
    assert "starting_obs_ens" not in source
    assert "standard_deviation" not in source
    for banned in ("np.percentile", "np.quantile", "nanpercentile", "np.partition"):
        assert banned not in source


# ---------------------------------------------------------------------------
# which file, base, and every refusal
# ---------------------------------------------------------------------------

STARTING_REASON = (
    "no case.obs+noise file was found for this run; pesto never uses a starting "
    "observation ensemble as the noise band"
)


def _run_with_only_a_starting_ensemble(tmp_path):
    """A run whose control file names ies_obs_en noise_oe.jcb, the file
    exists with plausible values, and there is no obs+noise file."""
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, pestpp_options={"ies_obs_en": "noise_oe.jcb"})
    writer = _ENSEMBLE_WRITERS["jcb"][0]
    writer(
        run_dir / "noise_oe.jcb",
        sample_values(5, len(run.obs_names), seed=7),
        ["a", "b", "c", "d", "e"],
        run.obs_names,
    )
    return run


def test_a_run_with_only_a_starting_observation_ensemble_plans_no_noise_agg(tmp_path, in_process):
    run = _run_with_only_a_starting_ensemble(tmp_path)

    found = discover(run.root)
    assert found.noise is None
    assert found.starting_obs_ens is not None
    assert found.starting_obs_ens.name == "noise_oe.jcb"

    cache_root = tmp_path / "cache"
    planned = runner.plan_artifacts(found, CacheLayout(root=cache_root))
    assert "noise_agg" not in [a.name for a in planned]
    assert not any("noise_oe" in source for a in planned for source in a.sources)

    ingest_run(run.root, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)
    assert not layout.noise_agg.exists()
    assert not layout.noise_agg_meta.exists()
    assert "noise_agg" not in Manifest.load(layout).artifacts
    assert _noise_capability(run, layout) == {
        "available": False,
        "blocked_by": [{"artifact": "noise_agg", "reason": STARTING_REASON}],
    }


def test_the_starting_ensemble_is_never_the_noise_band_even_when_both_exist(tmp_path, in_process):
    run = _run_with_only_a_starting_ensemble(tmp_path)
    writer = _ENSEMBLE_WRITERS["jcb"][0]
    noise = sample_values(4, len(run.obs_names), seed=99)
    writer(run.root / "case.obs+noise.jcb", noise, ["x", "base", "y", "z"], run.obs_names)

    cache_root = tmp_path / "cache"
    ingest_run(run.root, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)

    sidecar = json.loads(layout.noise_agg_meta.read_text())
    assert sidecar["source"] == "case.obs+noise.jcb"
    stats = _noise_by_name(run, layout)
    for control_row, name in enumerate(run.obs_names):
        np.testing.assert_allclose(
            stats[name]["mean"], np.mean(noise[[0, 2, 3], control_row]), rtol=1e-6, atol=1e-6
        )


def test_a_realization_named_BASE_is_left_out_and_the_note_says_only_the_folded_name_matched(
    tmp_path, in_process
):
    run, layout, _ = _ingest(
        tmp_path, noise_format="csv", noise_real_names=["r1", "BASE", "r2", "r3"]
    )

    sidecar = _sidecar(layout)
    assert sidecar["base"] == "excluded"
    assert sidecar["n_real_used"] == 3
    assert any("lower-casing" in note and "BASE" in note for note in sidecar["notes"])
    stats = _noise_by_name(run, layout)
    for control_row, name in enumerate(run.obs_names):
        np.testing.assert_allclose(
            stats[name]["mean"],
            np.mean(run.noise_values[[0, 2, 3], control_row]),
            rtol=1e-5,
            atol=1e-5,
        )


def test_an_exact_base_gets_no_folded_name_note(tmp_path, in_process):
    _run, layout, _ = _ingest(tmp_path)

    notes = _sidecar(layout)["notes"]
    assert not any("lower-casing" in note for note in notes)
    assert any("left out of the noise band" in note for note in notes)


def test_a_noise_file_without_base_uses_every_realization_and_says_base_was_not_present(
    tmp_path, in_process
):
    run, layout, _ = _ingest(tmp_path, noise_real_names=["r1", "r2", "r3"])

    sidecar = _sidecar(layout)
    assert sidecar["base"] == "not present"
    assert sidecar["n_real_used"] == 3
    assert any("no realization named base" in note for note in sidecar["notes"])
    stats = _noise_by_name(run, layout)
    for control_row, name in enumerate(run.obs_names):
        np.testing.assert_allclose(
            stats[name]["mean"], np.mean(run.noise_values[:, control_row]), rtol=1e-6, atol=1e-6
        )
        assert stats[name]["n_valid"] == 3


def test_a_noise_file_holding_only_base_is_refused_with_that_reason(tmp_path, in_process):
    run, layout, manifest = _ingest(tmp_path, noise_real_names=["base"])

    artifact = manifest.artifacts["noise_agg"]
    assert artifact.state == "failed"
    assert artifact.reason.startswith("noise_agg:")
    assert "holds no realization other than base" in artifact.reason
    assert not layout.noise_agg.exists()
    assert not layout.noise_agg_meta.exists()
    # The rest of the run is unaffected.
    assert manifest.artifacts["obs_ens/0"].state == "ok"


def test_a_noise_file_missing_one_observation_fails_alone_with_the_readers_counts(
    tmp_path, in_process
):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, with_noise=True)
    writer = _ENSEMBLE_WRITERS["jcb"][0]
    keep = list(range(len(run.obs_names) - 1))
    writer(
        run.noise_path,
        run.noise_values[:, keep],
        run.noise_real_names,
        [run.obs_names[i] for i in keep],
    )
    cache_root = tmp_path / "cache"

    manifest = ingest_run(run_dir, cache_root=cache_root)

    n = len(run.obs_names)
    artifact = manifest.artifacts["noise_agg"]
    assert artifact.state == "failed"
    assert artifact.reason.startswith("noise_agg:")
    assert f"matched {n - 1} of {n} control observations" in artifact.reason
    assert manifest.artifacts["obs_ens/0"].state == "ok"
    assert manifest.artifacts["obs_agg/0"].state == "ok"


def test_noise_agg_fails_by_name_when_obs_index_failed(tmp_path, in_process, monkeypatch):
    monkeypatch.setattr(
        runner,
        "_write_obs_index_artifact",
        lambda cache_root: ReadFailure(
            name="obs_index", path="x", reason="the order file would not write"
        ),
    )
    run_dir = tmp_path / "run"
    make_obs_run(run_dir, with_noise=True)

    manifest = ingest_run(run_dir, cache_root=tmp_path / "cache")

    reason = manifest.artifacts["noise_agg"].reason
    assert manifest.artifacts["noise_agg"].state == "failed"
    assert reason.startswith("noise_agg depends on obs_index, which failed: ")
    assert "the order file would not write" in reason


def test_editing_the_noise_file_makes_noise_agg_stale_and_leaves_obs_ens_fresh(
    tmp_path, in_process
):
    run, layout, _ = _ingest(tmp_path)
    planned = {a.name: a for a in runner.plan_artifacts(discover(run.root), layout)}
    manifest = Manifest.load(layout)
    for name in ("noise_agg", "obs_ens/0"):
        assert not manifest.is_stale(name, layout, planned[name].sources)

    writer = _ENSEMBLE_WRITERS["jcb"][0]
    writer(
        run.noise_path,
        sample_values(len(run.noise_real_names), len(run.obs_names), seed=1),
        run.noise_real_names,
        run.obs_names,
    )

    manifest = Manifest.load(layout)
    assert manifest.is_stale("noise_agg", layout, planned["noise_agg"].sources)
    assert not manifest.is_stale("obs_ens/0", layout, planned["obs_ens/0"].sources)
    assert not manifest.is_stale("obs_agg/0", layout, planned["obs_agg/0"].sources)


def test_editing_a_control_source_makes_noise_agg_stale_too(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)
    planned = {a.name: a for a in runner.plan_artifacts(discover(run.root), layout)}

    with run.pst_path.open("a") as handle:
        handle.write("\n* a trailing comment line that changes the bytes\n")

    manifest = Manifest.load(layout)
    assert manifest.is_stale("noise_agg", layout, planned["noise_agg"].sources)


def _read_noise(run, layout):
    from pesto.ingest.obsread import read_obs_file
    from pesto.ingest.tables import load_control_table

    loaded = load_control_table(layout, "obs", columns=["obsnme"])
    data = read_obs_file(
        run.noise_path, loaded[0].column("obsnme").to_pylist(), artifact="noise_agg"
    )
    assert not isinstance(data, ReadFailure), data
    return data


def test_noise_blocks_of_rows_give_the_same_numbers_as_one_block(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path)
    whole = np.array(load_noise_agg(layout).values)

    result = write_noise_agg(
        _read_noise(run, layout), load_obs_index(layout), run.noise_path.name, layout, block_rows=2
    )

    assert not isinstance(result, ReadFailure), result
    np.testing.assert_array_equal(np.array(load_noise_agg(layout).values), whole)


def test_a_failed_rewrite_leaves_no_old_sidecar_beside_a_missing_payload(
    tmp_path, in_process, monkeypatch
):
    run, layout, _ = _ingest(tmp_path)
    assert layout.noise_agg_meta.exists()
    data = _read_noise(run, layout)
    index = load_obs_index(layout)

    def _boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(obsagg, "summarise", _boom)
    result = write_noise_agg(data, index, run.noise_path.name, layout)

    assert isinstance(result, ReadFailure)
    assert "disk full" in result.reason
    assert result.reason.startswith("noise_agg:")
    assert not layout.noise_agg_meta.exists()


def test_load_noise_agg_refuses_a_band_built_against_another_obs_index(tmp_path, in_process):
    from pesto.ingest.obsindex import build_obs_index, write_obs_index

    from .obs_fixtures import obs_arrow

    run, layout, _ = _ingest(tmp_path)
    other = build_obs_index(obs_arrow(list(reversed(run.rows))))
    assert other.order_digest != load_obs_index(layout).order_digest
    assert not isinstance(write_obs_index(other, layout), ReadFailure)

    result = load_noise_agg(layout)

    assert isinstance(result, ReadFailure)
    assert "different obs_index" in result.reason
    assert result.reason.startswith("noise_agg:")


def test_load_noise_agg_refuses_a_sidecar_that_is_not_the_shape_it_wrote(tmp_path, in_process):
    _run, layout, _ = _ingest(tmp_path)
    sidecar = _sidecar(layout)
    del sidecar["n_real_used"]
    layout.noise_agg_meta.write_text(json.dumps(sidecar))

    result = load_noise_agg(layout)

    assert isinstance(result, ReadFailure)
    assert "noise statistics sidecar" in result.reason


def test_the_noise_file_is_read_once_through_the_guarded_reader(tmp_path, in_process, monkeypatch):
    seen = []
    real = runner.read_obs_file

    def _spy(path, control_names, *, artifact, budget=None):
        seen.append((Path(path).name, artifact))
        return real(path, control_names, artifact=artifact, budget=budget)

    monkeypatch.setattr(runner, "read_obs_file", _spy)
    _ingest(tmp_path)

    assert [name for name, artifact in seen if artifact == "noise_agg"] == ["case.obs+noise.jcb"]


# ---------------------------------------------------------------------------
# a real run (slow; skipped when the benchmark folder is absent)
# ---------------------------------------------------------------------------


def _tree_snapshot(root):
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
    }


@pytest.mark.slow
def test_a_real_runs_noise_file_is_summarised_without_base_and_the_run_is_untouched(
    pl253_run, tmp_path
):
    from pesto.ingest.control import read_control
    from pesto.ingest.obsread import read_obs_file
    from pesto.ingest.tables import load_control_table, write_control

    before = _tree_snapshot(pl253_run)
    run = discover(pl253_run)
    if run.noise is None:
        pytest.skip("this run has no obs+noise file")

    tables = read_control(run.pst_path)
    assert not isinstance(tables, ReadFailure), tables
    layout = CacheLayout(root=tmp_path / "cache")
    layout.ensure()
    assert not isinstance(write_control(tables, layout), ReadFailure)
    built = runner._write_obs_index_artifact(str(layout.root))
    assert not isinstance(built, ReadFailure), built

    loaded = load_control_table(layout, "obs", columns=["obsnme"])
    control_names = loaded[0].column("obsnme").to_pylist()
    data = read_obs_file(run.noise, control_names, artifact="noise_agg")
    assert not isinstance(data, ReadFailure), data
    base_rows = [n for n in data.real_names if n.strip().lower() == "base"]
    result = write_noise_agg(data, load_obs_index(layout), run.noise.name, layout)
    assert not isinstance(result, ReadFailure), result

    sidecar = json.loads(layout.noise_agg_meta.read_text())
    assert sidecar["n_real_used"] == len(data.real_names) - len(base_rows)
    assert sidecar["base"] == ("excluded" if base_rows else "not present")
    assert sidecar["source"] == run.noise.name
    assert _tree_snapshot(pl253_run) == before
