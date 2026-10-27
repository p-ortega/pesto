"""The measurements behind `pesto bench`. Nothing here writes inside a run folder."""

from __future__ import annotations

import os
import platform
import time
from fractions import Fraction
from pathlib import Path
from typing import Callable, Sequence

from pesto.bench.report import (
    ArtifactTiming,
    AsFoundCache,
    CacheSize,
    IngestTiming,
    LatencySummary,
    ObservationFacts,
    ObservationProbe,
    ReadFloor,
    ResidentFile,
    RunFacts,
    SourceFile,
    SourceRead,
)
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.runner import PlannedArtifact, Progress, plan_artifacts
from pesto.warm import load_pyemu

try:
    import resource
except ImportError:  # Windows has no resource module
    resource = None  # type: ignore[assignment]

_READ_CHUNK = 8 * 1024 * 1024
_NO_OBSERVATIONS = "parameters only, observation ensemble not present"
_NO_CPU = "CPU time is not available on this platform"
_FLOOR_NOTE = (
    "read straight after two ingests, so the files were likely in memory; "
    "above about 3,000 MB/s they did not come from the disk (an assumption, "
    "not something this run proved)"
)
# The as-found ingest counts as cold when at most this share of the source bytes was in memory.
COLD_RESIDENT_LIMIT = 0.01
_NO_OBS_FILES = "no observation ensemble present"
_NO_OBS_PLANNED = "no observation ensemble was planned for this run"
_PROBE_NOT_RUN = "not run (pass --obs-probe to time one observation file)"
_PROBE_LABEL = "information only, not part of ingest"
_READS_NOTE = (
    "counted from the artifact plan: an artifact that names a source reads it once in its "
    "worker and once more to checksum it, unless the control artifact or an artifact it "
    "needs already read that file, in which case it reads the cache instead"
)


def _size(path: Path) -> int:
    return path.stat().st_size


def run_facts(run_dir: Path) -> RunFacts:
    layout = discover(run_dir)
    keys = list(layout.par_ens)
    par_iterations = sorted(k for k in keys if isinstance(k, int)) + sorted(
        k for k in keys if isinstance(k, str)
    )
    obs = [SourceFile(name=path.name, bytes=_size(path)) for path in layout.obs_ens.values()]
    notes = list(layout.notes)
    if not obs:
        notes.append(_NO_OBSERVATIONS)
    resolved = Path(run_dir).resolve()
    return RunFacts(
        path=str(resolved),
        name=resolved.name,
        par_iterations=par_iterations,
        obs_ensembles=obs,
        grid=layout.grid.name if layout.grid is not None else None,
        factor_files=len(layout.factor_files),
        notes=notes,
    )


def _planned(run_dir: Path, cache_dir: Path):
    return plan_artifacts(discover(run_dir), CacheLayout(root=Path(cache_dir)))


def split_readable(paths: Sequence[Path]) -> tuple[list[Path], list[str]]:
    """The paths that exist and open read-only, and the names of those that do not."""
    readable: list[Path] = []
    missing: list[str] = []
    for path in paths:
        path = Path(path)
        if not path.is_file():
            missing.append(path.name)
            continue
        try:
            os.close(os.open(path, os.O_RDONLY))
        except OSError:
            missing.append(path.name)
            continue
        readable.append(path)
    return readable, missing


def missing_note(names: Sequence[str]) -> str | None:
    if not names:
        return None
    return f"{len(names)} planned source file(s) were not found and were skipped: {', '.join(names)}"


def source_paths(run_dir: Path, cache_dir: Path) -> list[Path]:
    """Each source file the artifact plan names, once, whether or not it is on disk."""
    seen: dict[Path, None] = {}
    for artifact in _planned(run_dir, cache_dir):
        for source in artifact.sources:
            seen.setdefault(Path(source).resolve(), None)
    return list(seen)


def source_files(run_dir: Path, cache_dir: Path) -> list[SourceFile]:
    """Each source file the artifact plan names, once, however many artifacts name it."""
    readable, _missing = split_readable(source_paths(run_dir, cache_dir))
    return [SourceFile(name=p.name, bytes=_size(p)) for p in readable]


