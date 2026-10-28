"""/obs/pdc: which sites hold prior-data conflict in one iteration, where they are, how
many per group, and where the figures came from. Sentinel-built rows are left out and
counted; the pdc table itself never leaves the server."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

import pesto.ingest.obspdc as obspdc
from ingest.fixtures import survivor_names
from ingest.obs_fixtures import make_obs_run, write_pdc_csv
from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.obscell import load_obs_cell
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.runner import ingest_run

from .obs_helpers import open_cache, open_obs_run, site_id
from .test_ingest import _snapshot

URL = "/api/run/obs/pdc"
ICPL_A = "oname:hds_otype:lst_usecol:icpl-a"
ICPL_B = "oname:hds_otype:lst_usecol:icpl-b"


def _root(client) -> Path:
    return Path(client.pesto_app.state.cache_root)


def _ints_only(body: dict) -> None:
    for values in body["sites"].values():
        assert all(type(v) is int for v in values)
    for entry in body["by_group"]:
        assert type(entry["n_obs"]) is int and type(entry["n_sites"]) is int


def test_a_pdc_file_answers_with_the_conflicted_sites_and_their_cells(tmp_path, in_process):  # noqa: F811
    client, run = open_obs_run(tmp_path, grid=True, with_pdc=True)
    layout = CacheLayout(root=_root(client))
    table = obspdc.load_pdc(0, layout)
    cells = load_obs_cell(layout)

    response = client.get(URL, params={"iteration": 0})

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["available"] is True
    assert body["reason"] is None
    assert (body["artifact"], body["iteration"]) == ("pdc/0", 0)
    assert body["source"] == "file"
    assert body["source_file"] == table.source_file
    assert body["weights_source"] == table.weights_source
    assert body["rule"] == table.rule
    assert body["n_unmatched"] == table.n_unmatched
    assert body["n_left_out"] == 0
    assert body["n_obs"] == table.n_conflict == 2

    ids = sorted([site_id(_root(client), ICPL_A), site_id(_root(client), ICPL_B)])
    assert body["sites"]["id"] == ids
    assert body["n_sites"] == 2
    assert body["sites"]["n_obs"] == [1, 1]
    at = [list(cells.site_id).index(i) for i in ids]
    assert body["sites"]["cell"] == [int(cells.cell[i]) for i in at]
    assert body["sites"]["layer"] == [int(cells.layer[i]) for i in at]
    assert [body["groups"][g] for g in body["sites"]["group_index"]] == ["gw_icpl", "gw_icpl"]

    by_group = {g["group"]: g for g in body["by_group"]}
    assert by_group["gw_icpl"] == {"group": "gw_icpl", "n_obs": 2, "n_sites": 2}
    assert by_group["gw_xy"] == {"group": "gw_xy", "n_obs": 0, "n_sites": 0}
    _ints_only(body)


def test_the_answer_never_ships_the_pdc_table(tmp_path, in_process):  # noqa: F811
    client, run = open_obs_run(tmp_path, grid=True, with_pdc=True)

    response = client.get(URL, params={"iteration": 0})

    body = response.json()
    # The notes pdc/K carries are passed on as written and may name an observation;
    # nothing else in the answer may.
    assert body["notes"]
    text = json.dumps({k: v for k, v in body.items() if k != "notes"})
    assert "obsnme" not in text
    for name in run.obs_names:
        assert name not in text
    assert set(body["sites"]) == {"id", "cell", "layer", "group_index", "n_obs"}


def test_computed_conflict_is_labelled_computed_with_its_rule(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, grid=True, with_noise=True)

    body = client.get(URL, params={"iteration": 0}).json()

    assert body["available"] is True
    assert body["source"] == "computed"
    assert body["rule"] == obspdc.COMPUTED_RULE
    assert body["n_unmatched"] == 0
    _ints_only(body)


def test_a_sentinel_built_row_is_left_out_and_counted(tmp_path, in_process):  # noqa: F811
    run = make_obs_run(
        tmp_path / "run", grid=True, with_pdc=True,
        sentinel_values={0: [(ICPL_B, name) for name in survivor_names()]},
    )
    assert run.obs_names[1] == ICPL_B
    # pestpp writes a dry cell's 1e30 straight into the simulated range of its pdc row.
    rows = [dict(r) for r in run.pdc_rows]
    rows[1]["sim_max"] = 1e30
    write_pdc_csv(run.pdc_path, rows)
    cache_root = tmp_path / "cache"
    ingest_run(run.root, cache_root=cache_root)
    client = open_cache(cache_root)
    assert obspdc.load_pdc(0, CacheLayout(root=cache_root)).n_conflict == 2

    body = client.get(URL, params={"iteration": 0}).json()

    assert body["n_left_out"] == 1
    assert body["n_obs"] == 1
    assert body["n_sites"] == 1
    assert body["sites"]["id"] == [site_id(cache_root, ICPL_A)]
    assert body["sites"]["n_obs"] == [1]
    by_group = {g["group"]: g for g in body["by_group"]}
    assert by_group["gw_icpl"] == {"group": "gw_icpl", "n_obs": 1, "n_sites": 1}


def test_a_position_outside_obs_index_is_refused_naming_pdc_k(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, grid=True, with_pdc=True)
    layout = CacheLayout(root=_root(client))
    n_obs = load_obs_index(layout).n_obs
    frame = pd.read_parquet(layout.pdc(0))
    frame.loc[0, "position"] = n_obs
    frame.to_parquet(layout.pdc(0), index=False)

    response = client.get(URL, params={"iteration": 0})

    assert response.status_code == 404
    problem = response.json()
    assert problem["artifact"] == "pdc/0"
    assert "position" in problem["detail"]


def test_an_iteration_without_pdc_says_so_and_never_borrows_another(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, grid=True, with_pdc=True)

    response = client.get(URL, params={"iteration": 1})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["available"] is False
    assert body["artifact"] == "pdc/1"
    assert body["reason"]
    assert body["sites"] == {"id": [], "cell": [], "layer": [], "group_index": [], "n_obs": []}
    assert body["n_obs"] == 0 and body["by_group"] == []


def test_an_iteration_without_pdc_carries_the_recorded_reason(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, grid=True, with_pdc=True)
    layout = CacheLayout(root=_root(client))
    manifest = Manifest.load(layout)
    manifest.mark_failed("pdc/1", "no pestpp pdc file and no obs+noise file to compute one from")
    manifest.save(layout)

    body = client.get(URL, params={"iteration": 1}).json()

    assert body["available"] is False
    assert body["reason"] == "no pestpp pdc file and no obs+noise file to compute one from"


def test_the_memo_is_reused_and_rebuilt_after_pdc_k_is_rewritten(tmp_path, in_process, monkeypatch):  # noqa: F811
    client, _run = open_obs_run(tmp_path, grid=True, with_pdc=True)
    calls: list = []
    original = obspdc.load_pdc

    def counted(iteration, layout):
        calls.append(iteration)
        return original(iteration, layout)

    monkeypatch.setattr(obspdc, "load_pdc", counted)

    first = client.get(URL, params={"iteration": 0}).json()
    client.get(URL, params={"iteration": 0})
    assert calls == [0]
    assert first["n_left_out"] == 0

    layout = CacheLayout(root=_root(client))
    frame = pd.read_parquet(layout.pdc(0))
    frame.loc[0, "distance"] = float("nan")
    frame.to_parquet(layout.pdc(0), index=False)
    after = client.get(URL, params={"iteration": 0}).json()

    assert calls == [0, 0]
    assert after["n_left_out"] == 1
    assert after["n_obs"] == 1


def test_the_run_directory_and_cache_are_untouched(tmp_path, in_process):  # noqa: F811
    client, run = open_obs_run(tmp_path, grid=True, with_pdc=True)
    run_before, cache_before = _snapshot(run.root), _snapshot(_root(client))

    for iteration in (0, 1, 0):
        assert client.get(URL, params={"iteration": iteration}).status_code == 200

    assert _snapshot(run.root) == run_before
    assert _snapshot(_root(client)) == cache_before
