"""Measuring pesto's own server: grid/values, obs/frame and grid/section latency, reopen share, browser targets.

The server runs in this process on a daemon thread, bound to 127.0.0.1 only.
The session token stays inside `BenchServer`; it is never printed, stored or
put in a result, and no URL is ever built as a string.
"""

from __future__ import annotations

import http.client
import json
import math
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import numpy as np

from pesto.bench.measure import percentile_summary
from pesto.bench.report import (
    BrowserTargets,
    HeaviestTarget,
    LatencySummary,
    ObsFramesLatency,
    PilotPointTarget,
    ReopenShare,
    RouteTiming,
    SectionLatency,
    ValuesLatency,
)

# Must equal the lists in frontend/src/data/parmap.ts; tests/bench/test_par_columns_match.py checks it.
PAR_TABLE_COLUMNS = ("parnme", "pargp")
PAR_TABLE_OPTIONAL_COLUMNS = ("parlbnd", "parubnd", "partrans")

_START_WAIT_SECONDS = 30.0
_STOP_WAIT_SECONDS = 10.0
_NO_FIRST_ITERATION = "config has no first_iteration; used 0 as the page does"

# The requests the page makes on open, in its order (main.ts boot, then map.ts loadAndDraw).
# {i} is the iteration; the idomain request is made only when the mesh says it has one.
OPEN_ROUTES = (
    "/api/run/config",
    "/api/run/ingest/state",
    "/api/run/view",
    "/api/run/grid/mesh",
    "/api/run/grid/mesh/positions",
    "/api/run/grid/mesh/cell_index",
    "/api/run/grid/mesh/indices",
    "/api/run/grid/mesh/idomain",
    "/api/run/grid/parmap",
    "/api/run/meta",
    "/api/run/grid/pp",
    "/api/run/grid/cells/cell",
    "/api/run/grid/cells/layer",
    "/api/run/grid/cells/xy",
    "/api/run/reals",
    "/api/run/grid/values",
)
_ITERATION_ROUTES = frozenset(
    {
        "/api/run/grid/parmap",
        "/api/run/grid/cells/cell",
        "/api/run/grid/cells/layer",
        "/api/run/grid/cells/xy",
        "/api/run/reals",
    }
)
_SHARE_NOTE = (
    "server share: one request per route on a server that has just started; "
    "the browser check shows the page's real request pattern"
)
_IDOMAIN_NOTE = "the idomain request was skipped because the mesh reports no idomain, as the page does"


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


def _realization_names(body: bytes) -> list[str] | None:
    """The realization names in an answer, or None when the answer cannot be read as that table."""
    import pyarrow as pa

    try:
        table = pa.ipc.open_stream(body).read_all()
        return [str(name) for name in table.column("realization").to_pylist()]
    except (pa.ArrowException, KeyError):
        return None


def page_iteration(server: BenchServer) -> tuple[int, str]:
    """The iteration the page draws: config first_iteration, else 0 with a note."""
    timed, body = server.get("/api/run/config")
    return _iteration_from(timed.status, body)


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
        if names is None:
            notes.append(
                "realization: the realization answer has no readable realization column, "
                "so this kind is not measured"
            )
        elif not names:
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


_FRAME_CANDIDATES = 5
_GROUP_COLUMNS = ("group", "n_sites", "n_placed", "first_iteration", "last_iteration")


def _frames_not_measured(note: str, **found: object) -> ObsFramesLatency:
    return ObsFramesLatency(
        group=found.get("group"),  # type: ignore[arg-type]
        iteration=found.get("iteration"),  # type: ignore[arg-type]
        n_sites=found.get("n_sites"),  # type: ignore[arg-type]
        n_times=found.get("n_times"),  # type: ignore[arg-type]
        summary=None,
        notes=[note],
    )


def _problem_artifact(body: bytes) -> str | None:
    try:
        artifact = json.loads(body).get("artifact")
    except (ValueError, AttributeError):
        return None
    return artifact if isinstance(artifact, str) else None


def _time_axis(server: BenchServer, group: str) -> tuple[dict | None, str]:
    """The group's /obs/times answer, or None with why it could not be read."""
    timed, body = server.get(f"/api/run/obs/times?group={quote(group, safe='')}")
    if timed.status != 200:
        return None, _problem_reason(timed, body)
    try:
        axis = json.loads(body)
        return {"n_sites": int(axis["n_sites"]), "times": [float(t) for t in axis["times"]]}, ""
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        return None, f"the answer could not be read ({type(exc).__name__})"