def _reads_by_artifact(plan: Sequence[PlannedArtifact]) -> dict[str, tuple[Path, ...]]:
    """Which source files each artifact reads from the run folder, walking the plan in order."""
    control_files: set[Path] = set()
    listed: dict[str, set[Path]] = {}
    reads: dict[str, tuple[Path, ...]] = {}
    for artifact in plan:
        paths = tuple(dict.fromkeys(Path(source).resolve() for source in artifact.sources))
        listed[artifact.name] = set(paths)
        # A file an artifact it needs also lists was read there; this one reads the cache.
        already_read = set().union(*(listed.get(need, set()) for need in artifact.needs))
        if artifact.name == "control":
            control_files.update(paths)
            reads[artifact.name] = paths
        else:
            reads[artifact.name] = tuple(
                p for p in paths if p not in control_files and p not in already_read
            )
    return reads


def source_reads(run_dir: Path, cache_dir: Path) -> list[SourceRead]:
    counts: dict[Path, int] = {}
    for paths in _reads_by_artifact(_planned(run_dir, cache_dir)).values():
        for path in paths:
            counts[path] = counts.get(path, 0) + 2
    readable, _missing = split_readable(list(counts))
    return [SourceRead(name=p.name, bytes=_size(p), reads_implied=counts[p]) for p in readable]


def source_reads_note() -> str:
    return _READS_NOTE


def _children_cpu() -> float:
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return usage.ru_utime + usage.ru_stime


def _own_cpu() -> float:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return usage.ru_utime + usage.ru_stime


def _started_read_bytes(
    run_dir: Path, cache_dir: Path, started: set[str]
) -> tuple[int | None, str | None]:
    """Bytes of every source file read once, from the run folder, by an artifact that started.

    The plan is made after the ingest so that planning never touches a file before it.
    """
    try:
        reads = _reads_by_artifact(_planned(run_dir, cache_dir))
    except Exception as exc:
        return None, f"the source read figure is not measured: the artifact plan could not be made ({exc})"
    once = dict.fromkeys(p for name, paths in reads.items() if name in started for p in paths)
    readable, missing = split_readable(list(once))
    return sum(_size(p) for p in readable), missing_note(missing)


def time_ingest(
    run_dir: Path,
    cache_dir: Path,
    label: str,
    ingest: Callable[..., object],
) -> IngestTiming:
    has_cpu = resource is not None
    rows: list[Progress] = []
    # Workers' CPU time at each row, so one artifact's share is a difference of two.
    children_at: list[float] = []

    def on_progress(row: Progress) -> None:
        rows.append(row)
        children_at.append(_children_cpu() if has_cpu else 0.0)

    cpu_before = (_children_cpu() + _own_cpu()) if has_cpu else 0.0
    start = time.perf_counter()
    ingest(run_dir, cache_root=cache_dir, on_progress=on_progress)
    wall = time.perf_counter() - start
    cpu = (_children_cpu() + _own_cpu() - cpu_before) if has_cpu else None

    artifacts: list[ArtifactTiming] = []
    started_at: dict[str, float] = {}
    started_names: set[str] = set()
    worker = 0.0
    skipped = 0
    for row, children in zip(rows, children_at):
        if row.state == "started":
            started_at[row.artifact] = children
            started_names.add(row.artifact)
            continue
        if row.state == "skipped":
            skipped += 1
        if row.state in ("ok", "failed"):
            worker += row.seconds
        artifact_cpu = None
        if has_cpu and row.artifact in started_at:
            artifact_cpu = children - started_at.pop(row.artifact)
        artifacts.append(
            ArtifactTiming(
                name=row.artifact,
                state=row.state,
                seconds=row.seconds,
                cpu_seconds=artifact_cpu,
                source_bytes=row.source_bytes,
                written_bytes=row.written_bytes,
                reason=row.reason,
            )
        )

    notes: list[str] = []
    if not has_cpu:
        notes.append(_NO_CPU)
    if skipped:
        notes.append(
            f"{skipped} artifacts were skipped as fresh, so this ingest did not re-read them"
        )
    read_bytes, read_note = _started_read_bytes(run_dir, cache_dir, started_names)
    if read_note:
        notes.append(read_note)
    wait = wall - cpu if cpu is not None else None
    if wait is not None and wait < 0:
        notes.append(
            "CPU time is above wall time because the workers used several cores, "
            "so waiting time is below zero"
        )
    return IngestTiming(
        label=label,
        cache_dir=str(cache_dir),
        wall_seconds=wall,
        worker_seconds=worker,
        outside_worker_seconds=wall - worker,
        cpu_seconds=cpu,
        wait_seconds=wait,
        artifacts=artifacts,
        notes=notes,
        read_mb_per_second=_rate(read_bytes, worker) if read_bytes is not None else None,
    )


