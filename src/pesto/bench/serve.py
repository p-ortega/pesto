"""Measuring pesto's own server: grid/values latency, reopen share, browser targets.

The server runs in this process on a daemon thread, bound to 127.0.0.1 only.
The session token stays inside `BenchServer`; it is never printed, stored or
put in a result, and no URL is ever built as a string.
"""

from __future__ import annotations

import http.client
import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from pesto.bench.measure import percentile_summary
from pesto.bench.report import LatencySummary, ValuesLatency

_START_WAIT_SECONDS = 30.0
_STOP_WAIT_SECONDS = 10.0
_NO_FIRST_ITERATION = "config has no first_iteration; used 0 as the page does"


@dataclass(frozen=True)
class Timed:
    """One request's outcome. The body is returned beside it, never inside it."""

    status: int
    bytes: int
    seconds: float


class BenchServer:
    """pesto's app served on a free loopback port for the length of a `with` block."""

    def __init__(self, cache_dir: Path, run_dir: Path) -> None:
        self._cache_dir = Path(cache_dir)
        self._run_dir = Path(run_dir)
        self._token: str | None = None
        self._port: int | None = None
        self._server = None
        self._thread: threading.Thread | None = None
        self._conn: http.client.HTTPConnection | None = None
        self.started_seconds: float | None = None

    def __repr__(self) -> str:
        return f"<BenchServer {'running' if self._conn is not None else 'stopped'}>"

    def __enter__(self) -> "BenchServer":
        import uvicorn

        from pesto.api.app import create_app
        from pesto.launch import find_free_port

        app, token = create_app()
        app.state.cache_root = str(self._cache_dir)
        app.state.initial_run_dir = str(self._run_dir)
        self._token = token
        self._port = find_free_port()
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=self._port,
            log_level="warning",
            timeout_keep_alive=120,
        )
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, daemon=True, name="pesto-bench-server")
        began = time.perf_counter()
        self._thread.start()
        while not self._server.started:
            if time.perf_counter() - began > _START_WAIT_SECONDS or not self._thread.is_alive():
                self._stop()
                raise RuntimeError("the measuring server did not start within 30 s")
            time.sleep(0.005)
        self.started_seconds = time.perf_counter() - began
        self._connect()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._stop()

    def _connect(self) -> None:
        self._conn = http.client.HTTPConnection("127.0.0.1", self._port, timeout=120)

    def _stop(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=_STOP_WAIT_SECONDS)

    def _request(self, path: str) -> tuple[int, bytes]:
        assert self._conn is not None and self._token is not None
        self._conn.request("GET", path, headers={"x-pesto-token": self._token})
        response = self._conn.getresponse()
        return response.status, response.read()

    def get(self, path: str) -> tuple[Timed, bytes]:
        """GET a path with the token header; the time covers sending and reading the whole body."""
        if self._conn is None:
            raise RuntimeError("the measuring server is not running")
        start = time.perf_counter()
        try:
            status, body = self._request(path)
        except (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError):
            # The server closed an idle connection; one fresh connection is part of the cost.
            self._conn.close()
            self._connect()
            status, body = self._request(path)
        seconds = time.perf_counter() - start
        return Timed(status, len(body), seconds), body


def _realization_names(body: bytes) -> list[str]:
    import pyarrow as pa

    table = pa.ipc.open_stream(body).read_all()
    return [str(name) for name in table.column("realization").to_pylist()]


def page_iteration(server: BenchServer) -> tuple[int, str]:
    """The iteration the page draws: config first_iteration, else 0 with a note."""
    timed, body = server.get("/api/run/config")
    if timed.status == 200:
        try:
            first = json.loads(body).get("first_iteration")
        except ValueError:
            first = None
        if isinstance(first, int) and not isinstance(first, bool):
            return first, ""
    return 0, _NO_FIRST_ITERATION


def _time_kind(
    server: BenchServer, paths: list[str], label: str
) -> tuple[LatencySummary | None, str | None]:
    seconds: list[float] = []
    failed = 0
    first_status = 0
    for path in paths:
        timed, _body = server.get(path)
        if timed.status != 200:
            failed += 1
            first_status = first_status or timed.status
        seconds.append(timed.seconds)
    if failed:
        return None, (
            f"{label}: {failed} of {len(paths)} requests failed (first status {first_status}), "
            "so this kind is not measured"
        )
    return percentile_summary(seconds), None


def measure_values(
    server: BenchServer, iteration: int, samples: int, iteration_note: str = ""
) -> ValuesLatency:
    """Time grid/values: realizations in file order, then each statistic other than value."""
    from pesto.api.enscache import STATS

    notes: list[str] = [iteration_note] if iteration_note else []
    base = f"/api/run/grid/values?iteration={iteration}"

    realization = statistic = None
    timed, body = server.get(f"/api/run/reals?iteration={iteration}")
    if timed.status != 200:
        notes.append(
            f"realization: could not read the realization names (status {timed.status}), "
            "so this kind is not measured"
        )
    else:
        names = _realization_names(body)
        if not names:
            notes.append("realization: the run lists no realization names, so this kind is not measured")
        else:
            paths = [f"{base}&realization={quote(names[i % len(names)], safe='')}" for i in range(samples)]
            realization, note = _time_kind(server, paths, "realization")
            if note:
                notes.append(note)

    stats = [name for name in STATS if name != "value"]
    paths = [f"{base}&stat={stats[i % len(stats)]}" for i in range(samples)]
    statistic, note = _time_kind(server, paths, "statistic")
    if note:
        notes.append(note)

    return ValuesLatency(iteration=iteration, realization=realization, statistic=statistic, notes=notes)