def measure_obs_frames(server: BenchServer, samples: int) -> ObsFramesLatency:
    """Time obs/frame on the placed group with the most sites times times, at its last iteration.

    The time covers the whole request, manifest reads included. The times are spread over the
    group's exact time axis and the four statistics take turns. Every way this cannot run gives
    no summary and one note that starts "obs/frame:".
    """
    import pyarrow as pa

    from pesto.api.obsmap import STATS

    if samples < 1:
        return _frames_not_measured("obs/frame: no frame requests were asked for, so none was timed")
    timed, body = server.get("/api/run/obs/groups")
    if timed.status == 404 and _problem_artifact(body) == "obs_ens":
        return _frames_not_measured(
            "obs/frame: this run has no observation statistics, so the frame route is not measured"
        )
    if timed.status != 200:
        return _frames_not_measured(
            f"obs/frame: could not read the observation groups ({_problem_reason(timed, body)}), "
            "so the frame route is not measured"
        )
    try:
        table = pa.ipc.open_stream(body).read_all()
        missing = [name for name in _GROUP_COLUMNS if name not in table.column_names]
        rows = table.to_pylist() if not missing else []
    except pa.ArrowException:
        missing, rows = ["a readable table"], []
    if missing:
        return _frames_not_measured(
            f"obs/frame: the observation groups answer could not be read (missing {', '.join(missing)}), "
            "so the frame route is not measured"
        )

    placed = [row for row in rows if (row["n_placed"] or 0) > 0]
    if not placed and rows and all(row["n_placed"] is None for row in rows):
        return _frames_not_measured(
            "obs/frame: the placement of the sites could not be read, so no group is known to have a placed site"
        )
    if not placed:
        return _frames_not_measured("obs/frame: no group has a placed site")
    # Candidates stay in the groups' own order so a tie goes to the first of them.
    keep = sorted(range(len(placed)), key=lambda i: -placed[i]["n_sites"])[:_FRAME_CANDIDATES]
    best: tuple[int, dict, dict] | None = None
    unreadable: list[str] = []
    for i in sorted(keep):
        axis, why = _time_axis(server, placed[i]["group"])
        if axis is None:
            unreadable.append(why)
            continue
        size = axis["n_sites"] * len(axis["times"])
        if best is None or size > best[0]:
            best = (size, placed[i], axis)
    if best is None:
        return _frames_not_measured(
            f"obs/frame: the time axis of {len(unreadable)} group(s) could not be read "
            f"(first: {unreadable[0]}), so there is no time axis to step through"
        )
    size, row, axis = best
    group, times = row["group"], axis["times"]
    if size == 0:
        return _frames_not_measured(
            "obs/frame: no group with a placed site has an exact time axis, so the frame route is not measured",
            group=group,
            n_sites=axis["n_sites"],
            n_times=len(times),
        )
    iteration = int(row["last_iteration"] if row["last_iteration"] is not None else row["first_iteration"])

    spots = np.rint(np.linspace(0, len(times) - 1, samples)).astype(int)
    paths = [
        f"/api/run/obs/frame?group={quote(group, safe='')}&iteration={iteration}"
        f"&time={quote(repr(times[spot]), safe='')}&stat={STATS[i % len(STATS)]}"
        for i, spot in enumerate(spots.tolist())
    ]
    summary, note = _time_kind(server, paths, "obs/frame")
    return ObsFramesLatency(
        group=group,
        iteration=iteration,
        n_sites=axis["n_sites"],
        n_times=len(times),
        summary=summary,
        notes=[note] if note else [],
    )


def _section_not_measured(note: str) -> SectionLatency:
    return SectionLatency(n_pieces=None, nlay=None, quads=None, summary=None, notes=[note])


def _problem_detail(timed: Timed, body: bytes) -> str:
    """The problem's status and title, then its detail, which names why a section is refused."""
    reason = _problem_reason(timed, body)
    try:
        detail = json.loads(body).get("detail")
    except (ValueError, AttributeError):
        detail = None
    return reason + (f" ({detail})" if isinstance(detail, str) and detail else "")


def _mesh_diagonal(body: bytes) -> tuple[float, float, float, float]:
    """(ax, ay, bx, by): the mesh bounds' lower-left to upper-right corner, in world coordinates."""
    mesh = json.loads(body)
    xmin, xmax, ymin, ymax = (float(v) for v in mesh["bounds"])
    ox, oy = (float(v) for v in mesh["origin"])
    ends = (xmin + ox, ymin + oy, xmax + ox, ymax + oy)
    if not all(math.isfinite(v) for v in ends):
        raise ValueError("a bound or the origin is not a finite number")
    return ends


