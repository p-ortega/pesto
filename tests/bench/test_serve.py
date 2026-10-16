"""The measuring server, grid/values timing, reopen share, browser targets and the observation statement."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest
from fixtures.synthetic_run import REAL_NAMES, write_synthetic_run

from pesto.bench.serve import BenchServer, Timed, measure_values, page_iteration


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
