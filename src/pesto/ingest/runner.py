"""Turn one call into a whole run's cache: plan every artifact and run each
in a process created just for it.

Every artifact is read and written inside a process created for that
artifact alone and torn down after it, because a Python ``try``/``except``
cannot catch a segfault in a C extension, and a shared worker pool fails
every job still queued behind a worker that dies (T-04-01).
"""

from __future__ import annotations

import json
import signal
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from pesto.cache.layout import CacheLayout, for_run
from pesto.cache.manifest import Manifest, SourceFingerprint, WrittenArtifact
from pesto.cache.runconfig import build_config, write_config
from pesto.ingest.aggregate import write_par_agg
from pesto.ingest.control import read_control
from pesto.ingest.discover import RunLayout, discover
from pesto.ingest.ensembles import write_par_ensemble
from pesto.ingest.ensfile import read_ensemble
from pesto.ingest.failures import ReadFailure
from pesto.ingest.mesh import write_grid_from_adapter
from pesto.ingest.tables import write_control

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


@dataclass(frozen=True)
class PlannedArtifact:
    """One artifact one ingest will attempt: what it depends on, what it
    writes, and how large its sources are before any of it runs.

    ``sources`` and ``outputs`` are absolute paths as strings -- inside the
    run directory and under the cache root respectively -- so they cross
    into a worker as picklable primitives with nothing further to resolve.
    ``source_bytes`` is the summed size of ``sources`` on disk, a real
    figure a progress row can carry before any work starts.
    """

    name: str
    kind: str  # "par_ens" | "par_agg" | "control" | "grid" | "config"
    sources: tuple[str, ...]
    outputs: tuple[str, ...]
    source_bytes: int


@dataclass(frozen=True)
class _RealNamesOnly:
    """The one field :func:`build_config` reads off ``first`` -- built from
    the realization index the ``par_ens`` worker already wrote, never from
    an ``EnsembleData`` crossing the process boundary."""

    real_names: tuple[str, ...]


def _run_isolated(fn, *args):
    """Run ``fn(*args)`` in a process created for this one call and torn
    down after it, so a hard crash in a C extension cannot reach any other
    artifact.

    Returns ``(ok, result_or_exception)``. Catching bare ``Exception``
    around ``future.result()`` covers ``BrokenProcessPool`` too, raised
    when a worker dies without raising anything itself.

    When the exception is a ``BrokenProcessPool``, the dead worker's exit
    code is read off the pool's own ``Process`` objects and attached to the
    exception as ``exitcode``, before the ``with`` block tears the pool
    down -- ``concurrent.futures`` exposes no public API for it, and it is
    the only way ``_reason_for`` can tell a worker killed by a signal (a
    negative exit code) from one that died for any other reason.
    """
    with ProcessPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fn, *args)
        try:
            return True, future.result()
        except Exception as exc:
            if isinstance(exc, BrokenProcessPool):
                for proc in pool._processes.values():
                    if proc.exitcode is not None:
                        exc.exitcode = proc.exitcode
                        break
            return False, exc


def _reason_for(artifact: str, source: str, exc: BaseException) -> str:
    """Turn a caught exception from a dead or raising worker into one
    sentence naming the artifact and the file, and then what happened --
    never a bare ``repr(exc)``, which is what a scientist would otherwise
    have to decode next to a red row in the ingest report.

    Three distinguishable shapes: a ``BrokenProcessPool`` whose worker's
    exit code is a negative number names the signal that killed it, because
    that and a worker that simply ran out of memory are different facts to
    someone reading a failed ingest; any other ``BrokenProcessPool`` says
    the worker exited without returning a result; and any other exception
    names its own message.
    """
    if isinstance(exc, BrokenProcessPool):
        exitcode = getattr(exc, "exitcode", None)
        if isinstance(exitcode, int) and exitcode < 0:
            signum = -exitcode
            try:
                signame = f" ({signal.Signals(signum).name})"
            except ValueError:
                signame = ""
            return (
                f"{artifact}: the worker reading {source} was killed by signal "
                f"{signum}{signame} before it returned a result"
            )
        return (
            f"{artifact}: the worker reading {source} exited without returning "
            f"a result, so the file could not be read"
        )
    return f"{artifact}: reading {source} failed -- {exc}"


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


def _write_par_agg_artifact(
    source: str, pst_path: str, cache_root: str, iteration: int
) -> "WrittenArtifact | ReadFailure":
    """The worker for one iteration's per-parameter summary: reads the same
    two untrusted files the ensemble worker does, independently, and writes
    ``agg/par_{iteration}.parquet``."""
    tables = read_control(Path(pst_path))
    if isinstance(tables, ReadFailure):
        return tables
    data = read_ensemble(Path(source), tables)
    if isinstance(data, ReadFailure):
        return data
    layout = CacheLayout(root=Path(cache_root))
    return write_par_agg(data, tables, iteration, layout)


