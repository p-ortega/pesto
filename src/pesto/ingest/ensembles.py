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


def _optional_array_equal(a: np.ndarray | None, b: np.ndarray | None) -> bool:
    if a is None or b is None:
        return a is b
    return np.array_equal(a, b)


@dataclass(frozen=True, eq=False)
class StoredEnsemble:
    """One iteration's parameter ensemble as it was written, or as
    :func:`load_stored` read it back: the two block arrays, alongside
    everything the sidecar records. Held together so a caller does not
    have to re-parse the sidecar JSON to see what was actually written.

    ``write_par_ensemble`` builds one of these to hold the values before
    they are serialised and never fills ``path``, ``iteration``,
    ``n_real``, ``n_par``, ``block_to_control``, ``control_to_block``,
    ``cell`` or ``layer`` -- those are what a reader needs and a writer
    already knows some other way. ``load_stored`` fills all of them:
    ``block_to_control`` is the block-position-to-control-position
    permutation `write_par_ensemble` computed, ``control_to_block`` is
    its inverse (built once here with ``numpy.argsort`` so
    ``read_par_across_reals`` never recomputes it per call),
    ``cell``/``layer`` are the map block's companion arrays (``None``
    when the sidecar names none), and ``map_values``/``nomap_values``
    become read-only ``numpy.memmap`` views rather than materialised
    arrays.

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
    path: Path | None = None
    iteration: int | None = None
    n_real: int | None = None
    n_par: int | None = None
    block_to_control: np.ndarray | None = None
    control_to_block: np.ndarray | None = None
    cell: np.ndarray | None = None
    layer: np.ndarray | None = None

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
            and self.path == other.path
            and self.iteration == other.iteration
            and self.n_real == other.n_real
            and self.n_par == other.n_par
            and _optional_array_equal(self.block_to_control, other.block_to_control)
            and _optional_array_equal(self.control_to_block, other.control_to_block)
            and _optional_array_equal(self.cell, other.cell)
            and _optional_array_equal(self.layer, other.layer)
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


def _remove_written(
    files: Sequence[CacheFile], layout: CacheLayout
) -> tuple[int, tuple[str, ...]]:
    """Undo a partly written artifact: remove every file in ``files`` that
    this same call already put on disk, and report what happened.

    This is the only code in pesto that deletes a file, so the guard below
    is not defensive padding. Every path handed to this function came from
    a ``CacheLayout`` accessor inside the very call that is now cleaning up
    after itself, so the check should never fire -- which is exactly why it
    must be there: if a future change ever hands this function a path
    composed some other way, the failure mode is a deleted file belonging
    to someone else. A source file is never a candidate for the same
    reason: nothing under the run directory is ever recorded as a
    ``CacheFile``, so nothing under the run directory can ever reach this
    function's unlink.

    Each path is resolved against the resolved cache root and proved to sit
    under it with ``Path.is_relative_to`` before anything is unlinked; a
    path that fails that check is left on disk and named in the returned
    notes instead of removed. A path that is already gone counts as removed
    and raises nothing. An ``OSError`` on one file does not stop the rest --
    it is named in the notes too. Returns the count removed and one
    sentence per path that could not be removed.
    """
    root = layout.root.resolve()
    removed = 0
    notes: list[str] = []
    for cache_file in files:
        resolved = (layout.root / cache_file.path).resolve()
        if not resolved.is_relative_to(root):
            notes.append(f"{resolved} is not under the cache root {root} -- left in place")
            continue
        try:
            resolved.unlink()
            removed += 1
        except FileNotFoundError:
            removed += 1
        except OSError as exc:
            notes.append(f"could not remove {resolved}: {exc}")
    return removed, tuple(notes)


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

    Atomic as a whole, not just per file: this function tracks every file
    it publishes as it goes, and when it cannot finish -- ``write_par_reals``
    failing partway, most realistically a disk filling up mid-ensemble, or
    any other exception -- it removes what it had already written through
    :func:`_remove_written` before returning the failure, rather than
    leaving disk on the cache root that ``manifest.cache_bytes`` no longer
    accounts for. The alternative the review also offers -- recording the
    orphaned files in the manifest's failed-artifact entry -- would keep
    ``cache_bytes`` honest but leave a partial artifact on disk that
    nothing points at and that ``is_stale`` would have to reason about
    specially; removing them keeps the invariant simple instead -- a
    ``par_ens`` artifact either finished or left nothing -- at the cost of
    re-writing bytes that were going to be re-written on the retry anyway.
    The cleanup call is wrapped so a failure inside it can never replace
    the ``ReadFailure`` the caller actually needs to see: the disk that
    filled up, not the tidying afterwards.
    """
    name = f"par_ens/{iteration}"
    try:
        written: list[CacheFile] = []
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

        n_real = data.values.shape[0]
        if n_real == 0:
            return ReadFailure(
                name=name,
                path=str(data.source_path),
                reason=(
                    f"{Path(data.source_path).name}: this ensemble holds zero "
                    f"realizations -- nothing to write"
                ),
            )
        if len(control_names) == 0:
            return ReadFailure(
                name=name,
                path=str(data.source_path),
                reason=(
                    f"{Path(data.source_path).name}: the control file names zero "
                    f"parameters -- nothing to write"
                ),
            )

        map_positions: list[int] = []
        nomap_positions: list[int] = []
        for control_pos, group in enumerate(pargp):
            if str(group) in mappable:
                map_positions.append(control_pos)
            else:
                nomap_positions.append(control_pos)

        map_file_cols = [permutation[p] for p in map_positions]
        nomap_file_cols = [permutation[p] for p in nomap_positions]

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
            payload_written = fileobj.write(stored.map_values.tobytes())
            payload_written += fileobj.write(stored.nomap_values.tobytes())
            return payload_written

        payload_bytes = write_atomic_bytes(payload_path, _write_payload)
        payload_entry = CacheFile(
            path=str(payload_path.relative_to(layout.root)), bytes=payload_bytes
        )
        written.append(payload_entry)

        parnames_path = layout.ens / f"par_{iteration}.parnames.txt"
        parnames_text = "".join(f"{n}\n" for n in stored.par_names)
        parnames_bytes = write_atomic_bytes(
            parnames_path, lambda f: f.write(parnames_text.encode("utf-8"))
        )
        parnames_entry = CacheFile(
            path=str(parnames_path.relative_to(layout.root)), bytes=parnames_bytes
        )
        written.append(parnames_entry)

        parmap_path = layout.ens / f"par_{iteration}.parmap.i32"
        block_order = map_positions + nomap_positions
        parmap_array = np.asarray(block_order, dtype="<i4")
        parmap_bytes = write_atomic_bytes(
            parmap_path, lambda f: f.write(parmap_array.tobytes())
        )
        parmap_entry = CacheFile(
            path=str(parmap_path.relative_to(layout.root)), bytes=parmap_bytes
        )
        written.append(parmap_entry)

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
            written.append(cell_file_entry)
            written.append(layer_file_entry)
            cell_file_name = cell_path.name
            layer_file_name = layer_path.name

        reals_result = write_par_reals(stored.real_names, iteration, layout)
        if isinstance(reals_result, ReadFailure):
            try:
                removed, cleanup_notes = _remove_written(written, layout)
            except Exception:
                removed, cleanup_notes = 0, ()
            reason = (
                f"{reals_result.reason} -- cleaned up {removed} file(s) already "
                f"written for this artifact"
            )
            if cleanup_notes:
                reason += f"; could not remove: {'; '.join(cleanup_notes)}"
            return ReadFailure(name=reals_result.name, path=reals_result.path, reason=reason)

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
            payload_entry,
            CacheFile(path=str(sidecar_path.relative_to(root)), bytes=sidecar_bytes),
            parnames_entry,
            parmap_entry,
            reals_result,
        ]
        if cell_file_entry is not None:
            files.append(cell_file_entry)
        if layer_file_entry is not None:
            files.append(layer_file_entry)
        return WrittenArtifact(name=name, files=tuple(files), notes=stored.notes)
    except Exception as exc:
        try:
            removed, cleanup_notes = _remove_written(written, layout)
        except Exception:
            removed, cleanup_notes = 0, ()
        reason = (
            f"failed to write ensemble artifact {name} from "
            f"{Path(data.source_path).name}: {exc} -- cleaned up {removed} file(s) "
            f"already written for this artifact"
        )
        if cleanup_notes:
            reason += f"; could not remove: {'; '.join(cleanup_notes)}"
        return ReadFailure(name=name, path=str(data.source_path), reason=reason)


