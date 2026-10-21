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
