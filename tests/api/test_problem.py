"""Pin the one error shape the whole app produces: application/problem+json,
built by exactly one function, with every absolute path redacted out of it.

Follows tests/test_launch.py's shape: a local _client(app), one behaviour per
test, exact status codes and exact body keys.
"""

from __future__ import annotations

import json

from fastapi import HTTPException
from fastapi.testclient import TestClient

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
