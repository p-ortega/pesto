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

import pandas as pd

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
from pesto.ingest.obsagg import write_noise_agg, write_obs_agg
from pesto.ingest.obscell import write_obs_cell
from pesto.ingest.obsens import write_obs_ensemble
from pesto.ingest.obsindex import IDENTITY_COLUMNS, build_obs_index, load_obs_index, write_obs_index
from pesto.ingest.obspdc import FIRST_ITERATION, compute_pdc, read_pdc_file, write_pdc
from pesto.ingest.obsread import read_obs_file
from pesto.ingest.obsweights import read_adjusted_weights
from pesto.ingest.parcell import load_par_cell, write_par_cell
from pesto.ingest.parview import write_par_change, write_par_groups
from pesto.ingest.phicheck import check_phi, write_phi_check
from pesto.ingest.tables import load_control_table, load_control_tables, write_control

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
    # "control" | "grid" | "par_cell" | "obs_index" | "obs_cell" | "noise_agg" | "par_ens"
    # | "par_agg" | "par_change" | "par_groups" | "obs_ens" | "obs_agg" | "pdc" | "phi_check"
    # | "pp_factors" | "config"
    kind: str
    sources: tuple[str, ...]
    outputs: tuple[str, ...]
    source_bytes: int
    # Names of artifacts this one is built from; it runs only when each is ok.
    needs: tuple[str, ...] = ()


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


def _control_tables_for(cache_root: str):
    """The cached control table every worker but ``control`` starts from, with
    its observation table as column schema only (``ObsSchemaOnly``, which
    raises on any row access): no worker here reads observation rows, and the
    table can hold millions of them."""
    layout = CacheLayout(root=Path(cache_root))
    return layout, load_control_tables(layout, obs="schema")


def _write_par_ens(
    source: str,
    cache_root: str,
    iteration: int,
    cell_note: str | None = None,
) -> "WrittenArtifact | ReadFailure":
    """The worker: reads the untrusted ensemble file against the cached
    control table, then writes the cache artifact. This function runs only
    inside a process created for it -- the parent process must never parse a
    run file itself. Only picklable primitives may cross the boundary in or
    out.

    ``cell_note``, when the parent gives one, says why there is no cell
    resolution; the map block is then empty and the note is kept. Otherwise
    the placed groups come from the cached ``par_cell`` artifact.
    """
    layout, tables = _control_tables_for(cache_root)
    if isinstance(tables, ReadFailure):
        return tables
    data = read_ensemble(Path(source), tables)
    if isinstance(data, ReadFailure):
        return data

    mappable: list[str] = []
    if cell_note is None:
        placed = load_par_cell(layout)
        if isinstance(placed, ReadFailure):
            cell_note = f"cell resolution failed, so the map block is empty: {placed.reason}"
        elif placed.parnme != tuple(str(n) for n in tables.par["parnme"]):
            cell_note = (
                "cell resolution failed, so the map block is empty: par_cell names "
                "do not match the cached control table"
            )
        else:
            mappable = sorted(placed.placed_groups)
    if cell_note is not None:
        data = replace(data, notes=data.notes + (cell_note,))

    return write_par_ensemble(
        data,
        tables,
        mappable=frozenset(mappable),
        iteration=iteration,
        layout=layout,
    )


def _write_par_agg_artifact(
    source: str, cache_root: str, iteration: int
) -> "WrittenArtifact | ReadFailure":
    """The worker for one iteration's per-parameter summary: reads the
    ensemble file against the cached control table, independently of the
    ensemble worker, and writes ``agg/par_{iteration}.parquet``."""
    layout, tables = _control_tables_for(cache_root)
    if isinstance(tables, ReadFailure):
        return tables
    data = read_ensemble(Path(source), tables)
    if isinstance(data, ReadFailure):
        return data
    return write_par_agg(data, tables, iteration, layout)


def _write_par_change_artifact(
    cache_root: str, first: int, last: int
) -> "WrittenArtifact | ReadFailure":
    """The worker for the per-parameter change between the first and last
    iteration: reads both cached ensembles, never the source files."""
    return write_par_change(first, last, CacheLayout(root=Path(cache_root)))


def _write_par_groups_artifact(
    run_dir: str, cache_root: str
) -> "WrittenArtifact | ReadFailure":
    """The worker for the per-group summary: reads ``par_change``, the control
    table, ``par_cell`` when it is there and the last iteration's pcs file."""
    return write_par_groups(Path(run_dir), CacheLayout(root=Path(cache_root)))


def _write_control_artifact(pst_path: str, cache_root: str) -> "WrittenArtifact | ReadFailure":
    """The worker for the ``control`` artifact: reads the control file and
    writes its parameter and observation tables into the cache."""
    tables = read_control(Path(pst_path))
    if isinstance(tables, ReadFailure):
        return tables
    layout = CacheLayout(root=Path(cache_root))
    return write_control(tables, layout)


def _write_par_cell_artifact(grid_path: str, cache_root: str) -> "WrittenArtifact | ReadFailure":
    """The worker for the ``par_cell`` artifact: resolves which cell each
    parameter sits on from the cached control table, never from the control
    file, and writes ``grid/par_cell.parquet`` and its sidecar."""
    layout, tables = _control_tables_for(cache_root)
    if isinstance(tables, ReadFailure):
        return tables
    # The cached table lost its index; the resolver reads names off the index.
    par = tables.par.set_index("parnme", drop=False)
    # Deferred import: nothing under pesto.ingest may name pesto.model at
    # module level (test_no_ingest_file_imports_anything_from_model).
    from pesto.model.mf6 import Mf6Adapter

    cells = Mf6Adapter(Path(grid_path)).locate_par(par)
    if isinstance(cells, ReadFailure):
        return cells
    return write_par_cell(cells, tables.par, layout)


