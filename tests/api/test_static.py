"""Served-bundle, no-bundle-fallback, and the tracer's one route, tested
against a real FastAPI app the same way tests/test_launch.py already does."""

from __future__ import annotations

import os
import re
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from pesto.api import static as static_module
from pesto.api.app import create_app
from pesto.api.static import mount_static

BASE_URL = "http://127.0.0.1"

_ASSET_SRC_RE = re.compile(r'src="(/[^"]+\.js)"')
_REPO_ROOT = Path(__file__).resolve().parents[2]


def test_fallback_page_served_when_no_static_dir(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(static_module, "STATIC_DIR", tmp_path / "static")
    app = FastAPI()
    mount_static(app)

    response = TestClient(app, base_url=BASE_URL).get("/")
    assert response.status_code == 200
    assert "PESTO_BUILD_FRONTEND" in response.text


def test_built_bundle_served_when_static_dir_exists(monkeypatch, tmp_path: Path) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<html>built bundle</html>")
    monkeypatch.setattr(static_module, "STATIC_DIR", static_dir)

    app = FastAPI()
    mount_static(app)

    response = TestClient(app, base_url=BASE_URL).get("/")
    assert response.status_code == 200
    assert "built bundle" in response.text


def test_run_config_with_no_active_run_returns_409() -> None:
    app, token = create_app()
    response = TestClient(app, base_url=BASE_URL).get(
        "/api/run/config", params={"token": token}
    )
    assert response.status_code == 409
    assert response.headers["content-type"] == "application/problem+json"


def test_the_boot_script_a_real_browser_fetches_needs_no_token() -> None:
    """A browser's <script type="module"> request carries no query string and
    can set no custom header, so the compiled bundle must be reachable with
    neither -- otherwise the code that reads and strips the token can never
    run in the first place."""
    app, _token = create_app()
    client = TestClient(app, base_url=BASE_URL)

    index = client.get("/")
    assert index.status_code == 200

    match = _ASSET_SRC_RE.search(index.text)
    assert match, "index.html has no built module script reference to follow"

    asset = client.get(match.group(1))
    assert asset.status_code == 200


def test_api_routes_still_require_a_token_once_the_bundle_is_public() -> None:
    app, _token = create_app()
    response = TestClient(app, base_url=BASE_URL).get("/api/health")
    assert response.status_code == 401


@pytest.mark.slow
def test_a_wheel_built_from_an_sdist_carries_the_compiled_frontend(tmp_path: Path) -> None:
    """The failure mode research Pitfall 3 documents: a wheel built directly
    from the source tree can succeed by force-including a directory that
    happens to already be on disk, while the same build from a *previously
    produced sdist* has nothing on disk yet and must actually run the hook."""
    env = dict(os.environ)
    env["PESTO_BUILD_FRONTEND"] = "1"

    subprocess.run(
        ["uv", "build", "--sdist", "-o", str(tmp_path)],
        cwd=_REPO_ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    sdists = list(tmp_path.glob("*.tar.gz"))
    assert len(sdists) == 1, sdists
    sdist_path = sdists[0]

    with tarfile.open(sdist_path) as tar:
        names = tar.getnames()
    assert any(name.endswith("frontend/package.json") for name in names)
    assert not any("src/pesto/static" in name for name in names)

    subprocess.run(
        ["uv", "build", "--wheel", str(sdist_path), "-o", str(tmp_path)],
        cwd=_REPO_ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    wheels = list(tmp_path.glob("*.whl"))
    assert len(wheels) == 1, wheels

    with zipfile.ZipFile(wheels[0]) as wheel:
        assert "pesto/static/index.html" in wheel.namelist()
