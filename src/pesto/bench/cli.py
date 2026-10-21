"""`pesto bench RUN --cache-dir DIR --json FILE`: ingest a run twice and measure it against the speed limits."""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import replace
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Callable

from pesto.bench.measure import (
    _source_paths,
    cache_size,
    cold_read,
    machine_facts,
    observation_facts,
    read_floor_for,
    run_facts,
    source_reads,
    source_reads_note,
    time_ingest,
)
from pesto.bench.report import (
    BenchResult,
    ServerMeasures,
    format_table,
    verdict,
    write_result_json,
)
from pesto.bench.serve import (
    BenchServer,
    measure_reopen_share,
    measure_values,
    pick_browser_targets,
)
from pesto.ingest.runner import ingest_run

_AS_FOUND = "ingest-1"
_WARM = "ingest-2"
_VALUES_SAMPLES = 300
_COLD_READ_NOTE = (
    "the cold-read check read every source file just before this ingest, "
    "so these files were likely in memory"
)
_STAGE_OFF = "the server stage was turned off"


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a whole number") from None
    if value < 1:
        raise argparse.ArgumentTypeError("must be 1 or more")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pesto bench",
        description=(
            "Ingest a run twice, once as found and once straight after, and "
            "measure it against pesto's speed limits. Prints a table and writes "
            "one JSON file. Nothing is written inside the run folder and nothing "
            "is deleted or overwritten. A run folder named bench is written ./bench."
        ),
    )
    parser.add_argument("run", type=Path, help="PEST working directory to measure")
    parser.add_argument(
        "--cache-dir",
        type=Path,
        required=True,
        help=f"Scratch folder; {_AS_FOUND} and {_WARM} are made inside it and must not exist yet",
    )
    parser.add_argument(
        "--json",
        type=Path,
        required=True,
        help="Where to write the result; the file must not exist yet",
    )
    parser.add_argument(
        "--values-samples",
        type=_positive_int,
        default=_VALUES_SAMPLES,
        help=f"grid/values requests timed per kind (default {_VALUES_SAMPLES})",
    )
    parser.add_argument(
        "--obs-probe",
        action="store_true",
        help=(
            "Also time one read of the lowest-numbered observation ensemble file (information "
            "only, not part of ingest). Loads that whole file into memory."
        ),
    )
    return parser


def _inside(candidate: Path, folder: Path) -> bool:
    return candidate == folder or folder in candidate.parents


def check_paths(run_dir: Path, cache_parent: Path, json_path: Path) -> str | None:
    """The reason to refuse these paths, or None when they are safe to use."""
    run = Path(run_dir).resolve()
    cache = Path(cache_parent).resolve()
    out = Path(json_path).resolve()
    if not run.is_dir():
        return f"{run_dir} is not a directory"
    if _inside(cache, run):
        return "--cache-dir is inside the run folder; pesto never writes inside a run folder"
    if _inside(out, run):
        return "--json is inside the run folder; pesto never writes inside a run folder"
    if cache.exists() and not cache.is_dir():
        return f"{cache_parent} is not a folder"
    for name in (_AS_FOUND, _WARM):
        taken = cache / name
        if os.path.lexists(taken):
            return (
                f"{taken} already exists; pesto bench never reuses or deletes an "
                f"earlier cache, so give a new --cache-dir"
            )
        if _inside(out, taken):
            return f"--json would be written inside {taken}; give it a path outside the caches"
    if os.path.lexists(out):
        return (
            f"{json_path} already exists; pesto bench never overwrites an earlier "
            f"result, so give a new --json path"
        )
    return None


def _version() -> str:
    try:
        return metadata.version("pesto")
    except metadata.PackageNotFoundError:
        return "unknown"


