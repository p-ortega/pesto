"""FastAPI app factory: mints the session token, installs the gate, and
registers the one route this phase proves the whole launch path on.

There is no unauthenticated route. ``/api/health`` requires the session
token like every other route -- there is no carve-out, per D-01 as written.
"""

from __future__ import annotations

from fastapi import FastAPI

from pesto import __version__
from pesto.api.security import install_security, mint_token


def create_app() -> tuple[FastAPI, str]:
    app = FastAPI(title="pesto", version=__version__)

    token = mint_token()
    app.state.session_token = token
    app.state.initial_run_dir = None

    install_security(app, token)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    return app, token