def _write_obs_index_artifact(cache_root: str) -> "WrittenArtifact | ReadFailure":
    """The worker for the ``obs_index`` artifact: reads only the observation
    columns it needs from the cached control table (the table can hold
    millions of rows), then writes the seven index files under ``control/``."""
    layout = CacheLayout(root=Path(cache_root))
    loaded = load_control_table(
        layout,
        "obs",
        columns=["obsnme", "obgnme"],
        optional_columns=["obsval", "weight", "datetime", "time", *IDENTITY_COLUMNS],
    )
    if isinstance(loaded, ReadFailure):
        return loaded
    table, notes = loaded
    index = build_obs_index(table, notes)
    if isinstance(index, ReadFailure):
        return index
    return write_obs_index(index, layout)


def _write_obs_cell_artifact(
    grid_path: str, cache_root: str, run_dir: str
) -> "WrittenArtifact | ReadFailure":
    """The worker for the ``obs_cell`` artifact: places every site of the
    cached ``obs_index`` on the grid, from the control file's columns and then
    from the model's own observation input, and writes
    ``grid/obs_cell.parquet`` and its sidecar."""
    layout = CacheLayout(root=Path(cache_root))
    index = load_obs_index(layout)
    if isinstance(index, ReadFailure):
        return ReadFailure(
            name="obs_cell",
            path=index.path,
            reason=f"obs_cell: the obs_index could not be read: {index.reason}",
        )
    sites = index.sites
    # The adapter reads names off the index and group off obgnme; the
    # identity columns go in as read.
    table = pd.DataFrame({"obgnme": sites["group"].astype(str).to_numpy()})
    for column in IDENTITY_COLUMNS:
        if column in sites.columns:
            table[column] = sites[column].to_numpy()
    table.index = pd.Index(sites["site"].astype(str).to_numpy(), name="obsnme")
    # Deferred import: nothing under pesto.ingest may name pesto.model at
    # module level (test_no_ingest_file_imports_anything_from_model).
    from pesto.model import ObsCells
    from pesto.model.mf6 import Mf6Adapter, note_missing_observation_input, observation_input_files

    has_model_input = bool(observation_input_files(Path(run_dir)))
    if has_model_input:
        adapter = Mf6Adapter(Path(grid_path), model_dir=Path(run_dir))
    else:
        adapter = Mf6Adapter(Path(grid_path))
    cells = adapter.locate_obs(table)
    if isinstance(cells, ReadFailure):
        return cells
    if not has_model_input and isinstance(cells, ObsCells):
        cells = note_missing_observation_input(cells)
    return write_obs_cell(cells, sites, index.order_digest, layout)


def _write_obs_ens_artifact(
    source: str, cache_root: str, iteration: int
) -> "WrittenArtifact | ReadFailure":
    """The worker for one iteration's observation ensemble: reads the file
    through the memory guard against the cached control table's observation
    names, then stores it observation-major in the cached ``obs_index``
    order. Runs only inside a process created for it."""
    name = f"obs_ens/{iteration}"
    layout = CacheLayout(root=Path(cache_root))
    index = load_obs_index(layout)
    if isinstance(index, ReadFailure):
        return ReadFailure(
            name=name,
            path=index.path,
            reason=f"{name}: the obs_index could not be read: {index.reason}",
        )
    loaded = load_control_table(layout, "obs", columns=["obsnme"])
    if isinstance(loaded, ReadFailure):
        return ReadFailure(
            name=name, path=loaded.path, reason=f"{name}: the control table: {loaded.reason}"
        )
    table, _notes = loaded
    control_names = table.column("obsnme").to_pylist()
    data = read_obs_file(Path(source), control_names, artifact=name)
    if isinstance(data, ReadFailure):
        return data
    return write_obs_ensemble(data, index, iteration, layout)


def _write_obs_agg_artifact(
    cache_root: str, iteration: int
) -> "WrittenArtifact | ReadFailure":
    """The worker for one iteration's observation statistics: reads the
    cached ``obs_ens/K`` and ``obs_index``, never the source file."""
    return write_obs_agg(iteration, CacheLayout(root=Path(cache_root)))


def _write_noise_agg_artifact(source: str, cache_root: str) -> "WrittenArtifact | ReadFailure":
    """The worker for the noise band: reads the run's obs+noise file through
    the memory guard against the cached control table's observation names,
    then stores per-observation statistics without the base realization.
    Runs only inside a process created for it."""
    name = "noise_agg"
    layout = CacheLayout(root=Path(cache_root))
    index = load_obs_index(layout)
    if isinstance(index, ReadFailure):
        return ReadFailure(
            name=name,
            path=index.path,
            reason=f"{name}: the obs_index could not be read: {index.reason}",
        )
    loaded = load_control_table(layout, "obs", columns=["obsnme"])
    if isinstance(loaded, ReadFailure):
        return ReadFailure(
            name=name, path=loaded.path, reason=f"{name}: the control table: {loaded.reason}"
        )
    table, _notes = loaded
    control_names = table.column("obsnme").to_pylist()
    data = read_obs_file(Path(source), control_names, artifact=name)
    if isinstance(data, ReadFailure):
        return data
    return write_noise_agg(data, index, Path(source).name, layout)


