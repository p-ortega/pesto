"""Read and write one iteration's ensemble in a process created just for it.

Every artifact is read and written inside a process created for that
artifact alone and torn down after it, because a Python ``try``/``except``
cannot catch a segfault in a C extension, and a shared worker pool fails
every job still queued behind a worker that dies (T-04-01).
"""

from __future__ import annotations

import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from pesto.cache.layout import CacheLayout, for_run
from pesto.cache.manifest import Manifest, SourceFingerprint, WrittenArtifact
from pesto.ingest.control import read_control
from pesto.ingest.discover import discover
from pesto.ingest.ensembles import write_par_ensemble
from pesto.ingest.ensfile import read_ensemble
from pesto.ingest.failures import ReadFailure

# CellsPayload is what crosses the process boundary in place of a live
# ParCells: the cell and layer arrays as little-endian int32 bytes plus
# their shared length, and parnme as a list of strings. Only picklable
# primitives -- never a CacheLayout, an open file handle, or a live
# DataFrame -- cross into or out of a worker.
CellsPayload = tuple[bytes, bytes, int, list[str]]


@dataclass(frozen=True)
class Progress:
    """One row of per-artifact progress. Every number is a count or a
    measurement, never an estimate -- a ``"started"`` row carries the
    source file's real size and zero for the two figures not yet known."""

    artifact: str
    state: str  # "started" | "ok" | "failed" | "skipped"
    index: int
    total: int
    source_bytes: int
    written_bytes: int
    seconds: float
    reason: str | None = None


def _run_isolated(fn, *args):
    """Run ``fn(*args)`` in a process created for this one call and torn
    down after it, so a hard crash in a C extension cannot reach any other
    artifact.

    Returns ``(ok, result_or_exception)``. Catching bare ``Exception``
    around ``future.result()`` covers ``BrokenProcessPool`` too, raised
    when a worker dies without raising anything itself.
    """
    with ProcessPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fn, *args)
        try:
            return True, future.result()
        except Exception as exc:
            return False, exc


def _resolve_cells(pst_path: str, grid_path: str | None):
    """Resolve which cell and layer each parameter lands on, for a run
    that has a grid file. Runs through :func:`_run_isolated` so ``flopy``
    parses the grid file inside a worker and never in the parent.

    ``None`` means there is no grid file -- an ordinary, early state Phase
    3 already treats as normal, not a failure. A ``ReadFailure`` from
    reading the control file or from the adapter's own ``locate_par`` is
    passed straight back.
    """
    if grid_path is None:
        return None
    tables = read_control(Path(pst_path))
    if isinstance(tables, ReadFailure):
        return tables
    # Deferred import: nothing under pesto.ingest may name pesto.model at
    # module level (test_no_ingest_file_imports_anything_from_model). This
    # function body is exactly where a first-use import belongs.
    from pesto.model.mf6 import Mf6Adapter

    adapter = Mf6Adapter(Path(grid_path))
    return adapter.locate_par(tables.par)


def _write_par_ens(
    source: str,
    pst_path: str,
    cache_root: str,
    iteration: int,
    mappable: list[str],
    cells_payload: CellsPayload | None = None,
    cell_note: str | None = None,
) -> "WrittenArtifact | ReadFailure":
    """The worker: reads the untrusted control file and ensemble file, then
    writes the cache artifact. This function runs only inside a process
    created for it -- the parent process must never parse a run file
    itself. Only picklable primitives may cross the boundary in or out."""
    tables = read_control(Path(pst_path))
    if isinstance(tables, ReadFailure):
        return tables
    data = read_ensemble(Path(source), tables)
    if isinstance(data, ReadFailure):
        return data
    if cell_note is not None:
        data = replace(data, notes=data.notes + (cell_note,))

    cells = None
    if cells_payload is not None:
        cell_bytes, layer_bytes, n, parnme = cells_payload
        # Deferred import for the same reason as in _resolve_cells: ParCells
        # lives in pesto.model, which pesto.ingest may never name at module
        # level. Reconstructed purely as a carrier for cell/layer arrays --
        # groups and summary are not needed by write_par_ensemble.
        from pesto.model import ParCells

        cells = ParCells(
            cell=np.frombuffer(cell_bytes, dtype="<i4", count=n).copy(),
            layer=np.frombuffer(layer_bytes, dtype="<i4", count=n).copy(),
            parnme=tuple(parnme),
            groups=(),
            summary="",
            notes=(),
        )

    layout = CacheLayout(root=Path(cache_root))
    return write_par_ensemble(
        data,
        tables,
        mappable=frozenset(mappable),
        iteration=iteration,
        layout=layout,
        cells=cells,
    )


