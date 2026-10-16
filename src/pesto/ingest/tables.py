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
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO

import pandas as pd

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.choices import Ambiguity
from pesto.ingest.control import ControlTables
from pesto.ingest.failures import ReadFailure

if TYPE_CHECKING:
    import pyarrow as pa


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


@dataclass(frozen=True)
class UnknownColumn(ReadFailure):
    """A column was asked for that the table file does not have. A caller
    can tell this apart from an unreadable file: the request was wrong."""


def _read_notes_json(notes_path: Path) -> dict | ReadFailure:
    """Read ``notes.json`` and check its shape and ``cache_version``, the one
    place both table readers do it."""
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

    if raw.get("cache_version") != CACHE_VERSION:
        return ReadFailure(
            name="control",
            path=str(notes_path),
            reason=(
                f"{notes_path.name} was written at cache_version "
                f"{raw.get('cache_version')!r}, this reader expects {CACHE_VERSION}"
            ),
        )
    return raw


def load_control_tables(layout: CacheLayout) -> ControlTables | ReadFailure:
    """Read the control tables back from ``layout.control``.

    An absent file, an unreadable one, a parquet file pyarrow refuses, a
    ``notes.json`` of the wrong shape, and a ``notes.json`` written at a
    different ``cache_version`` each resolve to a ``ReadFailure`` naming the
    file -- never an exception. Per D-08 a ``CACHE_VERSION`` bump is a hard
    reset like ``Manifest.load``, ``load_config`` and ``load_stored`` already
    apply: a schema change that reuses a key name with a different meaning
    would slip past the shape checks alone, so the version is checked before
    any field is believed.
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

    raw = _read_notes_json(notes_path)
    if isinstance(raw, ReadFailure):
        return raw

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


def load_control_table(
    layout: CacheLayout,
    kind: str,
    columns: Sequence[str] | None = None,
    optional_columns: Sequence[str] | None = None,
) -> "tuple[pa.Table, tuple[str, ...]] | ReadFailure":
    """Read one control table, and only the asked columns, plus the notes.

    The parameter table of a large run is read without touching the
    observation file, which can hold millions of rows. ``notes.json`` gets
    the same shape and ``cache_version`` checks ``load_control_tables``
    applies. A column in ``columns`` that the file does not have is a
    ``ReadFailure`` naming it. A column in ``optional_columns`` that the file
    does not have is left out of the table and named in a returned note, so
    the caller can tell it was asked for and not found.
    """
    import pyarrow.parquet as pq

    path = layout.control / f"{kind}.parquet"
    notes_path = layout.control / "notes.json"
    wanted = None if columns is None else list(columns)
    optional = None if optional_columns is None else list(optional_columns)
    absent: list[str] = []

    try:
        have = pq.read_schema(path).names
        missing = [name for name in wanted or () if name not in have]
        if missing:
            return UnknownColumn(
                name="control",
                path=str(path),
                reason=f"{path.name} has no column named {missing[0]!r}",
            )
        absent = [name for name in optional or () if name not in have]
        keep = set(wanted or ()) | set(optional or ())
        # The file's own column order, whatever order the caller listed them in.
        table = pq.read_table(
            path,
            columns=None if wanted is None and optional is None else [c for c in have if c in keep],
        )
    except Exception as exc:
        return ReadFailure(
            name="control", path=str(path), reason=f"failed to read {path.name}: {exc}"
        )

    raw = _read_notes_json(notes_path)
    if isinstance(raw, ReadFailure):
        return raw
    try:
        notes = tuple(raw.get("notes", ()))
    except TypeError as exc:
        return ReadFailure(
            name="control",
            path=str(notes_path),
            reason=f"{notes_path.name} has an unexpected shape: {exc}",
        )
    notes += tuple(
        f"{path.name} has no column {name!r}; it was asked for as optional and is not in the answer"
        for name in absent
    )
    return table, notes
