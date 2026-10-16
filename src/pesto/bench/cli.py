"""`pesto bench RUN --cache-dir DIR --json FILE`: ingest a run twice and measure it against the speed limits."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Callable

from pesto.bench.measure import (
    cache_size,
    machine_facts,
    read_floor_for,
    run_facts,
    source_reads,
    source_reads_note,
    time_ingest,
)
from pesto.bench.report import (
    BenchResult,
    format_table,
    verdict,
    write_result_json,
)
from pesto.ingest.runner import ingest_run

_AS_FOUND = "ingest-1"
_WARM = "ingest-2"


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
    print(f"pesto bench: ingesting {run.name} (as found)", file=sys.stderr)
    first = time_ingest(run, as_found_dir, "as found", ingest)
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
        verdicts=[verdict("cache_ratio", measured, "x", note)],
    )


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)

    reason = check_paths(args.run, args.cache_dir, args.json)
    if reason is not None:
        print(f"pesto bench: {reason}", file=sys.stderr)
        return 2

    result = run_bench(args.run, args.cache_dir, args.json)
    print(format_table(result))
    write_result_json(args.json, result)
    return 0