def _write_pdc_artifact(
    cache_root: str, iteration: int, pdc_file: str | None, weights_file: str | None
) -> "WrittenArtifact | ReadFailure":
    """The worker for one iteration's prior-data conflict. With ``pdc_file``
    it reads pestpp's own file; without, it computes from the cached
    statistics, using the adjusted weights in ``weights_file`` when there is
    one. Which of the two is decided by the plan, never here."""
    name = f"pdc/{iteration}"
    layout = CacheLayout(root=Path(cache_root))
    index = load_obs_index(layout)
    if isinstance(index, ReadFailure):
        return ReadFailure(
            name=name,
            path=index.path,
            reason=f"{name}: the obs_index could not be read: {index.reason}",
        )
    loaded = load_control_table(layout, "obs", columns=["obsnme"])
    if isinstance(loaded, ReadFailure):
        return ReadFailure(
            name=name, path=loaded.path, reason=f"{name}: the control table: {loaded.reason}"
        )
    table, _notes = loaded
    control_names = table.column("obsnme").to_pylist()
    if pdc_file is not None:
        result = read_pdc_file(Path(pdc_file), index, control_names, artifact=name)
    else:
        weights = None
        if weights_file is not None:
            weights = read_adjusted_weights(Path(weights_file), control_names, artifact=name)
            if isinstance(weights, ReadFailure):
                return weights
        result = compute_pdc(iteration, layout, weights)
    if isinstance(result, ReadFailure):
        return result
    return write_pdc(result, iteration, layout)


def _write_phi_check_artifact(
    cache_root: str, iteration: int, phi_file: str, weights_file: str | None
) -> "WrittenArtifact | ReadFailure":
    """The worker for one iteration's phi check: recompute phi from the cached
    observation ensemble, using the adjusted weights in ``weights_file`` when
    the run has them, and compare it with ``phi_file`` by realization name."""
    name = f"phi_check/{iteration}"
    layout = CacheLayout(root=Path(cache_root))
    weights = None
    if weights_file is not None:
        loaded = load_control_table(layout, "obs", columns=["obsnme"])
        if isinstance(loaded, ReadFailure):
            return ReadFailure(
                name=name, path=loaded.path, reason=f"{name}: the control table: {loaded.reason}"
            )
        table, _notes = loaded
        weights = read_adjusted_weights(
            Path(weights_file), table.column("obsnme").to_pylist(), artifact=name
        )
        if isinstance(weights, ReadFailure):
            return weights
    result = check_phi(iteration, layout, Path(phi_file), weights)
    if isinstance(result, ReadFailure):
        return result
    return write_phi_check(result, iteration, layout)


def _write_grid_artifact(
    grid_path: str, cache_root: str
) -> "WrittenArtifact | ReadFailure | None":
    """The worker for the ``grid`` artifact -- the one that matters most for
    isolation, since it is the one that lets flopy parse the binary grid
    file. Constructs its own :class:`Mf6Adapter` so a malformed ``.grb``
    costs this artifact and never the parent."""
    # Deferred import: nothing under pesto.ingest may name pesto.model at
    # module level.
    from pesto.model.mf6 import Mf6Adapter

    layout = CacheLayout(root=Path(cache_root))
    adapter = Mf6Adapter(Path(grid_path))
    return write_grid_from_adapter(adapter, layout)


def _write_pp_factors_artifact(
    run_dir: str, grid_path: str | None, cache_root: str
) -> "WrittenArtifact | ReadFailure":
    """The worker for the pp_factors artifact: links every pilot-point
    group to its factor file and writes the index. Needs the grid's shape
    for the layer rule, so a run with no grid file records every group as
    not interpolable rather than guessing a layer count."""
    from pesto.ingest.ppfactors import PpIndex, build_pp_index, write_pp_index

    layout, tables = _control_tables_for(cache_root)
    if isinstance(tables, ReadFailure):
        return tables
    run = discover(Path(run_dir))
    par = tables.par.set_index("parnme") if "parnme" in tables.par.columns else tables.par
    if grid_path is None:
        index = PpIndex(
            groups=(),
            not_interpolable=tuple(
                (p.name, "no grid file, so no layer count to place factors against")
                for p in run.factor_files
            ),
        )
        return write_pp_index(index, layout)
    from pesto.model.mf6 import Mf6Adapter

    shape = Mf6Adapter(Path(grid_path)).grid_shape()
    if isinstance(shape, ReadFailure):
        return shape
    index = build_pp_index(Path(run_dir), run.mult2model, run.factor_files, par, shape)
    return write_pp_index(index, layout)


def _write_config_artifact(
    run_dir: str,
    cache_root: str,
    first_iteration: int | None,
) -> "WrittenArtifact | ReadFailure":
    """The worker for the ``config`` artifact: rediscovers the run from
    ``run_dir`` (a line scan, never a saved ``RunLayout`` crossing the
    boundary) and reads the cached control table. The first ingested
    iteration's realization names come from
    ``reals/par_{first_iteration}.reals.json``, which the ``par_ens`` worker
    already wrote -- not from an ``EnsembleData`` passed in, which would make
    ``config`` depend on a value held in the parent rather than on an
    artifact that has already succeeded. A grid file, when the run has one,
    is parsed again here through its own :class:`Mf6Adapter` for ``crs()`` --
    one more isolated parse of a small binary file, not a departure from
    this worker's own process boundary.
    """
    layout, tables = _control_tables_for(cache_root)
    if isinstance(tables, ReadFailure):
        return tables
    run = discover(Path(run_dir))

    first: _RealNamesOnly | None = None
    if first_iteration is not None:
        try:
            reals_data = json.loads(layout.par_reals(first_iteration).read_text())
            first = _RealNamesOnly(real_names=tuple(reals_data.get("names", [])))
        except (OSError, json.JSONDecodeError, TypeError, AttributeError):
            first = None

    adapter = None
    if run.grid is not None:
        # Deferred import: nothing under pesto.ingest may name pesto.model at
        # module level.
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


def observation_iterations(
    run: RunLayout, iterations: Sequence[int] | None = None
) -> tuple[list[int], tuple[str, ...]]:
    """Which iterations' observation ensembles one ingest of ``run`` reads,
    and a note for each of them that has no observation file.

    The same first and last iteration as the parameters (D-01): the given
    ``iterations`` when the caller passed any, else the parameter default
    when the run has a numbered parameter ensemble, else the first and last
    numbered observation file. A selected iteration with no observation
    file stays in the list so the note can name it; planning skips it.
    """
    if iterations is not None:
        selected = list(iterations)
    else:
        numbered_par = [k for k in run.par_ens if isinstance(k, int)]
        if numbered_par:
            selected = _select_iterations(numbered_par)
        else:
            selected = _select_iterations([k for k in run.obs_ens if isinstance(k, int)])
    notes = tuple(
        f"no observation ensemble file was found for iteration {k}"
        for k in selected
        if run.obs_ens.get(k) is None
    )
    return selected, notes