def _write_control_artifact(pst_path: str, cache_root: str) -> "WrittenArtifact | ReadFailure":
    """The worker for the ``control`` artifact: reads the control file and
    writes its parameter and observation tables into the cache."""
    tables = read_control(Path(pst_path))
    if isinstance(tables, ReadFailure):
        return tables
    layout = CacheLayout(root=Path(cache_root))
    return write_control(tables, layout)


def _write_grid_artifact(
    grid_path: str, cache_root: str
) -> "WrittenArtifact | ReadFailure | None":
    """The worker for the ``grid`` artifact -- the one that matters most for
    isolation, since it is the one that lets flopy parse the binary grid
    file. Constructs its own :class:`Mf6Adapter` so a malformed ``.grb``
    costs this artifact and never the parent."""
    # Deferred import for the same reason as in _resolve_cells.
    from pesto.model.mf6 import Mf6Adapter

    layout = CacheLayout(root=Path(cache_root))
    adapter = Mf6Adapter(Path(grid_path))
    return write_grid_from_adapter(adapter, layout)


def _write_config_artifact(
    run_dir: str,
    cache_root: str,
    first_iteration: int | None,
) -> "WrittenArtifact | ReadFailure":
    """The worker for the ``config`` artifact: rediscovers the run from
    ``run_dir`` (a line scan, never a saved ``RunLayout`` crossing the
    boundary) and reads the control file. The first ingested iteration's
    realization names come from ``reals/par_{first_iteration}.reals.json``,
    which the ``par_ens`` worker already wrote -- not from an
    ``EnsembleData`` passed in, which would make ``config`` depend on a
    value held in the parent rather than on an artifact that has already
    succeeded. A grid file, when the run has one, is parsed again here
    through its own :class:`Mf6Adapter` for ``crs()`` -- one more isolated
    parse of a small binary file, not a departure from this worker's own
    process boundary.
    """
    run = discover(Path(run_dir))
    tables = read_control(run.pst_path)
    if isinstance(tables, ReadFailure):
        return tables

    layout = CacheLayout(root=Path(cache_root))

    first: _RealNamesOnly | None = None
    if first_iteration is not None:
        try:
            reals_data = json.loads(layout.par_reals(first_iteration).read_text())
            first = _RealNamesOnly(real_names=tuple(reals_data.get("names", [])))
        except (OSError, json.JSONDecodeError, TypeError, AttributeError):
            first = None

    adapter = None
    if run.grid is not None:
        # Deferred import for the same reason as in _resolve_cells.
        from pesto.model.mf6 import Mf6Adapter

        adapter = Mf6Adapter(run.grid)

    config = build_config(run, tables, first, adapter)
    return write_config(config, layout)


def _select_iterations(numbered: list[int]) -> list[int]:
    """First and last numbered iteration, collapsing to one when a run
    with ``noptmax <= 0`` makes them the same iteration."""
    if not numbered:
        return []
    ordered = sorted(numbered)
    if len(ordered) == 1:
        return [ordered[0]]
    return [ordered[0], ordered[-1]]


def _should_retry(manifest: Manifest, name: str, base: Path) -> bool:
    """Should artifact ``name`` be read again on this ingest?

    Decision (04-CONTEXT.md's Claude's Discretion item, resolved here): a
    failed artifact stays failed until its source changes. Re-reading a
    file that has not changed, only to fail on it in the same way, is time
    a scientist spends waiting for an answer they already have. An artifact
    in state ``"failed"`` whose recorded sources all still match ``base``
    is declined a retry. Everything else -- an artifact not yet in the
    manifest, one in any state other than ``"failed"``, a failed artifact
    with a changed source, or a failed artifact with no recorded sources at
    all -- is read again.
    """
    artifact = manifest.artifacts.get(name)
    if artifact is None or artifact.state != "failed":
        return True
    if not artifact.sources:
        return True
    return not all(source.matches(base) for source in artifact.sources)


