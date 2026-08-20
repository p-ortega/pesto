"""The one RFC 9457 problem+json builder every route and the security
middleware share, so there is exactly one error shape in this app.

A real filesystem path must never reach a response body (D-09, CLAUDE.md):
``problem_from_failure`` reads only ``ReadFailure.name`` and ``.reason``,
never ``.path``, and ``problem()`` itself redacts any absolute path out of
``detail`` before the body is built. ``ReadFailure.reason`` is free prose
written by the ingest layer for a developer reading a manifest, and some
reasons quote a whole source path -- the route layer redacts rather than
trusting the producer.

``install_problem_handlers`` puts FastAPI's two default error paths --
a request-validation failure and a raised ``StarletteHTTPException`` --
behind this same builder, since both bypass ordinary route code and
otherwise return FastAPI's own ``{"detail": ...}`` shape.
"""

from __future__ import annotations

import re
from http import HTTPStatus
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

if TYPE_CHECKING:
    from pesto.ingest.failures import ReadFailure

_REFERRER_POLICY = "no-referrer"

# A POSIX path: not preceded by a word char, dot or colon (so a URL's
# "http://host/path" is left alone), at least one directory segment, then a
# final segment -- "/etc/passwd" and deeper, never a bare "/x".
_POSIX_PATH_RE = re.compile(r"(?<![\w.:])/(?:[^\s/:]+/)+[^\s/:]+")
# A Windows path: a drive letter, then one or more backslash- or
# slash-separated segments.
_WINDOWS_PATH_RE = re.compile(r"[A-Za-z]:[\\/](?:[^\s\\/:]+[\\/])*[^\s\\/:]+")


def redact_paths(text: str) -> str:
    """Reduce every absolute filesystem path in ``text`` to its final component.

    Matches both POSIX (``/``-rooted, at least two components) and Windows
    (``C:\\`` or ``C:/``-rooted) forms. A bare file name is left alone.
    """

    def _basename(match: re.Match[str]) -> str:
        return re.split(r"[\\/]", match.group(0))[-1]

    text = _WINDOWS_PATH_RE.sub(_basename, text)
    return _POSIX_PATH_RE.sub(_basename, text)


def problem(
    status_code: int,
    title: str,
    *,
    artifact: str | None = None,
    detail: str | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    body: dict[str, object] = {"type": "about:blank", "title": title, "status": status_code}
    if artifact is not None:
        body["artifact"] = artifact
    if detail is not None:
        body["detail"] = redact_paths(detail)

    response = JSONResponse(
        body,
        status_code=status_code,
        media_type="application/problem+json",
        headers=headers,
    )
    response.headers["Referrer-Policy"] = _REFERRER_POLICY
    return response


def problem_from_failure(status_code: int, failure: "ReadFailure") -> JSONResponse:
    return problem(status_code, "read failure", artifact=failure.name, detail=failure.reason)


def _rejected_fields(exc: RequestValidationError) -> str | None:
    """Name what was rejected, never the value that was rejected.

    An error's ``loc`` is a name and a location (query, path, body); its
    ``input`` is attacker-controlled text that must never be echoed back into
    a response, or the error body becomes a reflection channel.
    """
    locations = [".".join(str(part) for part in error["loc"]) for error in exc.errors()]
    return ", ".join(locations) if locations else None


def install_problem_handlers(app: FastAPI) -> None:
    """Put FastAPI's two default error paths behind ``problem()``.

    A request-validation failure and a raised ``StarletteHTTPException`` both
    bypass any route code; left alone, both return FastAPI's own
    ``{"detail": ...}`` JSON body -- a second error shape.
    """

    @app.exception_handler(RequestValidationError)
    async def _validation_problem(request: Request, exc: RequestValidationError) -> JSONResponse:
        return problem(422, "request could not be understood", detail=_rejected_fields(exc))

    @app.exception_handler(StarletteHTTPException)
    async def _http_exception_problem(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        title = exc.detail if isinstance(exc.detail, str) else HTTPStatus(exc.status_code).phrase
        return problem(exc.status_code, title, headers=exc.headers)