def _should_retry(manifest: Manifest, name: str, base: Path, sources: Sequence[str]) -> bool:
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

    So is a failed artifact whose recorded source names differ from the
    planned ``sources``, the rule ``Manifest.is_stale`` applies to ``ok``
    artifacts. A failure recorded before the plan listed a source (or one
    that could not fingerprint a missing file) would otherwise never be read
    again, because the sources it did record still match.
    """
    artifact = manifest.artifacts.get(name)
    if artifact is None or artifact.state != "failed":
        return True
    if not artifact.sources:
        return True
    if {s.path for s in artifact.sources} != {Path(s).name for s in sources}:
        return True
    return not all(source.matches(base) for source in artifact.sources)


def _stat_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _size_of(sources: Sequence[str]) -> int:
    return sum(_stat_size(Path(s)) for s in sources)


def _unique(sources: Sequence[str]) -> tuple[str, ...]:
    """``sources`` without repeats, in first-seen order."""
    return tuple(dict.fromkeys(sources))


def _plan_pdc(
    artifacts: list[PlannedArtifact],
    run: RunLayout,
    layout: CacheLayout,
    iteration: int,
    control_sources: tuple[str, ...],
) -> None:
    """Add ``pdc/K`` to the plan: a read of pestpp's file when it exists, a
    computation only when it does not, nothing when neither can be done."""
    how = pdc_source_for(run, iteration)
    if how == "none":
        return
    outputs = (str(layout.pdc(iteration)), str(layout.pdc_meta(iteration)))
    if how == "file":
        sources = _unique((str(run.pdc[iteration]), *control_sources))
        needs: tuple[str, ...] = ("obs_index",)
    else:
        # The same observation and noise files the statistics were built
        # from, so an edit to either makes this stale as well.
        # Iteration 0 is checked before pestpp adjusts any weight, so it never reads them.
        uses_weights = run.adjusted_weights is not None and iteration != FIRST_ITERATION
        weights = (str(run.adjusted_weights),) if uses_weights else ()
        sources = _unique(
            (str(run.obs_ens[iteration]), str(run.noise), *weights, *control_sources)
        )
        needs = ("obs_index", f"obs_agg/{iteration}", "noise_agg")
    artifacts.append(
        PlannedArtifact(
            name=f"pdc/{iteration}",
            kind="pdc",
            sources=sources,
            outputs=outputs,
            source_bytes=_size_of(sources),
            needs=needs,
        )
    )


def _plan_phi_check(
    artifacts: list[PlannedArtifact],
    run: RunLayout,
    layout: CacheLayout,
    iteration: int,
    control_sources: tuple[str, ...],
) -> None:
    """Add ``phi_check/K`` to the plan when the run has ``case.phi.actual.csv``.
    It reads the cached observation ensemble for K, so it needs ``obs_ens/K``."""
    phi_file = run.phi.get("actual")
    if phi_file is None:
        return
    weights = (str(run.adjusted_weights),) if run.adjusted_weights is not None else ()
    sources = _unique((str(run.obs_ens[iteration]), str(phi_file), *weights, *control_sources))
    artifacts.append(
        PlannedArtifact(
            name=f"phi_check/{iteration}",
            kind="phi_check",
            sources=sources,
            outputs=(str(layout.phi_check(iteration)),),
            source_bytes=_size_of(sources),
            needs=("obs_index", f"obs_ens/{iteration}"),
        )
    )


def pdc_source_for(run: RunLayout, iteration: int) -> str:
    """How ``pdc/K`` would be made: ``"file"`` when pestpp wrote
    ``case.K.pdc.csv`` (it is read, never recomputed), ``"computed"`` only
    when that file is absent and both an observation ensemble for K and an
    obs+noise file exist, else ``"none"``."""
    if run.pdc.get(iteration) is not None:
        return "file"
    if run.noise is not None and run.obs_ens.get(iteration) is not None:
        return "computed"
    return "none"


def _pdc_inputs(run: RunLayout, iteration: int) -> tuple[str | None, str | None]:
    """The pdc file and the adjusted weights file a worker is handed: the
    file when pestpp wrote one (no weights needed), else the weights file
    when the run has one and the iteration is after the first."""
    pdc_file = run.pdc.get(iteration)
    if pdc_file is not None:
        return str(pdc_file), None
    weights = run.adjusted_weights
    if weights is None or iteration == FIRST_ITERATION:
        return None, None
    return None, str(weights)


def _plan_par_view(
    artifacts: list[PlannedArtifact],
    run: RunLayout,
    layout: CacheLayout,
    selected: Sequence[int],
    control_sources: tuple[str, ...],
) -> None:
    """Plan ``par_change`` and then ``par_groups`` after the parameter
    ensembles, or nothing when no parameter ensemble was planned.

    ``par_groups`` lists both ensemble files as well, so a rewritten ensemble
    makes it stale along with the change table it is built from."""
    planned = sorted({k for k in selected if run.par_ens.get(k) is not None})
    if not planned:
        return
    first, last = planned[0], planned[-1]
    ensembles = _unique((str(run.par_ens[first]), str(run.par_ens[last])))
    change_sources = _unique((*ensembles, *control_sources))
    artifacts.append(
        PlannedArtifact(
            name="par_change",
            kind="par_change",
            sources=change_sources,
            outputs=(str(layout.par_change), str(layout.par_change_meta)),
            source_bytes=_size_of(change_sources),
            needs=tuple(f"par_ens/{k}" for k in dict.fromkeys((first, last))),
        )
    )
    extras = list(ensembles)
    if run.grid is not None:
        extras.append(str(run.grid))
    pcs = run.pcs_file(last)
    if pcs is not None:
        extras.append(str(pcs))
    group_sources = _unique((*control_sources, *extras))
    artifacts.append(
        PlannedArtifact(
            name="par_groups",
            kind="par_groups",
            sources=group_sources,
            outputs=(str(layout.par_groups),),
            source_bytes=_size_of(group_sources),
            needs=("par_change",),
        )
    )


def plan_artifacts(
    run: RunLayout, layout: CacheLayout, iterations: Sequence[int] | None = None
) -> tuple[PlannedArtifact, ...]:
    """The whole, deterministically ordered list of artifacts one ingest of
    ``run`` will attempt: ``control`` first, so every later worker can read
    its cached tables; then ``grid`` and ``par_cell`` when a grid file
    exists; then ``obs_index``, which needs the control table only; then
    ``obs_cell`` when a grid file exists, which needs ``obs_index``; then
    ``noise_agg`` when the run has an obs+noise file (never a starting
    observation ensemble), which needs ``obs_index``; then an
    ensemble and a summary for each selected iteration in
    ascending order, ensemble before summary; then ``par_change`` (the
    per-parameter change between the first and last iteration, which needs
    both cached ensembles) and ``par_groups`` (the per-group summary, which
    needs ``par_change``) when a parameter ensemble is planned; then an observation ensemble
    for each iteration :func:`observation_iterations` selects that has an
    observation file, each followed by that iteration's ``pdc/K``: a read of
    pestpp's own ``case.K.pdc.csv`` when it exists, a computation from the
    cached statistics only when it does not and an obs+noise file exists,
    and nothing when neither is possible, then ``phi_check/K`` when the run
    has ``case.phi.actual.csv``; then ``pp_factors`` when the
    run carries pilot-point files; then ``config``. A caller watching rows
    go past sees the same sequence every time this is called for the same
    run and layout.

    ``iterations`` defaults to the first and last numbered iteration,
    exactly as :func:`ingest_run` has always chosen them. When ``noptmax``
    is zero or negative, or the run holds only one iteration, the first and
    last iteration are the same one and it is planned once -- two artifacts
    writing the same file would be a collision the runner already refuses,
    and re-reading the file to write the same bytes twice is time spent for
    nothing.

    Each artifact names the source files it depends on. Call the control
    file followed by every table it names in an external section the control
    sources: ``control`` lists exactly those, ``grid`` the grid file alone,
    ``par_cell`` the control sources and the grid file, ``obs_index`` the
    control sources alone, ``obs_cell`` the control sources and the grid file, a summary that
    iteration's ensemble file and then the control sources, an ensemble the
    same and, when one exists, the grid file too, an observation ensemble its
    observation file and then the control sources, ``par_change`` both ensemble
    files and then the control sources, ``par_groups`` the control sources, both
    ensemble files, the grid file and the last iteration's plain pcs file, each
    only when it exists, ``pp_factors`` its own
    files, the grid file and the control sources, and ``config`` the control
    sources and, when one exists, the grid file. A run with no grid file
    plans no ``grid``, no ``par_cell`` and no ``obs_cell`` artifact. No artifact lists a path
    twice.
    """
    if iterations is None:
        numbered = [k for k in run.par_ens if isinstance(k, int)]
        selected = _select_iterations(numbered)
    else:
        selected = list(iterations)

    pst_path = run.pst_path
    grid_path = run.grid
    # The control file first (workers and failure messages name sources[0]),
    # then every table it names in an external section. Every artifact built
    # from the control table lists all of them.
    control_sources = _unique((str(pst_path), *(str(p) for p in run.external_tables)))

    artifacts: list[PlannedArtifact] = [
        PlannedArtifact(
            name="control",
            kind="control",
            sources=control_sources,
            outputs=(
                str(layout.control / "par.parquet"),
                str(layout.control / "obs.parquet"),
                str(layout.control / "notes.json"),
            ),
            source_bytes=_size_of(control_sources),
        )
    ]

    if grid_path is not None:
        grid_bytes = _stat_size(grid_path)
        par_cell_sources = _unique((*control_sources, str(grid_path)))
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
        artifacts.append(
            PlannedArtifact(
                name="par_cell",
                kind="par_cell",
                sources=par_cell_sources,
                outputs=(
                    str(layout.grid / "par_cell.parquet"),
                    str(layout.grid / "par_cell.json"),
                ),
                source_bytes=_size_of(par_cell_sources),
            )
        )
        config_sources = par_cell_sources
    else:
        config_sources = control_sources

    # Needs the control table only, so a grid edit never touches it.
    artifacts.append(
        PlannedArtifact(
            name="obs_index",
            kind="obs_index",
            sources=control_sources,
            outputs=(
                str(layout.obs_order),
                str(layout.obs_time),
                str(layout.obs_value),
                str(layout.obs_flags),
                str(layout.obs_sites),
                str(layout.obs_groups),
                str(layout.obs_index_meta),
            ),
            source_bytes=_size_of(control_sources),
        )
    )

    if grid_path is not None:
        # Deferred import: nothing under pesto.ingest may name pesto.model at
        # module level (test_no_ingest_file_imports_anything_from_model).
        from pesto.model.mf6 import observation_input_files

        # Kept apart from the ensembles: a grid edit makes only this stale.
        model_input = tuple(str(p) for p in observation_input_files(run.run_dir))
        obs_cell_sources = _unique((*control_sources, str(grid_path), *model_input))
        artifacts.append(
            PlannedArtifact(
                name="obs_cell",
                kind="obs_cell",
                sources=obs_cell_sources,
                outputs=(
                    str(layout.obs_cell),
                    str(layout.obs_cell_meta),
                ),
                source_bytes=_size_of(obs_cell_sources),
                needs=("obs_index",),
            )
        )

    if run.noise is not None:
        # Only the obs+noise file pestpp used; a starting observation
        # ensemble is never the noise band.
        noise_sources = _unique((str(run.noise), *control_sources))
        artifacts.append(
            PlannedArtifact(
                name="noise_agg",
                kind="noise_agg",
                sources=noise_sources,
                outputs=(
                    str(layout.noise_agg),
                    str(layout.noise_agg_meta),
                ),
                source_bytes=_size_of(noise_sources),
                needs=("obs_index",),
            )
        )

    for iteration in selected:
        source = run.par_ens.get(iteration)
        if source is None:
            continue
        # _dispatch reads the ensemble file from sources[0].
        sources = _unique((str(source), *control_sources))
        # The map block follows the grid, so an edited grid must make the
        # ensemble stale too; the summary never looks at cells.
        ens_sources = _unique(sources + ((str(grid_path),) if grid_path is not None else ()))
        artifacts.append(
            PlannedArtifact(
                name=f"par_ens/{iteration}",
                kind="par_ens",
                sources=ens_sources,
                outputs=(str(layout.par_ens(iteration)),),
                source_bytes=_size_of(ens_sources),
            )
        )
        artifacts.append(
            PlannedArtifact(
                name=f"par_agg/{iteration}",
                kind="par_agg",
                sources=sources,
                outputs=(str(layout.par_agg(iteration)),),
                source_bytes=_size_of(sources),
            )
        )

    _plan_par_view(artifacts, run, layout, selected, control_sources)

    obs_selected, _obs_notes = observation_iterations(run, iterations)
    for iteration in obs_selected:
        obs_source = run.obs_ens.get(iteration)
        if obs_source is None:
            _plan_pdc(artifacts, run, layout, iteration, control_sources)
            continue
        # _dispatch reads the observation file from sources[0]; the file is
        # hashed once here and reused by later artifacts that list it.
        obs_sources = _unique((str(obs_source), *control_sources))
        artifacts.append(
            PlannedArtifact(
                name=f"obs_ens/{iteration}",
                kind="obs_ens",
                sources=obs_sources,
                outputs=(
                    str(layout.obs_ens(iteration)),
                    str(layout.obs_ens_meta(iteration)),
                    str(layout.obs_reals(iteration)),
                ),
                source_bytes=_size_of(obs_sources),
                needs=("obs_index",),
            )
        )
        # Lists the same observation file so both go stale together; it reads
        # the cached ensemble, and takes its fingerprint from obs_ens.
        artifacts.append(
            PlannedArtifact(
                name=f"obs_agg/{iteration}",
                kind="obs_agg",
                sources=obs_sources,
                outputs=(
                    str(layout.obs_agg(iteration)),
                    str(layout.obs_agg_meta(iteration)),
                ),
                source_bytes=_size_of(obs_sources),
                needs=("obs_index", f"obs_ens/{iteration}"),
            )
        )
        _plan_pdc(artifacts, run, layout, iteration, control_sources)
        _plan_phi_check(artifacts, run, layout, iteration, control_sources)

    pp_sources = [str(p) for p in run.factor_files]
    if run.mult2model is not None:
        pp_sources.insert(0, str(run.mult2model))
    if pp_sources:
        # The index also reads templates, point files and the grid, so an
        # edit to any of them must mark it stale too.
        pp_sources.extend(str(p) for p in sorted(run.run_dir.glob("*.tpl")))
        pp_sources.extend(str(p) for p in sorted(run.run_dir.glob("ppoints.*.csv")))
        if grid_path is not None:
            pp_sources.append(str(grid_path))
        pp_sources.extend(control_sources)
        pp_sources_final = _unique(pp_sources)
        artifacts.append(
            PlannedArtifact(
                name="pp_factors",
                kind="pp_factors",
                sources=pp_sources_final,
                outputs=(str(layout.pp_index),),
                source_bytes=_size_of(pp_sources_final),
            )
        )

    artifacts.append(
        PlannedArtifact(
            name="config",
            kind="config",
            sources=config_sources,
            outputs=(str(layout.config),),
            source_bytes=_size_of(config_sources),
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
the JCB overhead per value) is measured at 0.513 instead -- applying this
constant to a dense source's size yields roughly *half* the cache that
source actually produces, so the estimate under-states for that dialect,
it does not over-state. Because 0.26/0.513 is about 0.51, a dense-format
run sits almost exactly on the ±50% tolerance ``estimate_bytes`` states for
itself, and on the optimistic side of it: a scientist could be shown
roughly half the disk the ingest will actually need. That is the dangerous
direction, because this is the one figure in this phase shown to someone
before they agree to the ingest -- an under-estimate costs them a run that
runs out of disk partway through, where an over-estimate would only have
cost a few idle gigabytes. ``sniff()`` would have to open the file to tell
the two dialects apart, which this function may never do; see
``_DENSE_BIN_NOTE`` for how ``estimate_bytes`` names this gap instead."""

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

