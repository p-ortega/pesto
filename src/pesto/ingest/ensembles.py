"""Write one iteration's parameter ensemble into the cache as two blocks.

One iteration's parameters are stored in two blocks because the map reads
one realization across all its parameters while the group histograms read
one parameter across all realizations -- one contiguous layout cannot serve
both without a strided pass over the whole file. Which block a parameter
lands in is decided by its group (D-02), never by its own cell: cell
resolution can fail independently of grouping, and a parameter's storage
layout must not depend on whether that later step succeeded.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Sequence

import numpy as np

from pesto.cache._atomic import write_atomic_bytes, write_atomic_text
from pesto.cache.layout import CACHE_VERSION, CacheLayout
from pesto.cache.manifest import CacheFile, WrittenArtifact
from pesto.ingest.failures import ReadFailure

if TYPE_CHECKING:
    from pesto.ingest.control import ControlTables
    from pesto.ingest.ensfile import EnsembleData

    # ParCells lives in pesto.model, which nothing under pesto.ingest may
    # import (test_no_ingest_file_imports_anything_from_model) -- even for
    # typing. The "ParCells | None" annotation below stays an unresolved
    # forward reference, never evaluated at runtime.


@dataclass(frozen=True)
class Block:
    """One contiguous region of a two-block ensemble payload. ``name`` is
    ``"map"`` or ``"nomap"``; ``layout`` is ``"realization_major"`` (one
    realization's parameters contiguous) or ``"parameter_major"`` (one
    parameter's realizations contiguous)."""

    name: str
    layout: str
    offset_bytes: int
    n_par: int
    shape: tuple[int, int]


@dataclass(frozen=True, eq=False)
class StoredEnsemble:
    """One iteration's parameter ensemble as it was written: the two block
    arrays that became the payload, alongside everything the sidecar
    records. Held together so a caller does not have to re-parse the
    sidecar JSON to see what was actually written.

    Compares like :class:`pesto.ingest.ensfile.EnsembleData`: array fields
    with ``numpy.array_equal``, everything else with ``==``. Unhashable,
    for the same reason -- it holds mutable arrays.
    """

    blocks: tuple[Block, ...]
    map_values: np.ndarray
    nomap_values: np.ndarray
    real_names: tuple[str, ...]
    par_names: tuple[str, ...]
    source_path: Path
    on_disk_format: str
    orientation: str
    notes: tuple[str, ...]

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, StoredEnsemble):
            return NotImplemented
        return (
            self.blocks == other.blocks
            and np.array_equal(self.map_values, other.map_values)
            and np.array_equal(self.nomap_values, other.nomap_values)
            and self.real_names == other.real_names
            and self.par_names == other.par_names
            and self.source_path == other.source_path
            and self.on_disk_format == other.on_disk_format
            and self.orientation == other.orientation
            and self.notes == other.notes
        )

    __hash__ = None


def write_par_reals(
    real_names: Sequence[str], iteration: int, layout: CacheLayout
) -> CacheFile | ReadFailure:
    """Write the per-iteration realization index: the names exactly as read
    from the source file, in file order -- no sorting, no case folding, no
    whitespace stripping -- because a later comparison between iteration 0
    and iteration N joins on these strings.

    A name occurring more than once is kept, not deduplicated; a note names
    it and how many times it appeared.
    """
    name = f"par_reals/{iteration}"
    target = layout.par_reals(iteration)
    try:
        counts: dict[str, int] = {}
        for real_name in real_names:
            counts[real_name] = counts.get(real_name, 0) + 1
        notes = [
            f"realization name {real_name!r} appears {count} times in the source file"
            for real_name, count in counts.items()
            if count > 1
        ]
        payload = {
            "cache_version": CACHE_VERSION,
            "iteration": iteration,
            "n_real": len(real_names),
            "names": list(real_names),
            "notes": notes,
        }
        written = write_atomic_text(target, json.dumps(payload, indent=2))
        return CacheFile(path=str(target.relative_to(layout.root)), bytes=written)
    except Exception as exc:
        return ReadFailure(
            name=name,
            path=str(target),
            reason=f"failed to write realization index for iteration {iteration}: {exc}",
        )


