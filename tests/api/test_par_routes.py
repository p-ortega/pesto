"""The parameter view routes: the group summary, one group's per-parameter
change as Arrow, and the placement notes. Each test ingests a generated run
and reads the answer back through a real app, never the cache files."""

from __future__ import annotations

import pyarrow as pa
import pytest
from fastapi.testclient import TestClient

from ingest.par_fixtures import make_par_view_run, numeric_space, write_placement
from ingest.test_control_first import in_process  # noqa: F401  (a fixture, used by name)
from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.ingest.failures import ReadFailure
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


def test_placement_gives_each_groups_rule_and_counts_and_keeps_notes_that_name_no_group(
    tmp_path, in_process  # noqa: F811
):
    _run, _manifest, client = _open(tmp_path)
    notes = (
        "group 'hk_pp': rule 'idx-layer' placed 4 of 4 parameters; nothing left over",
        "group 'mix': rule 'idx-layer' placed 3 of 3 parameters; nothing left over",
        "the grid file holds two idomain arrays and the first was used",
    )
    written = write_placement(
        CacheLayout(root=tmp_path / "cache"), {"hk_pp": 1, "mix": 0}, notes=notes
    )
    assert not isinstance(written, ReadFailure), written

    response = client.get("/api/run/grid/placement")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    groups = {g["group"]: g for g in body["groups"]}
    assert (groups["hk_pp"]["rule"], groups["hk_pp"]["mapped"], groups["hk_pp"]["total"]) == (
        "idx-layer",
        4,
        4,
    )
    assert groups["hk_pp"]["notes"] == [notes[0]]
    assert groups["mix"]["notes"] == [notes[1]]
    assert groups["rch_gr"]["rule"] == "unmapped"
    assert groups["rch_gr"]["mapped"] == 0
    assert groups["rch_gr"]["notes"] == []
    assert body["notes"] == [notes[2]]
    assert body["summary"]


def test_a_note_for_a_group_whose_name_starts_like_another_goes_to_the_right_group(
    tmp_path, in_process  # noqa: F811
):
    _run, _manifest, client = _open(tmp_path)
    notes = ("group 'hk_pp': one", "group 'hk_ppx': two")
    written = write_placement(CacheLayout(root=tmp_path / "cache"), {"hk_pp": 1}, notes=notes)
    assert not isinstance(written, ReadFailure), written

    body = client.get("/api/run/grid/placement").json()

    groups = {g["group"]: g for g in body["groups"]}
    assert groups["hk_pp"]["notes"] == ["group 'hk_pp': one"]
    assert body["notes"] == ["group 'hk_ppx': two"]


def test_placement_without_a_par_cell_artifact_is_a_404_naming_par_cell(tmp_path, in_process):  # noqa: F811
    _run, _manifest, client = _open(tmp_path)

    response = client.get("/api/run/grid/placement")

    assert response.status_code == 404
    assert response.json()["artifact"] == "par_cell"


def test_placement_with_no_run_open_is_409():
    app, token = create_app()
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token

    assert client.get("/api/run/grid/placement").status_code == 409


def test_groups_without_the_cached_file_is_a_404_naming_par_groups(tmp_path, in_process):  # noqa: F811
    _run, _manifest, client = _open(tmp_path)
    (tmp_path / "cache" / "agg" / "par_groups.json").unlink()

    response = client.get("/api/run/par/groups")

    assert response.status_code == 404
    assert response.json()["artifact"] == "par_groups"


# ---------------------------------------------------------------------------
# /par/hist
# ---------------------------------------------------------------------------


def test_hist_serves_one_groups_shared_edge_histograms(tmp_path, in_process):  # noqa: F811
    run, manifest, client = _open(tmp_path)
    assert manifest.artifacts["par_hist"].state == "ok", manifest.artifacts["par_hist"].reason

    response = client.get("/api/run/par/hist", params={"group": "hk_pp"})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["group"] == "hk_pp"
    assert body["space"] == "log10"
    assert len(body["edges"]) == 51
    assert body["edges"] == sorted(body["edges"])
    assert (body["first"]["iteration"], body["last"]["iteration"]) == (0, 1)
    assert len(body["first"]["counts"]) == len(body["first"]["density"]) == 50
    assert sum(body["first"]["counts"]) == body["first"]["n"]
    assert body["n_common"] == 5
    assert body["refused"] is None


def test_hist_for_an_unknown_group_is_a_404_naming_par_hist(tmp_path, in_process):  # noqa: F811
    _run, _manifest, client = _open(tmp_path)

    response = client.get("/api/run/par/hist", params={"group": "nosuch"})

    assert response.status_code == 404
    assert response.json()["artifact"] == "par_hist"


def test_hist_with_no_run_open_is_409():
    app, token = create_app()
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token

    assert client.get("/api/run/par/hist", params={"group": "g"}).status_code == 409
