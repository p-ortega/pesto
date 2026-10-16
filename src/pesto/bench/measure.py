"""The measurements behind `pesto bench`. Nothing here writes inside a run folder."""

from __future__ import annotations

import os
import platform
import time
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from pesto.bench.report import (
    ArtifactTiming,
    CacheSize,
    IngestTiming,
    LatencySummary,
    ObservationFacts,
    ObservationProbe,
    ReadFloor,
    RunFacts,
    SourceFile,
    SourceRead,
)
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.runner import Progress, plan_artifacts
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
_INGEST_STATEMENT = "not implemented in M0"
_NO_OBS_FILES = "no observation ensemble present"
_PROBE_NOT_RUN = "not run (pass --obs-probe to time one observation file)"
_PROBE_LABEL = "information only, not part of ingest"
_READS_NOTE = (
    "counted from the artifact plan: each artifact that names a source reads it "
    "once in its worker and once more to checksum it"
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


def _source_paths(run_dir: Path, cache_dir: Path) -> list[Path]:
    seen: dict[Path, None] = {}
    for artifact in _planned(run_dir, cache_dir):
        for source in artifact.sources:
            seen.setdefault(Path(source).resolve(), None)
    return list(seen)


def source_files(run_dir: Path, cache_dir: Path) -> list[SourceFile]:
    """Each source file the artifact plan names, once, however many artifacts name it."""
    return [SourceFile(name=p.name, bytes=_size(p)) for p in _source_paths(run_dir, cache_dir)]


def source_reads(run_dir: Path, cache_dir: Path) -> list[SourceRead]:
    counts: dict[Path, int] = {}
    for artifact in _planned(run_dir, cache_dir):
        for source in artifact.sources:
            path = Path(source).resolve()
            counts[path] = counts.get(path, 0) + 2
    return [SourceRead(name=p.name, bytes=_size(p), reads_implied=n) for p, n in counts.items()]


def source_reads_note() -> str:
    return _READS_NOTE


def _children_cpu() -> float:
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return usage.ru_utime + usage.ru_stime


def _own_cpu() -> float:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return usage.ru_utime + usage.ru_stime


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
    worker = 0.0
    skipped = 0
    for row, children in zip(rows, children_at):
        if row.state == "started":
            started_at[row.artifact] = children
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
    total = 0
    start = time.perf_counter()
    for path in files:
        with open(path, "rb") as handle:
            while chunk := handle.read(_READ_CHUNK):
                total += len(chunk)
    seconds = time.perf_counter() - start
    rate = total / 1e6 / seconds if seconds > 0 and total > 0 else None
    return ReadFloor(bytes=total, seconds=seconds, mb_per_second=rate, note=_FLOOR_NOTE)


def read_floor_for(run_dir: Path, cache_dir: Path) -> ReadFloor:
    return read_floor(_source_paths(run_dir, cache_dir))


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


def percentile_summary(samples: Sequence[float]) -> LatencySummary | None:
    if len(samples) == 0:
        return None
    values = np.asarray(samples, dtype=float)
    p50, p95 = np.percentile(values, [50, 95], method="higher")
    return LatencySummary(
        count=len(values),
        first_seconds=float(values[0]),
        p50_seconds=float(p50),
        p95_seconds=float(p95),
        max_seconds=float(values.max()),
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


def observation_facts(run_dir: Path, probe: bool) -> ObservationFacts:
    """What M0 does with observation ensembles (nothing), and what is on disk.

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
        ingest=_INGEST_STATEMENT,
        files=[SourceFile(name=path.name, bytes=_size(path)) for _key, path in files],
        probe=probed,
        notes=notes,
    )