# ---------------------------------------------------------------------------
# Reading a stored ensemble back through its own sidecar
# ---------------------------------------------------------------------------


def load_stored(iteration: int, layout: CacheLayout) -> StoredEnsemble | ReadFailure:
    """Open the ensemble written for ``iteration`` through its own sidecar.

    Trusts nothing about the payload beyond what the sidecar describes:
    the same shape checks ``Manifest.load`` applies to the manifest --
    catch ``OSError``/``json.JSONDecodeError``, check the parsed value is
    a dict before reading a key, refuse a different ``cache_version`` --
    apply here too, plus one check the manifest has no need for: the
    payload's size on disk must equal the sum of the two blocks' byte
    lengths (T-04-06), because a file that does not match its own
    description is one this function cannot answer questions about.

    The payload is memory-mapped, never read whole -- an 11 GB cache must
    not be pulled into RAM to answer one realization's question.
    """
    name = f"par_ens/{iteration}"
    payload_path = layout.par_ens(iteration)
    sidecar_path = layout.ens / f"par_{iteration}.json"

    try:
        raw = sidecar_path.read_text()
    except OSError as exc:
        return ReadFailure(
            name=name,
            path=str(sidecar_path),
            reason=f"could not read sidecar {sidecar_path.name}: {exc}",
        )
    try:
        sidecar = json.loads(raw)
    except json.JSONDecodeError as exc:
        return ReadFailure(
            name=name,
            path=str(sidecar_path),
            reason=f"sidecar {sidecar_path.name} is not valid JSON: {exc}",
        )
    if not isinstance(sidecar, dict):
        return ReadFailure(
            name=name,
            path=str(sidecar_path),
            reason=f"sidecar {sidecar_path.name} is not a JSON object (got {type(sidecar).__name__})",
        )
    if sidecar.get("cache_version") != CACHE_VERSION:
        return ReadFailure(
            name=name,
            path=str(sidecar_path),
            reason=(
                f"sidecar {sidecar_path.name} was written at cache_version "
                f"{sidecar.get('cache_version')!r}, this reader expects {CACHE_VERSION}"
            ),
        )

    try:
        raw_blocks = sidecar["blocks"]
        if not isinstance(raw_blocks, list) or len(raw_blocks) != 2:
            raise ValueError("blocks is not a two-entry list")
        blocks = tuple(
            Block(
                name=b["name"],
                layout=b["layout"],
                offset_bytes=b["offset_bytes"],
                n_par=b["n_par"],
                shape=tuple(b["shape"]),
            )
            for b in raw_blocks
        )
        real_names = tuple(sidecar["real_names"])
        n_real = int(sidecar["n_real"])
        n_par = int(sidecar["n_par"])
        parnames_file = sidecar["par_names_file"]
        block_to_control_file = sidecar["block_to_control_file"]
        cell_file = sidecar.get("cell_file")
        layer_file = sidecar.get("layer_file")
        source = sidecar.get("source", {})
        notes = tuple(sidecar.get("notes", []))
    except (KeyError, TypeError, ValueError) as exc:
        return ReadFailure(
            name=name,
            path=str(sidecar_path),
            reason=f"sidecar {sidecar_path.name} is not shaped like a par ensemble sidecar: {exc}",
        )

    expected_bytes = sum(shape[0] * shape[1] * 4 for shape in (b.shape for b in blocks))
    try:
        actual_bytes = payload_path.stat().st_size
    except OSError as exc:
        return ReadFailure(
            name=name,
            path=str(payload_path),
            reason=f"could not stat payload {payload_path.name}: {exc}",
        )
    if actual_bytes != expected_bytes:
        direction = "shorter" if actual_bytes < expected_bytes else "longer"
        return ReadFailure(
            name=name,
            path=str(payload_path),
            reason=(
                f"payload {payload_path.name} is {direction} than the sidecar describes "
                f"({actual_bytes} bytes on disk, {expected_bytes} expected)"
            ),
        )

    try:
        par_names = tuple((layout.ens / parnames_file).read_text().splitlines())
        block_to_control = np.fromfile(layout.ens / block_to_control_file, dtype="<i4")
        cell = np.fromfile(layout.ens / cell_file, dtype="<i4") if cell_file else None
        layer = np.fromfile(layout.ens / layer_file, dtype="<i4") if layer_file else None

        map_block = next(b for b in blocks if b.name == "map")
        nomap_block = next(b for b in blocks if b.name == "nomap")
        map_values = np.memmap(
            payload_path,
            dtype="<f4",
            mode="r",
            offset=map_block.offset_bytes,
            shape=map_block.shape,
        )
        nomap_values = np.memmap(
            payload_path,
            dtype="<f4",
            mode="r",
            offset=nomap_block.offset_bytes,
            shape=nomap_block.shape,
        )
    except Exception as exc:
        return ReadFailure(
            name=name,
            path=str(payload_path),
            reason=f"failed to open ensemble artifact {name}: {exc}",
        )

    return StoredEnsemble(
        blocks=blocks,
        map_values=map_values,
        nomap_values=nomap_values,
        real_names=real_names,
        par_names=par_names,
        source_path=Path(source.get("path", "")),
        on_disk_format=source.get("on_disk_format", ""),
        orientation=source.get("orientation", ""),
        notes=notes,
        path=payload_path,
        iteration=iteration,
        n_real=n_real,
        n_par=n_par,
        block_to_control=block_to_control,
        control_to_block=np.argsort(block_to_control),
        cell=cell,
        layer=layer,
    )


