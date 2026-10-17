"""Route tests for GET /api/run/grid/parmap: bytes, order, the cache tag it
shares with GET /cells/{which}, the session-token gate, and the refusal by
name when an iteration recorded no permutation.

The two mappable parameters (G1's par1 and par3) sit neither first nor
contiguous in control-file order, so a route reading the wrong permutation,
or re-deriving one from row position, produces a visibly wrong answer
rather than an accidentally correct one.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.api.app import create_app
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest, SourceFingerprint, WrittenArtifact
from pesto.ingest.control import ControlTables
from pesto.ingest.ensembles import StoredEnsemble, load_stored, write_par_ensemble
from pesto.ingest.parcell import write_par_cell
from pesto.ingest.ensfile import EnsembleData
from pesto.model import GroupResolution, ParCells

BASE_URL = "http://127.0.0.1"

CONTROL_NAMES = ["par0", "par1", "par2", "par3", "par4"]
GROUPS = ["G2", "G1", "G2", "G1", "G3"]
MAPPABLE = frozenset({"G1"})
REAL_NAMES = ("zeta", "34", "alpha", "7")
N_PAR = len(CONTROL_NAMES)
N_MAP = 2


def _client(app):
    from fastapi.testclient import TestClient

    return TestClient(app, base_url=BASE_URL)


def _opened_client(layout: CacheLayout):
    app, token = create_app()
    app.state.cache_root = str(layout.root)
    client = _client(app)
    client.headers["x-pesto-token"] = token
    return client


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


def _ensemble_data() -> EnsembleData:
    values = np.array(
        [[1000.0 * r + p for p in range(N_PAR)] for r in range(len(REAL_NAMES))],
        dtype=np.float32,
    )
    return EnsembleData(
        values=values,
        real_names=tuple(REAL_NAMES),
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


def _write_case(tmp_path, *, iteration: int = 0):
    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()
    tables = _control_tables()
    data = _ensemble_data()

    ens_result = write_par_ensemble(
        data, tables, mappable=MAPPABLE, iteration=iteration, layout=layout, cells=_cells()
    )
    assert isinstance(ens_result, WrittenArtifact), ens_result
    cell_result = write_par_cell(_cells(), tables.par, layout)
    assert isinstance(cell_result, WrittenArtifact), cell_result
    return layout, ens_result, cell_result


def _write_manifest(
    layout: CacheLayout, run_dir: Path, iteration: int, ens_result, cell_result
) -> Manifest:
    manifest = Manifest.empty(str(run_dir))
    source = run_dir / "case.0.par.jcb"
    source.write_text("original ensemble source bytes")
    fingerprint = SourceFingerprint.of(source)
    manifest.mark_ok(f"par_ens/{iteration}", sources=[fingerprint], files=ens_result.files)
    manifest.mark_ok("par_cell", sources=[fingerprint], files=cell_result.files)
    manifest.save(layout)
    return manifest


def _setup(tmp_path, iteration: int = 0) -> CacheLayout:
    layout, ens_result, cell_result = _write_case(tmp_path, iteration=iteration)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_manifest(layout, run_dir, iteration, ens_result, cell_result)
    return layout


# ---------------------------------------------------------------------------
# Bytes, shape, order
# ---------------------------------------------------------------------------


def test_parmap_returns_n_map_times_4_bytes_with_block_order_meta(tmp_path):
    layout = _setup(tmp_path)
    client = _opened_client(layout)

    response = client.get("/api/run/grid/parmap", params={"iteration": 0})

    assert response.status_code == 200
    assert len(response.content) == N_MAP * 4
    meta = json.loads(response.headers["x-pesto-meta"])
    assert meta["order"] == "block"


def test_parmap_values_equal_the_recorded_block_to_control_permutation(tmp_path):
    layout = _setup(tmp_path)
    client = _opened_client(layout)

    response = client.get("/api/run/grid/parmap", params={"iteration": 0})
    decoded = np.frombuffer(response.content, dtype="<i4")

    stored = load_stored(0, layout)
    expected = stored.block_to_control[:N_MAP]
    np.testing.assert_array_equal(decoded, expected)
    # par1 and par3 (G1) are neither first nor contiguous in control order.
    assert list(expected) == [1, 3]


# ---------------------------------------------------------------------------
# Cache tag: parmap and /cells/{which} both honour a tag sent back
# ---------------------------------------------------------------------------


def test_parmap_and_the_cells_route_both_honour_the_tag_they_sent(tmp_path):
    layout = _setup(tmp_path)
    client = _opened_client(layout)

    for path in ("/api/run/grid/parmap", "/api/run/grid/cells/cell"):
        first = client.get(path, params={"iteration": 0})
        assert first.headers["cache-control"] == "no-store"
        tag = first.headers["etag"].strip('"')
        again = client.get(path, params={"iteration": 0, "v": tag})
        assert "immutable" in again.headers["cache-control"]


# ---------------------------------------------------------------------------
# Refusal by name, never a guessed row order
# ---------------------------------------------------------------------------


def test_an_iteration_with_no_recorded_permutation_returns_404_naming_the_artifact(
    tmp_path, monkeypatch
):
    layout = _setup(tmp_path)
    client = _opened_client(layout)

    # The shape write_par_ensemble builds before load_stored fills in
    # block_to_control -- a reader must refuse by name, not guess a row order.
    bare = StoredEnsemble(
        blocks=(),
        map_values=np.zeros((0, 0), dtype=np.float32),
        nomap_values=np.zeros((0, 0), dtype=np.float32),
        real_names=(),
        par_names=(),
        source_path=Path("unused"),
        on_disk_format="dense",
        orientation="realization_major",
        notes=(),
    )
    monkeypatch.setattr("pesto.api.values.get_stored", lambda *a, **k: bare)

    response = client.get("/api/run/grid/parmap", params={"iteration": 0})

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["artifact"] == "par_ens/0"


# ---------------------------------------------------------------------------
# No run open, no token
# ---------------------------------------------------------------------------


def test_no_run_open_returns_409(tmp_path):
    app, token = create_app()
    client = _client(app)
    client.headers["x-pesto-token"] = token

    response = client.get("/api/run/grid/parmap", params={"iteration": 0})

    assert response.status_code == 409


def test_no_token_returns_401(tmp_path):
    layout = _setup(tmp_path)
    app, _token = create_app()
    app.state.cache_root = str(layout.root)
    client = _client(app)

    response = client.get("/api/run/grid/parmap", params={"iteration": 0})

    assert response.status_code == 401
