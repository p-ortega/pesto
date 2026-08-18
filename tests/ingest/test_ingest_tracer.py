"""End-to-end proof of the ingest architecture: one iteration's parameter
ensemble read out of a synthetic run directory, written into the cache as
a two-block float32 file with a sidecar, recorded in the manifest against
the source file's fingerprint, and reported as one progress row with real
bytes and real seconds. Also proves the two-block split, the empty-map
case, that the run directory is left untouched, and that an ensemble whose
names cannot be matched to the control file refuses rather than falling
back to row position.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import WrittenArtifact
from pesto.ingest.control import ControlTables
from pesto.ingest.ensembles import write_par_ensemble
from pesto.ingest.ensfile import EnsembleData
from pesto.ingest.failures import ReadFailure
from pesto.ingest.runner import Progress, ingest_run

from .fixtures import make_run


def _control_tables(control_names: list[str], groups: list[str]) -> ControlTables:
    return ControlTables(
        par=pd.DataFrame({"parnme": control_names, "pargp": groups}),
        obs=pd.DataFrame({"obsnme": [], "obgnme": [], "weight": []}),
        par_groups=tuple(dict.fromkeys(groups)),
        obs_groups=(),
        source_path=Path("case.pst"),
        notes=(),
        ambiguities=(),
    )


def _ensemble_data(
    values,
    real_names,
    entity_names,
    permutation,
    source_path=Path("case.0.par.jcb"),
    notes=(),
) -> EnsembleData:
    return EnsembleData(
        values=np.asarray(values, dtype=np.float32),
        real_names=tuple(real_names),
        entity_names=tuple(entity_names),
        source_path=source_path,
        on_disk_format="dense",
        orientation="realization_major",
        orientation_decided_by="dimensions",
        contiguous=True,
        permutation=permutation,
        hash_ordered=False,
        notes=tuple(notes),
    )


# ---------------------------------------------------------------------------
# The end-to-end test
# ---------------------------------------------------------------------------


def test_a_synthetic_run_ingests_end_to_end(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    run = make_run(run_dir, iterations=(0, 1))

    progress_rows: list[Progress] = []
    manifest = ingest_run(run_dir, cache_root=cache_root, on_progress=progress_rows.append)

    layout = CacheLayout(root=cache_root)
    assert layout.par_ens(0).exists()

    sidecar = json.loads((layout.ens / "par_0.json").read_text())
    assert sidecar["kind"] == "par"
    assert len(sidecar["blocks"]) == 2
    total_len = 0
    for block in sidecar["blocks"]:
        n_real, n_par = block["shape"]
        total_len += n_real * n_par * 4
    assert total_len == layout.par_ens(0).stat().st_size
    assert sidecar["real_names"] == run.real_names

    parnames = (layout.ens / "par_0.parnames.txt").read_text().splitlines()
    assert parnames == run.par_names

    artifact = manifest.artifacts["par_ens/0"]
    assert artifact.state == "ok"
    ensemble_fp = next(s for s in artifact.sources if Path(s.path).name == run.par_ens[0].name)
    assert ensemble_fp.checksum
    assert ensemble_fp.size == run.par_ens[0].stat().st_size
    assert ensemble_fp.mtime_ns == run.par_ens[0].stat().st_mtime_ns

    ok_rows = [r for r in progress_rows if r.artifact == "par_ens/0" and r.state == "ok"]
    assert len(ok_rows) == 1
    written_bytes = sum(f.bytes for f in artifact.files)
    assert ok_rows[0].written_bytes == written_bytes
    assert ok_rows[0].seconds > 0


# ---------------------------------------------------------------------------
# The two-block split test
# ---------------------------------------------------------------------------


def test_write_par_ensemble_splits_by_group(tmp_path):
    # File order: parB0, parA1, parA0. Control order: parA0, parA1, parB0.
    control_names = ["parA0", "parA1", "parB0"]
    entity_names = ("parB0", "parA1", "parA0")
    permutation = (2, 1, 0)  # control position -> file column index
    values = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float32)
    real_names = ("real0", "real1")

    data = _ensemble_data(values, real_names, entity_names, permutation)
    tables = _control_tables(control_names, ["A", "A", "B"])

    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(
        data, tables, mappable=frozenset({"A"}), iteration=0, layout=layout
    )

    assert isinstance(result, WrittenArtifact)
    sidecar = json.loads((layout.ens / "par_0.json").read_text())
    map_block, nomap_block = sidecar["blocks"]
    assert map_block["name"] == "map"
    assert map_block["n_par"] == 2
    assert map_block["shape"] == [2, 2]
    assert nomap_block["name"] == "nomap"
    assert nomap_block["n_par"] == 1
    assert nomap_block["shape"] == [1, 2]

    raw = layout.par_ens(0).read_bytes()
    map_arr = np.frombuffer(raw, dtype="<f4", count=4, offset=map_block["offset_bytes"]).reshape(2, 2)
    nomap_arr = np.frombuffer(
        raw, dtype="<f4", count=2, offset=nomap_block["offset_bytes"]
    ).reshape(1, 2)

    # map block columns are parA0, parA1 (control order); parA0 for real1 is 6.0
    assert map_arr[1, 0] == 6.0
    # nomap block row is parB0; parB0 for real1 is 4.0
    assert nomap_arr[0, 1] == 4.0


def test_write_par_ensemble_with_empty_map_block(tmp_path):
    control_names = ["parA0", "parA1", "parB0"]
    entity_names = ("parB0", "parA1", "parA0")
    permutation = (2, 1, 0)
    values = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float32)
    real_names = ("real0", "real1")

    data = _ensemble_data(values, real_names, entity_names, permutation)
    tables = _control_tables(control_names, ["A", "A", "B"])

    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(
        data, tables, mappable=frozenset(), iteration=0, layout=layout
    )

    assert isinstance(result, WrittenArtifact)
    sidecar = json.loads((layout.ens / "par_0.json").read_text())
    map_block, _ = sidecar["blocks"]
    assert map_block["n_par"] == 0
    assert any("no parameter group was mappable" in n for n in sidecar["notes"])


# ---------------------------------------------------------------------------
# The run-directory-is-untouched test
# ---------------------------------------------------------------------------


def test_ingest_run_leaves_the_run_directory_untouched(tmp_path):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    cache_root = tmp_path / "cache"
    make_run(run_dir, iterations=(0,))

    before = {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in run_dir.iterdir()
    }

    ingest_run(run_dir, cache_root=cache_root)

    after = {
        entry.name: (entry.stat().st_size, entry.stat().st_mtime_ns)
        for entry in run_dir.iterdir()
    }
    assert after == before


# ---------------------------------------------------------------------------
# The undecidable-names test
# ---------------------------------------------------------------------------


def test_write_par_ensemble_refuses_when_names_cannot_be_matched(tmp_path):
    control_names = ["parA0", "parA1"]
    entity_names = ("parA0", "parA1")
    values = np.array([[1.0, 2.0]], dtype=np.float32)
    real_names = ("real0",)

    data = _ensemble_data(
        values,
        real_names,
        entity_names,
        permutation=None,
        source_path=Path("mystery.jcb"),
    )
    tables = _control_tables(control_names, ["A", "A"])

    layout = CacheLayout(root=tmp_path / ".pesto")
    layout.ensure()

    result = write_par_ensemble(data, tables, mappable=frozenset(), iteration=0, layout=layout)

    assert isinstance(result, ReadFailure)
    assert "mystery.jcb" in result.reason
    assert "could not be matched" in result.reason