def _resolve_realization(stored: StoredEnsemble, realization: int | str) -> int | ReadFailure:
    """Turn a name or index into a row index into the map block.

    An ``int`` is checked against the realization count; a ``str`` is
    looked up in ``real_names`` by exact string equality -- never the
    nearest row, and the two kinds are never confused with each other.
    """
    name = f"par_ens/{stored.iteration}"
    if isinstance(realization, str):
        try:
            return stored.real_names.index(realization)
        except ValueError:
            return ReadFailure(
                name=name,
                path=str(stored.path),
                reason=(
                    f"realization {realization!r} is not among the "
                    f"{len(stored.real_names)} realizations recorded for this file"
                ),
            )
    if isinstance(realization, int):
        if 0 <= realization < len(stored.real_names):
            return realization
        return ReadFailure(
            name=name,
            path=str(stored.path),
            reason=(
                f"realization index {realization} is out of range for "
                f"{len(stored.real_names)} realizations"
            ),
        )
    return ReadFailure(
        name=name,
        path=str(stored.path),
        reason=f"realization must be an int index or a str name, got {type(realization).__name__}",
    )


def read_realization_field(
    stored: StoredEnsemble, realization: int | str
) -> np.ndarray | ReadFailure:
    """One realization, every parameter, in control-file order.

    Reads the map block's row and the non-map block's column for this
    realization, concatenates them in block order, then scatters through
    ``stored.block_to_control`` so the result lines up with
    ``stored.par_names``.
    """
    row = _resolve_realization(stored, realization)
    if isinstance(row, ReadFailure):
        return row
    try:
        map_row = np.asarray(stored.map_values[row], dtype=np.float32)
        nomap_row = np.asarray(stored.nomap_values[:, row], dtype=np.float32)
        block_order_values = np.concatenate([map_row, nomap_row])
        control_order = np.empty(len(stored.par_names), dtype=np.float32)
        control_order[stored.block_to_control] = block_order_values
        return control_order
    except Exception as exc:
        return ReadFailure(
            name=f"par_ens/{stored.iteration}",
            path=str(stored.path),
            reason=f"failed to read realization {realization!r}: {exc}",
        )


