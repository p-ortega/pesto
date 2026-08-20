"""Pin the one error shape the whole app produces: application/problem+json,
built by exactly one function, with every absolute path redacted out of it.

Follows tests/test_launch.py's shape: a local _client(app), one behaviour per
test, exact status codes and exact body keys.
"""

from __future__ import annotations

import json

from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.routing import Mount

from pesto.api import static as static_module
from pesto.api.app import create_app
from pesto.api.problem import problem, problem_from_failure, redact_paths
from pesto.ingest.failures import ReadFailure

LOCAL_BASE_URL = "http://127.0.0.1"


def _client(app) -> TestClient:
    return TestClient(app, base_url=LOCAL_BASE_URL)


def _add_test_routes(app):
    @app.get("/api/_test/typed")
    async def _typed(iteration: int):
        return {"iteration": iteration}

    @app.get("/api/_test/boom")
    async def _boom():
        raise HTTPException(404, "no such realization")

    # When a frontend has been built, create_app has already mounted the static
    # catch-all at "/", which would shadow anything registered after it. The sort
    # is stable, so this only moves mounts to the end.
    app.router.routes.sort(key=lambda route: isinstance(route, Mount))


def test_a_validation_failure_returns_422_problem_json():
    app, token = create_app()
    _add_test_routes(app)
    response = _client(app).get(
        "/api/_test/typed", params={"iteration": "notanumber", "token": token}
    )
    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["type"] == "about:blank"
    assert body["status"] == 422
    assert "title" in body


def test_a_validation_failure_does_not_echo_the_rejected_value():
    app, token = create_app()
    _add_test_routes(app)
    response = _client(app).get(
        "/api/_test/typed", params={"iteration": "notanumber", "token": token}
    )
    assert "notanumber" not in response.text


def test_a_route_raised_404_returns_problem_json_with_the_raised_detail_as_title():
    app, token = create_app()
    _add_test_routes(app)
    response = _client(app).get("/api/_test/boom", params={"token": token})
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["title"] == "no such realization"


def test_problem_from_failure_maps_name_to_artifact_and_reason_to_detail_no_path():
    failure = ReadFailure(
        name="config",
        path="/Users/x/run/x.pst",
        reason="could not read /Users/x/run/x.pst: No such file",
    )
    response = problem_from_failure(502, failure)
    body = json.loads(response.body)
    assert body["artifact"] == "config"
    assert "x.pst" in body["detail"]
    assert "/Users/x/run" not in body["detail"]
    assert "path" not in body


def test_redact_paths_reduces_an_absolute_posix_path_to_its_final_component():
    text = "could not read /Users/x/run/case.pst: nope"
    assert redact_paths(text) == "could not read case.pst: nope"


def test_redact_paths_reduces_an_absolute_windows_path_to_its_final_component():
    text = r"could not read C:\Users\x\run\case.pst: nope"
    assert redact_paths(text) == "could not read case.pst: nope"


def test_redact_paths_leaves_a_bare_file_name_alone():
    text = "could not read case.pst: nope"
    assert redact_paths(text) == text


def test_redact_paths_reduces_a_posix_path_with_a_space_in_a_middle_segment():
    text = "[Errno 13] Permission denied: '/Users/John Smith/pesto-run/config.json'"
    assert redact_paths(text) == "[Errno 13] Permission denied: 'config.json'"


def test_redact_paths_reduces_a_posix_path_with_a_space_in_the_final_directory():
    text = "could not read /Volumes/Field Data/escondida run/case.pst: nope"
    assert redact_paths(text) == "could not read case.pst: nope"


def test_redact_paths_reduces_a_windows_path_with_a_space():
    text = r"could not read C:\Users\John Smith\run\case.pst: nope"
    assert redact_paths(text) == "could not read case.pst: nope"


def test_redact_paths_leaves_trailing_prose_intact_after_a_spaceless_path():
    text = "reading /a/b/c.pst failed badly"
    assert redact_paths(text) == "reading c.pst failed badly"


def test_redact_paths_leaves_a_url_alone():
    text = "see http://host/a/b for details"
    assert redact_paths(text) == text


def test_problem_from_failure_redacts_a_path_with_a_space_via_the_known_path():
    failure = ReadFailure(
        name="config",
        path="/Users/John Smith/run/x.pst",
        reason="could not read /Users/John Smith/run/x.pst: No such file",
    )
    response = problem_from_failure(502, failure)
    body = json.loads(response.body)
    assert body["detail"] == "could not read x.pst: No such file"
    assert "John Smith" not in body["detail"]


def test_the_security_middlewares_400_and_401_refusals_carry_the_problem_media_type():
    app, token = create_app()
    client = _client(app)

    bad_host = client.get(
        "/api/health", params={"token": token}, headers={"host": "evil.example.com"}
    )
    assert bad_host.status_code == 400
    assert bad_host.headers["content-type"] == "application/problem+json"

    no_token = client.get("/api/health")
    assert no_token.status_code == 401
    assert no_token.headers["content-type"] == "application/problem+json"


def test_no_problem_response_carries_the_session_token():
    app, token = create_app()
    _add_test_routes(app)
    client = _client(app)

    responses = [
        client.get("/api/health"),
        client.get("/api/health", params={"token": token}, headers={"host": "evil.example.com"}),
        client.get("/api/_test/typed", params={"iteration": "notanumber", "token": token}),
        client.get("/api/_test/boom", params={"token": token}),
    ]
    for response in responses:
        assert token not in response.text


def test_problem_builder_sets_referrer_policy_no_referrer():
    response = problem(400, "t")
    assert response.headers["Referrer-Policy"] == "no-referrer"


def test_an_unmatched_path_stays_problem_json_behind_the_static_mount(monkeypatch, tmp_path):
    """With a frontend built, a catch-all StaticFiles mount sits at "/" and answers
    every path no route claimed. Its 404 must still come back as problem+json, or
    the one-error-shape promise holds only until someone mistypes a URL."""
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<!doctype html><title>pesto</title>")
    monkeypatch.setattr(static_module, "STATIC_DIR", static_dir)

    app, token = create_app()
    client = _client(app)

    for path in ["/api/does-not-exist", "/api/run/nope", "/totally-unknown"]:
        response = client.get(path, headers={"x-pesto-token": token})
        assert response.status_code == 404, path
        assert response.headers["content-type"] == "application/problem+json", path