_OBS_ENS_SOURCE_RATIO = 0.26
"""Reuses the measured parameter ratio: an observation ensemble is float32
out of the same sparse-COO dialect, so the cache payload sits at the same
fraction of the source file. A dense ``.bin`` source errs low in the same
way (see ``_PAR_ENS_SOURCE_RATIO``)."""

_DENSE_BIN_NOTE = (
    "par_ens/par_agg/obs_ens: these figures assume the sparse-COO .jcb dialect -- a dense "
    ".bin ensemble produces roughly twice the cache this estimate reports, so the "
    "total is a floor for that dialect, not a midpoint"
)
"""Appended to ``estimate_bytes``' ``notes`` once, whenever at least one
ensemble artifact was sized -- named from this constant, not derived from
any file, so adding it costs no read. See ``_PAR_ENS_SOURCE_RATIO`` for the
arithmetic and why the optimistic direction is the one that matters here."""


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
    That tolerance is stated for the sparse-COO dialect specifically: for
    every call that sizes at least one ensemble artifact, ``notes`` also
    gains ``_DENSE_BIN_NOTE``, added from the constant rather than read from
    any file, naming a dense ``.bin`` source as a dialect this estimate
    cannot size reliably and the direction it errs in.
    """
    if iterations is None:
        numbered = [k for k in run.par_ens if isinstance(k, int)]
        selected = _select_iterations(numbered)
    else:
        selected = list(iterations)

    per_artifact: list[tuple[str, int]] = []
    notes: list[str] = []
    total = 0
    sized_an_ensemble = False

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
        sized_an_ensemble = True
        ens_bytes = int(source_bytes * _PAR_ENS_SOURCE_RATIO)
        per_artifact.append((f"par_ens/{iteration}", ens_bytes))
        total += ens_bytes
        agg_bytes = int(source_bytes * _PAR_AGG_SOURCE_RATIO)
        per_artifact.append((f"par_agg/{iteration}", agg_bytes))
        total += agg_bytes

    obs_selected, obs_notes = observation_iterations(run, iterations)
    notes.extend(f"obs_ens: {note}" for note in obs_notes)
    for iteration in obs_selected:
        obs_source = run.obs_ens.get(iteration)
        if obs_source is None:
            continue
        try:
            obs_source_bytes = obs_source.stat().st_size
        except OSError as exc:
            notes.append(f"obs_ens/{iteration}: could not stat {obs_source.name}: {exc}")
            continue
        sized_an_ensemble = True
        obs_bytes = int(obs_source_bytes * _OBS_ENS_SOURCE_RATIO)
        per_artifact.append((f"obs_ens/{iteration}", obs_bytes))
        total += obs_bytes

    if sized_an_ensemble:
        notes.append(_DENSE_BIN_NOTE)

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

    if run.grid is not None:
        notes.append(
            "par_cell: one row per parameter, whose size follows from the control table "
            "rather than from any source file's size -- excluded rather than guessed"
        )

    if run.grid is not None:
        notes.append(
            "obs_cell: one row per observation site, whose size follows the control table's "
            "site count rather than any source file's size -- excluded rather than guessed"
        )

    if any(planned.startswith("par_ens/") for planned, _ in per_artifact):
        notes.append(
            "par_change/par_groups: one row per parameter and one entry per group, whose size "
            "follows the parameter count rather than any source file's size -- excluded rather "
            "than guessed"
        )

    if any(run.obs_ens.get(k) is not None for k in obs_selected):
        notes.append(
            "obs_agg/K: statistics per observation, whose size follows the observation count "
            "rather than any source file's size -- excluded rather than guessed"
        )

    notes.append(
        "obs_index: a few files whose size follows the control table's observation count "
        "rather than any source file's size -- excluded rather than guessed"
    )

    if run.mult2model is not None or run.factor_files:
        notes.append(
            "pp_factors: a small index of pilot-point groups whose size does not follow "
            "from its source files' sizes -- excluded rather than guessed"
        )

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
    cell_note: str | None,
    grid_path: str | None,
    first_iteration: int | None,
    pdc_file: str | None = None,
    weights_file: str | None = None,
    phi_file: str | None = None,
) -> tuple[Callable, tuple]:
    """Which worker function runs this artifact, and with what arguments --
    every argument a string, an int, or ``None``, so nothing but picklable
    primitives crosses into the worker. Only ``control`` is handed the
    control file's path; every other worker reads the cached table."""
    if artifact.kind == "par_ens":
        iteration = int(artifact.name.split("/", 1)[1])
        return _write_par_ens, (artifact.sources[0], cache_root, iteration, cell_note)
    if artifact.kind == "par_agg":
        iteration = int(artifact.name.split("/", 1)[1])
        return _write_par_agg_artifact, (artifact.sources[0], cache_root, iteration)
    if artifact.kind == "par_change":
        # The planned needs name the iterations, "par_ens/F" then "par_ens/L".
        ends = [int(need.split("/", 1)[1]) for need in artifact.needs]
        return _write_par_change_artifact, (cache_root, ends[0], ends[-1])
    if artifact.kind == "par_groups":
        return _write_par_groups_artifact, (run_dir, cache_root)
    if artifact.kind == "obs_ens":
        iteration = int(artifact.name.split("/", 1)[1])
        return _write_obs_ens_artifact, (artifact.sources[0], cache_root, iteration)
    if artifact.kind == "obs_agg":
        iteration = int(artifact.name.split("/", 1)[1])
        return _write_obs_agg_artifact, (cache_root, iteration)
    if artifact.kind == "noise_agg":
        return _write_noise_agg_artifact, (artifact.sources[0], cache_root)
    if artifact.kind == "pdc":
        iteration = int(artifact.name.split("/", 1)[1])
        return _write_pdc_artifact, (cache_root, iteration, pdc_file, weights_file)
    if artifact.kind == "phi_check":
        iteration = int(artifact.name.split("/", 1)[1])
        return _write_phi_check_artifact, (cache_root, iteration, phi_file, weights_file)
    if artifact.kind == "control":
        return _write_control_artifact, (pst_path, cache_root)
    if artifact.kind == "grid":
        return _write_grid_artifact, (grid_path, cache_root)
    if artifact.kind == "par_cell":
        return _write_par_cell_artifact, (grid_path, cache_root)
    if artifact.kind == "obs_index":
        return _write_obs_index_artifact, (cache_root,)
    if artifact.kind == "obs_cell":
        return _write_obs_cell_artifact, (grid_path, cache_root, run_dir)
    if artifact.kind == "pp_factors":
        return _write_pp_factors_artifact, (run_dir, grid_path, cache_root)
    if artifact.kind == "config":
        return _write_config_artifact, (run_dir, cache_root, first_iteration)
    raise ValueError(f"plan_artifacts produced an artifact of unknown kind: {artifact.kind!r}")