def read_map_row(stored: StoredEnsemble, realization: int | str) -> np.ndarray | ReadFailure:
    """The map block's row for this realization, in block order -- no
    permutation applied.

    This is the array ``stored.cell`` and ``stored.layer`` are aligned
    with; a caller pairing it with ``stored.par_names`` instead would be
    pairing two different orders.
    """
    row = _resolve_realization(stored, realization)
    if isinstance(row, ReadFailure):
        return row
    try:
        return np.asarray(stored.map_values[row], dtype=np.float32)
    except Exception as exc:
        return ReadFailure(
            name=f"par_ens/{stored.iteration}",
            path=str(stored.path),
            reason=f"failed to read map row for realization {realization!r}: {exc}",
        )


def read_par_across_reals(stored: StoredEnsemble, parname: str) -> np.ndarray | ReadFailure:
    """One named parameter, every realization.

    Looks ``parname`` up in ``stored.par_names`` by exact string equality,
    refusing with a ``ReadFailure`` when it is absent, then uses
    ``stored.control_to_block`` to find which block position it landed
    in. A non-map-block parameter is read contiguously -- ``n_real``
    values at one stride-free slice -- because parameters have no time
    dimension and the non-map block exists for exactly this access
    pattern. A map-block parameter is read with a stride of ``n_map``
    instead: the map block is realization-first so the map can read one
    realization's whole row contiguously, and this is the price paid on
    the other axis for that choice.
    """
    name = f"par_ens/{stored.iteration}"
    try:
        control_pos = stored.par_names.index(parname)
    except ValueError:
        return ReadFailure(
            name=name,
            path=str(stored.path),
            reason=(
                f"parameter {parname!r} is not among the "
                f"{len(stored.par_names)} parameters recorded for this file"
            ),
        )
    try:
        block_pos = int(stored.control_to_block[control_pos])
        n_map = stored.map_values.shape[1]
        if block_pos < n_map:
            values = stored.map_values[:, block_pos]  # strided
        else:
            values = stored.nomap_values[block_pos - n_map]  # contiguous
        return np.asarray(values, dtype=np.float32)
    except Exception as exc:
        return ReadFailure(
            name=name,
            path=str(stored.path),
            reason=f"failed to read parameter {parname!r} across realizations: {exc}",
        )


