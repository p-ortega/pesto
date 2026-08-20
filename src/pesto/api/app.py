"""FastAPI app factory: mints the session token, installs the gate, and
registers every route this app serves.

Every ``/api/*`` route requires the session token -- there is no carve-out,
per D-01 as written. The compiled frontend bundle is the one exception
(security.py explains why); the auto-generated docs routes (``/docs``,
``/redoc``, ``/openapi.json``) are disabled outright rather than folded into
that exception, so the boundary stays exactly "the bundle is public, the API
is not."
"""

from __future__ import annotations

from fastapi import FastAPI

from pesto import __version__
from pesto.api import fs, grid, ingest, runs, tables, values
from pesto.api.security import install_security, mint_token
from pesto.api.static import mount_static


def create_app() -> tuple[FastAPI, str]:
    app = FastAPI(title="pesto", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)

    token = mint_token()
    app.state.session_token = token
    app.state.initial_run_dir = None
    app.state.fs_ids = {}

    install_security(app, token)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    app.include_router(runs.router)
    app.include_router(fs.router)
    app.include_router(tables.router)
    app.include_router(grid.router)
    app.include_router(values.router)
    app.include_router(ingest.router)
    mount_static(app)

    return app, token