def _stat_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def plan_artifacts(
    run: RunLayout, layout: CacheLayout, iterations: Sequence[int] | None = None
) -> tuple[PlannedArtifact, ...]:
    """The whole, deterministically ordered list of artifacts one ingest of
    ``run`` will attempt: an ensemble and a summary for each selected
    iteration, then ``control``, then ``grid`` when a grid file exists,
    then ``config``. Iteration artifacts come first in ascending iteration
    order, ensemble before summary within an iteration -- a caller
    watching rows go past sees the same sequence every time this is called
    for the same run and layout.

    ``iterations`` defaults to the first and last numbered iteration,
    exactly as :func:`ingest_run` has always chosen them. When ``noptmax``
    is zero or negative, or the run holds only one iteration, the first and
    last iteration are the same one and it is planned once -- two artifacts
    writing the same file would be a collision the runner already refuses,
    and re-reading the file to write the same bytes twice is time spent for
    nothing.

    Each artifact names the source files it depends on: an ensemble and a
    summary against that iteration's ensemble file and the control file,
    ``control`` against the control file, ``grid`` against the grid file,
    and ``config`` against the control file and, when one exists, the grid
    file too. A run with no grid file plans no ``grid`` artifact, and
    ``config`` fingerprints only the control file.
    """
    if iterations is None:
        numbered = [k for k in run.par_ens if isinstance(k, int)]
        selected = _select_iterations(numbered)
    else:
        selected = list(iterations)

    pst_path = run.pst_path
    pst_bytes = _stat_size(pst_path)
    grid_path = run.grid

    artifacts: list[PlannedArtifact] = []
    for iteration in selected:
        source = run.par_ens.get(iteration)
        if source is None:
            continue
        source_bytes = _stat_size(source) + pst_bytes
        sources = (str(source), str(pst_path))
        artifacts.append(
            PlannedArtifact(
                name=f"par_ens/{iteration}",
                kind="par_ens",
                sources=sources,
                outputs=(str(layout.par_ens(iteration)),),
                source_bytes=source_bytes,
            )
        )
        artifacts.append(
            PlannedArtifact(
                name=f"par_agg/{iteration}",
                kind="par_agg",
                sources=sources,
                outputs=(str(layout.par_agg(iteration)),),
                source_bytes=source_bytes,
            )
        )

    artifacts.append(
        PlannedArtifact(
            name="control",
            kind="control",
            sources=(str(pst_path),),
            outputs=(
                str(layout.control / "par.parquet"),
                str(layout.control / "obs.parquet"),
                str(layout.control / "notes.json"),
            ),
            source_bytes=pst_bytes,
        )
    )

    if grid_path is not None:
        grid_bytes = _stat_size(grid_path)
        artifacts.append(
            PlannedArtifact(
                name="grid",
                kind="grid",
                sources=(str(grid_path),),
                outputs=(
                    str(layout.grid / "positions.f32"),
                    str(layout.grid / "cell_index.f32"),
                    str(layout.grid / "indices.u32"),
                    str(layout.grid / "mesh.json"),
                ),
                source_bytes=grid_bytes,
            )
        )
        config_sources = (str(pst_path), str(grid_path))
        config_bytes = pst_bytes + grid_bytes
    else:
        config_sources = (str(pst_path),)
        config_bytes = pst_bytes

    artifacts.append(
        PlannedArtifact(
            name="config",
            kind="config",
            sources=config_sources,
            outputs=(str(layout.config),),
            source_bytes=config_bytes,
        )
    )

    return tuple(artifacts)


def _fingerprint_sources(sources: Sequence[str]) -> list[SourceFingerprint]:
    """Fingerprint every source path that can be stat'd and hashed. A
    source that has vanished since it was planned is left out rather than
    raised -- the artifact's own read will report that failure with a
    reason naming the file."""
    fingerprints: list[SourceFingerprint] = []
    for raw in sources:
        try:
            fingerprints.append(SourceFingerprint.of(Path(raw)))
        except OSError:
            continue
    return fingerprints


def _dispatch(
    artifact: PlannedArtifact,
    run_dir: str,
    pst_path: str,
    cache_root: str,
    mappable: list[str],
    cells_payload: CellsPayload | None,
    cell_note: str | None,
    grid_path: str | None,
    first_iteration: int | None,
) -> tuple[Callable, tuple]:
    """Which worker function runs this artifact, and with what arguments --
    every argument a string, an int, or a list of strings, so nothing but
    picklable primitives crosses into the worker."""
    if artifact.kind == "par_ens":
        iteration = int(artifact.name.split("/", 1)[1])
        return _write_par_ens, (
            artifact.sources[0],
            pst_path,
            cache_root,
            iteration,
            mappable,
            cells_payload,
            cell_note,
        )
    if artifact.kind == "par_agg":
        iteration = int(artifact.name.split("/", 1)[1])
        return _write_par_agg_artifact, (artifact.sources[0], pst_path, cache_root, iteration)
    if artifact.kind == "control":
        return _write_control_artifact, (pst_path, cache_root)
    if artifact.kind == "grid":
        return _write_grid_artifact, (grid_path, cache_root)
    if artifact.kind == "config":
        return _write_config_artifact, (run_dir, cache_root, first_iteration)
    raise ValueError(f"plan_artifacts produced an artifact of unknown kind: {artifact.kind!r}")


