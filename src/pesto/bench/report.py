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
class ColdRead:
    bytes: int
    files: int
    first_seconds: float
    first_mb_per_second: float | None
    reread_seconds: float
    reread_mb_per_second: float | None
    ratio: float | None
    proven_cold: bool
    label: str  # "cold" | "not proven cold" | "not measured"
    method: str
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
class RouteTiming:
    route: str
    status: int
    bytes: int
    seconds: float


@dataclass(frozen=True)
class ReopenShare:
    requests: list[RouteTiming]
    total_seconds: float
    note: str


@dataclass(frozen=True)
class ValuesLatency:
    iteration: int
    realization: LatencySummary | None
    statistic: LatencySummary | None
    notes: list[str]


@dataclass(frozen=True)
class ServerMeasures:
    started_seconds: float
    reopen_share: ReopenShare
    values: ValuesLatency


@dataclass(frozen=True)
class HeaviestTarget:
    group: str
    layer: int
    cells: int


@dataclass(frozen=True)
class PilotPointTarget:
    group: str
    layer: int
    n_pp: int


@dataclass(frozen=True)
class BrowserTargets:
    iteration: int
    iteration_note: str
    heaviest: HeaviestTarget | None
    heaviest_note: str
    pilot_point: PilotPointTarget | None
    pilot_point_note: str


@dataclass(frozen=True)
class ObservationProbe:
    file: str
    bytes: int
    raw_read_seconds: float | None
    raw_mb_per_second: float | None
    from_binary_seconds: float | None
    shape: list[int] | None
    note: str


@dataclass(frozen=True)
class ObservationFacts:
    ingest: str
    files: list[SourceFile]
    probe: ObservationProbe | None
    notes: list[str]


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
    server: ServerMeasures | None = None
    browser_targets: BrowserTargets | None = None
    observations: ObservationFacts | None = None
    # Why the server stage gave nothing, when it raised; None when it ran or was turned off.
    server_failure: str | None = None
    cold_read: ColdRead | None = None
    schema_version: int = SCHEMA_VERSION
    tool: str = TOOL


def verdict(
    name: str, measured: float | None, unit: str, note: str, label: str | None = None
) -> SpeedLimitVerdict:
    """A limit with nothing to measure is "not measured" with the reason, never "pass".

    `label` names the row when one limit is judged on more than one thing.
    """
    limit = float(getattr(SPEED_LIMITS, name))
    shown = label or name
    if measured is None:
        return SpeedLimitVerdict(shown, None, limit, unit, "not measured", note)
    status = "pass" if passes(name, measured) else "miss"
    return SpeedLimitVerdict(shown, measured, limit, unit, status, note)


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


def _ms(value: float) -> str:
    return f"{value * 1000:,.1f} ms"


def _server_lines(result: BenchResult) -> list[str]:
    server = result.server
    if server is None:
        return []
    lines = [f"Server: started in {_seconds(server.started_seconds)}"]
    share = server.reopen_share
    lines.append(f"Reopen, server share: {_seconds(share.total_seconds)} over {len(share.requests)} requests")
    for item in share.requests:
        lines.append(
            f"  {item.route.split('?')[0]}: {item.status}, {_megabytes(item.bytes)}, {_ms(item.seconds)}"
        )
    lines.append(f"  note: {share.note}")
    values = server.values
    lines.append(f"grid/values, iteration {values.iteration}:")
    for kind in ("realization", "statistic"):
        summary = getattr(values, kind)
        if summary is None:
            lines.append(f"  {kind}: not measured")
            continue
        lines.append(
            f"  {kind}: {summary.count} requests, first {_ms(summary.first_seconds)}, "
            f"p50 {_ms(summary.p50_seconds)}, p95 {_ms(summary.p95_seconds)} (nearest rank), "
            f"max {_ms(summary.max_seconds)}"
        )
    for note in values.notes:
        lines.append(f"  note: {note}")
    return lines


def _target_lines(result: BenchResult) -> list[str]:
    targets = result.browser_targets
    if targets is None:
        return []
    lines = [f"Browser targets (iteration {targets.iteration}):"]
    if targets.iteration_note:
        lines.append(f"  note: {targets.iteration_note}")
    heavy = targets.heaviest
    lines.append(
        f"  heaviest: group {heavy.group}, layer {heavy.layer}, {heavy.cells} cells"
        if heavy is not None
        else f"  heaviest: none ({targets.heaviest_note})"
    )
    pilot = targets.pilot_point
    lines.append(
        f"  pilot points: group {pilot.group}, layer {pilot.layer}, {pilot.n_pp} points"
        if pilot is not None
        else f"  pilot points: none ({targets.pilot_point_note})"
    )
    return lines


def _rate(value: float | None) -> str:
    return "n/a" if value is None else f"{value:,.0f} MB/s"


def _cold_read_lines(result: BenchResult) -> list[str]:
    cold = result.cold_read
    if cold is None:
        return []
    ratio = "n/a" if cold.ratio is None else f"{cold.ratio:.2f}"
    return [
        f"Cold read: {_megabytes(cold.bytes)} in {cold.files} files, first read "
        f"{_rate(cold.first_mb_per_second)}, re-read {_rate(cold.reread_mb_per_second)}, "
        f"ratio {ratio}, {cold.label} (method: {cold.method})",
        f"  note: {cold.note}",
    ]


def _observation_lines(result: BenchResult) -> list[str]:
    facts = result.observations
    if facts is None:
        return []
    lines = [f"Observation ingest: {facts.ingest}"]
    for item in facts.files:
        lines.append(f"  {item.name}: {_megabytes(item.bytes)}")
    probe = facts.probe
    if probe is not None:
        raw = "n/a" if probe.raw_read_seconds is None else _seconds(probe.raw_read_seconds)
        parsed = "n/a" if probe.from_binary_seconds is None else _seconds(probe.from_binary_seconds)
        shape = "n/a" if probe.shape is None else f"{probe.shape[0]} x {probe.shape[1]}"
        lines.append(
            f"  probe of {probe.file} ({_megabytes(probe.bytes)}): raw read {raw}, "
            f"pyemu read {parsed}, shape {shape}"
        )
        lines.append(f"    {probe.note}")
    for note in facts.notes:
        lines.append(f"  note: {note}")
    return lines


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

    lines.extend(_cold_read_lines(result))

    floor = result.read_floor
    if floor is not None:
        rate = "n/a" if floor.mb_per_second is None else f"{floor.mb_per_second:,.0f} MB/s"
        lines.append(
            f"Read floor: {_megabytes(floor.bytes)} read once in {_seconds(floor.seconds)} ({rate})"
        )
        lines.append(f"  note: {floor.note}")

    for note in result.notes:
        lines.append(f"note: {note}")
    lines.extend(_server_lines(result))
    lines.extend(_target_lines(result))
    lines.extend(_observation_lines(result))

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
    lines.append(
        "Cell picking is measured by frontend/tests/picking-scale.test.ts: "
        f"index build at or under {SPEED_LIMITS.pick_index_build_ms:g} ms, "
        f"warm pick p95 at or under {SPEED_LIMITS.pick_p95_ms:g} ms."
    )
    return "\n".join(lines)
