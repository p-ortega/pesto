"""End-to-end tests for the launcher, the loopback boundary and the request gate.

These prove the whole thin slice works together before any other route exists:
free-port discovery, the deferred science-stack import, the Host-header and
session-token gate (in that order), and a real CLI launch driven over HTTP.
"""

from __future__ import annotations

import re
import socket
import subprocess
import sys
import time

import httpx
from fastapi.testclient import TestClient

import pesto
from pesto.api.app import create_app
from pesto.launch import find_free_port

LOCAL_BASE_URL = "http://127.0.0.1"


def _client(app) -> TestClient:
    return TestClient(app, base_url=LOCAL_BASE_URL)


def test_health_endpoint_reports_ok_with_the_token():
    app, token = create_app()
    response = _client(app).get("/api/health", params={"token": token})
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": pesto.__version__}


def test_health_endpoint_refuses_a_request_with_no_token():
    app, _token = create_app()
    response = _client(app).get("/api/health")
    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"


def test_health_endpoint_refuses_an_empty_token():
    app, _token = create_app()
    response = _client(app).get("/api/health", params={"token": ""})
    assert response.status_code == 401


def test_health_endpoint_refuses_a_token_off_by_one_character():
    app, token = create_app()
    last_char = token[-1]
    replacement = "a" if last_char != "a" else "b"
    bad_token = token[:-1] + replacement
    response = _client(app).get("/api/health", params={"token": bad_token})
    assert response.status_code == 401


def test_a_foreign_host_header_is_refused_before_the_token_is_considered():
    app, token = create_app()
    response = _client(app).get(
        "/api/health",
        params={"token": token},
        headers={"host": "evil.example.com"},
    )
    assert response.status_code == 400


def test_lookalike_hostnames_are_refused():
    app, token = create_app()
    client = _client(app)
    for lookalike in ("localhost.evil.com", "127.0.0.1.evil.com", "evil-localhost"):
        response = client.get(
            "/api/health",
            params={"token": token},
            headers={"host": lookalike},
        )
        assert response.status_code == 400, lookalike


def test_bracketed_and_ported_local_hosts_are_accepted():
    app, token = create_app()
    client = _client(app)
    for host in ("127.0.0.1:53211", "[::1]:53211"):
        response = client.get(
            "/api/health",
            params={"token": token},
            headers={"host": host},
        )
        assert response.status_code == 200, host


def test_a_missing_or_empty_host_header_is_refused():
    app, token = create_app()
    response = _client(app).get(
        "/api/health",
        params={"token": token},
        headers={"host": ""},
    )
    assert response.status_code == 400


def test_find_free_port_returns_a_bindable_port():
    port = find_free_port()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", port))


def test_importing_pesto_does_not_import_the_science_stack():
    code = (
        "import sys\n"
        "import pesto, pesto.launch, pesto.api.app, pesto.cli\n"
        "print([m for m in ('pyemu', 'flopy', 'matplotlib') if m in sys.modules])\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    assert result.stdout.strip() == "[]"


def test_warm_up_imports_the_science_stack():
    code = (
        "import sys\n"
        "from pesto.warm import warm_up\n"
        "warm_up()\n"
        "print('pyemu' in sys.modules)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    assert result.stdout.strip() == "True"


def test_cli_launch_serves_only_with_the_token():
    code = "from pesto.cli import main\nmain(['--no-browser'])\n"
    proc = subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        url = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    break
                continue
            match = re.search(r"pesto serving (http://\S+)", line)
            if match:
                url = match.group(1)
                break
        assert url is not None, "launcher never printed a served URL"

        parsed_token = url.rsplit("token=", 1)[1]
        base = url.split("/?token=")[0]

        with_token = httpx.get(f"{base}/api/health", params={"token": parsed_token})
        assert with_token.status_code == 200

        without_token = httpx.get(f"{base}/api/health")
        assert without_token.status_code == 401

        foreign_host = httpx.get(
            f"{base}/api/health",
            params={"token": parsed_token},
            headers={"host": "evil.example.com"},
        )
        assert foreign_host.status_code == 400
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def test_two_launches_do_not_share_a_token():
    app_a, token_a = create_app()
    app_b, token_b = create_app()
    assert token_a != token_b

    client_a = _client(app_a)
    client_b = _client(app_b)

    assert client_a.get("/api/health", params={"token": token_b}).status_code == 401
    assert client_b.get("/api/health", params={"token": token_a}).status_code == 401


def test_a_query_param_token_never_yields_a_cookie():
    app, token = create_app()
    response = _client(app).get("/api/health", params={"token": token})
    assert response.status_code == 200
    assert "set-cookie" not in response.headers


def test_a_header_token_alone_authenticates():
    app, token = create_app()
    response = _client(app).get("/api/health", headers={"x-pesto-token": token})
    assert response.status_code == 200


def test_no_referrer_policy_on_every_response():
    app, token = create_app()
    client = _client(app)

    ok = client.get("/api/health", params={"token": token})
    assert ok.headers.get("referrer-policy") == "no-referrer"

    unauthorized = client.get("/api/health")
    assert unauthorized.headers.get("referrer-policy") == "no-referrer"

    bad_host = client.get(
        "/api/health",
        params={"token": token},
        headers={"host": "evil.example.com"},
    )
    assert bad_host.headers.get("referrer-policy") == "no-referrer"


def test_every_registered_route_refuses_a_tokenless_request():
    app, _token = create_app()
    client = _client(app)

    routes = [
        route
        for route in app.routes
        if hasattr(route, "path") and hasattr(route, "methods")
    ]
    assert routes, "route table is empty -- this invariant must not pass vacuously"

    checked_paths = set()
    for route in routes:
        for method in route.methods:
            if method in ("HEAD", "OPTIONS"):
                continue
            response = client.request(method, route.path)
            assert response.status_code == 401, f"{method} {route.path} answered without a token"
            checked_paths.add(route.path)

    assert "/api/health" in checked_paths


def test_two_concurrent_apps_refuse_each_others_tokens():
    app_a, token_a = create_app()
    app_b, token_b = create_app()

    client_a = _client(app_a)
    client_b = _client(app_b)

    assert client_a.get("/api/health", params={"token": token_b}).status_code == 401
    assert client_b.get("/api/health", params={"token": token_a}).status_code == 401