# Artifacts whose worker reads the cached control table. ``grid`` reads only
# the grid file and ``control`` is the one that writes the table.
_CONTROL_DEPENDENTS = frozenset(
    {
        "par_cell",
        "obs_index",
        "obs_cell",
        "par_ens",
        "par_agg",
        "par_change",
        "par_groups",
        "obs_ens",
        "obs_agg",
        "noise_agg",
        "pdc",
        "phi_check",
        "pp_factors",
        "config",
    }
)


def _control_failure_reason(manifest: Manifest, name: str) -> str | None:
    """Why ``name`` cannot run: control is not recorded ok. ``None`` when
    control is fine, so the artifact may go ahead."""
    control = manifest.artifacts.get("control")
    if control is not None and control.state == "ok":
        return None
    why = control.reason if control is not None and control.reason else None
    return f"{name} depends on control, which failed: {why or 'it was not read in this ingest'}"


def _needs_failure_reason(manifest: Manifest, artifact: PlannedArtifact) -> str | None:
    """Why ``artifact`` cannot run: an artifact it needs is not recorded ok.
    ``None`` when every one is fine. The first one that is not ok names the
    reason, with the reason that artifact recorded."""
    for needed in artifact.needs:
        found = manifest.artifacts.get(needed)
        if found is not None and found.state == "ok":
            continue
        why = found.reason if found is not None and found.reason else None
        return (
            f"{artifact.name} depends on {needed}, which failed: "
            f"{why or 'it was not read in this ingest'}"
        )
    return None


