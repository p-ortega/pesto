"""argparse entry point for the ``pesto`` console script.

The run directory is optional (D-09): ``pesto`` with no arguments must start
and let the user pick a directory from inside the app later, because M4
packages pesto as an icon with no command line to type a path into.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    # Only a first argument of exactly "bench" is the measuring command, so
    # `pesto <path>` parses as before. Imported here to keep this module light.
    if raw[:1] == ["bench"]:
        from pesto.bench.cli import main as bench_main

        return bench_main(raw[1:])

    parser = argparse.ArgumentParser(
        prog="pesto",
        epilog=(
            "To measure a run against pesto's speed limits, use "
            "`pesto bench RUN --cache-dir DIR --json FILE`. A run folder named "
            "bench must be given as ./bench."
        ),
    )
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=None,
        help="PEST working directory to open. Omit to choose one in the app.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="Port to bind (default: pick a free one)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser tab")
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=None,
        help="Put this run's cache here instead of choosing automatically",
    )

    args = parser.parse_args(raw)

    cache_override = args.cache_dir
    if cache_override is not None and str(cache_override) == "":
        parser.error("--cache-dir must not be empty")

    from pesto.launch import serve

    try:
        serve(
            host=args.host,
            port=args.port,
            open_browser=not args.no_browser,
            run_dir=args.path,
            cache_override=cache_override,
        )
    except NotADirectoryError as exc:
        # A mistyped run directory should read as a mistyped path, not as a
        # traceback.
        print(str(exc), file=sys.stderr)
        return 2

    return 0
