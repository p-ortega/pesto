# API Coverage — Phase 1

No external API integration: Phase 1 builds pesto's own loopback HTTP server (FastAPI/uvicorn on
`127.0.0.1`) and a filesystem-backed cache. It calls no third-party service, SDK or remote endpoint —
every dependency it uses is either the Python standard library or a local library it imports in-process
(pyemu and flopy are imported on the warm-up thread and not called at all in this phase). The
deterministic detector agrees: `api-coverage.cjs --json` over this phase's scope returns
`{"detected": false, "signals": []}`.

The API surfaces pesto *serves* are its own (`GET /api/health` in this phase); the browser and
filesystem surfaces it consumes are stdlib. There is therefore no external capability list to enumerate
and no opt-out to justify.

Revisit this when Phase 5 adds the filesystem picker and the cache-serving routes, and again in M2 if
basemap tile providers arrive — that is the first point at which pesto calls something it does not own.
