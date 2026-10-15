"""Coverage for the synthetic-run generator (Plan 05.1-02, Task 3): the
directory it writes opens with no ingest needed, every route this phase
draws from answers 200 against it, the run is shaped awkwardly enough to
exercise the states this phase cares about, and running the generator
twice into the same destination is byte-for-byte reproducible.
"""

from __future__ import annotations

import numpy as np
from fastapi.testclient import TestClient

from fixtures.synthetic_run import PP_GROUP, write_synthetic_run
from pesto.api.app import create_app
from pesto.cache.layout import for_run

BASE_URL = "http://127.0.0.1"

ROUTES = (
    ("/api/run/config", {}),
    ("/api/run/grid/mesh", {}),
    ("/api/run/grid/mesh/positions", {}),
    ("/api/run/grid/values", {"iteration": 0, "realization": "base"}),
    ("/api/run/grid/cells/cell", {"iteration": 0}),
    ("/api/run/grid/cells/layer", {"iteration": 0}),
    ("/api/run/grid/parmap", {"iteration": 0}),
    ("/api/run/meta", {"kind": "par"}),
    ("/api/run/reals", {"iteration": 0}),
)


def _opened_client(dest) -> TestClient:
    layout = for_run(dest)
    app, token = create_app()
    app.state.initial_run_dir = str(dest.resolve())
    app.state.cache_root = str(layout.root)
    client = TestClient(app, base_url=BASE_URL)
    client.headers["x-pesto-token"] = token
    return client


# ---------------------------------------------------------------------------
# Opens with no ingest, because its cache reads as fresh
# ---------------------------------------------------------------------------


def test_the_generated_run_reads_as_fresh_with_no_ingest_needed(tmp_path):
    dest = write_synthetic_run(tmp_path / "run")
    client = _opened_client(dest)

    response = client.get("/api/run/ingest/state")

    assert response.status_code == 200
    body = response.json()
    assert body["fresh"] is True, [a for a in body["artifacts"] if a["stale"]]


# ---------------------------------------------------------------------------
# Every route this phase draws from answers 200
# ---------------------------------------------------------------------------


def test_every_route_this_phase_draws_from_answers_200(tmp_path):
    dest = write_synthetic_run(tmp_path / "run")
    client = _opened_client(dest)

    for path, params in ROUTES:
        response = client.get(path, params=params)
        assert response.status_code == 200, (path, params, response.text)


# ---------------------------------------------------------------------------
# The run is deliberately awkward: layers, realizations, groups, contested
# and unmapped cells
# ---------------------------------------------------------------------------


def test_the_run_has_the_awkward_shape_this_phase_needs(tmp_path):
    dest = write_synthetic_run(tmp_path / "run")
    client = _opened_client(dest)

    config = client.get("/api/run/config").json()
    assert config["n_iterations"] == 2
    assert config["n_real"] == 3
    assert config["base_realization"] is True

    mesh = client.get("/api/run/grid/mesh").json()
    assert mesh["nlay"] == 2
    assert mesh["n_cells"] >= 6

    par = client.get("/api/run/meta", params={"kind": "par"})
    import pyarrow as pa

    table = pa.ipc.open_stream(par.content).read_all()
    groups = table.column("pargp").to_pylist()
    assert len(set(groups)) >= 3

    cell_resp = client.get("/api/run/grid/cells/cell", params={"iteration": 0})
    layer_resp = client.get("/api/run/grid/cells/layer", params={"iteration": 0})
    import numpy as np

    cells = np.frombuffer(cell_resp.content, dtype="<i4")
    layers = np.frombuffer(layer_resp.content, dtype="<i4")
    pairs = list(zip(cells.tolist(), layers.tolist()))
    # p1 and p2 (same group) share a cell and layer -- a contested mark.
    assert len(pairs) != len(set(pairs))

    # A parameter group (G3) places on no cell at all.
    parnames_par = table.column("parnme").to_pylist()
    assert len(parnames_par) > len(pairs)


# ---------------------------------------------------------------------------
# Deterministic: running it twice into the same destination is byte-for-byte
# reproducible
# ---------------------------------------------------------------------------


def test_running_the_generator_twice_into_the_same_destination_is_byte_identical(tmp_path):
    dest = tmp_path / "run"

    write_synthetic_run(dest)
    first = {
        p.relative_to(dest): p.read_bytes() for p in dest.rglob("*") if p.is_file()
    }

    write_synthetic_run(dest)
    second = {
        p.relative_to(dest): p.read_bytes() for p in dest.rglob("*") if p.is_file()
    }

    assert set(first) == set(second)
    assert first == second


def test_the_synthetic_run_interpolates_its_pilot_point_group_from_its_own_factor_file(tmp_path):
    dest = write_synthetic_run(tmp_path / "run")
    client = _opened_client(dest)
    index = client.get("/api/run/grid/pp").json()
    assert [g["group"] for g in index["groups"]] == [PP_GROUP]
    assert index["not_interpolable"] == []
    r = client.get(
        "/api/run/grid/field", params={"iteration": 0, "group": PP_GROUP, "realization": "base"}
    )
    field = np.frombuffer(r.content, dtype="<f4")
    assert field.shape == (6,)
    assert field[0] == 10.0 and field[5] == 20.0
    assert np.all(np.diff(field) >= 0)
