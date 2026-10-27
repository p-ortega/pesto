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
from pesto.bench.report import ArtifactTiming
from pesto.ingest import runner
from pesto.ingest.runner import ingest_run
from pesto.bench.serve import (
    OPEN_ROUTES,
    BenchServer,
    Timed,
    _route,
    measure_obs_frames,
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


def test_the_meta_route_carries_the_pages_own_column_lists() -> None:
    assert _route("/api/run/meta", 0, None) == (
        "/api/run/meta?kind=par&columns=parnme,pargp&optional_columns=parlbnd,parubnd,partrans"
    )


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


def test_a_pilot_point_index_of_the_wrong_shape_gives_a_reason_not_a_crash(server: BenchServer) -> None:
    for body in (b"not json", json.dumps({"groups": [{"group": "G"}]}).encode(), json.dumps([1]).encode()):
        wrapped = _Wrapped(server, {"/api/run/grid/pp": (200, body)})
        targets = pick_browser_targets(wrapped)  # type: ignore[arg-type]
        assert targets.pilot_point is None
        assert "could not be read" in targets.pilot_point_note
        assert targets.heaviest is not None


def test_a_realization_answer_without_the_realization_column_is_noted_not_raised(
    server: BenchServer,
) -> None:
    wrapped = _Wrapped(server, {"/api/run/reals": (200, _arrow({"name": ["a"]}))})
    values = measure_values(wrapped, 0, 5)  # type: ignore[arg-type]
    assert values.realization is None
    assert any(n.startswith("realization:") and "no readable realization column" in n for n in values.notes)
    assert values.statistic is not None
    share = measure_reopen_share(wrapped)  # type: ignore[arg-type]
    assert "no readable realization column" in share.note


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


def _timing(name: str, state: str, reason: str | None = None) -> ArtifactTiming:
    return ArtifactTiming(name, state, 0.1, None, 10, 5, reason)


def test_observation_facts_without_the_probe(obs_run: Path) -> None:
    facts = observation_facts(obs_run, probe=False, artifacts=[_timing("obs_ens/0", "ok")])
    assert facts.ingest == "obs_ens/0 ok"
    assert [f.name for f in facts.files] == ["case.0.obs.jcb", "case.1.obs.jcb"]
    assert all(f.bytes > 0 for f in facts.files)
    assert facts.probe is None
    assert "not run (pass --obs-probe to time one observation file)" in facts.notes


def test_observation_probe_times_the_lowest_iteration_and_leaves_the_run_alone(obs_run: Path) -> None:
    before = _snapshot(obs_run)
    facts = observation_facts(obs_run, probe=True, artifacts=[])
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
    facts = observation_facts(obs_run, probe=True, artifacts=[])
    assert facts.probe is not None
    assert "probe failed:" in facts.probe.note
    assert facts.probe.shape is None


def test_a_run_with_no_observation_ensemble_lists_none(tmp_path: Path) -> None:
    run = write_synthetic_run(tmp_path / "run")
    facts = observation_facts(run, probe=True, artifacts=[])
    assert facts.files == []
    assert facts.probe is None
    assert "no observation ensemble present" in facts.notes


def test_a_failed_observation_artifact_shows_its_reason_in_the_ingest_text(obs_run: Path) -> None:
    reason = "obs_ens/1: reading case.1.obs.jcb would need about 9.0 GB"
    rows = [
        _timing("control", "ok"),
        _timing("obs_ens/0", "ok"),
        _timing("obs_ens/1", "failed", reason),
    ]
    facts = observation_facts(obs_run, probe=False, artifacts=rows)
    assert facts.ingest == f"obs_ens/0 ok; obs_ens/1 failed: {reason}"


def test_with_no_observation_artifact_the_ingest_text_says_none_was_planned(tmp_path: Path) -> None:
    run = write_synthetic_run(tmp_path / "run")
    facts = observation_facts(run, probe=False, artifacts=[_timing("control", "ok")])
    assert facts.ingest == "no observation ensemble was planned for this run"


# ---------------------------------------------------------------------------
# obs/frame: the time slider's route, timed on a run with observation statistics
# ---------------------------------------------------------------------------


@pytest.fixture
def in_process(monkeypatch):
    """Run every ingest worker in this process, with the real adapter."""

    def _call(fn, *args):
        try:
            return True, fn(*args)
        except Exception as exc:
            return False, exc

    monkeypatch.setattr(runner, "_run_isolated", _call)


def _served_obs_run(tmp_path: Path, sites=None, iterations=(0, 1)):
    from ingest.obs_fixtures import DEFAULT_SITES, GRID_SITES, make_obs_run

    chosen = DEFAULT_SITES + GRID_SITES if sites is None else sites
    run = make_obs_run(tmp_path / "run", grid=True, sites=chosen, iterations=iterations)
    ingest_run(run.root, cache_root=tmp_path / "cache")
    return BenchServer(tmp_path / "cache", run.root)


class _Recording:
    """Passes every request to the real server and keeps the paths."""

    def __init__(self, real: BenchServer) -> None:
        self.real = real
        self.paths: list[str] = []

    def get(self, path: str) -> tuple[Timed, bytes]:
        self.paths.append(path)
        return self.real.get(path)

    def frames(self) -> list[str]:
        return [p for p in self.paths if p.startswith("/api/run/obs/frame")]


def _wide_site():
    from ingest.obs_fixtures import SiteSpec

    return SiteSpec(
        "gw_wide", "oname:hds_otype:lst_usecol:icpl-w", (1.0, 2.0, 3.0), "time-token",
        extras={"icpl": "0", "layer": "0"},
    )


def test_a_frame_is_timed_on_the_largest_placed_group_at_the_last_iteration(tmp_path, in_process) -> None:
    with _served_obs_run(tmp_path) as running:
        recording = _Recording(running)
        frames = measure_obs_frames(recording, 12)  # type: ignore[arg-type]
    # gw_head and gw_date have more times but no placed site, so the placed gw_icpl is chosen.
    assert frames.group == "gw_icpl"
    assert frames.iteration == 1
    assert frames.notes == []
    assert frames.summary is not None and frames.summary.count == 12
    assert frames.summary.p95_seconds >= frames.summary.p50_seconds
    requested = recording.frames()
    assert len(requested) == 12
    assert [p.split("stat=")[1] for p in requested[:5]] == ["resid_mean", "rmse", "std", "mean", "resid_mean"]
    assert all("group=gw_icpl&iteration=1&" in p for p in requested)


def test_the_placed_group_with_the_most_sites_times_times_wins(tmp_path, in_process) -> None:
    from ingest.obs_fixtures import GRID_SITES

    with _served_obs_run(tmp_path, sites=GRID_SITES + (_wide_site(),)) as running:
        frames = measure_obs_frames(running, 6)
    # gw_icpl has two sites and one time (2); gw_wide has one site and three times (3).
    assert frames.group == "gw_wide"
    assert frames.n_times == 3 and frames.n_sites == 1
    assert frames.summary is not None and frames.notes == []


def test_a_tie_goes_to_the_first_group_in_the_groups_answer(tmp_path, in_process) -> None:
    from ingest.obs_fixtures import SiteSpec

    # Two placed groups of one site and three times each.
    twin = _wide_site()
    other = SiteSpec(
        "gw_aaa", "oname:hds_otype:lst_usecol:icpl-a2", (1.0, 2.0, 3.0), "time-token",
        extras={"icpl": "0", "layer": "0"},
    )
    with _served_obs_run(tmp_path, sites=(twin, other)) as running:
        import pyarrow as pa

        _timed, body = running.get("/api/run/obs/groups")
        order = pa.ipc.open_stream(body).read_all().column("group").to_pylist()
        frames = measure_obs_frames(running, 3)
    assert frames.group == order[0]


def test_the_frame_block_holds_no_token(tmp_path, in_process, monkeypatch) -> None:
    known = "frame-block-known-token"
    monkeypatch.setattr("pesto.api.app.mint_token", lambda: known)
    with _served_obs_run(tmp_path) as running:
        frames = measure_obs_frames(running, 4)
    assert frames.summary is not None
    assert known not in json.dumps(asdict(frames))


def test_the_bench_reports_the_frame_row_against_the_limit(tmp_path, in_process) -> None:
    from ingest.obs_fixtures import DEFAULT_SITES, GRID_SITES, make_obs_run

    from pesto.bench.cli import run_bench
    from pesto.bench.limits import SPEED_LIMITS
    from pesto.bench.report import format_table, result_to_dict

    run = make_obs_run(tmp_path / "run", grid=True, sites=DEFAULT_SITES + GRID_SITES, iterations=(0, 1))
    result = run_bench(run.root, tmp_path / "scratch", tmp_path / "out.json", values_samples=8)
    rows = {row.speed_limit: row for row in result.verdicts}
    row = rows["obs/frame p95"]
    assert row.status in ("pass", "miss")
    assert row.measured == result.server.obs_frames.summary.p95_seconds
    assert row.limit == SPEED_LIMITS.obs_frame_p95_seconds
    assert "obs/frame p95" in format_table(result)
    assert result_to_dict(result)["server"]["obs_frames"]["summary"]["count"] == 8


def _not_measured(frames, reason_start: str = "obs/frame:") -> str:
    assert frames.summary is None
    assert len(frames.notes) == 1 and frames.notes[0].startswith(reason_start)
    return frames.notes[0]


def test_a_run_with_no_observation_statistics_is_not_measured_and_never_a_pass(server) -> None:
    from pesto.bench.cli import _obs_frame_verdict

    frames = measure_obs_frames(server, 6)
    assert _not_measured(frames) == (
        "obs/frame: this run has no observation statistics, so the frame route is not measured"
    )
    row = _obs_frame_verdict(frames)
    assert row.speed_limit == "obs/frame p95"
    assert row.status == "not measured" and row.measured is None
    assert row.note == frames.notes[0]


def test_groups_with_no_placed_site_are_not_measured(tmp_path, in_process) -> None:
    from ingest.obs_fixtures import DEFAULT_SITES

    with _served_obs_run(tmp_path, sites=DEFAULT_SITES) as running:
        frames = measure_obs_frames(running, 6)
    assert _not_measured(frames) == "obs/frame: no group has a placed site"


def test_one_failing_frame_request_makes_the_kind_not_measured_with_its_status(tmp_path, in_process) -> None:
    with _served_obs_run(tmp_path) as running:
        problem = json.dumps({"title": "gone", "status": 404}).encode()
        wrapped = _Wrapped(running, {"/api/run/obs/frame": (404, problem)})
        frames = measure_obs_frames(wrapped, 6)  # type: ignore[arg-type]
    note = _not_measured(frames)
    assert "6 of 6 requests failed (first status 404)" in note
    assert frames.group == "gw_icpl"


def test_a_group_whose_times_cannot_be_read_is_skipped_and_none_left_is_not_measured(
    tmp_path, in_process
) -> None:
    with _served_obs_run(tmp_path) as running:
        problem = json.dumps({"title": "no times", "status": 409}).encode()
        wrapped = _Wrapped(running, {"/api/run/obs/times": (409, problem)})
        frames = measure_obs_frames(wrapped, 6)  # type: ignore[arg-type]
    note = _not_measured(frames)
    assert "status 409" in note and "no time axis" in note


def test_groups_with_no_exact_times_are_not_measured(tmp_path, in_process) -> None:
    with _served_obs_run(tmp_path) as running:
        empty = json.dumps({"n_sites": 2, "times": [], "refused": "mixed time kinds"}).encode()
        wrapped = _Wrapped(running, {"/api/run/obs/times": (200, empty)})
        frames = measure_obs_frames(wrapped, 6)  # type: ignore[arg-type]
    assert "no group with a placed site has an exact time axis" in _not_measured(frames)


def test_a_groups_answer_of_the_wrong_shape_is_not_measured_not_a_crash(server) -> None:
    for body in (b"not arrow", _arrow({"name": ["a"]})):
        wrapped = _Wrapped(server, {"/api/run/obs/groups": (200, body)})
        frames = measure_obs_frames(wrapped, 6)  # type: ignore[arg-type]
        assert "could not be read" in _not_measured(frames)


def test_an_unreadable_placement_is_not_reported_as_no_placed_site(server) -> None:
    import pyarrow as pa

    table = pa.table(
        {
            "group": ["g"],
            "n_sites": pa.array([2], pa.int64()),
            "n_placed": pa.array([None], pa.int64()),
            "first_iteration": pa.array([0], pa.int32()),
            "last_iteration": pa.array([1], pa.int32()),
        }
    )
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    wrapped = _Wrapped(server, {"/api/run/obs/groups": (200, sink.getvalue().to_pybytes())})
    frames = measure_obs_frames(wrapped, 4)  # type: ignore[arg-type]
    assert "placement of the sites could not be read" in _not_measured(frames)


def test_asking_for_no_samples_is_not_measured_with_a_reason(tmp_path, in_process) -> None:
    with _served_obs_run(tmp_path) as running:
        frames = measure_obs_frames(running, 0)
    assert "no frame requests were asked for" in _not_measured(frames)


def test_the_frame_times_spread_over_the_groups_times(tmp_path, in_process) -> None:
    with _served_obs_run(tmp_path, sites=(_wide_site(),)) as running:
        recording = _Recording(running)
        measure_obs_frames(recording, 5)  # type: ignore[arg-type]
    times = [float(p.split("time=")[1].split("&")[0]) for p in recording.frames()]
    assert times[0] == 1.0 and times[-1] == 3.0 and set(times) == {1.0, 2.0, 3.0}
