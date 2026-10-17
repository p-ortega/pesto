"""The pilot-point routes: the index, the field with the same identity rules
as /values, and the readout's contributors."""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.cache.layout import CACHE_VERSION
from pesto.cache.manifest import CacheFile, Manifest
from pesto.ingest.ppfactors import PpGroup, PpIndex, write_pp_index
from .test_fields_compute import FAC, _stored


def _client(layout, run_dir):
    app, token = create_app()
    app.state.cache_root = str(layout.root)
    app.state.initial_run_dir = str(run_dir)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers["x-pesto-token"] = token
    return client


def _case(tmp_path):
    layout, _ = _stored(tmp_path)
    (tmp_path / "g.fac").write_text(FAC)
    group = PpGroup("G4", 0, "g.fac", "text", ("p8", "p9"), ("pp0", "pp1"), False, 4)
    write_pp_index(PpIndex((group,), (("hk", "no template"),)), layout)
    # mesh.json is what the field route reads ncpl from
    (layout.grid / "mesh.json").write_text(json.dumps({"cache_version": CACHE_VERSION, "n_cells": 5, "nlay": 1}))
    manifest = Manifest.empty(str(tmp_path))
    for name, folder in (("par_ens/0", layout.ens), ("par_agg/0", layout.agg)):
        files = tuple(
            CacheFile(path=str(p.relative_to(layout.root)), bytes=p.stat().st_size)
            for p in sorted(folder.iterdir())
        )
        manifest.mark_ok(name, sources=[], files=files)
    manifest.save(layout)
    return layout, _client(layout, tmp_path)


def test_pp_lists_groups_and_refusals(tmp_path):
    _, client = _case(tmp_path)
    body = client.get("/api/run/grid/pp").json()
    assert [g["group"] for g in body["groups"]] == ["G4"]
    assert body["groups"][0]["layer"] == 0 and body["groups"][0]["n_pp"] == 2
    assert body["not_interpolable"] == [{"group": "hk", "reason": "no template"}]


def test_field_serves_one_float_per_cell_for_a_realization_by_name(tmp_path):
    _, client = _case(tmp_path)
    r = client.get("/api/run/grid/field", params={"iteration": 0, "group": "G4", "realization": "34"})
    assert r.status_code == 200
    field = np.frombuffer(r.content, dtype="<f4")
    assert field.shape == (5,)
    assert field[0] == 30.0 and field[4] == 40.0 and field[1] == 32.5 and np.isnan(field[3])
    meta = json.loads(r.headers["x-pesto-meta"])
    assert meta["order"] == "cell" and meta["group"] == "G4" and meta["layer"] == 0 and meta["n_pp"] == 2


def test_field_serves_a_statistic(tmp_path):
    _, client = _case(tmp_path)
    r = client.get("/api/run/grid/field", params={"iteration": 0, "group": "G4", "stat": "mean"})
    assert r.status_code == 200
    assert np.frombuffer(r.content, dtype="<f4")[0] == np.float32((10 + 30 + 0.1) / 3)


def test_field_rejects_the_same_shapes_values_rejects(tmp_path):
    _, client = _case(tmp_path)
    assert client.get("/api/run/grid/field", params={"iteration": 0, "group": "G4"}).status_code == 422
    assert client.get("/api/run/grid/field", params={"iteration": 0, "group": "G4", "stat": "mean", "realization": "base"}).status_code == 422
    assert client.get("/api/run/grid/field", params={"iteration": 0, "group": "nope", "realization": "base"}).status_code == 404
    assert client.get("/api/run/grid/field", params={"iteration": 0, "group": "G4", "realization": "99"}).status_code == 404


def test_field_is_memoised_under_the_ensemble_tag(tmp_path):
    layout, client = _case(tmp_path)
    client.get("/api/run/grid/field", params={"iteration": 0, "group": "G4", "realization": "base"})
    files = list((layout.pp / "fields").rglob("*.f32"))
    assert len(files) == 1 and files[0].name == "base.f32"


def test_an_edited_factor_file_is_never_answered_from_the_old_memo(tmp_path):
    _, client = _case(tmp_path)
    params = {"iteration": 0, "group": "G4", "realization": "34"}
    assert np.frombuffer(client.get("/api/run/grid/field", params=params).content, dtype="<f4")[0] == 30.0
    fac = tmp_path / "g.fac"
    # Same length, so only the modified time tells the two files apart.
    fac.write_text(FAC.replace("1 0 2 0.0 1 1.0 2 0.0", "1 0 2 0.0 1 0.0 2 1.0"))
    st = fac.stat()
    os.utime(fac, ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
    assert np.frombuffer(client.get("/api/run/grid/field", params=params).content, dtype="<f4")[0] == 40.0


def test_field_cell_names_contributors(tmp_path):
    _, client = _case(tmp_path)
    body = client.get("/api/run/grid/field/cell", params={"iteration": 0, "group": "G4", "cell": 1}).json()
    assert body == {"group": "G4", "cell": 1, "contributors": [{"parnme": "p8", "weight": 0.75}, {"parnme": "p9", "weight": 0.25}]}


def test_routes_need_an_open_run(tmp_path):
    app, token = create_app()
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers["x-pesto-token"] = token
    assert client.get("/api/run/grid/pp").status_code == 409


def test_field_is_not_memoised_when_the_ensemble_carries_no_cache_tag(tmp_path):
    layout, client = _case(tmp_path)
    Manifest.empty(str(tmp_path)).save(layout)
    r = client.get("/api/run/grid/field", params={"iteration": 0, "group": "G4", "realization": "base"})
    assert r.status_code == 200
    assert not (layout.pp / "fields").exists()


def _header_free_client(client):
    # same app and token, but no x-pesto-token header, so only ?token= can authorise
    bare = TestClient(client.app, base_url="http://127.0.0.1")
    return bare, client.headers["x-pesto-token"]


def test_field_accepts_the_token_in_the_query_form(tmp_path):
    _, client = _case(tmp_path)
    params = {"iteration": 0, "group": "G4", "realization": "34"}
    expected = client.get("/api/run/grid/field", params=params)
    bare, token = _header_free_client(client)
    r = bare.get("/api/run/grid/field", params={**params, "token": token})
    assert r.status_code == 200
    assert r.content == expected.content


def test_field_cell_accepts_the_token_in_the_query_form(tmp_path):
    _, client = _case(tmp_path)
    params = {"iteration": 0, "group": "G4", "cell": 1}
    expected = client.get("/api/run/grid/field/cell", params=params)
    bare, token = _header_free_client(client)
    r = bare.get("/api/run/grid/field/cell", params={**params, "token": token})
    assert r.status_code == 200
    assert r.json() == expected.json()


def test_a_misspelt_query_field_is_still_refused_on_both_routes(tmp_path):
    _, client = _case(tmp_path)
    field = {"iteration": 0, "group": "G4", "realization": "34", "groupp": "G1"}
    cell = {"iteration": 0, "group": "G4", "cell": 1, "layer": 1}
    assert client.get("/api/run/grid/field", params=field).status_code == 422
    assert client.get("/api/run/grid/field/cell", params=cell).status_code == 422