def cache_size(run_dir: Path, cache_dir: Path) -> CacheSize:
    on_disk = 0
    for folder, _dirs, names in os.walk(cache_dir):
        for name in names:
            on_disk += os.lstat(os.path.join(folder, name)).st_size
    manifest = Manifest.load(CacheLayout(root=Path(cache_dir)))
    in_manifest = sum(f.bytes for a in manifest.artifacts.values() for f in a.files)
    sources = source_files(run_dir, cache_dir)
    source_total = sum(s.bytes for s in sources)
    return CacheSize(
        cache_dir=str(cache_dir),
        cache_bytes=on_disk,
        manifest_cache_bytes=in_manifest,
        source_bytes=source_total,
        ratio=on_disk / source_total if source_total > 0 else None,
        sources=sources,
    )


def read_floor(files: Sequence[Path]) -> ReadFloor:
    """How fast the source bytes read once, start to end, in one pass."""
    readable, missing = split_readable(files)
    total = 0
    start = time.perf_counter()
    for path in readable:
        with open(path, "rb") as handle:
            while chunk := handle.read(_READ_CHUNK):
                total += len(chunk)
    seconds = time.perf_counter() - start
    rate = total / 1e6 / seconds if seconds > 0 and total > 0 else None
    note = "; ".join(filter(None, [_FLOOR_NOTE, missing_note(missing)]))
    return ReadFloor(bytes=total, seconds=seconds, mb_per_second=rate, note=note)


def _rate(total: int, seconds: float) -> float | None:
    return total / 1e6 / seconds if total > 0 and seconds > 0 else None


# A page probe takes one file path and returns how many of its bytes are in memory.
PageProbe = Callable[[Path], int]
_PAGE_METHOD = "mincore on a read-only mapping (no file contents are read)"
_PURGE_STEP = (
    "sudo purge is your own step, in your own terminal right before pesto bench; "
    "pesto never runs it"
)


class PageCheckUnavailable(OSError):
    """The OS call that reports memory residency cannot be used here."""


def _load_mincore():
    import ctypes
    import ctypes.util

    name = ctypes.util.find_library("c")
    try:
        if name is not None:
            libc = ctypes.CDLL(name, use_errno=True)
        elif os.name == "posix":
            libc = ctypes.CDLL(None, use_errno=True)
        else:
            raise PageCheckUnavailable("the C library was not found")
    except OSError as exc:
        raise PageCheckUnavailable(f"the C library could not be loaded ({exc})") from exc
    function = getattr(libc, "mincore", None)
    if function is None:
        raise PageCheckUnavailable("the C library has no mincore call")
    function.argtypes = (ctypes.c_void_p, ctypes.c_size_t, ctypes.c_char_p)
    function.restype = ctypes.c_int
    return function


def _mincore_resident_bytes(path: Path) -> int:
    """Bytes of the file already in memory, asked of the OS through a read-only mapping."""
    import ctypes
    import mmap

    import numpy as np

    mincore = _load_mincore()
    fd = os.open(path, os.O_RDONLY)
    try:
        size = os.fstat(fd).st_size
        if size == 0:
            return 0
        mapping = mmap.mmap(fd, size, access=mmap.ACCESS_READ)
        try:
            view = np.frombuffer(mapping, dtype=np.uint8)
            address = view.ctypes.data
            # Dropped before the map closes; the address stays valid while the map is open.
            del view
            pages = (size + mmap.PAGESIZE - 1) // mmap.PAGESIZE
            vec = ctypes.create_string_buffer(pages)
            if mincore(address, size, vec) != 0:
                code = ctypes.get_errno()
                raise OSError(code, f"mincore failed: {os.strerror(code)}")
            flags = np.frombuffer(vec.raw, dtype=np.uint8)
            in_memory = int((flags & 1).sum())
        finally:
            mapping.close()
    finally:
        os.close(fd)
    # The last page may be only partly the file.
    return min(size, in_memory * mmap.PAGESIZE)