def _whole_number(answer: dict, key: str) -> int:
    value = answer[key]
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{key} is not a whole number")
    return value


def measure_section(server: BenchServer, samples: int) -> SectionLatency:
    """Time grid/section on the diagonal from the mesh's lower-left corner to its upper-right one.

    One untimed request reads the piece and layer counts, then `samples` requests are timed.
    The time is recorded with no verdict. Every way this cannot run gives no summary and one
    note that starts "section:".
    """
    if samples < 1:
        return _section_not_measured("section: no section requests were asked for, so none was timed")
    timed, body = server.get("/api/run/grid/mesh")
    if timed.status != 200:
        return _section_not_measured(
            f"section: could not read the mesh ({_problem_reason(timed, body)}), "
            "so the section route is not measured"
        )
    try:
        ends = _mesh_diagonal(body)
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        return _section_not_measured(
            f"section: the mesh answer could not be read ({type(exc).__name__}: {exc}), "
            "so the section route is not measured"
        )
    # repr keeps every digit of each float; quote keeps a "+" in an exponent from reading as a space.
    query = "&".join(f"{key}={quote(repr(value), safe='')}" for key, value in zip(("ax", "ay", "bx", "by"), ends))
    path = f"/api/run/grid/section?{query}"

    timed, body = server.get(path)
    if timed.status != 200:
        return _section_not_measured(
            f"section: the route refused the whole-mesh diagonal ({_problem_detail(timed, body)}), "
            "so it is not measured"
        )
    try:
        answer = json.loads(body)
        n_pieces, nlay = _whole_number(answer, "n_pieces"), _whole_number(answer, "nlay")
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        return _section_not_measured(
            f"section: the section answer could not be read ({type(exc).__name__}: {exc}), "
            "so the section route is not measured"
        )

    summary, note = _time_kind(server, [path] * samples, "section")
    return SectionLatency(
        n_pieces=n_pieces,
        nlay=nlay,
        quads=n_pieces * nlay,
        summary=summary,
        notes=[note] if note else [],
    )


def _names(names: tuple[str, ...]) -> str:
    return ",".join(quote(name, safe="") for name in names)


def _route(path: str, iteration: int, realization: str | None) -> str:
    if path == "/api/run/meta":
        return (
            f"/api/run/meta?kind=par&columns={_names(PAR_TABLE_COLUMNS)}"
            f"&optional_columns={_names(PAR_TABLE_OPTIONAL_COLUMNS)}"
        )
    if path == "/api/run/grid/values":
        who = f"realization={quote(realization, safe='')}" if realization is not None else "stat=mean"
        return f"{path}?iteration={iteration}&{who}"
    if path in _ITERATION_ROUTES:
        return f"{path}?iteration={iteration}"
    return path


def measure_reopen_share(server: BenchServer, iteration: int | None = None) -> ReopenShare:
    """One request per route the page asks for on open, in the page's order.

    Meant to run right after the server starts. With no iteration given, the
    first iteration comes from the config answer, as it does for the page.
    """
    notes = [_SHARE_NOTE]
    requests: list[RouteTiming] = []
    has_idomain = True
    realization: str | None = None
    current = iteration if iteration is not None else 0

    for path in OPEN_ROUTES:
        if path == "/api/run/grid/mesh/idomain" and not has_idomain:
            notes.append(_IDOMAIN_NOTE)
            continue
        route = _route(path, current, realization)
        timed, body = server.get(route)
        requests.append(RouteTiming(route, timed.status, timed.bytes, timed.seconds))
        if path == "/api/run/config" and iteration is None:
            current, note = _iteration_from(timed.status, body)
            if note:
                notes.append(note)
        elif path == "/api/run/grid/mesh" and timed.status == 200:
            try:
                has_idomain = bool(json.loads(body).get("has_idomain", False))
            except ValueError:
                has_idomain = False
        elif path == "/api/run/reals" and timed.status == 200:
            names = _realization_names(body)
            if names is None:
                notes.append("the realization answer has no readable realization column; the values request used stat=mean")
            realization = names[0] if names else None

    failed = [item for item in requests if item.status != 200]
    if failed:
        listed = ", ".join(f"{item.route.split('?')[0]} ({item.status})" for item in failed)
        notes.append(f"{len(failed)} request(s) did not answer 200: {listed}")
    return ReopenShare(
        requests=requests,
        total_seconds=sum(item.seconds for item in requests),
        note="; ".join(notes),
    )


