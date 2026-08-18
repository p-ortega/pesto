"""Control file tables as a cache artifact.

The parameter and observation tables are written into the cache so a later
phase can name what it is drawing without re-parsing the control file. The
notes ``read_control`` left about repaired headers and dropped columns
travel with them into ``control/notes.json``, because a table separated
from its provenance cannot be told apart from a table that needed no
repair.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import BinaryIO

import pandas as pd

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.choices import Ambiguity
from pesto.ingest.control import ControlTables
from pesto.ingest.failures import ReadFailure


def _write_parquet_atomic(df: pd.DataFrame, target: Path) -> int:
    """Write ``df`` to ``target`` as parquet through the atomic byte
    writer, handing the temp file object to ``DataFrame.to_parquet`` rather
    than calling it on the final path -- a crash mid-write must not leave a
    half-written table under a name a later size check would call fresh."""

    def _write(fileobj: BinaryIO) -> int:
        df.to_parquet(fileobj, index=False)
        return fileobj.tell()

    return write_atomic_bytes(target, _write)


def write_control(tables: ControlTables, layout: CacheLayout) -> WrittenArtifact | ReadFailure:
    """Write ``tables`` into ``layout.control`` as two parquet files and a
    notes sidecar, and return the artifact describing what was written.

    Row order and the dtypes ``_tighten_dtypes`` already chose are
    preserved; each file is written with ``index=False`` so no row numbers
    survive that a later reader could mistake for identity. Any exception
    resolves to a ``ReadFailure`` naming what was being written -- the
    first raise aborts everything after it, so no file is ever left half
    written under its final name.
    """
    try:
        layout.ensure()
        par_path = layout.control / "par.parquet"
        obs_path = layout.control / "obs.parquet"

        par_bytes = _write_parquet_atomic(tables.par, par_path)
        obs_bytes = _write_parquet_atomic(tables.obs, obs_path)

        notes = list(tables.notes)
        if len(tables.par) == 0:
            notes.append("parameter table has zero rows")
        if len(tables.obs) == 0:
            notes.append("observation table has zero rows")

        notes_path = layout.control / "notes.json"
        payload = {
            "cache_version": CACHE_VERSION,
            "source_path": str(tables.source_path),
            "par_groups": list(tables.par_groups),
            "obs_groups": list(tables.obs_groups),
            "notes": notes,
            "ambiguities": [
                {
                    "slot": a.slot,
                    "chosen": a.chosen,
                    "rejected": list(a.rejected),
                    "policy": a.policy,
                }
                for a in tables.ambiguities
            ],
        }
        notes_bytes = write_atomic_text(notes_path, json.dumps(payload, indent=2))

        root = layout.root
        files = (
            CacheFile(path=str(par_path.relative_to(root)), bytes=par_bytes),
            CacheFile(path=str(obs_path.relative_to(root)), bytes=obs_bytes),
            CacheFile(path=str(notes_path.relative_to(root)), bytes=notes_bytes),
        )
        return WrittenArtifact(name="control", files=files, notes=tuple(notes))
    except Exception as exc:
        return ReadFailure(
            name="control",
            path=str(layout.control),
            reason=f"failed to write control tables to {layout.control}: {exc}",
        )


def load_control_tables(layout: CacheLayout) -> ControlTables | ReadFailure:
    """Read the control tables back from ``layout.control``.

    An absent file, an unreadable one, a parquet file pyarrow refuses, and
    a ``notes.json`` of the wrong shape each resolve to a ``ReadFailure``
    naming the file -- never an exception.
    """
    par_path = layout.control / "par.parquet"
    obs_path = layout.control / "obs.parquet"
    notes_path = layout.control / "notes.json"

    try:
        par = pd.read_parquet(par_path)
    except Exception as exc:
        return ReadFailure(
            name="control", path=str(par_path), reason=f"failed to read {par_path.name}: {exc}"
        )

    try:
        obs = pd.read_parquet(obs_path)
    except Exception as exc:
        return ReadFailure(
            name="control", path=str(obs_path), reason=f"failed to read {obs_path.name}: {exc}"
        )

    try:
        raw = json.loads(notes_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return ReadFailure(
            name="control",
            path=str(notes_path),
            reason=f"failed to read {notes_path.name}: {exc}",
        )

    if not isinstance(raw, dict):
        return ReadFailure(
            name="control",
            path=str(notes_path),
            reason=f"{notes_path.name} is not a JSON object",
        )

    try:
        par_groups = tuple(raw.get("par_groups", ()))
        obs_groups = tuple(raw.get("obs_groups", ()))
        notes = tuple(raw.get("notes", ()))
        ambiguities = tuple(
            Ambiguity(
                slot=a["slot"],
                chosen=a["chosen"],
                rejected=tuple(a["rejected"]),
                policy=a["policy"],
            )
            for a in raw.get("ambiguities", ())
        )
        source_path = Path(raw.get("source_path", ""))
    except (KeyError, TypeError) as exc:
        return ReadFailure(
            name="control",
            path=str(notes_path),
            reason=f"{notes_path.name} has an unexpected shape: {exc}",
        )

    return ControlTables(
        par=par,
        obs=obs,
        par_groups=par_groups,
        obs_groups=obs_groups,
        source_path=source_path,
        notes=notes,
        ambiguities=ambiguities,
    )
