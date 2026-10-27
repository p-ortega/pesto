"""The observation memo: each artifact is opened once per write, a re-ingest is
seen on the next request, a failure is never kept, and an ingest drops the memo."""

from __future__ import annotations

from pathlib import Path
from unittest import mock

import numpy as np

import pesto.ingest.obsagg as obsagg
import pesto.ingest.obsens as obsens
import pesto.ingest.obsindex as obsindex
import pesto.ingest.runner as runner_module
from ingest.obs_fixtures import make_obs_run
from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.api import obscache
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.runner import ingest_run

from .obs_helpers import HEAD_SITE, open_obs_run, series_meta, site_id
from .test_ingest import _app_for, _client, _drain_events, _make_run, _scripted_ingest


def _counted(monkeypatch, module, name):
    """Wrap ``module.name`` so every call is recorded; the real function still runs."""
    original = getattr(module, name)
    calls: list = []

    def wrapper(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(module, name, wrapper)
    return calls


def _root(client) -> str:
    return client.pesto_app.state.cache_root


def test_two_requests_for_one_site_open_each_artifact_once(tmp_path, in_process, monkeypatch):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, with_noise=True)
    index_calls = _counted(monkeypatch, obsindex, "load_obs_index")
    ens_calls = _counted(monkeypatch, obsens, "load_obs_ensemble")
    noise_calls = _counted(monkeypatch, obsagg, "load_noise_agg")
    site = site_id(_root(client), HEAD_SITE)

    for _ in range(2):
        assert client.get("/api/run/obs/site", params={"site": site}).status_code == 200
        series = client.get("/api/run/obs/series", params={"site": site, "iteration": 1})
        assert series.status_code == 200

    assert len(index_calls) == 1
    assert len(ens_calls) == 1
    assert len(noise_calls) == 1


def test_a_re_ingest_with_a_changed_observation_file_is_read_again(tmp_path, in_process, monkeypatch):  # noqa: F811
    client, run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    ens_calls = _counted(monkeypatch, obsens, "load_obs_ensemble")
    site = site_id(_root(client), HEAD_SITE)
    before = client.get("/api/run/obs/series", params={"site": site, "iteration": 1})
    assert series_meta(before)["n_real"] == 4
    assert len(ens_calls) == 1

    make_obs_run(run.root, iterations=(0, 1), n_real=3)
    ingest_run(run.root, cache_root=Path(_root(client)))
    after = client.get("/api/run/obs/series", params={"site": site, "iteration": 1})

    assert after.status_code == 200, after.text
    assert series_meta(after)["n_real"] == 3
    assert len(ens_calls) == 2
    layout = CacheLayout(root=Path(_root(client)))
    stored = obsens.load_obs_ensemble(1, layout)
    index = obsindex.load_obs_index(layout)
    row = index.sites.loc[index.sites["site_id"] == site].iloc[0]
    start, count = int(row["start"]), int(row["count"])
    assert after.content == np.asarray(stored.values[start : start + count]).tobytes()


def test_a_read_failure_is_not_kept_and_the_loader_runs_again(tmp_path, in_process, monkeypatch):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    site = site_id(_root(client), HEAD_SITE)
    calls: list = []

    def failing(iteration, layout):
        calls.append(iteration)
        return ReadFailure(
            name=f"obs_ens/{iteration}", path="x", reason=f"obs_ens/{iteration}: sidecar is unreadable"
        )

    with monkeypatch.context() as patched:
        patched.setattr(obsens, "load_obs_ensemble", failing)
        for _ in range(2):
            response = client.get("/api/run/obs/series", params={"site": site, "iteration": 1})
            assert response.status_code == 404
            assert response.json()["artifact"] == "obs_ens/1"

    assert calls == [1, 1]
    assert client.get("/api/run/obs/series", params={"site": site, "iteration": 1}).status_code == 200


def test_an_ingest_started_through_the_route_drops_the_memo_for_its_cache(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"
    elsewhere = str(tmp_path / "other")
    fake = _scripted_ingest(["control"], sleep=0.02)

    with mock.patch.object(runner_module, "ingest_run", fake):
        app, token = _app_for(run_dir, cache_root)
        app.state.obs_memo = {
            (str(cache_root), "index"): object(),
            (str(cache_root), "ens", 1): object(),
            (elsewhere, "index"): object(),
        }
        with _client(app) as client:
            assert client.post("/api/run/ingest", headers={"x-pesto-token": token}).status_code == 202
            _drain_events(client, token)

    assert list(app.state.obs_memo) == [(elsewhere, "index")]


def test_an_ingest_that_raises_still_drops_the_obs_memo(tmp_path):
    run_dir = _make_run(tmp_path, iterations=())
    cache_root = tmp_path / "cache"

    def failing(run_dir, cache_root, iterations, on_progress, cancel):
        raise RuntimeError("boom")

    with mock.patch.object(runner_module, "ingest_run", failing):
        app, token = _app_for(run_dir, cache_root)
        app.state.obs_memo = {(str(cache_root), "index"): object()}
        with _client(app) as client:
            assert client.post("/api/run/ingest", headers={"x-pesto-token": token}).status_code == 202
            _drain_events(client, token)

    assert app.state.obs_memo == {}


def test_two_cache_roots_in_one_app_keep_separate_entries(tmp_path, in_process):  # noqa: F811
    first, _ = open_obs_run(tmp_path / "one", iterations=(0, 1), n_real=4)
    second, _ = open_obs_run(tmp_path / "two", iterations=(0, 1), n_real=4)
    state = create_app()[0].state
    root_one, root_two = _root(first), _root(second)

    index_one = obscache.get_index(state, root_one)
    index_two = obscache.get_index(state, root_two)

    assert not isinstance(index_one, ReadFailure)
    assert not isinstance(index_two, ReadFailure)
    assert index_one is not index_two
    assert obscache.get_index(state, root_one) is index_one
    assert obscache.get_index(state, root_two) is index_two

    obscache.invalidate(state, root_one)

    assert list(state.obs_memo) == [(root_two, "index")]


def test_the_memo_follows_every_artifact_a_value_was_built_from(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, with_noise=True)
    state = client.pesto_app.state
    root = _root(client)
    layout = CacheLayout(root=Path(root))

    held = obscache.get_noise(state, root)
    assert obscache.get_noise(state, root) is held

    manifest = Manifest.load(layout)
    manifest.mark_failed("noise_agg", "gone")
    manifest.save(layout)

    assert obscache.get_noise(state, root) is not held
