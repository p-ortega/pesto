"""The measurements behind `pesto bench`. Nothing here writes inside a run folder."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Callable

from pesto.bench.report import (
    ArtifactTiming,
    CacheSize,
    IngestTiming,
    RunFacts,
    SourceFile,
)
from pesto.cache.layout import CacheLayout
from pesto.cache.manifest import Manifest
from pesto.ingest.discover import discover
from pesto.ingest.runner import Progress, plan_artifacts


def _size(path: Path) -> int:
    return path.stat().st_size


def run_facts(run_dir: Path) -> RunFacts:
    layout = discover(run_dir)
    keys = list(layout.par_ens)
    par_iterations = sorted(k for k in keys if isinstance(k, int)) + sorted(
        k for k in keys if isinstance(k, str)
    )
    obs = [SourceFile(name=path.name, bytes=_size(path)) for path in layout.obs_ens.values()]
    resolved = Path(run_dir).resolve()
    return RunFacts(
        path=str(resolved),
        name=resolved.name,
        par_iterations=par_iterations,
        obs_ensembles=obs,
        grid=layout.grid.name if layout.grid is not None else None,
        factor_files=len(layout.factor_files),
        notes=list(layout.notes),
    )


def source_files(run_dir: Path, cache_dir: Path) -> list[SourceFile]:
    """Each source file the artifact plan names, once, however many artifacts name it."""
    planned = plan_artifacts(discover(run_dir), CacheLayout(root=Path(cache_dir)))
    seen: dict[Path, SourceFile] = {}
    for artifact in planned:
        for source in artifact.sources:
            resolved = Path(source).resolve()
            if resolved not in seen:
                seen[resolved] = SourceFile(name=resolved.name, bytes=_size(resolved))
    return list(seen.values())


def time_ingest(
    run_dir: Path,
    cache_dir: Path,
    label: str,
    ingest: Callable[..., object],
) -> IngestTiming:
    rows: list[Progress] = []
    start = time.perf_counter()
    ingest(run_dir, cache_root=cache_dir, on_progress=rows.append)
    wall = time.perf_counter() - start

    finals = [row for row in rows if row.state != "started"]
    worker = sum(row.seconds for row in finals if row.state in ("ok", "failed"))
    artifacts = [
        ArtifactTiming(
            name=row.artifact,
            state=row.state,
            seconds=row.seconds,
            cpu_seconds=None,
            source_bytes=row.source_bytes,
            written_bytes=row.written_bytes,
            reason=row.reason,
        )
        for row in finals
    ]
    return IngestTiming(
        label=label,
        cache_dir=str(cache_dir),
        wall_seconds=wall,
        worker_seconds=worker,
        outside_worker_seconds=wall - worker,
        cpu_seconds=None,
        wait_seconds=None,
        artifacts=artifacts,
        notes=[],
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
