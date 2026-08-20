"""Arrow round-trip, column-order, and failure-shape tests for
``GET /api/run/meta`` and ``GET /api/run/reals``, tested against a real
FastAPI app the same way ``tests/test_launch.py`` already does."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pytest
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.ingest.control import ControlTables, read_control
from pesto.ingest.ensembles import write_par_reals
from pesto.ingest.tables import write_control

BASE_URL = "http://127.0.0.1"

# Deliberately not alphabetical: sorting these would move parval1 and
# partrans ahead of pargp, so a route that sorted its columns would fail
# every column-order assertion below.
_PAR_COLUMNS = ["parnme", "pargp", "parval1", "partrans", "parlbnd", "parubnd"]


def _client(app) -> TestClient:
    return TestClient(app, base_url=BASE_URL)


def _control_tables(*, notes: tuple[str, ...] = ()) -> ControlTables:
    par = pd.DataFrame(
        {
            "parnme": ["p1", "p2"],
            "pargp": ["g1", "g1"],
            "parval1": [1.0, 2.0],
            "partrans": ["log", "log"],
            "parlbnd": [0.1, 0.1],
            "parubnd": [10.0, 10.0],
        }
    )
    obs = pd.DataFrame(
        {
            "obsnme": ["o1", "o2"],
            "obgnme": ["og1", "og1"],
            "weight": [1.0, 1.0],
        }
    )
    return ControlTables(
        par=par,
        obs=obs,
        par_groups=("g1",),
        obs_groups=("og1",),
        source_path=Path("/fake/x.pst"),
        notes=tuple(notes),
        ambiguities=(),
    )


def _open_run(tmp_path: Path, *, notes: tuple[str, ...] = (), write_control_table: bool = True):
    """Build a cache under ``tmp_path``, wire it into a fresh app's
    ``cache_root``, and hand back ``(app, token)``."""
    layout = CacheLayout(root=tmp_path)
    layout.ensure()
    if write_control_table:
        write_control(_control_tables(notes=notes), layout)
    app, token = create_app()
    app.state.cache_root = str(tmp_path)
    return app, token


def _get(app, token: str, path: str, **params):
    return _client(app).get(path, params={**params, "token": token})


def test_parameter_table_round_trips_in_the_control_files_own_column_order(tmp_path):
    app, token = _open_run(tmp_path)
    response = _get(app, token, "/api/run/meta", kind="par")

    assert response.status_code == 200
    table = pa.ipc.open_stream(response.content).read_all()
    assert table.column_names == _PAR_COLUMNS


def test_observation_table_round_trips_the_same_way(tmp_path):
    app, token = _open_run(tmp_path)
    response = _get(app, token, "/api/run/meta", kind="obs")

    assert response.status_code == 200
    table = pa.ipc.open_stream(response.content).read_all()
    assert table.column_names == ["obsnme", "obgnme", "weight"]


def test_the_response_media_type_is_the_arrow_stream_type_never_json(tmp_path):
    app, token = _open_run(tmp_path)
    response = _get(app, token, "/api/run/meta", kind="par")

    assert response.headers["content-type"] == "application/vnd.apache.arrow.stream"
    assert response.headers["content-type"] != "application/json"


def test_an_unknown_kind_returns_422_problem_json(tmp_path):
    app, token = _open_run(tmp_path)
    response = _get(app, token, "/api/run/meta", kind="phi")

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"


def test_no_active_run_returns_409_problem_json():
    app, token = create_app()
    response = _get(app, token, "/api/run/meta", kind="par")

    assert response.status_code == 409
    assert response.headers["content-type"] == "application/problem+json"


def test_an_absent_control_parquet_returns_502_naming_the_artifact_with_no_absolute_path(
    tmp_path,
):
    app, token = _open_run(tmp_path, write_control_table=False)
    response = _get(app, token, "/api/run/meta", kind="par")

    assert response.status_code == 502
    body = response.json()
    assert body["artifact"] == "control"
    assert str(tmp_path) not in body["detail"]


def test_recorded_notes_appear_in_the_notes_header(tmp_path):
    app, token = _open_run(tmp_path, notes=("a repaired column",))
    response = _get(app, token, "/api/run/meta", kind="par")

    assert json.loads(response.headers["x-pesto-notes"]) == ["a repaired column"]


def test_the_notes_header_is_absent_when_there_are_no_notes(tmp_path):
    app, token = _open_run(tmp_path, notes=())
    response = _get(app, token, "/api/run/meta", kind="par")

    assert "x-pesto-notes" not in response.headers


def test_realization_names_round_trip_in_recorded_not_sorted_order(tmp_path):
    layout = CacheLayout(root=tmp_path)
    layout.ensure()
    write_par_reals(["r3", "r1", "r2"], 0, layout)
    app, token = create_app()
    app.state.cache_root = str(tmp_path)

    response = _get(app, token, "/api/run/reals", iteration=0)

    assert response.status_code == 200
    table = pa.ipc.open_stream(response.content).read_all()
    assert table.column_names == ["realization"]
    assert table.column("realization").to_pylist() == ["r3", "r1", "r2"]


def test_an_iteration_with_no_recorded_names_returns_404_naming_the_artifact(tmp_path):
    layout = CacheLayout(root=tmp_path)
    layout.ensure()
    write_par_reals(["r1"], 0, layout)
    app, token = create_app()
    app.state.cache_root = str(tmp_path)

    response = _get(app, token, "/api/run/reals", iteration=99)

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["artifact"] == "par_reals/99"


def test_a_realization_sidecar_at_a_foreign_cache_version_is_refused_not_served_empty(tmp_path):
    layout = CacheLayout(root=tmp_path)
    layout.ensure()
    target = layout.par_reals(0)
    target.write_text(
        json.dumps(
            {
                "cache_version": CACHE_VERSION + 1,
                "iteration": 0,
                "n_real": 1,
                "names": ["r1"],
                "notes": [],
            }
        )
    )
    app, token = create_app()
    app.state.cache_root = str(tmp_path)

    response = _get(app, token, "/api/run/reals", iteration=0)

    assert response.status_code != 200
    body = response.json()
    assert target.name in body["detail"]
    assert str(CACHE_VERSION) in body["detail"]
    assert str(CACHE_VERSION + 1) in body["detail"]


@pytest.mark.slow
def test_reads_a_real_forecast_runs_parameter_table(tmp_path, forecast_run):
    pst_path = forecast_run / "escondida.pst"
    tables = read_control(pst_path)
    assert isinstance(tables, ControlTables)

    layout = CacheLayout(root=tmp_path)
    layout.ensure()
    write_control(tables, layout)
    app, token = create_app()
    app.state.cache_root = str(tmp_path)

    response = _get(app, token, "/api/run/meta", kind="par")

    assert response.status_code == 200
    table = pa.ipc.open_stream(response.content).read_all()
    assert len(table.column_names) > 0