@dataclass(frozen=True)
class RealAlignment:
    """The join between two realization-name sequences, by name.

    ``names`` holds the names present in both, in ``a``'s order;
    ``index_a``/``index_b`` are the matching row indexes into each side.
    ``only_a``/``only_b`` are the names present in one side only --
    reported rather than dropped, because pestpp-ies removes failed
    realizations from the working ensemble rather than writing NaN rows,
    so iteration 0 and a later iteration routinely hold different sets.
    """

    names: tuple[str, ...]
    index_a: tuple[int, ...]
    index_b: tuple[int, ...]
    only_a: tuple[str, ...]
    only_b: tuple[str, ...]
    notes: tuple[str, ...]


def _first_occurrence_index(names: Sequence[str]) -> tuple[dict[str, int], list[str]]:
    """First-seen index for each name, plus a note for every repeat."""
    index: dict[str, int] = {}
    counts: dict[str, int] = {}
    for position, name in enumerate(names):
        counts[name] = counts.get(name, 0) + 1
        if name not in index:
            index[name] = position
    notes = [
        f"realization name {name!r} appears {count} times; joined on its first occurrence"
        for name, count in counts.items()
        if count > 1
    ]
    return index, notes


def align_realizations(a: Sequence[str], b: Sequence[str]) -> RealAlignment:
    """Join two realization-name sequences by exact string equality.

    Matching is never by position -- a name differing from another only
    by case or surrounding whitespace simply does not join, and is
    reported in ``only_a`` or ``only_b`` rather than silently dropped. No
    overlap at all is a real answer about two iterations of a run, not an
    error: it comes back as empty ``names``/``index_a``/``index_b`` and a
    note saying so.
    """
    index_a, notes_a = _first_occurrence_index(a)
    index_b, notes_b = _first_occurrence_index(b)

    common = [name for name in index_a if name in index_b]
    only_a = tuple(name for name in index_a if name not in index_b)
    only_b = tuple(name for name in index_b if name not in index_a)

    notes = notes_a + notes_b
    if not common:
        notes.append("no realization name is shared between the two sequences")

    return RealAlignment(
        names=tuple(common),
        index_a=tuple(index_a[name] for name in common),
        index_b=tuple(index_b[name] for name in common),
        only_a=only_a,
        only_b=only_b,
        notes=tuple(notes),
    )