def run_bench(
    run_dir: Path,
    cache_parent: Path,
    json_path: Path,
    *,
    ingest: Callable[..., object] | None = None,
    measure_server: bool = True,
    obs_probe: bool = False,
    values_samples: int = _VALUES_SAMPLES,
) -> BenchResult:
    run = Path(run_dir).resolve()
    parent = Path(cache_parent).resolve()
    if ingest is None:
        ingest = ingest_run

    as_found_dir = parent / _AS_FOUND
    warm_dir = parent / _WARM
    # Claiming each folder here stops the run before any ingest if one already exists.
    as_found_dir.mkdir(parents=True, exist_ok=False)
    warm_dir.mkdir(parents=True, exist_ok=False)

    facts = run_facts(run)
    print("pesto bench: reading the source files before any ingest (cold read check)", file=sys.stderr)
    cold = cold_read(_source_paths(run, as_found_dir))
    print(f"pesto bench: ingesting {run.name} (as found)", file=sys.stderr)
    first = time_ingest(run, as_found_dir, "as found", ingest)
    first = replace(first, notes=[*first.notes, _COLD_READ_NOTE])
    print(f"pesto bench: ingesting {run.name} (warm, straight after)", file=sys.stderr)
    second = time_ingest(run, warm_dir, "warm (straight after)", ingest)

    floor = read_floor_for(run, warm_dir)
    size = cache_size(run, warm_dir)
    failed = [a.name for a in second.artifacts if a.state == "failed"]
    if size.ratio is None:
        measured, note = None, "the source files add up to zero bytes, so there is no ratio"
    elif failed:
        measured = None
        note = (
            f"{len(failed)} artifact(s) failed in the warm ingest ({', '.join(failed)}), "
            "so the cache is incomplete and the ratio would flatter it"
        )
    else:
        measured, note = size.ratio, ""

    verdicts = [verdict("cache_ratio", measured, "x", note)]
    server_result = None
    targets = None
    server_failure = None
    notes: list[str] = []
    if measure_server:
        print(f"pesto bench: timing the server on {run.name}", file=sys.stderr)
        try:
            with BenchServer(warm_dir, run) as server:
                # Reopen goes first, on a server that has only just started.
                share = measure_reopen_share(server)
                targets = pick_browser_targets(server)
                values = measure_values(server, targets.iteration, values_samples, targets.iteration_note)
                server_result = ServerMeasures(
                    started_seconds=server.started_seconds, reopen_share=share, values=values
                )
            verdicts += _values_verdicts(values)
        except Exception as exc:
            # The two ingests took minutes; their numbers are kept and the server rows say why they are empty.
            server_result = None
            targets = None
            server_failure = f"{type(exc).__name__}: {exc}"
            notes.append(f"the server stage failed, so its rows are not measured: {server_failure}")
            verdicts += _values_verdicts(None, f"the server stage failed: {server_failure}")
    else:
        verdicts += _values_verdicts(None)
    observations = observation_facts(run, obs_probe)

    return BenchResult(
        pesto_version=_version(),
        measured_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        machine=machine_facts(),
        run=facts,
        cache={
            "parent_dir": str(parent),
            "as_found_dir": str(as_found_dir),
            "warm_dir": str(warm_dir),
        },
        ingests=[first, second],
        read_floor=floor,
        source_reads=source_reads(run, warm_dir),
        source_reads_note=source_reads_note(),
        cache_size=size,
        verdicts=verdicts,
        notes=notes,
        server_failure=server_failure,
        server=server_result,
        browser_targets=targets,
        observations=observations,
        cold_read=cold,
    )


def _values_verdicts(values, off_reason: str = _STAGE_OFF):
    rows = []
    for kind, label in (("realization", "grid/values p95, realization"), ("statistic", "grid/values p95, statistic")):
        summary = getattr(values, kind) if values is not None else None
        if values is None:
            note = off_reason
        else:
            note = next((n for n in values.notes if n.startswith(f"{kind}:")), "")
        measured = summary.p95_seconds if summary is not None else None
        rows.append(verdict("values_p95_seconds", measured, "s", note, label=label))
    return rows


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)

    reason = check_paths(args.run, args.cache_dir, args.json)
    if reason is not None:
        print(f"pesto bench: {reason}", file=sys.stderr)
        return 2

    try:
        result = run_bench(
            args.run,
            args.cache_dir,
            args.json,
            obs_probe=args.obs_probe,
            values_samples=args.values_samples,
        )
    except KeyboardInterrupt:
        print(
            "pesto bench: interrupted; no result written; the caches made so far "
            f"are in {Path(args.cache_dir).resolve()}",
            file=sys.stderr,
        )
        return 130
    except Exception as exc:
        print(f"pesto bench: could not finish: {exc}", file=sys.stderr)
        return 1

    print(format_table(result))
    # The result is written only now, after the stages ran or failed.
    if os.path.lexists(args.json):
        print(f"pesto bench: {args.json} appeared while measuring; result not written", file=sys.stderr)
        return 2
    try:
        write_result_json(args.json, result)
    except Exception as exc:
        print(f"pesto bench: could not write the result: {exc}", file=sys.stderr)
        return 1
    if result.server_failure is not None:
        print(
            f"pesto bench: could not finish: the server stage failed ({result.server_failure}); "
            f"the ingest numbers are in {args.json}",
            file=sys.stderr,
        )
        return 1
    return 0
