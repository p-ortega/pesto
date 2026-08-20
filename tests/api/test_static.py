"""Served-bundle, no-bundle-fallback, and the tracer's one route, tested
against a real FastAPI app the same way tests/test_launch.py already does."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from pesto.api import static as static_module
from pesto.api.app import create_app
from pesto.api.static import mount_static

BASE_URL = "http://127.0.0.1"


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