def _fingerprint_as_upstream_read_them(
    manifest: Manifest, sources: Sequence[str], upstream: Sequence[str] = ()
) -> tuple[list[SourceFingerprint], tuple[str, ...]]:
    """Fingerprints for a control dependent's ``sources``, taking each file
    from the first of ``control`` and then the artifacts in ``upstream`` that
    recorded it by base name, and hashing only the rest.

    A dependent is built from what its upstream artifacts cached, so a file
    edited while it ran must leave it stale, not fresh -- and the upstream
    record is what makes that so. It also means a 398 MB observation table
    that seven artifacts list, or a 1 GB observation file two artifacts
    list, is hashed once per ingest.
    """
    recorded: dict[str, SourceFingerprint] = {}
    for name in ("control", *upstream):
        found = manifest.artifacts.get(name)
        if found is None:
            continue
        for source in found.sources:
            recorded.setdefault(source.path, source)
    fingerprints: list[SourceFingerprint] = []
    unfingerprinted: list[str] = []
    for raw in sources:
        known = recorded.get(Path(raw).name)
        if known is not None:
            fingerprints.append(known)
            continue
        found_now, missing = _fingerprint_sources([raw])
        fingerprints.extend(found_now)
        unfingerprinted.extend(missing)
    return fingerprints, tuple(unfingerprinted)


