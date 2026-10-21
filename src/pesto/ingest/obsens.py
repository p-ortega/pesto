"""Store one iteration's observation ensemble in the cache, by observation.

Rows are observations in ``obs_index`` order and columns are realizations,
so one site is one unbroken slice of rows. Every number is placed by the
observation name the file gave it; a file that cannot be matched by name is
refused, never stored by position. The sidecar records the digest of the
``obs_index`` the rows were ordered against, and a load against a different
index is refused.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.ensembles import _remove_written, write_reals
from pesto.ingest.failures import ReadFailure
from pesto.ingest.obsindex import ObsIndex, load_obs_index

if TYPE_CHECKING:
    from pesto.ingest.ensfile import EnsembleData

LAYOUT_TEXT = "observation-major, rows in obs_index order"


@dataclass(frozen=True, eq=False)
class StoredObsEnsemble:
    """An observation ensemble read back through its sidecar. ``values`` is a
    read-only memory map of shape (n_obs, n_real), float32."""

    iteration: int
    values: np.ndarray
    real_names: tuple[str, ...]
    order_digest: str
    source: dict
    n_nan: int
    notes: tuple[str, ...]


def _fail(name: str, path: Path | str, reason: str) -> ReadFailure:
    return ReadFailure(name=name, path=str(path), reason=f"{name}: {reason}")


def write_obs_ensemble(
    data: "EnsembleData",
    index: ObsIndex,
    iteration: int,
    layout: CacheLayout,
    *,
    block_rows: int = 50_000,
) -> WrittenArtifact | ReadFailure:
    """Write ``ens/obs_K.f32``, ``reals/obs_K.reals.json`` and the sidecar
    ``ens/obs_K.json`` (last), or leave nothing behind.

    ``data.permutation`` maps a control row to the file column holding that
    observation, so each block of sorted positions is gathered by name from
    the file's own columns. Nothing here ever uses a file column's position
    as an identity.
    """
    name = f"obs_ens/{iteration}"
    source_name = Path(data.source_path).name
    written: list[CacheFile] = []
    try:
        if data.permutation is None:
            return _fail(
                name,
                data.source_path,
                f"the observation names in {source_name} could not be matched to the "
                "control file, so no control-file order exists to store against -- "
                "refusing rather than falling back to file row position",
            )
        permutation = np.asarray(data.permutation, dtype=np.int64)
        if permutation.shape[0] != index.control_rows:
            return _fail(
                name,
                data.source_path,
                f"the name match for {source_name} covers {permutation.shape[0]} control "
                f"observations but the obs_index was built from {index.control_rows} -- "
                "refusing to store against a different control table",
            )
        n_obs = index.n_obs
        if n_obs == 0:
            return _fail(name, data.source_path, "the obs_index holds no observations")
        if int(index.order.max()) >= permutation.shape[0] or int(index.order.min()) < 0:
            return _fail(
                name,
                data.source_path,
                "the obs_index order points outside the control table",
            )
        values = data.values
        n_real = int(values.shape[0])
        if n_real == 0:
            return _fail(
                name, data.source_path, f"{source_name} holds zero realizations -- nothing to write"
            )
        if len(data.real_names) != n_real:
            return _fail(
                name,
                data.source_path,
                f"{source_name} has {n_real} realizations but {len(data.real_names)} names",
            )

        # An older sidecar must not outlive a failed rewrite of its payload.
        sidecar_path = layout.obs_ens_meta(iteration)
        if sidecar_path.exists():
            _remove_written(
                [CacheFile(path=str(sidecar_path.relative_to(layout.root)), bytes=0)], layout
            )

        counted = {"nan": 0}
        step = max(int(block_rows), 1)

        def _write_payload(fileobj) -> int:
            total = 0
            for start in range(0, n_obs, step):
                control_rows = index.order[start : start + step]
                file_columns = permutation[control_rows]
                block = np.ascontiguousarray(values[:, file_columns].T, dtype="<f4")
                counted["nan"] += int(np.isnan(block).sum())
                total += fileobj.write(block.tobytes())
            return total

        payload_path = layout.obs_ens(iteration)
        payload_bytes = write_atomic_bytes(payload_path, _write_payload)
        written.append(
            CacheFile(path=str(payload_path.relative_to(layout.root)), bytes=payload_bytes)
        )

        reals_result = write_reals(data.real_names, iteration, layout, "obs")
        if isinstance(reals_result, ReadFailure):
            raise OSError(reals_result.reason)
        written.append(reals_result)

        notes = list(data.notes)
        sidecar = {
            "cache_version": CACHE_VERSION,
            "kind": "obs",
            "iteration": iteration,
            "dtype": "<f4",
            "shape": [n_obs, n_real],
            "layout": LAYOUT_TEXT,
            "order_digest": index.order_digest,
            "real_names": list(data.real_names),
            "source": {
                "name": source_name,
                "on_disk_format": data.on_disk_format,
                "orientation": data.orientation,
                "decided_by": data.orientation_decided_by,
                "hash_ordered": bool(data.hash_ordered),
            },
            "n_nan": counted["nan"],
            "notes": notes,
        }
        sidecar_bytes = write_atomic_text(sidecar_path, json.dumps(sidecar, indent=2))
        written.append(
            CacheFile(path=str(sidecar_path.relative_to(layout.root)), bytes=sidecar_bytes)
        )
        return WrittenArtifact(name=name, files=tuple(written), notes=tuple(notes))
    except Exception as exc:
        try:
            removed, cleanup_notes = _remove_written(written, layout)
        except Exception:
            removed, cleanup_notes = 0, ()
        reason = (
            f"failed to write the observation ensemble from {source_name}: {exc} -- "
            f"cleaned up {removed} file(s) already written for this artifact"
        )
        if cleanup_notes:
            reason += f"; could not remove: {'; '.join(cleanup_notes)}"
        return _fail(name, data.source_path, reason)


def load_obs_ensemble(iteration: int, layout: CacheLayout) -> StoredObsEnsemble | ReadFailure:
    """Open the stored observation ensemble through its sidecar. The payload
    is memory-mapped, never read whole. Refused when the sidecar is not the
    shape this reader wrote, the payload size disagrees with it, or the rows
    were ordered against a different ``obs_index`` than the one in the cache."""
    name = f"obs_ens/{iteration}"
    sidecar_path = layout.obs_ens_meta(iteration)
    payload_path = layout.obs_ens(iteration)
    try:
        sidecar = json.loads(sidecar_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return _fail(name, sidecar_path, f"could not read sidecar {sidecar_path.name}: {exc}")
    if not isinstance(sidecar, dict):
        return _fail(name, sidecar_path, f"sidecar {sidecar_path.name} is not a JSON object")
    if sidecar.get("cache_version") != CACHE_VERSION:
        return _fail(
            name,
            sidecar_path,
            f"sidecar {sidecar_path.name} was written at cache_version "
            f"{sidecar.get('cache_version')!r}, this reader expects {CACHE_VERSION}",
        )
    try:
        n_obs, n_real = (int(v) for v in sidecar["shape"])
        digest = str(sidecar["order_digest"])
        real_names = tuple(str(v) for v in sidecar["real_names"])
        source = dict(sidecar.get("source", {}))
        n_nan = int(sidecar.get("n_nan", 0))
        notes = tuple(str(v) for v in sidecar.get("notes", []))
        if sidecar.get("dtype") != "<f4":
            raise ValueError(f"dtype {sidecar.get('dtype')!r}")
        if len(real_names) != n_real:
            raise ValueError(f"{len(real_names)} names for {n_real} realizations")
    except (KeyError, TypeError, ValueError) as exc:
        return _fail(
            name,
            sidecar_path,
            f"sidecar {sidecar_path.name} is not shaped like an observation ensemble sidecar: {exc}",
        )

    expected = n_obs * n_real * 4
    try:
        actual = payload_path.stat().st_size
    except OSError as exc:
        return _fail(name, payload_path, f"could not stat payload {payload_path.name}: {exc}")
    if actual != expected:
        return _fail(
            name,
            payload_path,
            f"payload {payload_path.name} holds {actual} bytes but its sidecar describes "
            f"{expected}",
        )

    current = load_obs_index(layout)
    if isinstance(current, ReadFailure):
        return _fail(
            name,
            payload_path,
            f"the obs_index it was built against cannot be read: {current.reason}",
        )
    if current.order_digest != digest:
        return _fail(
            name,
            payload_path,
            "it was built against a different obs_index than the one in the cache "
            f"(recorded digest {digest[:12]}, current {current.order_digest[:12]}); "
            "ingest the run again",
        )
    if current.n_obs != n_obs:
        return _fail(
            name,
            payload_path,
            f"it holds {n_obs} observations but the obs_index holds {current.n_obs}",
        )

    values = np.memmap(payload_path, dtype="<f4", mode="r", shape=(n_obs, n_real))
    return StoredObsEnsemble(
        iteration=iteration,
        values=values,
        real_names=real_names,
        order_digest=digest,
        source=source,
        n_nan=n_nan,
        notes=notes,
    )
