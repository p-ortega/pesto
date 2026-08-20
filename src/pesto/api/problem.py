"""The one RFC 9457 problem+json builder every route and the security
middleware share, so there is exactly one error shape in this app.

A real filesystem path must never reach a response body (D-09, CLAUDE.md):
``problem_from_failure`` reads only ``ReadFailure.name`` and ``.reason``,
never ``.path``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from starlette.responses import JSONResponse

if TYPE_CHECKING:
    from pesto.ingest.failures import ReadFailure

_REFERRER_POLICY = "no-referrer"


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
        body["detail"] = detail

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