def write_par_ensemble(
    data: "EnsembleData",
    tables: "ControlTables",
    mappable: frozenset[str],
    iteration: int,
    layout: CacheLayout,
    cells: "ParCells | None" = None,
) -> WrittenArtifact | ReadFailure:
    """Write ``data`` into the cache as a two-block float32 file plus its
    sidecar, names, permutation, cells and realization index.

    Every step after the permutation check works with the parameter's
    control-file position -- the identity that survives everything else
    (hash-ordered files, a group split, a cell resolution). ``cells``' cell
    and layer arrays, when given, are derived companion data written
    alongside the map block for a reader's convenience; the parameter
    names in control-file order remain the identity of everything in this
    artifact, cells included.
    """
    name = f"par_ens/{iteration}"
    try:
        if data.permutation is None:
            return ReadFailure(
                name=name,
                path=str(data.source_path),
                reason=(
                    f"{Path(data.source_path).name}: the parameter names in this "
                    f"ensemble could not be matched to the control file, so no "
                    f"control-file order exists to store against -- refusing rather "
                    f"than falling back to file row position"
                ),
            )

        control_names = list(tables.par["parnme"])
        pargp = list(tables.par["pargp"])
        permutation = data.permutation  # control position -> file column index

        map_positions: list[int] = []
        nomap_positions: list[int] = []
        for control_pos, group in enumerate(pargp):
            if str(group) in mappable:
                map_positions.append(control_pos)
            else:
                nomap_positions.append(control_pos)

        map_file_cols = [permutation[p] for p in map_positions]
        nomap_file_cols = [permutation[p] for p in nomap_positions]

        n_real = data.values.shape[0]
        n_map = len(map_file_cols)
        n_nomap = len(nomap_file_cols)

        # One gather straight from file-order columns into the block's own
        # order -- never a full control-order copy of every column first.
        map_values = np.ascontiguousarray(data.values[:, map_file_cols], dtype=np.float32)
        nomap_values = np.ascontiguousarray(
            data.values[:, nomap_file_cols].T, dtype=np.float32
        )

        blocks = (
            Block(
                name="map",
                layout="realization_major",
                offset_bytes=0,
                n_par=n_map,
                shape=(n_real, n_map),
            ),
            Block(
                name="nomap",
                layout="parameter_major",
                offset_bytes=map_values.nbytes,
                n_par=n_nomap,
                shape=(n_nomap, n_real),
            ),
        )

        notes: list[str] = list(data.notes)
        if n_map == 0:
            notes.append("no parameter group was mappable -- the map block is empty")

        stored = StoredEnsemble(
            blocks=blocks,
            map_values=map_values,
            nomap_values=nomap_values,
            real_names=data.real_names,
            par_names=tuple(control_names),
            source_path=Path(data.source_path),
            on_disk_format=data.on_disk_format,
            orientation=data.orientation,
            notes=tuple(notes),
        )

        payload_path = layout.par_ens(iteration)

        def _write_payload(fileobj) -> int:
            written = fileobj.write(stored.map_values.tobytes())
            written += fileobj.write(stored.nomap_values.tobytes())
            return written

        payload_bytes = write_atomic_bytes(payload_path, _write_payload)

        parnames_path = layout.ens / f"par_{iteration}.parnames.txt"
        parnames_text = "".join(f"{n}\n" for n in stored.par_names)
        parnames_bytes = write_atomic_bytes(
            parnames_path, lambda f: f.write(parnames_text.encode("utf-8"))
        )

        parmap_path = layout.ens / f"par_{iteration}.parmap.i32"
        block_order = map_positions + nomap_positions
        parmap_array = np.asarray(block_order, dtype="<i4")
        parmap_bytes = write_atomic_bytes(
            parmap_path, lambda f: f.write(parmap_array.tobytes())
        )

        cell_file_entry = None
        layer_file_entry = None
        cell_file_name: str | None = None
        layer_file_name: str | None = None
        if cells is not None and n_map > 0:
            cell_map_order = np.asarray(cells.cell, dtype="<i4")[map_positions]
            layer_map_order = np.asarray(cells.layer, dtype="<i4")[map_positions]
            cell_path = layout.ens / f"par_{iteration}.cell.i32"
            layer_path = layout.ens / f"par_{iteration}.layer.i32"
            cell_bytes = write_atomic_bytes(
                cell_path, lambda f: f.write(cell_map_order.tobytes())
            )
            layer_bytes = write_atomic_bytes(
                layer_path, lambda f: f.write(layer_map_order.tobytes())
            )
            cell_file_entry = CacheFile(path=str(cell_path.relative_to(layout.root)), bytes=cell_bytes)
            layer_file_entry = CacheFile(
                path=str(layer_path.relative_to(layout.root)), bytes=layer_bytes
            )
            cell_file_name = cell_path.name
            layer_file_name = layer_path.name

        reals_result = write_par_reals(stored.real_names, iteration, layout)
        if isinstance(reals_result, ReadFailure):
            return reals_result

        sidecar_path = layout.ens / f"par_{iteration}.json"
        sidecar = {
            "cache_version": CACHE_VERSION,
            "kind": "par",
            "iteration": iteration,
            "dtype": "float32",
            "n_real": n_real,
            "n_par": n_map + n_nomap,
            "real_names": list(stored.real_names),
            "blocks": [
                {
                    "name": b.name,
                    "layout": b.layout,
                    "offset_bytes": b.offset_bytes,
                    "n_par": b.n_par,
                    "shape": list(b.shape),
                }
                for b in stored.blocks
            ],
            "par_names_file": parnames_path.name,
            "block_to_control_file": parmap_path.name,
            "cell_file": cell_file_name,
            "layer_file": layer_file_name,
            "source": {
                "path": str(stored.source_path),
                "on_disk_format": stored.on_disk_format,
                "orientation": stored.orientation,
            },
            "notes": list(stored.notes),
        }
        sidecar_bytes = write_atomic_text(sidecar_path, json.dumps(sidecar, indent=2))

        root = layout.root
        files = [
            CacheFile(path=str(payload_path.relative_to(root)), bytes=payload_bytes),
            CacheFile(path=str(sidecar_path.relative_to(root)), bytes=sidecar_bytes),
            CacheFile(path=str(parnames_path.relative_to(root)), bytes=parnames_bytes),
            CacheFile(path=str(parmap_path.relative_to(root)), bytes=parmap_bytes),
            reals_result,
        ]
        if cell_file_entry is not None:
            files.append(cell_file_entry)
        if layer_file_entry is not None:
            files.append(layer_file_entry)
        return WrittenArtifact(name=name, files=tuple(files), notes=stored.notes)
    except Exception as exc:
        return ReadFailure(
            name=name,
            path=str(data.source_path),
            reason=f"failed to write ensemble artifact {name} from {Path(data.source_path).name}: {exc}",
        )
