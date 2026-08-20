"""Turn one call into a whole run's cache: plan every artifact, run each in
a process created just for it, skip what is already fresh, and let a caller
cancel or ask the size first.

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
from typing import Callable, Protocol, Sequence, runtime_checkable

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
    notes: tuple[str, ...] = ()


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
class BytesEstimate:
    """How large a cache will be, before any of it is written.

    ``per_artifact`` names every artifact this estimate could size;
    ``notes`` names every one it could not, and why -- an artifact left out
    of ``total`` is never silently folded into it as zero.
    """

    total: int
    per_artifact: tuple[tuple[str, int], ...]
    notes: tuple[str, ...]


@runtime_checkable
class CancelSignal(Protocol):
    """Anything :func:`ingest_run`'s ``cancel`` argument can be: whatever
    has an ``is_set() -> bool``. A ``threading.Event`` satisfies this
    without pesto inventing a type of its own."""

    def is_set(self) -> bool: ...


@dataclass(frozen=True)
class _RealNamesOnly:
    """The one field :func:`build_config` reads off ``first`` -- built from
    the realization index the ``par_ens`` worker already wrote, never from
    an ``EnsembleData`` crossing the process boundary."""

    real_names: tuple[str, ...]


def _exit_code_of(pool: ProcessPoolExecutor) -> int | None:
    """The first dead worker's exit code this pool still holds, or ``None``
    for every way that cannot be answered.

    ``concurrent.futures`` exposes no public API for a dead worker's exit
    code, and it is the only way ``_reason_for`` can tell a worker killed by
    a signal from one that died for any other reason -- two different facts
    to a scientist reading a failed ingest -- so the private ``_processes``
    attribute stays. This function contains both ways reading it can go
    wrong. The process mapping is copied into a ``list`` before iterating,
    so a dict the executor's own management thread is concurrently mutating
    while tearing the broken pool down cannot raise mid-iteration. And the
    whole body is wrapped in a bare ``except``, because this call runs
    inside ``_run_isolated``'s own ``except`` handler, where a second
    exception has nothing left to catch it -- an ``AttributeError`` from a
    future CPython renaming or removing ``_processes`` would otherwise
    propagate out of ``_run_isolated``, out of ``ingest_run``'s loop, and
    end the whole ingest. Returning ``None`` costs a less specific reason
    string in ``_reason_for``; raising would cost every artifact that had
    not run yet.
    """
    try:
        for proc in list(pool._processes.values()):
            if proc.exitcode is not None:
                return proc.exitcode
        return None
    except Exception:
        return None


def _run_isolated(fn, *args):
    """Run ``fn(*args)`` in a process created for this one call and torn
    down after it, so a hard crash in a C extension cannot reach any other
    artifact.

    Returns ``(ok, result_or_exception)``. Catching bare ``Exception``
    around ``future.result()`` covers ``BrokenProcessPool`` too, raised
    when a worker dies without raising anything itself.

    When the exception is a ``BrokenProcessPool``, the dead worker's exit
    code is read through :func:`_exit_code_of` and attached to the
    exception as ``exitcode``, before the ``with`` block tears the pool
    down. The call is wrapped a second time here, on top of
    ``_exit_code_of``'s own containment: this is the one place in the
    whole ingest where a second failure has nothing left to catch it, so
    the guard belongs at both the callee and the call site rather than
    trusting either alone.
    """
    with ProcessPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fn, *args)
        try:
            return True, future.result()
        except Exception as exc:
            if isinstance(exc, BrokenProcessPool):
                try:
                    exc.exitcode = _exit_code_of(pool)
                except Exception:
                    exc.exitcode = None
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


# Ratios below turn a source file's own size into a rough estimate of the
# artifact it will produce, calibrated against four real benchmark runs
# (measured, not guessed) rather than re-derived per estimate. Each is a
# deliberately rough proxy -- estimate_bytes opens no file, so it can never
# know an ensemble's real realization/parameter counts ahead of ingest,
# only the bytes its source occupies on disk.
_PAR_ENS_SOURCE_RATIO = 0.26
"""Measured across three real ``.jcb`` ensembles: the cache's float32
two-block payload (4 bytes/value) against the modern sparse-COO dialect's
own on-disk size (row index + column index + float64 value, 16 bytes per
populated entry, plus name tables) lands at 0.258-0.259 of the source size
-- consistently, because a densely populated JCB file's own overhead is a
fixed multiple of the payload it carries. Above 100,000 parameters pestpp
writes hash-ordered JCB by default (PROJECT.md), so this is the ratio that
matters for the runs this estimate exists for. A dense ``.bin`` source (half
the JCB overhead per value) is measured at 0.513 instead -- this estimate
runs roughly 2x high for that dialect, a known, accepted gap: ``sniff()``
would have to open the file to tell the two apart, which this function may
never do."""

_PAR_AGG_SOURCE_RATIO = 0.012
"""Measured across four real ensembles: a per-parameter summary table (a
handful of float32/float64 columns per parameter, parquet-compressed) lands
between 0.008 and 0.016 of its ensemble's own source size. 0.012 is the
midpoint -- there is no single source-only signal that narrows this
further."""

_GRID_SOURCE_RATIO = 0.06
"""Measured across three real grid files: the mesh's three binaries plus
its JSON sidecar land between 0.047 and 0.089 of the binary grid file's own
size. 0.06 sits inside that measured range."""

_CONFIG_BYTES = 1024
"""``config.json`` measured 620-696 bytes across four real runs -- a small,
roughly fixed-size fact sheet whose size does not scale with the run, so a
flat, slightly generous estimate stands in for a ratio against any source
file."""


def estimate_bytes(
    run: RunLayout, iterations: Sequence[int] | None = None
) -> BytesEstimate:
    """How large the cache will be, before any of it is written.

    Every figure comes from ``Path.stat()`` on a source file -- this
    function opens no file's contents and creates no directory, because it
    is meant to be shown to a user before they have agreed to anything.
    Each ensemble artifact is sized from its own source file's size with
    ``_PAR_ENS_SOURCE_RATIO``; the summary and grid artifacts are sized from
    the same source sizes with their own stated ratios above.

    ``control`` is always left out of ``total`` and named in ``notes``
    instead of estimated: a real ``PstFrom``-style control file keeps its
    parameter and observation data in external CSVs the ``.pst`` file only
    references, so the ``.pst`` file's own size -- 1-2 KB whether the run
    has six parameters or six hundred thousand -- carries no usable signal
    about the control tables' eventual size. Measured against four real
    runs, that gap would have been between 3,800x and 21,800x had a ratio
    been guessed anyway -- naming the artifact honestly is what "leave it
    out and say so, rather than guess" (D-09's own rule) means in practice.

    This function's own tolerance, checked by the slow benchmark test in
    ``tests/ingest/test_runner.py``, is that ``total`` lands within 50% of
    the cache the same run actually produces for a run whose ensembles are
    the modern sparse-COO dialect -- generous, because every ratio above is
    a rough proxy measured across a handful of real runs, not a formula.
    """
    if iterations is None:
        numbered = [k for k in run.par_ens if isinstance(k, int)]
        selected = _select_iterations(numbered)
    else:
        selected = list(iterations)

    per_artifact: list[tuple[str, int]] = []
    notes: list[str] = []
    total = 0

    for iteration in selected:
        source = run.par_ens.get(iteration)
        if source is None:
            notes.append(f"par_ens/{iteration}: no source ensemble file found to size from")
            continue
        try:
            source_bytes = source.stat().st_size
        except OSError as exc:
            notes.append(f"par_ens/{iteration}: could not stat {source.name}: {exc}")
            continue
        ens_bytes = int(source_bytes * _PAR_ENS_SOURCE_RATIO)
        per_artifact.append((f"par_ens/{iteration}", ens_bytes))
        total += ens_bytes
        agg_bytes = int(source_bytes * _PAR_AGG_SOURCE_RATIO)
        per_artifact.append((f"par_agg/{iteration}", agg_bytes))
        total += agg_bytes

    if run.pst_path.exists():
        notes.append(
            "control: a PstFrom-style .pst file's own size carries no usable signal "
            "about its external parameter/observation tables -- excluded rather than "
            "guessed"
        )
    else:
        notes.append(f"control: could not stat {run.pst_path.name}: file not found")

    if run.grid is not None:
        try:
            grid_source_bytes = run.grid.stat().st_size
        except OSError as exc:
            notes.append(f"grid: could not stat {run.grid.name}: {exc}")
        else:
            grid_bytes = int(grid_source_bytes * _GRID_SOURCE_RATIO)
            per_artifact.append(("grid", grid_bytes))
            total += grid_bytes

    per_artifact.append(("config", _CONFIG_BYTES))
    total += _CONFIG_BYTES

    return BytesEstimate(total=total, per_artifact=tuple(per_artifact), notes=tuple(notes))


def _fingerprint_sources(
    sources: Sequence[str],
) -> tuple[list[SourceFingerprint], tuple[str, ...]]:
    """Fingerprint every source path this artifact depends on, reporting
    which ones could not be fingerprinted rather than silently returning a
    shorter list.

    Recording fewer sources than an artifact depends on is worse than
    failing it: ``is_stale`` only ever checks the sources actually
    recorded, so a source dropped here can never again make the artifact
    stale, and a different file appearing at that path later with
    different content would be invisible -- ``manifest.py``'s own rule is
    that freshness is a claim that must be provable. This function still
    never raises: the second element names one sentence per source that
    could not be fingerprinted, naming the path and what went wrong, and
    the caller decides what that costs the artifact.
    """
    fingerprints: list[SourceFingerprint] = []
    missing: list[str] = []
    for raw in sources:
        try:
            fingerprints.append(SourceFingerprint.of(Path(raw)))
        except OSError as exc:
            missing.append(f"{Path(raw).name} could not be fingerprinted: {exc}")
    return fingerprints, tuple(missing)


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
    cancel: "CancelSignal | None" = None,
) -> Manifest:
    """Ingest a run's first and last parameter ensemble iterations into the
    cache: both iterations' ensembles and summaries, the control tables,
    the grid and ``config.json``, each read and written in a process of its
    own.

    An interruption leaves finished artifacts recorded: the manifest is
    saved after every artifact, not once at the end. An artifact that is
    not stale -- its sources unchanged and its recorded cache files still
    the size they were written at -- is skipped before any worker starts.
    ``cancel``, when given, is checked at each artifact boundary, before a
    worker is started and never in the middle of one; on a set signal this
    function saves and returns the manifest as it stands, and because every
    finished artifact was already written atomically and recorded as it
    completed, a cancel needs no rollback. This function never asks a
    question and never blocks on one -- the size estimate and the
    free-space conversation belong to whichever caller has a user in front
    of it.
    """
    run = discover(run_dir)
    if cache_root is None:
        layout = for_run(run_dir)
    else:
        layout = CacheLayout(root=Path(cache_root))
    layout.ensure()
    manifest = Manifest.load(layout)
    # A freshly loaded manifest's own run_dir may be stale or empty (a first
    # ingest has no manifest.json to load run_dir from at all) -- is_stale
    # resolves every recorded source against self.run_dir, so this call's
    # own run_dir is the one fact that must always be current here.
    manifest.run_dir = str(run_dir)

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
        if cancel is not None and cancel.is_set():
            break

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

        existing = manifest.artifacts.get(artifact.name)
        declined_retry = not _should_retry(manifest, artifact.name, run_dir)
        fresh = (not declined_retry) and (not manifest.is_stale(artifact.name, layout))
        if declined_retry or fresh:
            written_bytes = sum(f.bytes for f in existing.files) if existing is not None else 0
            if on_progress is not None:
                on_progress(
                    Progress(
                        artifact=artifact.name,
                        state="skipped",
                        index=index,
                        total=total,
                        source_bytes=artifact.source_bytes,
                        written_bytes=written_bytes,
                        seconds=0.0,
                        reason=existing.reason if existing is not None else None,
                        notes=existing.notes if existing is not None else (),
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

        sources, unfingerprinted = _fingerprint_sources(artifact.sources)

        notes: tuple[str, ...] = ()
        if ok and isinstance(result, WrittenArtifact) and not unfingerprinted:
            written_bytes = sum(f.bytes for f in result.files)
            notes = result.notes
            manifest.mark_ok(
                artifact.name, sources, files=result.files, seconds=seconds, notes=notes
            )
            manifest.save(layout)
            state = "ok"
            reason = None
        elif ok and isinstance(result, WrittenArtifact):
            # The worker succeeded and its cache files are complete and
            # correct, but a source it depends on could no longer be
            # fingerprinted afterwards -- this ingest cannot prove the
            # artifact fresh, so it is failed by name rather than recorded
            # ok against a source list that has quietly shrunk. The files
            # the worker wrote are not deleted: they are good, and a later
            # successful run overwrites them.
            written_bytes = 0
            reason = (
                f"{artifact.name}: the worker read its source and returned a result, "
                f"but {'; '.join(unfingerprinted)}, so this ingest cannot prove the "
                f"artifact fresh"
            )
            manifest.mark_failed(artifact.name, reason, sources=sources, seconds=seconds)
            manifest.save(layout)
            state = "failed"
        else:
            written_bytes = 0
            if isinstance(result, ReadFailure):
                reason = result.reason
            else:
                reason = _reason_for(
                    artifact.name, artifact.sources[0] if artifact.sources else "", result
                )
            if unfingerprinted:
                reason = f"{reason}; also, {'; '.join(unfingerprinted)}"
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
                    notes=notes,
                )
            )

    manifest.ingest_seconds, manifest.cache_bytes = _manifest_totals(manifest)
    manifest.save(layout)

    return manifest
