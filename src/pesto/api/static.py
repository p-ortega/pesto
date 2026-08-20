"""Serve the built frontend bundle, or an informational page when it has
not been built.

Registered last in ``app.py`` so the static mount can never shadow an
``/api/...`` route -- a bundle file named the same as a future API path
would otherwise win by mount order.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from starlette.responses import HTMLResponse
from starlette.staticfiles import StaticFiles

_NOT_BUILT_HTML = """\
<!doctype html>
<html>
  <body>
    <h1>pesto's frontend has not been built</h1>
    <p>
      This installation of pesto was built without its compiled frontend.
      Set the environment variable <code>PESTO_BUILD_FRONTEND=1</code> and
      build again, or build it from source directly:
    </p>
    <pre>PESTO_BUILD_FRONTEND=1 uv build</pre>
    <pre>cd frontend &amp;&amp; npm install &amp;&amp; npm run build</pre>
  </body>
</html>
"""


STATIC_DIR = Path(__file__).parent.parent / "static"


def mount_static(app: FastAPI) -> None:
    if (STATIC_DIR / "index.html").exists():
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
        return

    @app.get("/")
    async def _not_built() -> HTMLResponse:
        return HTMLResponse(_NOT_BUILT_HTML, status_code=200)
