"""The parameter view routes: the group summary, one group's per-parameter
change as Arrow, and the placement notes. Each test ingests a generated run
and reads the answer back through a real app, never the cache files."""

from __future__ import annotations

import pyarrow as pa
import pytest
from fastapi.testclient import TestClient

from ingest.par_fixtures import make_par_view_run, numeric_space
from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.api.app import create_app
from pesto.ingest.runner import ingest_run

BASE_URL = "http://127.0.0.1"


def _open(tmp_path, **kwargs):
    run = make_par_view_run(tmp_path / "run", **kwargs)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run.root, cache_root=cache_root)
    app, token = create_app()
    app.state.cache_root = str(cache_root)
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    return run, manifest, client


def _table(response) -> pa.Table:
    assert response.status_code == 200, response.text
    return pa.ipc.open_stream(response.content).read_all()


def test_an_ingested_run_carries_par_change_and_par_groups(tmp_path, in_process):  # noqa: F811
    _run, manifest, _client = _open(tmp_path)

    assert manifest.artifacts["par_change"].state == "ok", manifest.artifacts["par_change"].reason
    assert manifest.artifacts["par_groups"].state == "ok", manifest.artifacts["par_groups"].reason


def test_groups_lists_every_group_once_in_control_order_with_its_size(tmp_path, in_process):  # noqa: F811
    run, _manifest, client = _open(tmp_path)

    response = client.get("/api/run/par/groups")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert [g["group"] for g in body["groups"]] == list(run.groups)
    assert [g["n_par"] for g in body["groups"]] == [len(v) for v in run.groups.values()]


def test_change_serves_one_groups_parameters_in_control_order(tmp_path, in_process):  # noqa: F811
    run, _manifest, client = _open(tmp_path)

    table = _table(client.get("/api/run/par/change", params={"group": "hk_pp"}))

    assert table.column("parnme").to_pylist() == run.groups["hk_pp"]
    assert set(table.column("pargp").to_pylist()) == {"hk_pp"}


def test_change_means_equal_numpy_on_the_generated_values(tmp_path, in_process):  # noqa: F811
    run, _manifest, client = _open(tmp_path)
    common = [n for n in run.real_names[0] if n in run.real_names[1]]
    assert len(common) == 5

    for group in ("hk_pp", "rch_gr"):
        table = _table(client.get("/api/run/par/change", params={"group": group}))
        names = table.column("parnme").to_pylist()
        first = table.column("mean_first").to_pylist()
        last = table.column("mean_last").to_pylist()
        for i, name in enumerate(names):
            expected_first = numeric_space(run, 0, name, common).mean()
            expected_last = numeric_space(run, 1, name, common).mean()
            assert first[i] == pytest.approx(expected_first, rel=1e-6)
            assert last[i] == pytest.approx(expected_last, rel=1e-6)


def test_an_unknown_group_is_a_404_naming_par_change(tmp_path, in_process):  # noqa: F811
    _run, _manifest, client = _open(tmp_path)

    response = client.get("/api/run/par/change", params={"group": "nosuch"})

    assert response.status_code == 404
    assert response.json()["artifact"] == "par_change"


def test_groups_with_no_run_open_is_409(tmp_path):
    app, token = create_app()
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token

    assert client.get("/api/run/par/groups").status_code == 409
    assert client.get("/api/run/par/change", params={"group": "g"}).status_code == 409


def test_change_refuses_a_query_field_it_does_not_know(tmp_path, in_process):  # noqa: F811
    _run, _manifest, client = _open(tmp_path)

    response = client.get("/api/run/par/change", params={"group": "hk_pp", "layer": 1})

    assert response.status_code == 422


def test_groups_without_the_cached_file_is_a_404_naming_par_groups(tmp_path, in_process):  # noqa: F811
    _run, _manifest, client = _open(tmp_path)
    (tmp_path / "cache" / "agg" / "par_groups.json").unlink()

    response = client.get("/api/run/par/groups")

    assert response.status_code == 404
    assert response.json()["artifact"] == "par_groups"