def _cell_note_for(manifest: Manifest, planned: Sequence[PlannedArtifact]) -> str | None:
    """The note an ensemble carries when there is no cell resolution to
    draw its map block from, or ``None`` when ``par_cell`` is recorded ok."""
    if not any(a.name == "par_cell" for a in planned):
        return "no grid file was found for this run, so the map block is empty"
    cell = manifest.artifacts.get("par_cell")
    if cell is not None and cell.state == "ok":
        return None
    why = cell.reason if cell is not None and cell.reason else "it was not resolved in this ingest"
    return f"cell resolution failed, so the map block is empty: {why}"


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

    # The caller's own argument goes through unchanged, so the plan can tell
    # "none given" (it then picks observation iterations by its own rule)
    # from a list the caller chose.
    planned = plan_artifacts(run, layout, iterations=iterations)
    first_iteration = selected[0] if selected else None

    grid_path = str(run.grid) if run.grid is not None else None

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
        declined_retry = not _should_retry(manifest, artifact.name, run_dir, artifact.sources)
        fresh = (not declined_retry) and (not manifest.is_stale(artifact.name, layout, artifact.sources))
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

        blocked = None
        if artifact.kind in _CONTROL_DEPENDENTS:
            blocked = _control_failure_reason(manifest, artifact.name)
        if blocked is None:
            blocked = _needs_failure_reason(manifest, artifact)
        if blocked is not None:
            sources, unfingerprinted = _fingerprint_sources(artifact.sources)
            if unfingerprinted:
                blocked = f"{blocked}; also, {'; '.join(unfingerprinted)}"
            manifest.mark_failed(artifact.name, blocked, sources=sources)
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
                        reason=blocked,
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

        pdc_file, weights_file = (
            _pdc_inputs(run, int(artifact.name.split("/", 1)[1]))
            if artifact.kind == "pdc"
            else (None, None)
        )
        phi_file = None
        if artifact.kind == "phi_check":
            phi_file = str(run.phi["actual"])
            weights_file = str(run.adjusted_weights) if run.adjusted_weights is not None else None
        worker_fn, worker_args = _dispatch(
            artifact,
            str(run_dir),
            str(run.pst_path),
            str(layout.root),
            _cell_note_for(manifest, planned) if artifact.kind == "par_ens" else None,
            grid_path,
            first_iteration,
            pdc_file,
            weights_file,
            phi_file,
        )

        start = time.perf_counter()
        ok, result = _run_isolated(worker_fn, *worker_args)
        seconds = time.perf_counter() - start

        if artifact.kind in _CONTROL_DEPENDENTS:
            sources, unfingerprinted = _fingerprint_as_upstream_read_them(
                manifest, artifact.sources, artifact.needs
            )
        else:
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
