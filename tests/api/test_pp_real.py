"""The pilot-point routes against a real PstFrom run (hm_20251104154614, the
pl253 model): the index lists its text-factor groups, and one group's field
computes once and then comes back from the memo."""

from __future__ import annotations

import json
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout

GROUP = "npfklayer3pp"


@pytest.mark.slow
def test_pl253_lists_its_pilot_point_groups_and_serves_a_memoised_field(pl253_run, tmp_path):
    from pesto.ingest.runner import ingest_run

    cache_root = tmp_path / "cache"
    manifest = ingest_run(pl253_run, cache_root=cache_root)
    assert manifest.artifacts["pp_factors"].state == "ok", manifest.artifacts["pp_factors"].reason
    layout = CacheLayout(root=cache_root)
    iteration = min(
        int(name.split("/")[1])
        for name, artifact in manifest.artifacts.items()
        if name.startswith("par_ens/") and artifact.state == "ok"
    )
    realization = json.loads(layout.par_reals(iteration).read_text())["names"][0]

    app, token = create_app()
    app.state.cache_root = str(cache_root)
    app.state.initial_run_dir = str(pl253_run)
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers["x-pesto-token"] = token

    index = client.get("/api/run/grid/pp").json()
    groups = {g["group"] for g in index["groups"]}
    assert GROUP in groups
    assert len(groups) >= 60

    params = {"iteration": iteration, "group": GROUP, "realization": realization}
    t0 = time.perf_counter()
    first = client.get("/api/run/grid/field", params=params)
    first_seconds = time.perf_counter() - t0
    assert first.status_code == 200, first.text
    field = np.frombuffer(first.content, dtype="<f4")
    assert np.isfinite(field).sum() > 0

    t0 = time.perf_counter()
    second = client.get("/api/run/grid/field", params=params)
    assert time.perf_counter() - t0 < 0.1  # the memo serves the second request
    assert second.content == first.content
    print(f"first field computed in {first_seconds * 1000:.0f} ms, {np.isfinite(field).sum()} finite cells")