def _megabytes_text(value: int) -> str:
    return f"{value / 1e6:,.1f} MB"


def _percent_text(fraction: float) -> str:
    return f"{fraction * 100:.2f}%"


def _skipped_note(skipped: Sequence[tuple[str, str]]) -> str | None:
    if not skipped:
        return None
    named = ", ".join(f"{name} ({why})" for name, why in skipped)
    return f"{len(skipped)} planned source file(s) were skipped: {named}"


def _not_measured(
    method: str, note: str, files: int, source_bytes: int, skipped: Sequence[tuple[str, str]]
) -> AsFoundCache:
    note = "; ".join(filter(None, [f"not measured: {note}", _PURGE_STEP, _skipped_note(skipped)]))
    return AsFoundCache(
        source_bytes=source_bytes,
        resident_bytes=None,
        resident_fraction=None,
        files=files,
        missing=[name for name, _why in skipped],
        largest_resident=[],
        label="not measured",
        method=method,
        note=note,
    )


def page_residency(files: Sequence[Path], probe: PageProbe | None = None) -> AsFoundCache:
    """How much of the source bytes is already in memory, asked without reading any of it.

    The label is "cold" only when at most COLD_RESIDENT_LIMIT of the bytes were in memory.
    Missing and empty files are skipped and named. Nothing is run to empty the cache.
    """
    ask = probe or _mincore_resident_bytes
    method = _PAGE_METHOD if probe is None else "page probe given by the caller"
    readable, missing = split_readable(files)
    skipped: list[tuple[str, str]] = [(name, "not found") for name in missing]
    sizes: list[tuple[Path, int]] = []
    for path in readable:
        size = _size(path)
        if size == 0:
            skipped.append((path.name, "empty"))
        else:
            sizes.append((path, size))
    source_bytes = sum(size for _path, size in sizes)
    if source_bytes == 0:
        return _not_measured(
            method,
            "the source files add up to zero bytes, so there is nothing to check",
            0,
            0,
            skipped,
        )

    found: list[ResidentFile] = []
    try:
        for path, size in sizes:
            found.append(ResidentFile(name=path.name, bytes=size, resident_bytes=int(ask(path))))
    except Exception as exc:
        reason = f"{type(exc).__name__}: {exc}"
        if isinstance(exc, PageCheckUnavailable):
            method = f"not available on this platform ({exc})"
        return _not_measured(method, f"the page check failed ({reason})", len(sizes), source_bytes, skipped)

    resident = sum(item.resident_bytes for item in found)
    fraction = resident / source_bytes
    largest = sorted((f for f in found if f.resident_bytes > 0), key=lambda f: -f.resident_bytes)[:3]
    # Exact comparison, so a share of exactly 1% is cold and 1.01% is not.
    cold = Fraction(resident, source_bytes) <= Fraction(str(COLD_RESIDENT_LIMIT))
    measured = (
        f"{_megabytes_text(resident)} of {_megabytes_text(source_bytes)} "
        f"({_percent_text(fraction)}) of the source files was in memory before the as-found ingest"
    )
    if cold:
        label = "cold"
        head = f"cold: {measured}, at most {COLD_RESIDENT_LIMIT:.0%} (checked without reading any file)"
    else:
        label = "not cold"
        names = ", ".join(f"{f.name} ({_megabytes_text(f.resident_bytes)})" for f in largest)
        head = f"not cold: {measured}, above {COLD_RESIDENT_LIMIT:.0%}; largest in memory: {names}"
    note = "; ".join(filter(None, [head, _PURGE_STEP, _skipped_note(skipped)]))
    return AsFoundCache(
        source_bytes=source_bytes,
        resident_bytes=resident,
        resident_fraction=fraction,
        files=len(found),
        missing=[name for name, _why in skipped],
        largest_resident=largest,
        label=label,
        method=method,
        note=note,
    )


