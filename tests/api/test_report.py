"""GET /api/report: a problem report that is safe to post in public, built
with and without an open run, behind the session token, writing nothing."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient
from starlette.routing import Mount

from fixtures.synthetic_run import CASE, write_synthetic_run
from pesto.api.app import create_app
from pesto.api.errorlog import MAX_ERRORS, ErrorLog, error_log, record_exception, record_failure
from pesto.api.problem import problem
from pesto.api.report import ISSUES_URL, MAX_URL_BODY_CHARS, PASTE_LINE
from pesto.cache.layout import CacheLayout, for_run
from pesto.cache.manifest import Manifest

BASE_URL = "http://127.0.0.1"

SECRET_PAR = "kx_northpit_zone9"
SECRET_GROUP = "north pit drains"
SECRET_SITE = "bh-204"


def _client(app, token, **kwargs) -> TestClient:
    client = TestClient(app, base_url=BASE_URL, **kwargs)
    client.headers["x-pesto-token"] = token
    return client


def _open(app, dest: Path) -> None:
    app.state.initial_run_dir = str(dest.resolve())
    app.state.cache_root = str(for_run(dest).root)


def _opened_client(dest: Path) -> tuple[TestClient, object]:
    app, token = create_app()
    _open(app, dest)
    return _client(app, token), app


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    out = {}
    for path in sorted(root.rglob("*")):
        st = path.stat()
        out[str(path.relative_to(root))] = (st.st_size, st.st_mtime_ns)
    return out


def _run_dir(tmp_path: Path) -> Path:
    # A folder name that must not reach the report.
    return write_synthetic_run(tmp_path / "northfield_mine_2025")


def _fail_an_artifact(dest: Path, reason: str, notes: tuple[str, ...] = ()) -> None:
    layout = for_run(dest)
    manifest = Manifest.load(layout)
    manifest.mark_failed("par_ens/1", reason)
    if notes:
        manifest.artifacts["control"].notes = notes
    manifest.save(layout)


# -- no run open ----------------------------------------------------------------


def test_the_report_is_built_with_no_run_open():
    app, token = create_app()
    response = _client(app, token).get("/api/report")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"title", "body", "issue_url", "truncated"}
    assert "- a run is open: no" in body["body"]
    assert "- pesto: " in body["body"] and "- Python: " in body["body"] and "- system: " in body["body"]
    assert "Ingest artifacts" not in body["body"]
    assert body["truncated"] is False


def test_the_report_needs_the_session_token():
    app, _token = create_app()
    response = TestClient(app, base_url=BASE_URL).get("/api/report")
    assert response.status_code == 401


# -- the synthetic run ------------------------------------------------------------


def test_the_report_for_an_open_run_states_kinds_counts_and_artifacts(tmp_path):
    client, _app = _opened_client(_run_dir(tmp_path))
    body = client.get("/api/report").json()["body"]

    assert "- a run is open: yes" in body
    assert "- control file: 1 file (.pst)" in body
    assert "- par ensembles: 2 files (.jcb)" in body
    assert "- grid file: 1 file (.grb)" in body
    assert "- grid kind: DISV" in body
    assert "- parameters: 11" in body
    assert "- realizations: 3" in body
    assert "- iterations: 2 (noptmax 5)" in body
    assert "- par_ens/0: ok" in body
    assert "- config: ok" in body
    assert "None recorded since pesto started." in body


def test_the_report_for_an_open_run_names_nothing_of_the_run(tmp_path):
    dest = _run_dir(tmp_path)
    client, _app = _opened_client(dest)
    payload = client.get("/api/report").json()
    text = payload["title"] + payload["body"] + payload["issue_url"]

    assert CASE not in text
    assert "northfield" not in text
    assert str(tmp_path) not in text
    assert str(Path.home()) not in text
    assert "g4pp_inst0pp" not in text
    # The fixture's parameters and groups: p1..p9, G1..G5, and realizations r1, r2.
    import re

    assert not re.search(r"\b(?:p\d|G\d|G4layer1|pp[01]|r[12])\b", payload["body"])


def test_building_the_report_writes_nothing(tmp_path):
    dest = _run_dir(tmp_path)
    client, _app = _opened_client(dest)
    before = _snapshot(tmp_path)

    assert client.get("/api/report").status_code == 200
    assert client.get("/api/report").status_code == 200

    assert _snapshot(tmp_path) == before


def test_the_report_is_still_built_when_the_run_folder_is_gone(tmp_path):
    app, token = create_app()
    app.state.initial_run_dir = str(tmp_path / "northfield_gone")
    app.state.cache_root = str(tmp_path / "northfield_gone" / ".pesto")
    response = _client(app, token).get("/api/report")

    assert response.status_code == 200
    assert "northfield" not in response.json()["body"]
    assert not (tmp_path / "northfield_gone").exists()


# -- a failed artifact whose reason quotes names and paths ---------------------------


def test_a_failed_artifacts_reason_reaches_the_report_with_every_name_and_path_removed(tmp_path):
    dest = _run_dir(tmp_path)
    reason = (
        f"failed to read {dest}/{CASE}.1.par.jcb: parameter '{SECRET_PAR}' of group "
        f'"{SECRET_GROUP}" is not in the control file; p3 and G2 were dropped; '
        r"a copy sits at C:\Clients\Northfield Mine\backup\run.jcb"
    )
    notes = tuple(f"parameter '{SECRET_PAR}_{i}' is not in the ensemble" for i in range(40)) + (
        f"site `{SECRET_SITE}` read from {Path.home()}/sites/northfield_bores.csv",
    )
    _fail_an_artifact(dest, reason, notes)
    client, _app = _opened_client(dest)
    payload = client.get("/api/report").json()
    text = payload["title"] + payload["body"] + payload["issue_url"]

    assert "- par_ens/1: failed" in payload["body"]
    assert "reason: failed to read <path>/<case>.1.par.jcb: parameter <name> of group <name>" in payload["body"]
    assert "<name> (x2) were dropped" in payload["body"]
    assert "parameter <name> is not in the ensemble (x40)" in payload["body"]
    assert payload["title"].endswith("par_ens/1 failed")
    for secret in (SECRET_PAR, SECRET_GROUP, SECRET_SITE, "northfield", "Northfield", "Clients", CASE):
        assert secret not in text, secret
    assert str(tmp_path) not in text
    assert str(Path.home()) not in text


# -- the error ring buffer -----------------------------------------------------------


def _add_failing_routes(app, dest: Path) -> None:
    @app.get("/api/_test/raises")
    async def _raises(realization: str = ""):
        raise KeyError(f"{SECRET_PAR} not found under {dest}")

    @app.get("/api/_test/bad-gateway")
    async def _bad_gateway():
        return problem(502, "read failure", artifact="grid", detail=f"cannot read {dest}/model.grb for '{SECRET_PAR}'")

    @app.get("/api/_test/not-found")
    async def _not_found():
        return problem(404, "nothing here", detail=SECRET_SITE)

    app.router.routes.sort(key=lambda route: isinstance(route, Mount))


def test_an_unexpected_error_is_kept_and_reported_with_a_short_traceback(tmp_path):
    dest = _run_dir(tmp_path)
    app, token = create_app()
    _open(app, dest)
    _add_failing_routes(app, dest)
    client = _client(app, token, raise_server_exceptions=False)

    failed = client.get("/api/_test/raises", params={"realization": "r2"})
    assert failed.status_code == 500
    assert failed.headers["content-type"] == "application/problem+json"
    assert SECRET_PAR not in failed.text

    body = client.get("/api/report").json()
    assert body["title"].endswith("an error on the server")
    assert "/api/_test/raises, status 500" in body["body"]
    assert "KeyError" in body["body"]
    assert "at test_report.py:" in body["body"]
    assert " in _raises" in body["body"]
    for secret in (SECRET_PAR, "northfield", str(tmp_path), "realization=r2"):
        assert secret not in body["body"], secret


def test_a_problem_of_status_500_or_more_is_kept_and_a_lower_one_is_not(tmp_path):
    dest = _run_dir(tmp_path)
    app, token = create_app()
    _open(app, dest)
    _add_failing_routes(app, dest)
    client = _client(app, token)

    assert client.get("/api/_test/not-found").status_code == 404
    assert client.get("/api/_test/bad-gateway").status_code == 502

    entries = error_log(app.state).entries()
    assert [(e.status, e.where, e.artifact) for e in entries] == [(502, "/api/_test/bad-gateway", "grid")]

    body = client.get("/api/report").json()["body"]
    assert "status 502, artifact grid" in body
    assert "read failure: cannot read <path>/<file>.grb for <name>" in body
    assert SECRET_PAR not in body and SECRET_SITE not in body


def test_a_message_from_a_run_that_is_no_longer_open_is_left_out(tmp_path):
    first = write_synthetic_run(tmp_path / "first")
    second = write_synthetic_run(tmp_path / "second")
    app, token = create_app()
    _open(app, first)
    record_failure(app.state, "ingest", "par_ens/0", f"{SECRET_PAR} is not in the ensemble")
    _open(app, second)

    body = _client(app, token).get("/api/report").json()["body"]
    assert "ingest, artifact par_ens/0" in body
    assert "message left out" in body
    assert SECRET_PAR not in body


def test_the_error_log_keeps_only_the_newest_entries():
    class State:
        initial_run_dir = None

    state = State()
    for i in range(MAX_ERRORS + 5):
        record_failure(state, "ingest", f"par_ens/{i}", "bad")
    kept = error_log(state).entries()
    assert len(kept) == MAX_ERRORS
    assert kept[0].artifact == "par_ens/5" and kept[-1].artifact == f"par_ens/{MAX_ERRORS + 4}"


def test_a_traceback_holds_no_folder_of_this_machine():
    class State:
        initial_run_dir = None
        error_log = ErrorLog()

    try:
        import json

        json.loads("{not json")
    except ValueError as exc:
        record_exception(State, "somewhere", exc)
    (entry,) = State.error_log.entries()
    assert entry.exc_type == "JSONDecodeError"
    assert entry.trace
    for frame in entry.trace:
        assert not frame.startswith("/") and ":\\" not in frame
        assert str(Path.home()) not in frame


# -- the link to a new GitHub issue ---------------------------------------------------


def test_the_issue_link_carries_the_title_and_the_whole_body_when_it_is_short():
    app, token = create_app()
    payload = _client(app, token).get("/api/report").json()

    parts = urlsplit(payload["issue_url"])
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == ISSUES_URL
    query = parse_qs(parts.query)
    assert query["title"] == [payload["title"]]
    assert query["body"] == [payload["body"]]
    assert "+" not in parts.query and " " not in payload["issue_url"]


def test_a_long_report_gives_a_short_link_and_says_so(tmp_path):
    dest = _run_dir(tmp_path)
    client, app = _opened_client(dest)
    for i in range(MAX_ERRORS):
        record_failure(app.state, "ingest", f"par_ens/{i}", "the header could not be read; " * 15)

    payload = client.get("/api/report").json()
    assert len(payload["body"]) > MAX_URL_BODY_CHARS
    assert payload["truncated"] is True
    (url_body,) = parse_qs(urlsplit(payload["issue_url"]).query)["body"]
    assert PASTE_LINE in url_body
    assert len(url_body) < 1000
    assert "- pesto: " in url_body


# -- every note two whole runs produce --------------------------------------------------


def _run_names(cache_root: Path) -> set[str]:
    """Every parameter, group, observation, site and realization name in a cache."""
    import json

    import pyarrow.parquet as pq

    names: set[str] = set()
    for relative, columns in (
        ("control/par.parquet", ("parnme", "pargp")),
        ("control/obs.parquet", ("obsnme", "obgnme")),
        ("control/obs_sites.parquet", ("site", "group")),
    ):
        path = cache_root / relative
        if path.is_file():
            table = pq.read_table(path, columns=list(columns))
            for column in columns:
                names.update(str(v) for v in table.column(column).to_pylist() if v is not None)
    for path in (cache_root / "reals").glob("*.reals.json"):
        names.update(json.loads(path.read_text())["names"])
    # A bare number or one letter names nothing; "base" is pestpp's own word for a realization.
    return {n for n in names if len(n) > 1 and not n.isdigit() and n != "base"}


def _names_found(text: str, names: set[str]) -> list[str]:
    import re

    lowered = text.lower()
    found = []
    for name in sorted(names):
        if name.lower() in lowered and re.search(
            rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])", text, re.IGNORECASE
        ):
            found.append(name)
    return found


def _assert_no_name_survives(run_dir: Path, cache_root: Path, case: str) -> None:
    from pesto.api.scrub import load_known_names, scrubber_for

    names = _run_names(cache_root)
    assert names, "the run has no names to look for"
    manifest = Manifest.load(CacheLayout(root=cache_root))
    notes = [text for a in manifest.artifacts.values() for text in (a.reason, *a.notes) if text]
    assert notes, "the run produced no notes"

    scrubber = scrubber_for(
        case=case, run_dir=run_dir, cache_root=cache_root, names=load_known_names(cache_root)
    )
    for note in notes:
        scrubbed = scrubber.scrub(note)
        assert _names_found(scrubbed, names) == [], (note, scrubbed)
        assert case not in scrubbed, (note, scrubbed)

    # The same with no cached names at all: the own-words rule has to hold alone,
    # except for names made only of pesto's own words.
    bare = scrubber_for(case=case, run_dir=run_dir, cache_root=cache_root)
    own = {n for n in names if bare.scrub(n) == n}
    for note in notes:
        scrubbed = bare.scrub(note)
        assert _names_found(scrubbed, names - own) == [], (note, scrubbed)

    app, token = create_app()
    app.state.initial_run_dir = str(run_dir)
    app.state.cache_root = str(cache_root)
    for note in notes[:MAX_ERRORS]:
        record_failure(app.state, "ingest", "par_ens/0", note)
    payload = _client(app, token).get("/api/report").json()
    text = payload["title"] + payload["body"]
    assert _names_found(text, names) == []
    assert case not in text.replace("<case>", "")
    assert run_dir.name not in text


def test_no_name_from_the_synthetic_run_survives_in_any_note_or_in_the_report(tmp_path):
    dest = write_synthetic_run(tmp_path / "northfield_synthetic")
    _assert_no_name_survives(dest, for_run(dest).root, CASE)


def test_no_name_from_the_example_run_survives_in_any_note_or_in_the_report(tmp_path):
    from pesto.example import CASE as EXAMPLE_CASE
    from pesto.example import write_example_run
    from pesto.ingest.runner import ingest_run

    run_dir = write_example_run(tmp_path / "northfield_example")
    cache_root = tmp_path / "example-cache"
    ingest_run(run_dir, cache_root=cache_root)
    _assert_no_name_survives(run_dir, cache_root, EXAMPLE_CASE)
