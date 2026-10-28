"""The realization names behind the spaghetti (``/obs/reals``) and the base realization's name for
the chip (``/reals/base``). Base is found by ``find_base``, never by a plain string comparison."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.api.app import create_app
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.ingest.ensembles import write_par_reals

from .obs_helpers import BASE_URL, open_cache, open_obs_run


def _root(client) -> str:
    return client.pesto_app.state.cache_root


def _closed() -> TestClient:
    app, token = create_app()
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    return client


def _snapshot(*roots: Path) -> dict:
    seen = {}
    for root in roots:
        for path in sorted(Path(root).rglob("*")):
            if path.is_file():
                stat = path.stat()
                seen[str(path)] = (stat.st_size, stat.st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
            else:
                seen[str(path)] = "dir"
    return seen


def _reals_cache(tmp_path, names: list[str], iteration: int = 0) -> TestClient:
    layout = CacheLayout(root=tmp_path / "cache")
    layout.ensure()
    write_par_reals(names, iteration, layout)
    return open_cache(layout.root)


# ---------------------------------------------------------------------------
# /obs/reals
# ---------------------------------------------------------------------------


def test_obs_reals_gives_the_names_in_file_order_and_where_base_is(tmp_path, in_process):  # noqa: F811
    names = ["base", "r1", "r2", "r3"]
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, real_names=names)

    response = client.get("/api/run/obs/reals", params={"iteration": 0})

    assert response.status_code == 200, response.text
    assert response.json() == {"iteration": 0, "names": names, "base_index": [0], "base_note": None}


def test_obs_reals_keeps_an_order_that_is_not_sorted(tmp_path, in_process):  # noqa: F811
    names = ["r3", "r1", "base", "r2"]
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4, real_names=names)

    body = client.get("/api/run/obs/reals", params={"iteration": 1}).json()

    assert body["names"] == names
    assert body["base_index"] == [2]


def test_obs_reals_finds_a_base_spelled_with_spaces_and_capitals_and_says_so(tmp_path, in_process):  # noqa: F811
    names = ["r1", " Base ", "r2", "r3"]
    # A binary ensemble file stores names lower-cased, so only a csv one keeps this spelling.
    client, _run = open_obs_run(
        tmp_path, iterations=(0,), n_real=4, real_names=names, ensemble_format="csv"
    )

    body = client.get("/api/run/obs/reals", params={"iteration": 0}).json()

    assert body["names"] == names
    assert body["base_index"] == [1]
    assert "trimming" in body["base_note"] and "lower-casing" in body["base_note"]


def test_obs_reals_without_a_base_gives_no_position(tmp_path, in_process):  # noqa: F811
    names = ["r1", "r2", "r3", "r4"]
    client, _run = open_obs_run(tmp_path, iterations=(0,), n_real=4, real_names=names)

    body = client.get("/api/run/obs/reals", params={"iteration": 0}).json()

    assert body["base_index"] == []
    assert body["base_note"] is None


def test_obs_reals_for_an_iteration_with_no_ensemble_is_404_naming_it(tmp_path, in_process):  # noqa: F811
    client, _run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)

    response = client.get("/api/run/obs/reals", params={"iteration": 7})

    assert response.status_code == 404
    assert response.json()["artifact"] == "obs_ens/7"


def test_obs_reals_with_no_run_open_is_409():
    assert _closed().get("/api/run/obs/reals", params={"iteration": 0}).status_code == 409


def test_obs_reals_writes_nothing_to_the_run_or_the_cache(tmp_path, in_process):  # noqa: F811
    client, run = open_obs_run(tmp_path, iterations=(0, 1), n_real=4)
    before = _snapshot(run.root, Path(_root(client)))

    client.get("/api/run/obs/reals", params={"iteration": 0})
    client.get("/api/run/obs/reals", params={"iteration": 1})
    client.get("/api/run/obs/reals", params={"iteration": 7})

    assert _snapshot(run.root, Path(_root(client))) == before


# ---------------------------------------------------------------------------
# /reals/base
# ---------------------------------------------------------------------------


def test_reals_base_names_base(tmp_path):
    client = _reals_cache(tmp_path, ["34", "base", "35"])

    response = client.get("/api/run/reals/base", params={"iteration": 0})

    assert response.status_code == 200, response.text
    assert response.json() == {"iteration": 0, "name": "base", "note": None, "reason": None}


def test_reals_base_gives_the_files_own_spelling_and_a_note_when_only_the_folded_name_matched(tmp_path):
    client = _reals_cache(tmp_path, ["34", " BASE ", "35"], iteration=3)

    body = client.get("/api/run/reals/base", params={"iteration": 3}).json()

    assert body["name"] == " BASE "
    assert "trimming" in body["note"]
    assert body["reason"] is None


def test_reals_base_without_a_base_says_so(tmp_path):
    client = _reals_cache(tmp_path, ["34", "35", "176"])

    body = client.get("/api/run/reals/base", params={"iteration": 0}).json()

    assert body == {
        "iteration": 0,
        "name": None,
        "note": None,
        "reason": "no realization named base in iteration 0",
    }


def test_reals_base_for_an_iteration_with_no_names_is_the_same_404_as_reals(tmp_path):
    client = _reals_cache(tmp_path, ["base"])

    base = client.get("/api/run/reals/base", params={"iteration": 9})
    reals = client.get("/api/run/reals", params={"iteration": 9})

    assert base.status_code == reals.status_code == 404
    assert base.json() == reals.json()
    assert base.json()["artifact"] == "par_reals/9"


def test_reals_base_refuses_a_file_that_is_not_an_object_as_reals_does(tmp_path):
    client = _reals_cache(tmp_path, ["base"])
    CacheLayout(root=Path(_root(client))).par_reals(0).write_text(json.dumps(["base"]))

    base = client.get("/api/run/reals/base", params={"iteration": 0})
    reals = client.get("/api/run/reals", params={"iteration": 0})

    assert base.status_code == reals.status_code == 502
    assert base.json() == reals.json()


def test_reals_base_refuses_a_foreign_cache_version_as_reals_does(tmp_path):
    client = _reals_cache(tmp_path, ["base"])
    CacheLayout(root=Path(_root(client))).par_reals(0).write_text(
        json.dumps({"cache_version": CACHE_VERSION + 1, "names": ["base"]})
    )

    base = client.get("/api/run/reals/base", params={"iteration": 0})
    reals = client.get("/api/run/reals", params={"iteration": 0})

    assert base.status_code == reals.status_code == 502
    assert base.json() == reals.json()
    assert str(CACHE_VERSION + 1) in base.json()["detail"]


@pytest.mark.parametrize("names", [["base", 3], "base"])
def test_reals_base_refuses_names_that_are_not_a_list_of_text(tmp_path, names):
    client = _reals_cache(tmp_path, ["base"])
    CacheLayout(root=Path(_root(client))).par_reals(0).write_text(
        json.dumps({"cache_version": CACHE_VERSION, "names": names})
    )

    response = client.get("/api/run/reals/base", params={"iteration": 0})

    assert response.status_code == 502
    assert response.json()["artifact"] == "par_reals/0"


def test_reals_base_with_no_run_open_is_409():
    assert _closed().get("/api/run/reals/base", params={"iteration": 0}).status_code == 409


def test_reals_base_writes_nothing_to_the_cache(tmp_path):
    client = _reals_cache(tmp_path, ["34", "base"])
    before = _snapshot(Path(_root(client)))

    client.get("/api/run/reals/base", params={"iteration": 0})
    client.get("/api/run/reals/base", params={"iteration": 9})

    assert _snapshot(Path(_root(client))) == before