def read_floor_for(run_dir: Path, cache_dir: Path) -> ReadFloor:
    return read_floor(source_paths(run_dir, cache_dir))


def _memory_bytes() -> int | None:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (AttributeError, ValueError, OSError):
        return None


def machine_facts() -> dict[str, object]:
    return {
        "platform": platform.platform() or "unknown",
        "machine": platform.machine() or "unknown",
        "cpu_count": os.cpu_count() or "unknown",
        "memory_bytes": _memory_bytes(),
        "python": platform.python_version() or "unknown",
    }


def nearest_rank(sorted_values: Sequence[float], percent: int) -> float:
    """The k-th smallest of n, k = ceil(percent * n / 100), in integers. The browser check uses the same rule."""
    k = (percent * len(sorted_values) + 99) // 100
    return sorted_values[max(1, k) - 1]


def percentile_summary(samples: Sequence[float]) -> LatencySummary | None:
    if len(samples) == 0:
        return None
    values = [float(x) for x in samples]
    ranked = sorted(values)
    return LatencySummary(
        count=len(values),
        first_seconds=values[0],
        p50_seconds=nearest_rank(ranked, 50),
        p95_seconds=nearest_rank(ranked, 95),
        max_seconds=ranked[-1],
    )


def _obs_files(run_dir: Path) -> list[tuple[int | str, Path]]:
    found = discover(run_dir).obs_ens
    keys = sorted(k for k in found if isinstance(k, int)) + sorted(k for k in found if isinstance(k, str))
    return [(key, found[key]) for key in keys]


def _probe_file(path: Path) -> ObservationProbe:
    """Time one read-only pass over the file, then one pyemu read of it."""
    size = _size(path)
    raw_seconds: float | None = None
    raw_rate: float | None = None
    from_binary_seconds: float | None = None
    shape: list[int] | None = None
    note = _PROBE_LABEL
    try:
        start = time.perf_counter()
        with open(path, "rb") as handle:
            while handle.read(_READ_CHUNK):
                pass
        raw_seconds = time.perf_counter() - start
        raw_rate = size / 1e6 / raw_seconds if raw_seconds > 0 and size > 0 else None

        pyemu = load_pyemu()
        start = time.perf_counter()
        matrix = pyemu.Matrix.from_binary(str(path))
        from_binary_seconds = time.perf_counter() - start
        shape = [len(matrix.row_names), len(matrix.col_names)]
    except Exception as exc:
        note = f"probe failed: {exc}; {_PROBE_LABEL}"
    return ObservationProbe(
        file=path.name,
        bytes=size,
        raw_read_seconds=raw_seconds,
        raw_mb_per_second=raw_rate,
        from_binary_seconds=from_binary_seconds,
        shape=shape,
        note=note,
    )


def _observation_ingest_text(artifacts: Sequence[ArtifactTiming]) -> str:
    parts = []
    for item in artifacts:
        if not item.name.startswith("obs_ens/"):
            continue
        text = f"{item.name} {item.state}"
        if item.state == "failed" and item.reason:
            text += f": {item.reason}"
        parts.append(text)
    return "; ".join(parts) if parts else _NO_OBS_PLANNED


def observation_facts(
    run_dir: Path, probe: bool, artifacts: Sequence[ArtifactTiming]
) -> ObservationFacts:
    """What the warm ingest did with each observation ensemble, and what is on disk.

    The probe only reads: it opens one file with "rb" and makes one pyemu read.
    """
    files = _obs_files(run_dir)
    notes: list[str] = []
    probed: ObservationProbe | None = None
    if not files:
        notes.append(_NO_OBS_FILES)
    elif not probe:
        notes.append(_PROBE_NOT_RUN)
    else:
        numbered = [path for key, path in files if isinstance(key, int)]
        if numbered:
            probed = _probe_file(numbered[0])
        else:
            notes.append("no numbered iteration to probe")
    return ObservationFacts(
        ingest=_observation_ingest_text(artifacts),
        files=[SourceFile(name=path.name, bytes=_size(path)) for _key, path in files],
        probe=probed,
        notes=notes,
    )