def _manifest_totals(manifest: Manifest) -> tuple[float, int]:
    """The ingest facts D-07 keeps out of ``config.json``: the summed
    measured seconds and summed finished byte size of every artifact
    currently recorded ``ok`` or otherwise carrying a measurement -- read
    off the manifest itself, so a run that skips every artifact because
    nothing changed still reports the totals its cache actually cost to
    build."""
    seconds = sum(a.seconds for a in manifest.artifacts.values() if a.seconds is not None)
    cache_bytes = sum(f.bytes for a in manifest.artifacts.values() for f in a.files)
    return seconds, cache_bytes


def ingest_run(
    run_dir: Path,
    cache_root: Path | None = None,
    iterations: Sequence[int] | None = None,
    on_progress: Callable[[Progress], None] | None = None,
) -> Manifest:
    """Ingest a run's first and last parameter ensemble iterations into the
    cache: both iterations' ensembles and summaries, the control tables,
    the grid and ``config.json``, each read and written in a process of its
    own.

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

    planned = plan_artifacts(run, layout, iterations=selected)
    first_iteration = selected[0] if selected else None

    # Resolved once, ahead of the artifact loop -- every selected iteration
    # shares the same grid and the same group-to-cell mapping.
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

    total = len(planned)
    seen_paths: dict[Path, str] = {}

    for index, artifact in enumerate(planned):
        output_paths = [Path(p) for p in artifact.outputs]
        collision_path = next((p for p in output_paths if p in seen_paths), None)
        if collision_path is not None:
            # A name collision would let one artifact silently overwrite
            # another's file (T-04-12) -- refuse the second one by name
            # rather than let that happen.
            reason = (
                f"{artifact.name} would write to {collision_path}, the same output "
                f"path {seen_paths[collision_path]} already claims in this ingest -- "
                f"refusing rather than letting one artifact silently overwrite "
                f"the other"
            )
            manifest.mark_failed(artifact.name, reason, sources=[])
            manifest.save(layout)
            if on_progress is not None:
                on_progress(
                    Progress(
                        artifact=artifact.name,
                        state="failed",
                        index=index,
                        total=total,
                        source_bytes=artifact.source_bytes,
                        written_bytes=0,
                        seconds=0.0,
                        reason=reason,
                    )
                )
            continue
        for output_path in output_paths:
            seen_paths[output_path] = artifact.name

        if not _should_retry(manifest, artifact.name, run_dir):
            existing = manifest.artifacts[artifact.name]
            if on_progress is not None:
                on_progress(
                    Progress(
                        artifact=artifact.name,
                        state="skipped",
                        index=index,
                        total=total,
                        source_bytes=artifact.source_bytes,
                        written_bytes=0,
                        seconds=0.0,
                        reason=existing.reason,
                    )
                )
            continue

        if on_progress is not None:
            on_progress(
                Progress(
                    artifact=artifact.name,
                    state="started",
                    index=index,
                    total=total,
                    source_bytes=artifact.source_bytes,
                    written_bytes=0,
                    seconds=0.0,
                )
            )

        worker_fn, worker_args = _dispatch(
            artifact,
            str(run_dir),
            str(run.pst_path),
            str(layout.root),
            mappable,
            cells_payload,
            cell_note,
            grid_path,
            first_iteration,
        )

        start = time.perf_counter()
        ok, result = _run_isolated(worker_fn, *worker_args)
        seconds = time.perf_counter() - start

        sources = _fingerprint_sources(artifact.sources)

        if ok and isinstance(result, WrittenArtifact):
            written_bytes = sum(f.bytes for f in result.files)
            manifest.mark_ok(artifact.name, sources, files=result.files, seconds=seconds)
            manifest.save(layout)
            state = "ok"
            reason = None
        else:
            written_bytes = 0
            if isinstance(result, ReadFailure):
                reason = result.reason
            else:
                reason = _reason_for(
                    artifact.name, artifact.sources[0] if artifact.sources else "", result
                )
            manifest.mark_failed(artifact.name, reason, sources=sources, seconds=seconds)
            manifest.save(layout)
            state = "failed"

        if on_progress is not None:
            on_progress(
                Progress(
                    artifact=artifact.name,
                    state=state,
                    index=index,
                    total=total,
                    source_bytes=artifact.source_bytes,
                    written_bytes=written_bytes,
                    seconds=seconds,
                    reason=reason,
                )
            )

    manifest.ingest_seconds, manifest.cache_bytes = _manifest_totals(manifest)
    manifest.save(layout)

    return manifest
