"""Session token minting and the combined Host-header plus token gate.

The session token is minted once per process and is immutable for that
process's lifetime, so every request handled by this process compares
against the same value, and two pesto processes running at the same time
hold distinct tokens on distinct ports.

This is a single piece of middleware, not two gates bolted together: the
Host check runs first and refuses a foreign hostname with 400 before the
token is even read, so a request from a foreign Host never learns whether
its token was valid. Only once the Host is confirmed local does the token
check run, refusing a missing, empty or wrong token with 401. Neither check
fails open: if either evaluation cannot be completed, the request is
refused.

Do not reach for the framework's bundled host-allowlist middleware here: it
has a documented port-handling defect (Kludex/starlette #1997/#1998), and
pesto's own port changes every launch, so a fixed allowlist is the wrong
shape regardless.
"""

from __future__ import annotations

import hmac
import secrets

from fastapi import FastAPI, Request
from starlette.responses import JSONResponse

LOCAL_HOSTNAMES = {"127.0.0.1", "localhost", "::1", "[::1]"}

TOKEN_QUERY_PARAM = "token"
TOKEN_HEADER = "x-pesto-token"
TOKEN_COOKIE = "pesto_token"


def mint_token() -> str:
    """Return a fresh, CSPRNG-backed session token.

    Never ``random``, never ``uuid4`` -- neither is a security primitive.
    """
    return secrets.token_urlsafe(32)


def _hostname_only(host_header: str) -> str:
    """Strip the port from a Host header, keeping bracketed IPv6 literals intact.

    ``"127.0.0.1:53211"`` yields ``"127.0.0.1"``; ``"[::1]:53211"`` yields ``"[::1]"``.
    """
    if host_header.startswith("["):
        return host_header.rsplit("]", 1)[0] + "]"
    return host_header.rsplit(":", 1)[0]


def _supplied_token(request: Request) -> str:
    """Read the caller's token from the fixed source order: query, header, cookie."""
    query_token = request.query_params.get(TOKEN_QUERY_PARAM)
    if query_token:
        return query_token
    header_token = request.headers.get(TOKEN_HEADER)
    if header_token:
        return header_token
    return request.cookies.get(TOKEN_COOKIE, "")


def install_security(app: FastAPI, token: str) -> None:
    """Register the one HTTP middleware guard every route passes through."""

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        host = request.headers.get("host", "")
        if _hostname_only(host) not in LOCAL_HOSTNAMES:
            return JSONResponse(
                {"type": "about:blank", "title": "invalid host", "status": 400},
                status_code=400,
                media_type="application/problem+json",
            )

        supplied = _supplied_token(request)
        if not hmac.compare_digest(supplied, token):
            return JSONResponse(
                {"type": "about:blank", "title": "invalid or missing token", "status": 401},
                status_code=401,
                media_type="application/problem+json",
            )

        return await call_next(request)
