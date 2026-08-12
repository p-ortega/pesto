"""Free-port discovery and the readiness-gated serve loop.

``serve()`` never starts the warm-up thread or opens the browser on a fixed
wall-clock delay. Both are gated on ``uvicorn.Server.started`` becoming
``True`` -- the port is genuinely bound and accepting connections at that
point, not merely requested. The URL is printed unconditionally (D-10):
launching a browser usually reports success even when nothing appears, so
pesto cannot detect its own failure and must not pretend to.
"""

from __future__ import annotations

import socket
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from pesto.api.app import create_app


def prepare_run(run_dir: Path, cache_override: Path | None = None):
    """Resolve and lay down this run's cache, returning a usable layout.

    The cache layout module is imported here rather than at module scope so
    that ``pesto.launch`` stays importable without pulling in the
    ``pesto.cache`` package -- LAUNCH-01's deferred-import contract only
    guards against pyemu/flopy/matplotlib, but keeping this import local as
    well means importing ``pesto.launch`` alone never touches the cache
    package either.
    """
    import pesto.cache.layout as cache_layout

    layout = cache_layout.for_run(run_dir, cache_override)
    layout.ensure()
    return layout


def find_free_port() -> int:
    """Ask the OS for a free ephemeral port on the loopback interface.

    There is a microsecond-wide race between this socket releasing the port
    and uvicorn binding to it. That window is an accepted, extremely
    low-probability failure mode for a single-user local app -- not
    engineered around, per RESEARCH.md Pitfall 5.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def serve(
    host: str = "127.0.0.1",
    port: int | None = None,
    open_browser: bool = True,
    run_dir: Path | None = None,
    cache_override: Path | None = None,
) -> None:
    cache_root: str | None = None
    if run_dir is not None:
        # Prepare the cache before the server exists at all: a mistyped run
        # directory (NotADirectoryError) must surface before anything is
        # bound, not after.
        layout = prepare_run(run_dir, cache_override)
        cache_root = str(layout.root)
        # Printing which of the two possible locations was chosen matters for
        # the same reason D-10 prints the URL unconditionally: the cache can
        # legitimately land in either place, and a user who cannot see which
        # one has no way to find, inspect or delete it.
        print(f"pesto cache at {cache_root}", flush=True)

    resolved_port = find_free_port() if port is None else port
    app, token = create_app()
    app.state.initial_run_dir = str(run_dir) if run_dir else None
    app.state.cache_root = cache_root
    url = f"http://{host}:{resolved_port}/?token={token}"

    config = uvicorn.Config(app, host=host, port=resolved_port, log_level="warning")
    server = uvicorn.Server(config)

    def _warm_up_stack() -> None:
        from pesto.warm import warm_up

        warm_up()

    def _after_startup() -> None:
        # Runs once server.started flips True -- the port is genuinely bound
        # and accepting connections at this point, not merely "requested".
        while not server.started:
            time.sleep(0.005)
        threading.Thread(target=_warm_up_stack, daemon=True, name="pesto-warmup").start()
        # flush=True: stdout is fully buffered (not line-buffered) once it's
        # piped rather than attached to a tty, so a caller reading this line
        # (e.g. a subprocess-driven CLI test) would otherwise block forever
        # waiting for a flush that only happens on process exit.
        print(f"pesto serving {url}", flush=True)  # D-10: always print, regardless of browser-open outcome
        if open_browser:
            webbrowser.open(url)

    threading.Thread(target=_after_startup, daemon=True, name="pesto-after-startup").start()
    server.run()  # blocks the calling thread
