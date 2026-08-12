"""argparse entry point for the ``pesto`` console script.

The run directory is optional (D-09): ``pesto`` with no arguments must start
and let the user pick a directory from inside the app later, because M4
packages pesto as an icon with no command line to type a path into.
"""

from __future__ import annotations

import argparse
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pesto")
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

    args = parser.parse_args(argv)

    from pesto.launch import serve

    serve(host=args.host, port=args.port, open_browser=not args.no_browser, run_dir=args.path)
    return 0
