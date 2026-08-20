"""Route tests for the field and the statistic: shape, order, byte
compatibility, unknown-stat, unknown-realization and memo invalidation.

Every fast test builds its own small two-block ensemble and a matching
aggregate by hand, through the same writers Phase 4 uses
(``write_par_ensemble``, ``write_par_agg``), with the mappable parameters
placed *not* first in control-file order -- so the block-to-control
permutation is neither the identity nor a contiguous slice, and a route
that used the wrong one would be caught rather than accidentally correct.
One ``@pytest.mark.slow`` test additionally proves the same contract
against a real ingested run.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

import pesto.api.enscache as enscache
import pesto.ingest.ensembles as ensembles_module
from pesto.api.app import create_app
from pesto.api.blob import cache_tag
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest, SourceFingerprint, WrittenArtifact
from pesto.ingest.aggregate import write_par_agg
from pesto.ingest.control import ControlTables
from pesto.ingest.ensembles import load_stored, read_map_row, write_par_ensemble
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.failures import ReadFailure
from pesto.model import GroupResolution, ParCells

BASE_URL = "http://127.0.0.1"

# par1 and par3 are the mappable (G1) parameters -- neither first nor
# contiguous in control-file order, so block_to_control[:n_map] == [1, 3]
# rather than an identity or a contiguous slice.
CONTROL_NAMES = ["par0", "par1", "par2", "par3", "par4"]
GROUPS = ["G2", "G1", "G2", "G1", "G3"]
MAPPABLE = frozenset({"G1"})
# Deliberately unsorted, and "34" is a decimal-integer-looking name -- if
# the route ever coerced it to a row index it would land on the wrong row
# (there is no row 34 among four realizations).
REAL_NAMES = ("zeta", "34", "alpha", "7")
N_REAL = len(REAL_NAMES)
N_PAR = len(CONTROL_NAMES)
N_MAP = 2


def _client(app) -> TestClient:
    return TestClient(app, base_url=BASE_URL)


def _opened_client(layout: CacheLayout) -> TestClient:
    app, token = create_app()
    app.state.cache_root = str(layout.root)
    client = _client(app)
    client.headers["x-pesto-token"] = token
    return client


def _meta(response) -> dict:
    return json.loads(response.headers["x-pesto-meta"])


def _control_tables() -> ControlTables:
    n = len(CONTROL_NAMES)
    return ControlTables(
        par=pd.DataFrame(
            {
                "parnme": CONTROL_NAMES,
                "pargp": GROUPS,
                "parlbnd": [0.0] * n,
                "parubnd": [100.0] * n,
                "partrans": ["none"] * n,
            }
        ),
        obs=pd.DataFrame({"obsnme": [], "obgnme": [], "weight": []}),
        par_groups=tuple(dict.fromkeys(GROUPS)),
        obs_groups=(),
        source_path=Path("case.pst"),
        notes=(),
        ambiguities=(),
    )


def _values_array(n_real: int = N_REAL) -> np.ndarray:
    # values[r, p] = 1000*r + p -- unique per (realization, parameter), so a
    # wrong permutation or a wrong row selects a visibly different number.
    return np.array(
        [[1000.0 * r + p for p in range(N_PAR)] for r in range(n_real)], dtype=np.float32
    )


def _ensemble_data(real_names=REAL_NAMES, values=None) -> EnsembleData:
    if values is None:
        values = _values_array(len(real_names))
    return EnsembleData(
        values=np.asarray(values, dtype=np.float32),
        real_names=tuple(real_names),
        entity_names=tuple(CONTROL_NAMES),
        source_path=Path("case.0.par.jcb"),
        on_disk_format="dense",
        orientation="realization_major",
        orientation_decided_by="dimensions",
        contiguous=True,
        permutation=tuple(range(len(CONTROL_NAMES))),
        hash_ordered=False,
        notes=(),
    )


def _cells() -> ParCells:
    return ParCells(
        cell=np.array([10, 20, 30, 40, 50], dtype=np.int32),
        layer=np.array([0, 1, 0, 1, 2], dtype=np.int32),
        parnme=tuple(CONTROL_NAMES),
        groups=(
            GroupResolution(group="G1", rule="test", mapped=2, total=2),
            GroupResolution(group="G2", rule="test", mapped=2, total=2),
            GroupResolution(group="G3", rule="test", mapped=1, total=1),
        ),
        summary="test adapter placed every group",
        notes=(),
    )


def _write_case(
    tmp_path,
    *,
    iteration: int = 0,
    mappable: frozenset = MAPPABLE,
    cells: bool = True,
    write_agg: bool = True,
    real_names=REAL_NAMES,
):
    """Write one iteration's ensemble (and, by default, its matching
    aggregate) through the real Phase 4 writers, into a shared cache root
    keyed on ``tmp_path`` -- so several iterations can coexist for the
    memo tests."""
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    tables = _control_tables()
    data = _ensemble_data(real_names=real_names)

    ens_result = write_par_ensemble(
        data,
        tables,
        mappable=mappable,
        iteration=iteration,
        layout=layout,
        cells=_cells() if cells else None,
    )
    assert isinstance(ens_result, WrittenArtifact), ens_result

    agg_result = None
    if write_agg:
        agg_result = write_par_agg(data, tables, iteration=iteration, layout=layout)
        assert isinstance(agg_result, WrittenArtifact), agg_result

    return layout, ens_result, agg_result, data, tables


def _write_manifest(layout: CacheLayout, run_dir: Path, entries) -> Manifest:
    """Record every ``(iteration, ens_result, agg_result | None)`` as an
    ``ok`` artifact against one real source file under ``run_dir``, so
    ``is_stale`` has something genuine to check rather than an empty
    manifest that reports everything fresh by omission."""
    manifest = Manifest.empty(str(run_dir))
    source = run_dir / "case.0.par.jcb"
    source.write_text("original ensemble source bytes")
    fingerprint = SourceFingerprint.of(source)
    for iteration, ens_result, agg_result in entries:
        manifest.mark_ok(f"par_ens/{iteration}", sources=[fingerprint], files=ens_result.files)
        if agg_result is not None:
            manifest.mark_ok(
                f"par_agg/{iteration}", sources=[fingerprint], files=agg_result.files
            )
    manifest.save(layout)
    return manifest


# ---------------------------------------------------------------------------
# The realization payload: shape, dtype, and the independently-read value
# ---------------------------------------------------------------------------


def test_a_realization_payload_has_shape_n_map_and_little_endian_float32(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    response = client.get(
        "/api/run/grid/values", params={"iteration": 0, "realization": REAL_NAMES[0]}
    )

    assert response.status_code == 200
    assert len(response.content) == N_MAP * 4
    meta = _meta(response)
    assert meta["shape"] == [N_MAP]
    assert meta["dtype"] == "<f4"


def test_the_decoded_realization_payload_equals_read_map_row_independently(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    response = client.get(
        "/api/run/grid/values", params={"iteration": 0, "realization": REAL_NAMES[0]}
    )
    decoded = np.frombuffer(response.content, dtype="<f4")

    stored = load_stored(0, layout)
    expected = read_map_row(stored, REAL_NAMES[0])
    np.testing.assert_array_equal(decoded, expected)


# ---------------------------------------------------------------------------
# The statistic payload: byte-compatible with the realization payload, and
# permuted with the sidecar's own permutation -- never the identity one
# ---------------------------------------------------------------------------


def test_a_stat_mean_payload_matches_the_realization_payloads_length_and_dtype(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    value_resp = client.get(
        "/api/run/grid/values", params={"iteration": 0, "realization": REAL_NAMES[0]}
    )
    mean_resp = client.get("/api/run/grid/values", params={"iteration": 0, "stat": "mean"})

    assert len(value_resp.content) == len(mean_resp.content)
    assert _meta(value_resp)["dtype"] == _meta(mean_resp)["dtype"]
    assert _meta(value_resp)["shape"] == _meta(mean_resp)["shape"]


def test_the_decoded_stat_payload_equals_the_permuted_column_not_the_unpermuted_one(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    response = client.get("/api/run/grid/values", params={"iteration": 0, "stat": "mean"})
    decoded = np.frombuffer(response.content, dtype="<f4")

    stored = load_stored(0, layout)
    permutation = stored.block_to_control[:N_MAP]
    control_order = pd.read_parquet(layout.par_agg(0), columns=["mean"])["mean"].to_numpy(
        dtype=np.float32
    )
    expected = control_order[permutation]
    identity = control_order[np.arange(N_MAP)]

    np.testing.assert_array_equal(decoded, expected)
    assert not np.array_equal(decoded, identity)


@pytest.mark.parametrize("stat", [s for s in enscache.STATS if s != "value"])
def test_every_non_value_statistic_returns_a_payload_of_the_right_length(tmp_path, stat):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    response = client.get("/api/run/grid/values", params={"iteration": 0, "stat": stat})

    assert response.status_code == 200
    assert len(response.content) == N_MAP * 4


# ---------------------------------------------------------------------------
# The cells route: companion arrays at exactly a values payload's length
# ---------------------------------------------------------------------------


def test_the_cell_and_layer_arrays_match_a_values_payload_length(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    values_resp = client.get(
        "/api/run/grid/values", params={"iteration": 0, "realization": REAL_NAMES[0]}
    )
    cell_resp = client.get("/api/run/grid/cells/cell", params={"iteration": 0})
    layer_resp = client.get("/api/run/grid/cells/layer", params={"iteration": 0})

    assert len(cell_resp.content) == len(values_resp.content) == N_MAP * 4
    assert len(layer_resp.content) == N_MAP * 4
    np.testing.assert_array_equal(np.frombuffer(cell_resp.content, dtype="<i4"), [20, 40])
    np.testing.assert_array_equal(np.frombuffer(layer_resp.content, dtype="<i4"), [1, 1])


def test_an_ensemble_with_no_recorded_cell_mapping_returns_404_from_the_cells_route(tmp_path):
    layout, ens2, agg2, _data, _tables = _write_case(tmp_path, iteration=2, cells=False)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(2, ens2, agg2)])
    client = _opened_client(layout)

    response = client.get("/api/run/grid/cells/cell", params={"iteration": 2})

    assert response.status_code == 404
    assert response.json()["artifact"] == "par_ens/2"


# ---------------------------------------------------------------------------
# Refusals: deferred statistics, layer/group, stat+realization combinations
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_stat", ["sigma_ratio", "rmse", "pdc"])
def test_a_deferred_statistic_name_returns_422(tmp_path, bad_stat):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    response = client.get("/api/run/grid/values", params={"iteration": 0, "stat": bad_stat})

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"


@pytest.mark.parametrize("extra_param", ["layer", "group"])
def test_an_unexpected_query_parameter_returns_422(tmp_path, extra_param):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    response = client.get(
        "/api/run/grid/values",
        params={"iteration": 0, "realization": REAL_NAMES[0], extra_param: "3"},
    )

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"


def test_stat_and_realization_together_returns_422(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    response = client.get(
        "/api/run/grid/values",
        params={"iteration": 0, "stat": "mean", "realization": REAL_NAMES[0]},
    )

    assert response.status_code == 422


def test_neither_stat_nor_realization_returns_422(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    response = client.get("/api/run/grid/values", params={"iteration": 0})

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Realization identity: never resolved to the nearest row, never confused
# with a row index
# ---------------------------------------------------------------------------


def test_an_unknown_realization_name_returns_404_naming_the_ensemble(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    response = client.get(
        "/api/run/grid/values", params={"iteration": 0, "realization": "not-a-real-name"}
    )

    assert response.status_code == 404
    body = response.json()
    assert body["artifact"] == "par_ens/0"
    assert "not-a-real-name" in body["detail"]


def test_a_numeric_realization_name_resolves_to_the_named_realization_not_the_row_index(
    tmp_path,
):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    # There is no row 34 among four realizations -- a route that coerced
    # this to an int and treated it as a row index would 404 here instead
    # of finding the realization actually named "34".
    assert REAL_NAMES.index("34") != 34

    response = client.get("/api/run/grid/values", params={"iteration": 0, "realization": "34"})

    assert response.status_code == 200
    decoded = np.frombuffer(response.content, dtype="<f4")
    stored = load_stored(0, layout)
    expected = read_map_row(stored, "34")
    np.testing.assert_array_equal(decoded, expected)


# ---------------------------------------------------------------------------
# Edge shapes: an empty map block, a missing aggregate
# ---------------------------------------------------------------------------


def test_an_empty_map_block_returns_a_zero_length_body_with_a_note(tmp_path):
    layout, ens_empty, _agg_empty, _data, _tables = _write_case(
        tmp_path, iteration=5, mappable=frozenset(), cells=False, write_agg=False
    )
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(5, ens_empty, None)])
    client = _opened_client(layout)

    response = client.get(
        "/api/run/grid/values", params={"iteration": 5, "realization": REAL_NAMES[0]}
    )

    assert response.status_code == 200
    assert response.content == b""
    assert _meta(response)["shape"] == [0]
    notes = json.loads(response.headers["x-pesto-notes"])
    assert any("map block is empty" in note for note in notes)


def test_an_iteration_with_no_aggregate_file_returns_404_naming_par_agg(tmp_path):
    layout, ens1, _agg_none, _data, _tables = _write_case(tmp_path, iteration=1, write_agg=False)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(1, ens1, None)])
    client = _opened_client(layout)

    response = client.get("/api/run/grid/values", params={"iteration": 1, "stat": "mean"})

    assert response.status_code == 404
    assert response.json()["artifact"] == "par_agg/1"


# ---------------------------------------------------------------------------
# The memo: parsed at most once per (cache root, iteration)
# ---------------------------------------------------------------------------


def test_memo_caches_get_stored_across_two_calls(tmp_path, monkeypatch):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])

    calls: list[int] = []
    real_load_stored = ensembles_module.load_stored

    def _counting(iteration, layout_arg):
        calls.append(iteration)
        return real_load_stored(iteration, layout_arg)

    monkeypatch.setattr(ensembles_module, "load_stored", _counting)

    state = SimpleNamespace()
    first = enscache.get_stored(state, layout.root, 0)
    second = enscache.get_stored(state, layout.root, 0)

    assert not isinstance(first, ReadFailure)
    assert first is second
    assert calls == [0]


def test_memo_reloads_after_manifest_reports_stale(tmp_path, monkeypatch):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    source = run_dir / "case.0.par.jcb"

    calls: list[int] = []
    real_load_stored = ensembles_module.load_stored

    def _counting(iteration, layout_arg):
        calls.append(iteration)
        return real_load_stored(iteration, layout_arg)

    monkeypatch.setattr(ensembles_module, "load_stored", _counting)

    state = SimpleNamespace()
    first = enscache.get_stored(state, layout.root, 0)
    source.write_text(source.read_text() + " -- changed after the first read")
    second = enscache.get_stored(state, layout.root, 0)

    assert calls == [0, 0]
    assert second is not first


def test_memo_does_not_evict_a_different_iterations_entry(tmp_path, monkeypatch):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path, iteration=0)
    _layout2, ens3, agg3, _data2, _tables2 = _write_case(tmp_path, iteration=3)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0), (3, ens3, agg3)])

    calls: list[int] = []
    real_load_stored = ensembles_module.load_stored

    def _counting(iteration, layout_arg):
        calls.append(iteration)
        return real_load_stored(iteration, layout_arg)

    monkeypatch.setattr(ensembles_module, "load_stored", _counting)

    state = SimpleNamespace()
    enscache.get_stored(state, layout.root, 0)
    enscache.get_stored(state, layout.root, 3)
    enscache.get_stored(state, layout.root, 0)

    assert calls == [0, 3]


def test_memo_does_not_cache_a_read_failure(tmp_path, monkeypatch):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])

    calls: list[int] = []
    real_load_stored = ensembles_module.load_stored
    outcomes = [ReadFailure(name="par_ens/0", path=str(layout.par_ens(0)), reason="synthetic")]

    def _flaky(iteration, layout_arg):
        calls.append(iteration)
        if outcomes:
            return outcomes.pop(0)
        return real_load_stored(iteration, layout_arg)

    monkeypatch.setattr(ensembles_module, "load_stored", _flaky)

    state = SimpleNamespace()
    first = enscache.get_stored(state, layout.root, 0)
    second = enscache.get_stored(state, layout.root, 0)

    assert isinstance(first, ReadFailure)
    assert not isinstance(second, ReadFailure)
    assert calls == [0, 0]


# ---------------------------------------------------------------------------
# Cache tags: par_ens and par_agg behave independently
# ---------------------------------------------------------------------------


def test_the_realization_cache_tag_behaves_for_par_ens(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    tag = cache_tag(Manifest.load(layout), "par_ens/0")
    assert tag is not None

    matching = client.get(
        "/api/run/grid/values",
        params={"iteration": 0, "realization": REAL_NAMES[0], "v": tag},
    )
    assert "immutable" in matching.headers["cache-control"]

    stale = client.get(
        "/api/run/grid/values",
        params={"iteration": 0, "realization": REAL_NAMES[0], "v": "not-the-tag"},
    )
    assert stale.headers["cache-control"] == "no-store"

    no_tag_requested = client.get(
        "/api/run/grid/values", params={"iteration": 0, "realization": REAL_NAMES[0]}
    )
    assert no_tag_requested.headers["cache-control"] == "no-store"


def test_the_stat_cache_tag_behaves_for_par_agg(tmp_path):
    layout, ens0, agg0, _data, _tables = _write_case(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, [(0, ens0, agg0)])
    client = _opened_client(layout)

    tag = cache_tag(Manifest.load(layout), "par_agg/0")
    assert tag is not None

    matching = client.get(
        "/api/run/grid/values", params={"iteration": 0, "stat": "mean", "v": tag}
    )
    assert "immutable" in matching.headers["cache-control"]

    stale = client.get(
        "/api/run/grid/values", params={"iteration": 0, "stat": "mean", "v": "not-the-tag"}
    )
    assert stale.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# One real, ingested run -- a behaviour assertion, not a fact about this
# particular benchmark folder
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_real_ingested_run_serves_a_realization_and_a_stat_payload_of_equal_length(
    forecast_run, tmp_path
):
    from pesto.ingest.runner import ingest_run

    cache_root = tmp_path / "cache"
    manifest = ingest_run(forecast_run, cache_root=cache_root)
    layout = CacheLayout(root=cache_root)

    ens_names = [
        name
        for name, artifact in manifest.artifacts.items()
        if name.startswith("par_ens/") and artifact.state == "ok"
    ]
    assert ens_names, "ingest produced no ok par_ens artifact"
    iteration = int(ens_names[0].split("/")[1])

    reals_raw = json.loads(layout.par_reals(iteration).read_text())
    realization = reals_raw["names"][0]

    client = _opened_client(layout)

    value_resp = client.get(
        "/api/run/grid/values", params={"iteration": iteration, "realization": realization}
    )
    mean_resp = client.get("/api/run/grid/values", params={"iteration": iteration, "stat": "mean"})

    assert value_resp.status_code == 200
    assert mean_resp.status_code == 200
    assert len(value_resp.content) == len(mean_resp.content)
