"""pdc/K: prior-data conflict, read from pestpp's file or computed and labelled.

The tracer ingests a generated run that has a ``case.0.pdc.csv`` and checks
the rows come from the file, by name, labelled ``file``. The later tests pin
the computed rule, the label on every row, and every absence and refusal.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsindex import load_obs_index
from pesto.ingest.obspdc import (
    NUMERIC_COLUMNS,
    PDC_FILE_COLUMNS,
    load_pdc,
)
from pesto.ingest.runner import ingest_run

from .obs_fixtures import PDC_NUMBER_COLUMNS, make_obs_run
from .test_control_first import in_process  # noqa: F401  (a fixture, used by name)


def _ingest(tmp_path, **kwargs):
    run_dir = tmp_path / "run"
    run = make_obs_run(run_dir, **kwargs)
    cache_root = tmp_path / "cache"
    manifest = ingest_run(run_dir, cache_root=cache_root)
    return run, CacheLayout(root=cache_root), manifest


def _sidecar(layout, iteration=0):
    return json.loads(layout.pdc_meta(iteration).read_text())


def _pdc_capability(run, layout):
    from fastapi.testclient import TestClient

    from pesto.api.app import create_app

    app, token = create_app()
    app.state.initial_run_dir = str(run.root)
    app.state.cache_root = str(layout.root)
    client = TestClient(app, base_url="http://127.0.0.1")
    response = client.get("/api/run/ingest/state", headers={"x-pesto-token": token})
    assert response.status_code == 200, response.text
    return response.json()["capabilities"]["pdc"]


# ---------------------------------------------------------------------------
# the tracer
# ---------------------------------------------------------------------------


def test_pestpps_pdc_file_is_read_by_name_into_pdc_0_and_labelled_file(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_noise=True, with_pdc=True)

    manifest = Manifest.load(layout)
    assert manifest.artifacts["pdc/0"].state == "ok"
    table = load_pdc(0, layout)
    assert not isinstance(table, ReadFailure), table

    frame = table.frame
    assert len(frame) == 2
    # The first file name was upper case; the stored name is the control name.
    assert list(frame["obsnme"]) == [run.obs_names[0], run.obs_names[1]]
    index = load_obs_index(layout)
    inverse = {int(row): position for position, row in enumerate(index.order)}
    assert list(frame["position"]) == [inverse[0], inverse[1]]
    for column in NUMERIC_COLUMNS:
        assert frame[column].dtype == np.float64
    for stored, written in zip(frame.to_dict("records"), run.pdc_rows):
        for column in PDC_NUMBER_COLUMNS:
            assert stored[column] == written[column]
    assert set(frame["source"]) == {"file"}
    assert table.source == "file"

    sidecar = _sidecar(layout)
    assert sidecar["source"] == "file"
    assert sidecar["source_file"] == "case.0.pdc.csv"
    assert sidecar["n_conflict"] == 2
    assert sidecar["n_unmatched"] == 0
    assert sidecar["order_digest"] == index.order_digest
    assert any("lower-casing" in note for note in sidecar["notes"])


def test_the_state_route_says_pdc_is_available(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_noise=True, with_pdc=True)

    assert _pdc_capability(run, layout) == {"available": True, "blocked_by": []}


def test_the_stored_columns_are_the_ones_pestpp_writes(tmp_path, in_process):
    run, layout, _ = _ingest(tmp_path, with_noise=True, with_pdc=True)

    frame = load_pdc(0, layout).frame
    assert list(frame.columns) == ["obsnme", "position", *PDC_FILE_COLUMNS[1:], "source"]
