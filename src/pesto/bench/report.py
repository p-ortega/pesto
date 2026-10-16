"""What `pesto bench` measured: the result shapes, the JSON and the printed table.

Timings stay as unrounded seconds in the dataclasses and the JSON. Rounding
happens only when the table is printed, and verdicts compare unrounded values.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from pesto.bench.limits import SPEED_LIMITS, passes, speed_limits_dict
from pesto.cache._atomic import write_atomic_text

SCHEMA_VERSION = 1
TOOL = "pesto bench"


@dataclass(frozen=True)
class SourceFile:
    name: str
    bytes: int


@dataclass(frozen=True)
class RunFacts:
    path: str
    name: str
    par_iterations: list[int | str]
    obs_ensembles: list[SourceFile]
    grid: str | None
    factor_files: int
    notes: list[str]


@dataclass(frozen=True)
class ArtifactTiming:
    name: str
    state: str
    seconds: float
    cpu_seconds: float | None
    source_bytes: int
    written_bytes: int
    reason: str | None


@dataclass(frozen=True)
class IngestTiming:
    label: str
    cache_dir: str
    wall_seconds: float
    worker_seconds: float
    outside_worker_seconds: float
    cpu_seconds: float | None
    wait_seconds: float | None
    artifacts: list[ArtifactTiming]
    notes: list[str]


@dataclass(frozen=True)
class ReadFloor:
    bytes: int
    seconds: float
    mb_per_second: float | None
    note: str


@dataclass(frozen=True)
class SourceRead:
    name: str
    bytes: int
    reads_implied: int


@dataclass(frozen=True)
class CacheSize:
    cache_dir: str
    cache_bytes: int
    manifest_cache_bytes: int
    source_bytes: int
    ratio: float | None
    sources: list[SourceFile]


@dataclass(frozen=True)
class LatencySummary:
    count: int
    first_seconds: float
    p50_seconds: float
    p95_seconds: float
    max_seconds: float


@dataclass(frozen=True)
class SpeedLimitVerdict:
    speed_limit: str
    measured: float | None
    limit: float
    unit: str
    status: str  # "pass" | "miss" | "not measured"
    note: str


@dataclass(frozen=True)
class BenchResult:
    pesto_version: str
    measured_at: str
    machine: dict[str, Any]
    run: RunFacts
    cache: dict[str, str]
    ingests: list[IngestTiming]
    read_floor: ReadFloor | None
    source_reads: list[SourceRead] | None
    source_reads_note: str
    cache_size: CacheSize
    verdicts: list[SpeedLimitVerdict]
    notes: list[str] = field(default_factory=list)
    schema_version: int = SCHEMA_VERSION
    tool: str = TOOL


def verdict(name: str, measured: float | None, unit: str, note: str) -> SpeedLimitVerdict:
    """A limit with nothing to measure is "not measured" with the reason, never "pass"."""
    limit = float(getattr(SPEED_LIMITS, name))
    if measured is None:
        return SpeedLimitVerdict(name, None, limit, unit, "not measured", note)
    status = "pass" if passes(name, measured) else "miss"
    return SpeedLimitVerdict(name, measured, limit, unit, status, note)


def result_to_dict(result: BenchResult) -> dict[str, Any]:
    body = asdict(result)
    # The limits sit next to the numbers so the browser check can read them.
    body["speed_limits"] = speed_limits_dict()
    return body


def write_result_json(path: Path, result: BenchResult) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_atomic_text(path, json.dumps(result_to_dict(result), indent=2) + "\n")


def _seconds(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2f} s"


def _megabytes(value: int) -> str:
    if value < 1_000_000:
        return f"{value / 1e3:,.1f} kB"
    return f"{value / 1e6:,.1f} MB"


def _measured_text(item: SpeedLimitVerdict) -> str:
    if item.measured is None:
        return "not measured"
    if item.unit == "x":
        return f"{item.measured:.2f}x"
    return f"{item.measured:.3f} {item.unit}"


def format_table(result: BenchResult) -> str:
    lines = [f"pesto bench: {result.run.name}", ""]

    rows = [
        (
            item.speed_limit,
            _measured_text(item),
            f"{item.limit:g} {item.unit}",
            item.status,
        )
        for item in result.verdicts
    ]
    header = ("Speed limit", "Measured", "Limit", "Result")
    widths = [max(len(header[i]), *(len(r[i]) for r in rows)) if rows else len(header[i]) for i in range(4)]
    lines.append("  ".join(header[i].ljust(widths[i]) for i in range(4)))
    for row in rows:
        lines.append("  ".join(row[i].ljust(widths[i]) for i in range(4)))
    for item in result.verdicts:
        if item.note:
            lines.append(f"  {item.speed_limit}: {item.note}")

    lines.append("")
    for ingest in result.ingests:
        lines.append(
            f"Ingest, {ingest.label}: wall {_seconds(ingest.wall_seconds)}, "
            f"workers {_seconds(ingest.worker_seconds)}, "
            f"outside workers {_seconds(ingest.outside_worker_seconds)}, "
            f"CPU {_seconds(ingest.cpu_seconds)}, "
            f"waiting {_seconds(ingest.wait_seconds)}"
        )
        for note in ingest.notes:
            lines.append(f"  note: {note}")

    floor = result.read_floor
    if floor is not None:
        rate = "n/a" if floor.mb_per_second is None else f"{floor.mb_per_second:,.0f} MB/s"
        lines.append(
            f"Read floor: {_megabytes(floor.bytes)} read once in {_seconds(floor.seconds)} ({rate})"
        )
        lines.append(f"  note: {floor.note}")

    cache = result.cache_size
    ratio = "n/a" if cache.ratio is None else f"{cache.ratio:.2f}x"
    lines.append(
        f"Cache: {_megabytes(cache.cache_bytes)} on disk from "
        f"{_megabytes(cache.source_bytes)} of source files ({ratio})"
    )
    lines.append("")
    lines.append(
        "Reopen and slider delay are measured by the browser check, "
        "and ingest growth by tests/perf."
    )
    return "\n".join(lines)