def _iteration_from(status: int, body: bytes) -> tuple[int, str]:
    if status != 200:
        return 0, f"config could not be read (status {status}); used 0 as the page does"
    try:
        first = json.loads(body).get("first_iteration")
    except (ValueError, AttributeError):
        first = None
    if isinstance(first, int) and not isinstance(first, bool):
        return first, ""
    return 0, _NO_FIRST_ITERATION


def _int32(body: bytes) -> np.ndarray:
    return np.frombuffer(body, dtype="<i4")


def _problem_reason(timed: Timed, body: bytes) -> str:
    try:
        title = json.loads(body).get("title")
    except (ValueError, AttributeError):
        title = None
    return f"status {timed.status}" + (f": {title}" if isinstance(title, str) else "")


def _pilot_point_target(server: BenchServer) -> tuple[PilotPointTarget | None, str, set[str]]:
    timed, body = server.get("/api/run/grid/pp")
    if timed.status != 200:
        return None, f"no pilot-point index ({_problem_reason(timed, body)})", set()
    try:
        groups = json.loads(body).get("groups", [])
        names = {g["group"] for g in groups}
        if not groups:
            return None, "the run has no interpolable pilot-point group", names
        best = min(groups, key=lambda g: (-int(g["n_pp"]), str(g["group"])))
        target = PilotPointTarget(str(best["group"]), int(best["layer"]), int(best["n_pp"]))
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        return None, f"the pilot-point index answer could not be read ({type(exc).__name__}: {exc})", set()
    return target, "", names


def _heaviest_target(
    server: BenchServer, iteration: int, interpolated: set[str]
) -> tuple[HeaviestTarget | None, str]:
    base = f"?iteration={iteration}"
    fetched = {}
    for label, path in (
        ("parmap", f"/api/run/grid/parmap{base}"),
        ("cell", f"/api/run/grid/cells/cell{base}"),
        ("layer", f"/api/run/grid/cells/layer{base}"),
        ("par table", "/api/run/meta?kind=par"),
    ):
        timed, body = server.get(path)
        if timed.status != 200:
            return None, f"could not read the {label} ({_problem_reason(timed, body)}), so no heaviest group is named"
        fetched[label] = body
    parmap, cell, layer = (_int32(fetched[k]) for k in ("parmap", "cell", "layer"))
    if not (len(parmap) == len(cell) == len(layer)):
        return None, (
            f"the parmap ({len(parmap)}), cell ({len(cell)}) and layer ({len(layer)}) "
            "arrays differ in length, so no heaviest group is named"
        )
    import pyarrow as pa

    try:
        table = pa.ipc.open_stream(fetched["par table"]).read_all()
    except pa.ArrowException as exc:
        return None, f"the parameter table answer could not be read ({exc}), so no heaviest group is named"
    if "pargp" not in table.column_names:
        return None, "the parameter table has no pargp column, so no heaviest group is named"
    pargp = table.column("pargp").to_pylist()

    seen: dict[tuple[str, int], set[int]] = {}
    for control, c, lay in zip(parmap.tolist(), cell.tolist(), layer.tolist()):
        if c < 0 or lay < 0 or not 0 <= control < len(pargp):
            continue
        group = str(pargp[control])
        if group in interpolated:
            continue
        seen.setdefault((group, lay), set()).add(c)
    if not seen:
        return None, "no parameter group places on any cell"
    group, lay = min(seen, key=lambda key: (-len(seen[key]), key[0], key[1]))
    return HeaviestTarget(group, lay, len(seen[(group, lay)])), ""


def pick_browser_targets(server: BenchServer) -> BrowserTargets:
    """The iteration the page draws, its heaviest group and layer, and the biggest pilot-point group."""
    iteration, iteration_note = page_iteration(server)
    pilot_point, pilot_note, interpolated = _pilot_point_target(server)
    heaviest, heaviest_note = _heaviest_target(server, iteration, interpolated)
    return BrowserTargets(
        iteration=iteration,
        iteration_note=iteration_note,
        heaviest=heaviest,
        heaviest_note=heaviest_note,
        pilot_point=pilot_point,
        pilot_point_note=pilot_note,
    )
