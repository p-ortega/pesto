"""Session token minting and the combined Host-header plus token gate.

The session token is minted once per process and is immutable for that
process's lifetime, so every request handled by this process compares
against the same value, concurrent requests all compare against that one
value, and two pesto processes running at the same time hold distinct
tokens on distinct ports and each refuses the other's token with 401.

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

D-08: the URL token authenticates the boot request only. The frontend reads
it once, strips it from the address bar with `history.replaceState`, and
sends it as the `X-Pesto-Token` header on every request after that. There is
no cookie handoff -- a token that only ever rides a header cannot leak
through a bookmark, browser history, or a proxy access log the way a URL
token can. `Referrer-Policy: no-referrer` is set on every response, success
and refusal alike, so a token that does travel in a URL cannot ride a
`Referer` header to a third-party origin.

Only `/api/*` requires the token. The compiled bundle -- `index.html` and its
built JS/CSS -- is a static asset with no run data in it, and a browser
fetches a `<script type="module">`'s subresource with no query string and no
way to attach a custom header, so gating it would make the boot script that
is supposed to read and strip the token unable to load at all. The Host
check still runs first for every request, static or not; only the token
check is scoped to `/api/*`. FastAPI's own `/docs`, `/redoc` and
`/openapi.json` are disabled entirely in `create_app()` rather than folded
into this exemption, so "everything outside `/api/*` is public on loopback"
stays a fact about the compiled bundle only, not about the API's shape.
"""

from __future__ import annotations

import hmac
import secrets

from fastapi import FastAPI, Request
from starlette.responses import Response

from pesto.api.problem import problem

LOCAL_HOSTNAMES = {"127.0.0.1", "localhost", "::1", "[::1]"}

TOKEN_QUERY_PARAM = "token"
TOKEN_HEADER = "x-pesto-token"

_REFERRER_POLICY = "no-referrer"


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
    """Read the caller's token from the fixed source order: query, then header."""
    query_token = request.query_params.get(TOKEN_QUERY_PARAM)
    if query_token:
        return query_token
    return request.headers.get(TOKEN_HEADER, "")


def _problem_response(status_code: int, title: str) -> Response:
    return problem(status_code, title)


def install_security(app: FastAPI, token: str) -> None:
    """Register the one HTTP middleware guard every route passes through."""

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        host = request.headers.get("host", "")
        if _hostname_only(host) not in LOCAL_HOSTNAMES:
            return _problem_response(400, "invalid host")

        if request.url.path.startswith("/api/"):
            supplied = _supplied_token(request)
            if not hmac.compare_digest(supplied, token):
                return _problem_response(401, "invalid or missing token")

        response: Response = await call_next(request)
        response.headers["Referrer-Policy"] = _REFERRER_POLICY
        return response