def _select_iterations(numbered: list[int]) -> list[int]:
    """First and last numbered iteration, collapsing to one when a run
    with ``noptmax <= 0`` makes them the same iteration."""
    if not numbered:
        return []
    ordered = sorted(numbered)
    if len(ordered) == 1:
        return [ordered[0]]
    return [ordered[0], ordered[-1]]


def ingest_run(
    run_dir: Path,
    cache_root: Path | None = None,
    iterations: Sequence[int] | None = None,
    on_progress: Callable[[Progress], None] | None = None,
) -> Manifest:
    """Ingest a run's first and last parameter ensemble iterations into the
    cache, one artifact at a time, each read and written in a process of
    its own.

    An interruption leaves finished artifacts recorded: the manifest is
    saved after every artifact, not once at the end.
    """
    run = discover(run_dir)
    if cache_root is None:
        layout = for_run(run_dir)
    else:
        layout = CacheLayout(root=Path(cache_root))
    layout.ensure()
    manifest = Manifest.load(layout)

    if iterations is None:
        numbered = [k for k in run.par_ens if isinstance(k, int)]
        selected = _select_iterations(numbered)
    else:
        selected = list(iterations)

    # Resolved once, ahead of the iteration loop -- every selected
    # iteration shares the same grid and the same group-to-cell mapping.
    grid_path = str(run.grid) if run.grid is not None else None
    cells_ok, cells_result = _run_isolated(_resolve_cells, str(run.pst_path), grid_path)

    mappable: list[str] = []
    cells_payload: CellsPayload | None = None
    cell_note: str | None = None
    if not cells_ok:
        cell_note = f"cell resolution failed, so the map block is empty: {cells_result}"
    elif cells_result is None:
        cell_note = "no grid file was found for this run, so the map block is empty"
    elif isinstance(cells_result, ReadFailure):
        cell_note = f"cell resolution failed, so the map block is empty: {cells_result.reason}"
    else:
        mappable = sorted(cells_result.placed_groups)
        cells_payload = (
            np.asarray(cells_result.cell, dtype="<i4").tobytes(),
            np.asarray(cells_result.layer, dtype="<i4").tobytes(),
            len(cells_result.cell),
            list(cells_result.parnme),
        )

    total = len(selected)
    for index, iteration in enumerate(selected):
        source = run.par_ens[iteration]
        artifact_name = f"par_ens/{iteration}"
        source_bytes = source.stat().st_size if source.exists() else 0

        if on_progress is not None:
            on_progress(
                Progress(
                    artifact=artifact_name,
                    state="started",
                    index=index,
                    total=total,
                    source_bytes=source_bytes,
                    written_bytes=0,
                    seconds=0.0,
                )
            )

        start = time.perf_counter()
        ok, result = _run_isolated(
            _write_par_ens,
            str(source),
            str(run.pst_path),
            str(layout.root),
            iteration,
            mappable,
            cells_payload,
            cell_note,
        )
        seconds = time.perf_counter() - start

        sources = [SourceFingerprint.of(source), SourceFingerprint.of(run.pst_path)]

        if ok and isinstance(result, WrittenArtifact):
            written_bytes = sum(f.bytes for f in result.files)
            manifest.mark_ok(artifact_name, sources, files=result.files, seconds=seconds)
            manifest.save(layout)
            state = "ok"
            reason = None
        else:
            written_bytes = 0
            reason = result.reason if isinstance(result, ReadFailure) else str(result)
            manifest.mark_failed(artifact_name, reason, sources=sources, seconds=seconds)
            manifest.save(layout)
            state = "failed"

        if on_progress is not None:
            on_progress(
                Progress(
                    artifact=artifact_name,
                    state=state,
                    index=index,
                    total=total,
                    source_bytes=source_bytes,
                    written_bytes=written_bytes,
                    seconds=seconds,
                    reason=reason,
                )
            )

    return manifest
