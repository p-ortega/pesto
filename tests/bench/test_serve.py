"""The measuring server, grid/values timing, reopen share, browser targets and the observation statement."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest
import numpy as np
from fixtures.synthetic_run import (
    CELLS,
    CONTROL_NAMES,
    GROUPS,
    LAYERS,
    MAPPABLE,
    PP_GROUP,
    REAL_NAMES,
    write_synthetic_run,
)
from ingest.fixtures import make_run

from pesto.bench.measure import observation_facts
from pesto.bench.serve import (
    OPEN_ROUTES,
    BenchServer,
    Timed,
    measure_reopen_share,
    measure_values,
    page_iteration,
    pick_browser_targets,
)


@pytest.fixture
def synthetic(tmp_path: Path) -> Path:
    return write_synthetic_run(tmp_path / "run")


@pytest.fixture
def server(synthetic: Path):
    with BenchServer(synthetic / ".pesto", synthetic) as running:
        yield running


def test_the_server_answers_the_config_route(server: BenchServer) -> None:
    timed, body = server.get("/api/run/config")
    assert timed.status == 200
    assert timed.bytes == len(body)
    assert timed.seconds > 0
    assert server.started_seconds is not None and server.started_seconds > 0


def test_values_are_timed_per_kind(server: BenchServer) -> None:
    values = measure_values(server, 0, 25)
    assert values.iteration == 0
    for summary in (values.realization, values.statistic):
        assert summary is not None
        assert summary.count == 25
        assert summary.p95_seconds >= summary.p50_seconds
        assert summary.max_seconds >= summary.p95_seconds
    assert values.notes == []


def test_the_token_is_in_no_repr_and_no_result(
    synthetic: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    known = "known-token-value-for-this-test"
    monkeypatch.setattr("pesto.api.app.mint_token", lambda: known)
    with BenchServer(synthetic / ".pesto", synthetic) as running:
        values = measure_values(running, 0, 5)
        assert values.realization is not None
        assert known not in repr(running)
        assert known not in json.dumps(asdict(values))
        assert "127.0.0.1" not in repr(running)


class _Scripted:
    """A stand-in server: answers the names route, fails chosen values requests."""

    def __init__(self, fail_every: int | None = None, status: int = 500) -> None:
        self.calls = 0
        self.fail_every = fail_every
        self.status = status

    def get(self, path: str) -> tuple[Timed, bytes]:
        import pyarrow as pa

        if path.startswith("/api/run/reals"):
            sink = pa.BufferOutputStream()
            table = pa.table({"realization": list(REAL_NAMES)})
            writer = pa.ipc.new_stream(sink, table.schema)
            writer.write_table(table)
            writer.close()
            body = sink.getvalue().to_pybytes()
            return Timed(200, len(body), 0.001), body
        self.calls += 1
        failed = self.fail_every is not None and self.calls % self.fail_every == 0
        return Timed(self.status if failed else 200, 4, 0.001), b"\0\0\0\0"


def test_one_failed_request_makes_a_kind_not_measured() -> None:
    scripted = _Scripted(fail_every=7, status=502)
    values = measure_values(scripted, 0, 20)  # type: ignore[arg-type]
    assert values.realization is None
    assert values.statistic is None
    joined = " ".join(values.notes)
    assert "realization: 2 of 20 requests failed (first status 502)" in joined
    assert "statistic:" in joined


def test_requests_cycle_realizations_in_file_order_then_statistics() -> None:
    seen: list[str] = []

    class Recording(_Scripted):
        def get(self, path: str):
            if not path.startswith("/api/run/reals"):
                seen.append(path)
            return super().get(path)

    measure_values(Recording(), 3, 4)  # type: ignore[arg-type]
    assert seen[:4] == [
        "/api/run/grid/values?iteration=3&realization=base",
        "/api/run/grid/values?iteration=3&realization=r1",
        "/api/run/grid/values?iteration=3&realization=r2",
        "/api/run/grid/values?iteration=3&realization=base",
    ]
    assert seen[4:] == [
        "/api/run/grid/values?iteration=3&stat=mean",
        "/api/run/grid/values?iteration=3&stat=std",
        "/api/run/grid/values?iteration=3&stat=q05",
        "/api/run/grid/values?iteration=3&stat=q25",
    ]


def test_an_iteration_with_no_data_is_not_measured_with_a_reason(server: BenchServer) -> None:
    values = measure_values(server, 99, 3)
    assert values.realization is None and values.statistic is None
    assert any(note.startswith("realization:") for note in values.notes)
    assert any(note.startswith("statistic:") for note in values.notes)


def test_page_iteration_reads_first_iteration(server: BenchServer) -> None:
    assert page_iteration(server) == (0, "")


def _expected_heaviest() -> tuple[str, int, int]:
    cells: dict[tuple[str, int], set[int]] = {}
    for name, group, cell, layer in zip(CONTROL_NAMES, GROUPS, CELLS, LAYERS):
        if group in MAPPABLE and group != PP_GROUP and cell >= 0:
            cells.setdefault((group, layer), set()).add(cell)
    group, layer = min(cells, key=lambda key: (-len(cells[key]), key[0], key[1]))
    return group, layer, len(cells[(group, layer)])


class _Wrapped:
    """The real server with chosen routes answered by something else."""

    def __init__(self, real: BenchServer, replace: dict[str, tuple[int, bytes]]) -> None:
        self.real = real
        self.replace = replace

    def get(self, path: str) -> tuple[Timed, bytes]:
        for prefix, (status, body) in self.replace.items():
            if path.startswith(prefix):
                return Timed(status, len(body), 0.001), body
        return self.real.get(path)


def test_reopen_share_has_one_timing_per_route_in_the_pages_order(server: BenchServer) -> None:
    share = measure_reopen_share(server)
    routes = [item.route.split("?")[0] for item in share.requests]
    expected = [route for route in OPEN_ROUTES if route != "/api/run/grid/mesh/idomain"]
    assert routes == expected
    assert routes[0] == "/api/run/config"
    assert routes[-1] == "/api/run/grid/values"
    assert all(item.status == 200 for item in share.requests), share.requests
    assert all(item.bytes > 0 and item.seconds > 0 for item in share.requests)
    assert share.total_seconds == pytest.approx(sum(item.seconds for item in share.requests))
    assert "server share" in share.note
    assert "idomain" in share.note  # the page skips it when the mesh has none, and the note says so


def test_reopen_share_names_no_token(synthetic: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    known = "another-known-token-value"
    monkeypatch.setattr("pesto.api.app.mint_token", lambda: known)
    with BenchServer(synthetic / ".pesto", synthetic) as running:
        share = measure_reopen_share(running)
    assert known not in json.dumps(asdict(share))


def test_browser_targets_follow_the_stated_rule(server: BenchServer) -> None:
    targets = pick_browser_targets(server)
    group, layer, cells = _expected_heaviest()
    assert targets.iteration == 0
    assert targets.heaviest is not None
    assert (targets.heaviest.group, targets.heaviest.layer, targets.heaviest.cells) == (group, layer, cells)
    assert targets.pilot_point is not None
    assert targets.pilot_point.group == PP_GROUP
    assert targets.pilot_point.n_pp == 2
    assert isinstance(targets.pilot_point.layer, int)


def test_no_pilot_point_index_gives_a_null_target_and_a_reason(server: BenchServer) -> None:
    problem = json.dumps({"title": "no pilot-point index", "status": 404}).encode()
    wrapped = _Wrapped(server, {"/api/run/grid/pp": (404, problem)})
    targets = pick_browser_targets(wrapped)  # type: ignore[arg-type]
    assert targets.pilot_point is None
    assert "404" in targets.pilot_point_note
    assert targets.heaviest is not None


def test_no_group_on_any_cell_gives_a_null_heaviest_and_a_reason(server: BenchServer) -> None:
    _timed, real = server.get("/api/run/grid/cells/cell?iteration=0")
    nothing = np.full(len(real) // 4, -1, dtype="<i4").tobytes()
    wrapped = _Wrapped(server, {"/api/run/grid/cells/cell": (200, nothing)})
    targets = pick_browser_targets(wrapped)  # type: ignore[arg-type]
    assert targets.heaviest is None
    assert targets.heaviest_note == "no parameter group places on any cell"


def _arrow(columns: dict[str, list]) -> bytes:
    import pyarrow as pa

    sink = pa.BufferOutputStream()
    table = pa.table(columns)
    writer = pa.ipc.new_stream(sink, table.schema)
    writer.write_table(table)
    writer.close()
    return sink.getvalue().to_pybytes()


def test_ties_go_to_the_group_name_then_the_layer() -> None:
    # Block rows in a different order from the control table, so identity must come through parmap.
    pargp = ["B", "A", "A", "B", "A", "B"]
    parmap = np.array([5, 4, 3, 2, 1, 0], dtype="<i4")
    # Row i is control row parmap[i]: groups B, A, B, A, A, B.
    cell = np.array([0, 1, 2, 3, 4, 5], dtype="<i4")
    layer = np.array([0, 1, 0, 1, 1, 0], dtype="<i4")

    class Scripted:
        def get(self, path: str) -> tuple[Timed, bytes]:
            bodies = {
                "/api/run/config": json.dumps({"first_iteration": 2}).encode(),
                "/api/run/grid/parmap": parmap.tobytes(),
                "/api/run/grid/cells/cell": cell.tobytes(),
                "/api/run/grid/cells/layer": layer.tobytes(),
                "/api/run/meta": _arrow({"parnme": [f"p{i}" for i in range(6)], "pargp": pargp}),
                "/api/run/grid/pp": json.dumps(
                    {
                        "groups": [
                            {"group": "Z", "layer": 3, "n_pp": 4},
                            {"group": "M", "layer": 1, "n_pp": 4},
                            {"group": "N", "layer": 0, "n_pp": 2},
                        ]
                    }
                ).encode(),
            }
            body = bodies[path.split("?")[0]]
            return Timed(200, len(body), 0.001), body

    targets = pick_browser_targets(Scripted())  # type: ignore[arg-type]
    assert targets.iteration == 2
    # B: rows 0, 2, 5 -> cells 0, 2, 5 on layer 0 (3 cells). A: rows 1, 3, 4 -> layer 1 (3 cells).
    assert targets.heaviest is not None
    assert (targets.heaviest.group, targets.heaviest.layer, targets.heaviest.cells) == ("A", 1, 3)
    assert targets.pilot_point is not None
    assert (targets.pilot_point.group, targets.pilot_point.layer, targets.pilot_point.n_pp) == ("M", 1, 4)


def test_a_missing_first_iteration_is_zero_with_a_note(server: BenchServer) -> None:
    wrapped = _Wrapped(server, {"/api/run/config": (200, json.dumps({"case": "x"}).encode())})
    targets = pick_browser_targets(wrapped)  # type: ignore[arg-type]
    assert targets.iteration == 0
    assert "used 0" in targets.iteration_note


def _snapshot(folder: Path) -> dict[str, tuple[bool, int, int]]:
    state = {}
    for path in sorted(folder.rglob("*")):
        stat = path.stat()
        state[str(path.relative_to(folder))] = (path.is_dir(), stat.st_size, stat.st_mtime_ns)
    root = folder.stat()
    state["."] = (True, root.st_size, root.st_mtime_ns)
    return state


@pytest.fixture
def obs_run(tmp_path: Path) -> Path:
    folder = tmp_path / "obsrun"
    folder.mkdir()
    make_run(folder, n_real=4, n_obs=3)
    return folder


def test_observation_facts_without_the_probe(obs_run: Path) -> None:
    facts = observation_facts(obs_run, probe=False)
    assert facts.ingest == "not implemented in M0"
    assert [f.name for f in facts.files] == ["case.0.obs.jcb", "case.1.obs.jcb"]
    assert all(f.bytes > 0 for f in facts.files)
    assert facts.probe is None
    assert "not run (pass --obs-probe to time one observation file)" in facts.notes


def test_observation_probe_times_the_lowest_iteration_and_leaves_the_run_alone(obs_run: Path) -> None:
    before = _snapshot(obs_run)
    facts = observation_facts(obs_run, probe=True)
    probe = facts.probe
    assert probe is not None
    assert probe.file == "case.0.obs.jcb"
    assert probe.bytes == (obs_run / "case.0.obs.jcb").stat().st_size
    assert probe.raw_read_seconds is not None and probe.raw_read_seconds >= 0
    assert probe.from_binary_seconds is not None and probe.from_binary_seconds > 0
    assert probe.shape == [4, 3]
    assert "information only, not part of ingest" in probe.note
    assert _snapshot(obs_run) == before


def test_a_failing_probe_is_a_note_not_a_crash(obs_run: Path) -> None:
    (obs_run / "case.0.obs.jcb").write_bytes(b"not an ensemble")
    facts = observation_facts(obs_run, probe=True)
    assert facts.probe is not None
    assert "probe failed:" in facts.probe.note
    assert facts.probe.shape is None


def test_a_run_with_no_observation_ensemble_lists_none(tmp_path: Path) -> None:
    run = write_synthetic_run(tmp_path / "run")
    facts = observation_facts(run, probe=True)
    assert facts.files == []
    assert facts.probe is None
    assert "no observation ensemble present" in facts.notes
