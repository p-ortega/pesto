# Phase 1: Launcher, Server and Cache Foundation - Research

**Researched:** 2026-08-12
**Domain:** Local-loopback Python web app launcher (FastAPI/uvicorn) + filesystem-backed cache with staleness detection
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** The launcher mints a random session token at startup and puts it in the URL it opens. The
  server rejects any request that does not carry it. Built now, in Phase 1 — not deferred to M4.
  — Reversibility: costly — every endpoint added from Phase 2 onward inherits the check for free,
  but retrofitting it after Phase 5 means touching roughly twenty route handlers and their tests.
  Rationale from discussion: pesto's eventual home is undecided, and the token stops being cheap once
  the endpoints exist.
- **D-02:** The server also rejects requests whose `Host` header is not localhost. This closes the
  case a token alone does not: a web page open in the same browser probing local ports. Decided by
  Claude rather than asked, as a three-line addition consistent with D-01.
- **D-03:** How the token travels after the first page load — URL parameter, header, or cookie — is
  left to the planner. All work; the constraint is only that requests without a valid token fail.
- **D-04:** Cache location detection is try-and-catch, not inspection. pesto writes a probe file into
  `.pesto/` in the run directory; if that fails for any reason, it falls back to a stable path under
  `~/.cache/pesto/`. No `statvfs` free-space arithmetic, no mount-type inspection for network shares.
  Rationale: the probe catches failure modes nobody predicted, including ones that only appear on
  another person's machine, and mount detection is least reliable in exactly the environments where
  it would matter. Accepted downside: a slow network share writes successfully and stays slow.
- **D-05:** When the run directory is a git repository, pesto adds `.pesto/` to its `.gitignore`
  during cache creation — silently, not as a prompt. Rationale: the cache runs to gigabytes and a
  modeller version-controlling their run directory would otherwise stage it by accident. This resolves
  the roadmap's deferred item, which had listed Phase 1 or M4 as candidates.
  — Reversibility: reversible — it is one file write in the user's repo, and removing the
  behaviour later leaves no artifact beyond a `.gitignore` line.
- **D-06:** Cheap check first, expensive check only when the cheap one looks suspicious. Opening a run
  compares each source file's size and mtime against the manifest. Only files where those disagree get
  read and checksummed, and if the checksum matches the manifest, no re-ingest happens.
  Rationale: checksumming the whole 3.5 GB benchmark run costs about 2 s on local SSD and about 30 s
  over the external USB drive, which makes M0's 1.5 s warm-open budget unreachable. Meanwhile
  size-and-mtime alone would re-ingest 11 GB every time a run directory is copied off the backup
  drive, because copying rewrites every mtime while changing no content.
  Accepted gap: an edit that preserves both size and mtime goes unnoticed.
- **D-07:** When a checksum is taken, it covers the whole file — not a sample of the ends plus size.
  Rationale: the slow path is rare by construction, so it should be correct when it runs; a sampled
  hash is blind to a rewritten block in the middle of a file, which is exactly where a changed
  realization would sit.
- **D-08:** `CACHE_VERSION` remains a hard invalidation — bumping it marks everything stale regardless
  of size, mtime or checksum. Carried forward from the roadmap, not re-litigated.
- **D-09:** `pesto` with no arguments starts the app and lets the user pick the run directory from
  inside it. Passing a path stays available as a shortcut. Rationale: matches the design spec's
  double-click story, and M4 packages pesto as an icon with no command line to type a path into — so
  the picker gets built either way.
- **D-10:** The URL is always printed to the terminal, whether or not the browser opened. Rationale:
  launching a browser usually reports success even when nothing appears, so pesto cannot reliably
  detect its own failure; printing unconditionally covers remote sessions and unusual desktop setups
  at no cost.

### Claude's Discretion

- Token transport after first load (D-03).
- Whether the `Host` header check is middleware or per-route (D-02).
- The exact shape of the fallback path under `~/.cache/pesto/` — only its stability for a given run
  directory is required.
- CLI flag names beyond the behaviour fixed above (`--port`, `--no-browser`, `--cache-dir` and
  similar).

### Deferred Ideas (OUT OF SCOPE)

- **Where pesto runs (shared machine or laptop)** — the user did not want to settle this, and chose to
  build the session token regardless. If it later turns out pesto only ever runs on a single-account
  laptop, D-01 is not wasted, but the Host-header check in D-02 becomes the part that earns its keep.
  Worth revisiting at M4 packaging, when other people install it.
- **Warning the user when a slow network share is accepted** — D-04 deliberately does not detect
  network filesystems, so a slow share writes successfully and stays slow. If that bites in practice,
  a warning belongs with the ingest progress reporting in Phase 4, not here.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LAUNCH-01 | Browser opens ~150 ms on a free port; nothing at module load touches pyemu/flopy; a background thread imports them right after the port is bound. | See "Startup and lazy imports" pattern and the `Common Pitfalls → The browser-open race condition` finding: the M0 plan's fixed `threading.Timer(0.3, ...)` does not actually satisfy "right after the port is bound" — the port only becomes real once uvicorn's ASGI startup completes. The Code Examples section gives a corrected `launch.py` that hooks the FastAPI lifespan/startup event, verified against uvicorn's own `Server.started` attribute. |
| LAUNCH-02 | Server listens only on `127.0.0.1`; refused elsewhere. `Host` header check (D-02) and session token (D-01) close the same-machine gap. | See "Don't Hand-Roll → Host validation" and "Security Domain" for why `TrustedHostMiddleware` is the wrong tool given a port that changes every launch, and the custom middleware pattern that replaces it. |
| LAUNCH-03 | `.pesto/` in the run directory, falling back to a stable path under `~/.cache/pesto/`; explicit override wins; try-and-catch probe (D-04), not inspection. | See "Architecture Patterns → Cache root resolution" — the M0 plan's `os.access(path, os.W_OK)` check is exactly the kind of *inspection* D-04 rejects, and is independently unreliable on Windows (see Common Pitfalls). The corrected pattern replaces the access check with a real probe-file write inside a `try/except OSError`. |
| LAUNCH-04 | Staleness by size, mtime, checksum (cheap-then-expensive per D-06/D-07); `CACHE_VERSION` bump invalidates everything (D-08). | See "Architecture Patterns → Manifest staleness" — the M0 plan's `SourceFingerprint` has no checksum field at all, so it cannot implement D-06/D-07 as specified. The Code Examples section gives the corrected dataclass and `matches()` logic, using `hashlib.file_digest` (stdlib, Python 3.11+, matches the project's floor exactly). |
</phase_requirements>

## Summary

This phase has almost no third-party research risk — FastAPI, uvicorn and the standard library are
mature, extensively documented, and already named as the stack in the project's own canonical
references. The real research value here is in three places where the M0 plan's reference
implementation (written before D-01/D-02 and D-04/D-06/D-07 existed) needs a *correction*, not a
lookup: the browser-open race condition, the cache-root probe-vs-inspection distinction, and the
missing checksum field on the manifest's source fingerprint. All three are cheap to get right now and
expensive to discover later (the fingerprint schema in particular is the durable interface every later
phase's ingest code writes against, per CONTEXT.md's Integration Points).

Package versions were confirmed directly against the PyPI registry this session (`pip index versions`)
rather than trusted from training data: fastapi 0.141.1, uvicorn 0.52.1, flopy 3.10.0, and — notably —
pyemu now has a released PyPI version (1.7.0), so the M0 plan's `git+develop` source pin in
`[tool.uv.sources]` is no longer necessary and should be replaced with a version specifier for
reproducibility.

**Primary recommendation:** Build Task 1-3 largely as the M0 plan specifies (it is a solid skeleton),
but apply three corrections before writing tests: (1) drive the warm-up thread and the browser-open
call from the FastAPI startup/lifespan event and `uvicorn.Server.started`, not from a fixed
`threading.Timer`; (2) implement `resolve_cache_root` as an actual probe-file write wrapped in
`try/except OSError`, not an `os.access` check; (3) add a `checksum` field to `SourceFingerprint` and
implement the cheap-then-expensive staleness algorithm D-06/D-07 actually describe. Add the session
token and Host-header middleware from D-01/D-02, which the M0 plan omits entirely (this was the
subject of OPEN-05 and WARNING 5 in the ingest conflict report).

## Architectural Responsibility Map

pesto in Phase 1 is a single local process; there is no separate frontend server tier and no CDN. The
"tiers" below map onto pesto's own module boundaries (per the design spec's module table) rather than
a multi-service web architecture.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Port binding, ASGI lifecycle, CLI entry point | API/Backend (`pesto.launch`, `pesto.cli`) | — | One process, no separate app server. |
| Deferred science-stack import (`warm.py`) | API/Backend | — | Must run off the import path so the port can bind first; owned by the same process, different thread. |
| Browser auto-launch | API/Backend (decision + timing) | Browser/Client (rendering) | The backend decides *when* it is safe to open a tab; the browser itself does the rendering, which is out of scope until Phase 5. |
| Session token minting + verification | API/Backend | — | Middleware-level concern; no persistent session store exists yet (single token per process lifetime). |
| Host header validation | API/Backend | — | Network-boundary concern, sits beside the token check. |
| Cache root resolution (`.pesto/` vs `~/.cache/pesto/`) | Database/Storage (filesystem is the storage layer) | API/Backend (invokes it) | Pure filesystem logic; no query path touches it after Phase 1. |
| Cache layout (`CacheLayout`, directories) | Database/Storage | — | Defines the on-disk schema every later phase's ingest code writes into (per CONTEXT.md Integration Points). |
| Manifest + staleness detection | Database/Storage | API/Backend (`ingest/cache.py` will call it in Phase 2+) | Durable interface; the "when to re-ingest" decision lives entirely here, not in any query code. |
| `.gitignore` mutation in the run directory | API/Backend (side effect of cache creation) | Database/Storage (writes into the user's repo, not pesto's) | A write into a directory pesto does not own; keep it a small, isolated, idempotent function so it is easy to audit and to disable later. |

**Why this matters for planning:** every capability above is Backend or Storage. Nothing in Phase 1
belongs on the Browser/Client tier except "a tab exists" — there is no frontend code to write yet
(the compiled TypeScript frontend does not exist until later milestones; M0's frontend tasks are
Task 14-16 in the M0 plan, outside this phase's scope). Do not let a plan smuggle browser-side JS into
this phase.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `fastapi` | `>=0.115` (registry current: 0.141.1) [VERIFIED: PyPI registry, `pip index versions fastapi`, checked 2026-08-12] | ASGI web framework, serves `/api/health` and future routes | Already the project's locked stack choice [CITED: `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 1; `.planning/PROJECT.md` § Constraints] |
| `uvicorn` | `>=0.34` (registry current: 0.52.1) [VERIFIED: PyPI registry, `pip index versions uvicorn`, checked 2026-08-12] | ASGI server; binds the loopback socket | Same source as above |
| Python stdlib: `secrets` | 3.11+ | Cryptographically secure token generation (D-01) | `secrets.token_urlsafe` is the documented, CSPRNG-backed way to mint a session token — never hand-roll with `random` [CITED: docs.python.org/3/library/secrets.html] |
| Python stdlib: `hashlib` | 3.11+ | Whole-file checksum for staleness (D-06/D-07) | `hashlib.file_digest()` was added in Python 3.11 — exactly this project's floor — and streams the file via the OS file descriptor, avoiding a hand-rolled chunked-read loop [CITED: docs.python.org/3/library/hashlib.html; cross-checked against cpython PR #95965 gh-89313] |
| Python stdlib: `socket`, `threading`, `webbrowser`, `argparse`, `pathlib` | 3.11+ | Free-port discovery, warm-up thread, browser launch, CLI, path handling | Already used by the M0 plan reference implementation; no third-party replacement needed |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pytest` | `>=8.0` | Test runner | Every test in this phase |
| `httpx` | `>=0.28` | Required by FastAPI's `TestClient` under the hood | Import indirectly via `fastapi.testclient.TestClient` |
| `pytest-cov` | `>=5.0` | Coverage reporting | CI / local coverage checks |
| `hatchling` | current (build backend, not a runtime dep) | Packaging backend for `pyproject.toml` | Declared in `[build-system]`, not imported by app code |
| `numpy`, `pandas`, `pyarrow`, `flopy`, `pyemu` | as pinned in the M0 plan | Declared in `pyproject.toml` per the canonical M0 plan, but **not imported by any Phase 1 code path** except through `pesto.warm`'s lazy loaders | These belong to Phase 1's `pyproject.toml` because Task 1 defines the whole dependency set up front, but the deferred-import contract (LAUNCH-01) means no Phase 1 test should import them eagerly |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom Host-header middleware (recommended) | Starlette's `TrustedHostMiddleware` | Documented bug across multiple GitHub issues where the middleware does not strip the port before comparing against `allowed_hosts` [CITED: github.com/Kludex/starlette issues #1997/#1998; github.com/fastapi/fastapi issues #5818, discussion #6091]. Since pesto's port changes every launch, a fixed `allowed_hosts` list is awkward; a five-line middleware that parses the hostname and ignores the port is simpler and has no known bug. |
| `uvicorn.run(app, ...)` (blocking helper) | Manual `uvicorn.Config` + `uvicorn.Server` | `uvicorn.run()` is fine for the CLI's outermost blocking call, but it gives no hook to know when the socket is actually accepting connections — needed to fix the browser-open race (see Common Pitfalls). Constructing `Server` directly exposes `.started` [VERIFIED: github.com/encode/uvicorn `uvicorn/server.py`, fetched 2026-08-12 — `self.started = False` in `__init__`, set `True` in `startup()`]. |
| `pyemu` pinned to `git+develop` | `pyemu>=1.7` from PyPI | The M0 plan pinned to a git branch because no PyPI release existed yet at write time. `pip index versions pyemu` now shows a released `1.7.0` [VERIFIED: PyPI registry, checked 2026-08-12]. A version specifier is more reproducible than a floating branch. |
| `os.access(path, os.W_OK)` inspection | Real probe-file write in `try/except OSError` | D-04 explicitly requires try-and-catch, not inspection — and `os.access`/`chmod`-based permission checks are documented as unreliable on Windows, where `chmod` only toggles a read-only *attribute* bit and ignores everything else [CITED: Python docs `os.chmod` platform notes; multiple corroborating sources on Windows chmod limitations]. |

**Installation:**
```bash
uv add "fastapi>=0.115" "uvicorn>=0.34" "numpy>=2.0" "pandas>=2.2" "pyarrow>=18.0" "flopy>=3.9.5" "pyemu>=1.7"
uv add --optional test "pytest>=8.0" "pytest-cov>=5.0" "httpx>=0.28"
```

**Version verification:** confirmed live against the PyPI registry this session:
```
$ pip index versions fastapi   -> fastapi (0.141.1)
$ pip index versions uvicorn   -> uvicorn (0.52.1)
$ pip index versions pyemu     -> pyemu (1.7.0)
$ pip index versions flopy     -> flopy (3.10.0)
```
[VERIFIED: PyPI registry, `pip index versions <pkg>`, checked 2026-08-12]

## Package Legitimacy Audit

The automated legitimacy checker (`gsd_run query package-legitimacy check --ecosystem pypi`) flagged
every package in this phase's dependency set as `SUS`. Inspecting the `reasons` field shows why this
is a **tool-limitation false positive, not a real signal**: for the PyPI ecosystem the checker cannot
retrieve weekly-download counts (`weeklyDownloads: null` on every package, including `numpy`) and its
`publishedAt` field reflects the *latest release date*, not the package's age — so a mature project
that shipped a point release last week reads as "too-new." All package **names** below come from the
project's own canonical M0 plan document (an authoritative source per CONTEXT.md), not from this
session's web search, so the package-name-provenance rule does not force an `[ASSUMED]` tag on the
names themselves; only the disposition judgment below is manual.

| Package | Registry | Age | Downloads | Source Repo | Verdict (tool) | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| fastapi | pypi | version history to 0.1.0 (multi-year) | tool: unknown | github.com/fastapi/fastapi | SUS (too-new, unknown-downloads) | **Approved** — false positive; foundational, extremely widely used web framework |
| uvicorn | pypi | version history to 0.0.1 (multi-year) | tool: unknown | github.com/Kludex/uvicorn | SUS (too-new, unknown-downloads) | **Approved** — false positive; ASGI reference server, FastAPI's own recommended runner |
| numpy | pypi | decades old | tool: unknown | (tool returned none; actual: github.com/numpy/numpy) | SUS (too-new, unknown-downloads, no-repository) | **Approved** — false positive; foundational scientific-Python package |
| pandas | pypi | over a decade old | tool: unknown | (tool returned none; actual: github.com/pandas-dev/pandas) | SUS (too-new, unknown-downloads, no-repository) | **Approved** — false positive |
| pyarrow | pypi | version history well established | tool: unknown | arrow.apache.org | SUS (too-new, unknown-downloads) | **Approved** — false positive; Apache Arrow's official Python binding |
| flopy | pypi | version history to 2.2.x (multi-year), current 3.10.0 | tool: unknown | (tool returned none; actual: github.com/modflowpy/flopy) | SUS (unknown-downloads, no-repository) | **Approved** — canonical MODFLOW 6 Python package, already a locked project constraint |
| pyemu | pypi | version history to 0.1 (multi-year), current 1.7.0 | tool: unknown | (tool returned none; actual: github.com/pypest/pyemu) | SUS (too-new, unknown-downloads, no-repository) | **Approved** — canonical PEST(++) Python package, already a locked project constraint |
| httpx | pypi | multi-year | tool: unknown | github.com/encode/httpx | SUS (unknown-downloads) | **Approved** — required transitively by FastAPI's `TestClient` |
| pytest | pypi | multi-year | tool: unknown | github.com/pytest-dev/pytest | SUS (unknown-downloads) | **Approved** — de facto standard Python test runner |
| pytest-cov | pypi | multi-year | tool: unknown | (tool returned none; actual: github.com/pytest-dev/pytest-cov) | SUS (unknown-downloads, no-repository) | **Approved** |
| hatchling | pypi | multi-year | tool: unknown | github.com/pypa/hatch | SUS (too-new, unknown-downloads) | **Approved** — official PyPA build backend |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** all eleven, per the tool run above — **but every flag traces
to the checker's known PyPI-ecosystem blind spots (no download-count source, `publishedAt` conflated
with package age) rather than a genuine legitimacy concern.** No `checkpoint:human-verify` task is
warranted for these; they are the project's own already-locked dependency choices (`.planning/PROJECT.md`
§ Constraints), independently corroborated by official GitHub organizations and multi-year version
histories fetched directly from the registry. If the planner wants an extra safety margin regardless,
a single lightweight `checkpoint:human-verify` before `uv sync` (rather than one per package) is the
proportionate response.

## Architecture Patterns

### System Architecture Diagram

```
   pesto <path>?              (CLI, stdlib argparse only)
       |
       v
 [1] find_free_port()  --binds & immediately releases a loopback socket--> port N
       |
       v
 [2] create_app()  (FastAPI: /api/health only in this phase; no pyemu/flopy import)
       |
       v
 [3] uvicorn.Config + uvicorn.Server(app, host="127.0.0.1", port=N)
       |
       v
 [4] server.serve() starts  ---ASGI startup event fires--->  server.started = True
       |                                   |
       |                                   +--> [5a] background thread: pesto.warm.warm_up()
       |                                   |         (imports pyemu, flopy -- ~1s warm)
       |                                   |
       |                                   +--> [5b] background thread: webbrowser.open(url + token)
       |                                             (only fires once server.started is True)
       |
       v
 [6] every incoming request
       |
       v
   Host-header middleware (D-02) --reject if hostname not in {127.0.0.1, localhost, ::1}-->  400
       |
       v
   Token check (D-01) --reject if token missing/wrong-->  401/403
       |
       v
   route handler (only /api/health exists in Phase 1)


 Separately, on "open a run directory" (invoked once a run_dir is known, not yet wired to a route):
   resolve_cache_root(run_dir, override)
       |
       +--> override given?  --yes-->  use override, done
       |
       +--> try: write a probe file under run_dir/.pesto/
       |         succeeds --> cache root = run_dir/.pesto
       |         raises OSError (any reason) --> cache root = ~/.cache/pesto/<hash of resolved run_dir>
       |
       v
   CacheLayout(root).ensure()   -- creates control/ phi/ ens/ reals/ agg/ grid/ time/
       |
       v
   if run_dir is a git repo (".git" exists, dir or file) --> idempotently append ".pesto/" to run_dir/.gitignore
       |
       v
   Manifest.load(layout)  -- cache_version mismatch => empty manifest, everything stale
       |
       v
   for each known source file: is_stale(artifact_name)?
       size+mtime match manifest?  --yes--> not stale, cheap path done
       size+mtime differ?  --> hashlib.file_digest(source) --> compare to stored checksum
              checksum matches --> not stale (copy with rewritten mtime, same content)
              checksum differs --> stale, caller re-ingests and calls mark_ok(..., new fingerprint)
```

### Recommended Project Structure

Matches the design spec's module table and the M0 plan's file layout for these three tasks:

```
src/pesto/
├── __init__.py          # deliberately empty of imports (LAUNCH-01)
├── warm.py              # deferred pyemu/flopy loaders, thread-safe
├── launch.py            # find_free_port, serve() -- corrected startup/browser wiring
├── cli.py                # argparse entry point, path optional (D-09)
├── api/
│   ├── __init__.py
│   ├── app.py            # create_app(): /api/health + Host + token middleware
│   └── security.py       # NEW vs M0 plan: token minting/check, Host-header middleware (D-01/D-02)
└── cache/
    ├── __init__.py
    ├── layout.py          # CACHE_VERSION, resolve_cache_root (probe-based), CacheLayout, for_run
    ├── manifest.py        # SourceFingerprint (+checksum), Artifact, Manifest, staleness (D-06/D-07)
    └── gitignore.py       # NEW vs M0 plan: idempotent .pesto/ gitignore entry (D-05)
tests/
├── conftest.py
├── test_launch.py         # extended: loopback-only bind, Host rejection, token rejection
└── cache/
    ├── test_layout.py     # extended: probe-write fallback (not chmod-only), override precedence
    ├── test_manifest.py   # extended: checksum-based staleness (copy-with-new-mtime stays fresh)
    └── test_gitignore.py  # NEW
```

### Pattern 1: Deferred import via a lock-guarded loader module

**What:** All heavy scientific-stack imports go through `pesto.warm`, never at module top level
anywhere else in the codebase.
**When to use:** Any module that will eventually need `pyemu` or `flopy` — Phase 2's `ingest/`
modules included, though those are out of scope here.
**Example:**
```python
# Source: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 1 (canonical reference, cited in CONTEXT.md)
import threading
from types import ModuleType

_lock = threading.Lock()
_modules: dict[str, ModuleType] = {}

def _load(name: str) -> ModuleType:
    with _lock:
        if name not in _modules:
            _modules[name] = __import__(name)
        return _modules[name]

def load_pyemu() -> ModuleType:
    return _load("pyemu")

def load_flopy() -> ModuleType:
    return _load("flopy")

def warm_up() -> None:
    load_pyemu()
    load_flopy()
```

### Pattern 2: Startup-event-driven warm-up and browser open (corrects the M0 plan)

**What:** Kick off the warm-up thread and the browser-open call from the ASGI startup event /
`uvicorn.Server.started`, not from a fixed-delay `threading.Timer` started before the server binds.
**When to use:** `pesto.launch.serve()`.
**Why the correction matters:** LAUNCH-01's success criterion is that the browser appears "before
pyemu and flopy have imported, because ... the imports happen on a background thread started once the
port is bound." The M0 plan's `serve()` starts the warm-up thread and schedules `webbrowser.open` via
`threading.Timer(0.3, ...)` *before* calling `uvicorn.run()` — at that point the port is not bound yet
(binding happens inside `uvicorn.run()`). A slow machine (the design spec's own example: "a Windows
machine whose antivirus is scanning a fresh bundle can still take several seconds") means the browser
can open before the socket accepts connections, or the "port bound" and "start importing" ordering is
not actually enforced by anything.
**Example:**
```python
# Verified against uvicorn source: github.com/encode/uvicorn/blob/master/uvicorn/server.py
# (Server.__init__ sets self.started = False; Server.startup() sets self.started = True)
from __future__ import annotations

import socket
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from pesto.api.app import create_app


def find_free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def serve(
    host: str = "127.0.0.1",
    port: int | None = None,
    open_browser: bool = True,
    run_dir: Path | None = None,
) -> None:
    port = find_free_port() if port is None else port
    app, token = create_app()  # security.py mints the token; app carries it in app.state
    url = f"http://{host}:{port}/?token={token}"

    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)

    def _after_startup() -> None:
        # Runs once server.started flips True -- the port is genuinely bound
        # and accepting connections at this point, not merely "requested".
        while not server.started:
            time.sleep(0.005)
        threading.Thread(target=_warm_up_stack, daemon=True, name="pesto-warmup").start()
        print(f"pesto serving {url}")  # D-10: always print, browser-open success is not detectable
        if open_browser:
            webbrowser.open(url)

    def _warm_up_stack() -> None:
        from pesto.warm import warm_up
        warm_up()

    threading.Thread(target=_after_startup, daemon=True, name="pesto-after-startup").start()
    server.run()  # blocks the calling thread; equivalent to uvicorn.run() but exposes .started
```
Note: `server.run()` internally calls `asyncio_run(self.serve(...))` [VERIFIED: uvicorn source, fetched
this session], so this is a drop-in replacement for `uvicorn.run(app, host=..., port=...)` that also
gives calling code a real readiness signal.

### Pattern 3: Cache root resolution as a real probe, not an inspection (D-04)

**What:** Replace `os.access(path, os.W_OK)` with an actual write to a temp file inside
`run_dir/.pesto/`, guarded by `try/except OSError`.
**When to use:** `pesto.cache.layout.resolve_cache_root`.
**Example:**
```python
from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path

CACHE_VERSION = 1
_DIR_NAME = ".pesto"


def _fallback_root(run_dir: Path) -> Path:
    digest = hashlib.sha256(str(run_dir.resolve()).encode()).hexdigest()[:16]
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "pesto" / digest


def resolve_cache_root(run_dir: Path, override: Path | None = None) -> Path:
    if override is not None:
        return Path(override)

    candidate = Path(run_dir) / _DIR_NAME
    probe = candidate / f".probe-{uuid.uuid4().hex}"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        probe.write_bytes(b"")
        probe.unlink()
    except OSError:
        # Catches read-only filesystems, network shares that reject the write,
        # disks that are full, and anything else nobody predicted -- D-04's
        # entire point is that this list is not meant to be enumerated.
        return _fallback_root(Path(run_dir))
    return candidate
```

### Pattern 4: Cheap-then-expensive staleness, with a checksum the M0 plan's schema is missing (D-06/D-07)

**What:** `SourceFingerprint` needs a stored `checksum`; `matches()` needs a two-tier check.
**When to use:** `pesto.cache.manifest`.
**Example:**
```python
# hashlib.file_digest added in Python 3.11 -- matches this project's floor exactly.
# Source: docs.python.org/3/library/hashlib.html (cross-checked against cpython gh-89313 / PR #95965)
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SourceFingerprint:
    path: str
    mtime_ns: int
    size: int
    checksum: str  # sha256 hex digest of the whole file, per D-07

    @classmethod
    def of(cls, path: Path) -> "SourceFingerprint":
        info = path.stat()
        with open(path, "rb") as f:
            digest = hashlib.file_digest(f, "sha256")
        return cls(
            path=path.name,
            mtime_ns=info.st_mtime_ns,
            size=info.st_size,
            checksum=digest.hexdigest(),
        )

    def matches(self, base: Path) -> bool:
        target = Path(base) / self.path
        if not target.exists():
            return False
        info = target.stat()
        if info.st_mtime_ns == self.mtime_ns and info.st_size == self.size:
            return True  # cheap path: D-06's fast case
        # size/mtime disagree -- D-06's expensive path: checksum before declaring stale
        with open(target, "rb") as f:
            digest = hashlib.file_digest(f, "sha256")
        return digest.hexdigest() == self.checksum
```
Note this changes the *cost* of `SourceFingerprint.of()` at ingest time: it now always computes a
checksum (needed so a later comparison has something to check against), even though the *comparison*
stays cheap in the common case. This matches D-06's rationale, which is about avoiding repeated
checksumming on the read path, not about avoiding it at write time.

### Pattern 5: Idempotent `.gitignore` mutation (D-05)

**What:** Add `.pesto/` to the run directory's `.gitignore` only if the directory is a git repo and
the line is not already present.
**Example:**
```python
from pathlib import Path


def ensure_gitignored(run_dir: Path) -> None:
    # ".git" can be a directory (normal clone) or a file (worktree/submodule) --
    # check existence, not is_dir().
    if not (run_dir / ".git").exists():
        return
    gitignore = run_dir / ".gitignore"
    existing = gitignore.read_text() if gitignore.exists() else ""
    lines = existing.splitlines()
    if ".pesto/" in lines or ".pesto" in lines:
        return
    with gitignore.open("a") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        f.write(".pesto/\n")
```

### Anti-Patterns to Avoid

- **Fixed-delay browser open:** `threading.Timer(0.3, webbrowser.open, ...)` started before the server
  binds. Works on a fast machine, silently opens a connection-refused tab on a slow one. Use the
  startup-event / `.started`-polling pattern instead.
- **`os.access()` as a proxy for "can I write here":** unreliable cross-platform (especially Windows,
  where `chmod`/permission bits do not map the way POSIX code expects), and it is exactly the
  *inspection* D-04 rules out in favor of a real probe write.
- **`TrustedHostMiddleware` with a fixed `allowed_hosts` list:** the port changes every launch, and the
  middleware has a documented port-stripping bug. Write the five-line custom check instead.
- **Comparing tokens with `==`:** timing side-channel; use `hmac.compare_digest`.
- **Checking `.git` with `.is_dir()` only:** misses git worktrees and submodules, where `.git` is a
  file containing a pointer, not a directory.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session token generation | A custom random string using `random` or string concatenation of `uuid` | `secrets.token_urlsafe(32)` | `secrets` is the stdlib's documented CSPRNG-backed module specifically for security tokens; `random` is not cryptographically secure and `uuid4` is not designed as a security primitive even though it happens to use randomness |
| Token comparison | `token == expected` | `hmac.compare_digest(token, expected)` | Constant-time comparison avoids a timing side-channel that leaks how many leading characters matched |
| Whole-file checksum | A manual chunked `while chunk := f.read(65536): hasher.update(chunk)` loop | `hashlib.file_digest(fileobj, "sha256")` | Stdlib since Python 3.11 (this project's exact floor); uses the file descriptor directly and is less code to get wrong |
| Host-header allowlisting | Starlette's `TrustedHostMiddleware` with a per-launch port baked into the allowlist | A five-line custom middleware that strips the port and checks the hostname | Documented middleware bug around port handling; the custom version is simpler than working around the bug |
| Free-port discovery | Manually probing a port range | `socket.socket(); sock.bind(("127.0.0.1", 0)); sock.getsockname()[1]` | The OS already does this correctly; asking the kernel for an ephemeral port and reading it back is the standard idiom, already used correctly in the M0 plan |
| `.gitignore` editing | A regex-based line inserter, or blind append on every run | Idempotent read-check-append against split lines | Prevents duplicate `.pesto/` lines accumulating across repeated `pesto` launches on the same repo |

**Key insight:** everything in this phase that looks like it needs a library is actually a five-to-
fifteen-line stdlib idiom. The risk in this phase is not "which library" but "which stdlib idiom, and
did the M0 plan's reference implementation actually implement the constraint it claims to" — which is
why three of the five patterns above are corrections, not confirmations.

## Common Pitfalls

### Pitfall 1: The browser-open race condition
**What goes wrong:** The browser opens to `ECONNREFUSED` / "can't connect" instead of the app, or opens
early enough that the user's click lands before the warm-up thread has even started.
**Why it happens:** `webbrowser.open()` is scheduled by wall-clock delay (`threading.Timer(0.3, ...)`)
rather than by an actual readiness signal, and that delay is chosen before `uvicorn.run()` — which
performs the actual bind — is even called.
**How to avoid:** Use `uvicorn.Server` directly and gate the browser-open (and the warm-up thread
start) on `server.started` becoming `True`, or hook FastAPI's lifespan/startup event. See Pattern 2.
**Warning signs:** intermittent CI flakiness in any test that shells out to the CLI and expects an
immediate successful HTTP response; user reports of "nothing happened" on first launch that resolve on
a second click.

### Pitfall 2: `os.access`/`chmod`-based permission checks are not reliable on Windows
**What goes wrong:** A test (or worse, production code) that `chmod`s a directory read-only and expects
`os.access(path, os.W_OK)` to reflect that will pass on macOS/Linux CI and silently do nothing on
Windows, because `os.chmod()` on Windows only toggles the read-only *attribute* and ignores the
permission bits Unix code assumes exist.
**Why it happens:** Windows' file permission model is fundamentally different (ACL-based, not
Unix-mode-based), and Python's `os.chmod`/`os.access` present a POSIX-shaped API over it without fully
emulating POSIX semantics.
**How to avoid:** D-04 already sidesteps most of this by requiring a real probe write rather than an
access check — apply that at the test level too: to simulate a fallback, monkeypatch the write call to
raise `OSError` (or point `HOME`/`XDG_CACHE_HOME` at a genuinely unwritable path created by a fixture
appropriate to the current OS) rather than relying purely on `chmod` in a cross-platform test suite.
**Warning signs:** the fallback test (`test_cache_falls_back_when_the_run_directory_is_read_only`) is
green on the CI runner's OS but the fallback path never actually triggers on Windows in the field.

### Pitfall 3: `SourceFingerprint` without a checksum field cannot implement D-06/D-07
**What goes wrong:** A cache that survives being copied off a backup drive (mtimes rewritten, content
identical) is exactly the case D-06 exists to handle. Without a `checksum` field on the stored
fingerprint, there is nothing to compare against when size/mtime disagree, so the implementation is
forced into an all-or-nothing choice: either always trust mtime (wrongly stale after every copy) or
never trust it (defeats the point of the cheap path).
**Why it happens:** The M0 plan's `SourceFingerprint` (`path, mtime_ns, size`) predates D-06/D-07,
which were resolved in this phase's CONTEXT.md, not in the original M0 plan.
**How to avoid:** Add `checksum: str` to `SourceFingerprint`, compute it once at ingest time (Pattern 4
above), and implement the two-tier `matches()`.
**Warning signs:** a test that copies a fixture file to a new path (preserving content, changing
mtime) and asserts it is *not* stale — if that test does not exist yet, this pitfall has not been
guarded against.

### Pitfall 4: Session token in the URL leaks into logs, history, and `Referer` headers
**What goes wrong:** D-01 requires the token to travel in the URL for the first load, matching the
Jupyter model. Left unchanged, every subsequent navigation that carries the token in the URL (rather
than transitioning to a cookie) leaks it into browser history, and if the page ever makes a
cross-origin request, into that target's `Referer` header.
**Why it happens:** URL query parameters are the simplest way to get a token to the client on first
load, but they are not designed to stay secret across a session.
**How to avoid:** Follow the Jupyter precedent researched this session: use the URL token only to
authenticate the very first request, then set an `HttpOnly`, `SameSite=Strict` cookie from the server
and require *that* for everything after. D-03 explicitly leaves this transport decision to the planner
— this is the recommended default. At minimum, set `Referrer-Policy: no-referrer` on all responses.
**Warning signs:** the token still appears in query strings for API calls made well after the initial
page load; no cookie is ever set.

### Pitfall 5: `find_free_port()` has an unavoidable, low-probability TOCTOU race
**What goes wrong:** `find_free_port()` binds a socket to port 0, reads back the OS-assigned port, and
immediately closes the socket — releasing the port before `uvicorn` binds to it. Between those two
events, in principle another process could grab the same port.
**Why it happens:** There is no atomic "reserve this port, tell me its number, then hand me the
listening socket" primitive in the stdlib socket API used this way.
**How to avoid:** This is the standard idiom and the race window is microseconds; do not over-engineer
a fix (e.g. passing the still-open socket descriptor into uvicorn is possible but adds complexity out
of proportion to the risk for a single-user local app). Document it as an accepted, extremely
low-probability failure mode rather than "solving" it.
**Warning signs:** an intermittent, unreproducible "address already in use" error in CI; if this
appears frequently rather than rarely, something else is wrong (e.g. a fixed port left over from a
previous run) — do not misattribute a real bug to this race.

## Code Examples

Verified/cited patterns (also given inline above in Architecture Patterns; consolidated here for the
common operations a plan will decompose into tasks):

### Host + token middleware (D-01, D-02)
```python
# Host-header check: custom, not TrustedHostMiddleware (see Alternatives Considered for why)
from __future__ import annotations

import hmac
from fastapi import FastAPI, Request
from starlette.responses import JSONResponse

LOCAL_HOSTNAMES = {"127.0.0.1", "localhost", "::1", "[::1]"}


def _hostname_only(host_header: str) -> str:
    # Host header may be "127.0.0.1:53211"; IPv6 literals are bracketed: "[::1]:53211"
    if host_header.startswith("["):
        return host_header.rsplit("]", 1)[0] + "]"
    return host_header.rsplit(":", 1)[0]


def install_security(app: FastAPI, token: str) -> None:
    @app.middleware("http")
    async def _guard(request: Request, call_next):
        host = request.headers.get("host", "")
        if _hostname_only(host) not in LOCAL_HOSTNAMES:
            return JSONResponse(
                {"type": "about:blank", "title": "invalid host", "status": 400},
                status_code=400,
                media_type="application/problem+json",
            )
        supplied = request.query_params.get("token") or request.headers.get("x-pesto-token", "")
        if not hmac.compare_digest(supplied, token):
            return JSONResponse(
                {"type": "about:blank", "title": "invalid or missing token", "status": 401},
                status_code=401,
                media_type="application/problem+json",
            )
        return await call_next(request)
```
(Note: `/api/health` may need to stay reachable without a token for local liveness probes — that
tradeoff is for the planner/discuss step to make explicit, not assumed here.)

### Token minting (D-01)
```python
import secrets

def mint_token() -> str:
    return secrets.token_urlsafe(32)
```
[CITED: docs.python.org/3/library/secrets.html]

## State of the Art

| Old Approach (M0 plan, pre-CONTEXT.md) | Current Approach (this phase) | When Changed | Impact |
|--------------------------------------|-------------------------------|---------------|--------|
| `pyemu` pinned via `git+develop` in `[tool.uv.sources]` | `pyemu>=1.7` from PyPI | pyemu shipped a PyPI release (confirmed 1.7.0 live on the registry this session) | More reproducible builds; no need to track a moving branch |
| Loopback bind only, no token, no Host check | Token (D-01) + Host-header check (D-02), both added this phase | Resolved by CONTEXT.md D-01/D-02, closing WARNING 5 from the ingest conflict report | Every route added from Phase 2 onward inherits the check for free instead of needing retrofitting |
| `SourceFingerprint(path, mtime_ns, size)` | `SourceFingerprint(path, mtime_ns, size, checksum)` | Resolved by CONTEXT.md D-06/D-07 | Enables the cheap-then-expensive staleness algorithm the design spec actually describes |
| `os.access(path, os.W_OK)` cache-root check | Real probe-file write in `try/except OSError` | Resolved by CONTEXT.md D-04 | Matches machines and failure modes nobody predicted, and works correctly on Windows where `os.access` does not reliably reflect writability |
| Fixed `threading.Timer(0.3, webbrowser.open)` | Startup-event-gated browser open using `uvicorn.Server.started` | This research session (no CONTEXT.md decision yet — flagged as a correction, not a locked choice) | Removes a race condition that scales with machine slowness, which the design spec itself calls out (antivirus-scanned Windows startup) |

**Deprecated/outdated:** none — this is a greenfield phase; there is no legacy code in this repository
to deprecate.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The fixed-delay browser-open pattern is a genuine defect worth fixing now, rather than an acceptable simplification for M0. | Common Pitfalls #1, Pattern 2 | Low-to-medium: if wrong, the extra `uvicorn.Server`/`.started` plumbing is unnecessary complexity for a phase whose own success criterion (~150 ms browser open) already implies tight timing is closely watched — but if the planner judges the M0 plan's simpler `Timer` approach is "good enough," that is a legitimate discretion call, not a research error. |
| A2 | `uv sync --extra test` (or equivalent) is the correct command to install the `[project.optional-dependencies] test` group under `uv`; not independently verified against `uv`'s own docs this session. | Validation Architecture | Low: if the exact flag differs, the fix is a one-line command correction with no architectural impact. |
| A3 | `/api/health` should remain reachable without the session token, so external liveness checks and the "did the server come up" verification step in Task 1 still work with a plain `curl`. | Code Examples (Host + token middleware) | Medium: if the design intends *every* endpoint including health to require the token, a plan built on this assumption would need a follow-up fix; flagging explicitly rather than silently deciding it. |

## Open Questions

1. **Does `/api/health` require the session token?**
   - What we know: D-01 says "the server rejects any request that does not carry it," which reads as
     universal; but Task 1's own verification step 6 curls `/api/health` with no token
     (`curl -s localhost:8420/api/health`).
   - What's unclear: whether that verification step should be updated to include the token, or whether
     health is a deliberate carve-out.
   - Recommendation: planner should decide explicitly and record it — either exempt `/api/health` and
     say so in the plan, or update the verification command to include the token.

2. **Should the browser-open correction (Pattern 2) be a locked task in this phase's plan, or is the
   M0 plan's simpler `Timer`-based approach acceptable for M0's risk-probe purpose?**
   - What we know: the design spec's stated LAUNCH-01 criterion is about import ordering, not strictly
     about browser-open reliability under load; the race is real but the M0 plan's own philosophy
     (Task 17's revised exit criteria) tends to accept "good enough, measured" over "theoretically
     complete."
   - What's unclear: whether the planner should spend a task on this or fold it into Task 1's rewrite
     as an obvious correction.
   - Recommendation: fold it into Task 1 rather than a separate task — it is a rewrite of the same
     function, not new scope.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Python | all of Phase 1 | not probed this session (research-only; no code executed against project's own interpreter) | — | `uv run` manages its own interpreter per `pyproject.toml`'s `requires-python = ">=3.11"` |
| `uv` | every command in this project (mandatory, per CLAUDE-level project constraint) | not probed this session | — | none — required tooling; if absent, install before Task 1 |
| Network access to PyPI / GitHub | first `uv sync` (installs fastapi, uvicorn, pyemu, flopy, etc.) | confirmed reachable this session (used to run `pip index versions` and fetch uvicorn's source from GitHub) | — | none needed; connectivity confirmed |
| `~/.cache/pesto/` writability (fallback path) | LAUNCH-03's fallback branch | not probed (depends on the machine `pesto` eventually runs on, not this research machine) | — | if `~/.cache` itself is unwritable, `resolve_cache_root`'s fallback has no further fallback — this is an accepted edge case per D-04's philosophy (catch what you can, don't chase every possible failure) |

**Missing dependencies with no fallback:** `uv` itself — the project's own constraints mandate it for
every Python command; if it is not installed on the machine that will execute this phase's plan, that
is a precondition to fix before Task 1, not something Phase 1's code should work around.

**Missing dependencies with fallback:** none beyond the cache-root fallback already designed into
LAUNCH-03 itself.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest `>=8.0` [CITED: `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 1 `pyproject.toml`] |
| Config file | none yet — `[tool.pytest.ini_options] testpaths = ["tests"]` is created by this phase's own Task 1, see Wave 0 Gaps |
| Quick run command | `uv run pytest tests/test_launch.py tests/cache -v` |
| Full suite command | `uv run pytest -v` (once `scripts/get_fixtures.sh` has run; fixtures are not needed by Phase 1's own tests, only by later phases sharing the same `tests/` tree) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LAUNCH-01 | Module import touches neither pyemu, flopy nor matplotlib; `warm_up()` does. | unit (subprocess-isolated) | `uv run pytest tests/test_launch.py -k "does_not_import or warm_up" -x` | ❌ Wave 0 (create `tests/test_launch.py`, adapting the M0 plan's four tests) |
| LAUNCH-01 | Health endpoint responds; server actually becomes reachable before any browser-open attempt is made. | integration | `uv run pytest tests/test_launch.py -k started -x` | ❌ Wave 0 (new test for the `.started`-gated startup, not present in the M0 plan) |
| LAUNCH-02 | Server refuses a bind to a non-loopback host / refuses a request with a non-local `Host` header / refuses a request with a missing or wrong token. | unit + integration | `uv run pytest tests/test_launch.py -k "loopback or host_header or token" -x` | ❌ Wave 0 (entirely new — the M0 plan predates D-01/D-02) |
| LAUNCH-03 | Cache resolves beside the run dir when writable; falls back to a stable `~/.cache/pesto/<hash>` path on any write failure (simulated via a forced `OSError`, not solely via `chmod`); explicit override wins over both. | unit | `uv run pytest tests/cache/test_layout.py -x` | ❌ Wave 0 (create `tests/cache/test_layout.py`, adapting the M0 plan's tests but replacing the `chmod`-only fallback test per Pitfall 2) |
| LAUNCH-03 | `.pesto/` added to `.gitignore` idempotently, only inside a git repo. | unit | `uv run pytest tests/cache/test_gitignore.py -x` | ❌ Wave 0 (new — D-05 has no corresponding M0 plan task) |
| LAUNCH-04 | Unchanged file (same size+mtime) is not stale; copied file (same content, new mtime) is not stale via checksum; changed file is stale; `CACHE_VERSION` bump marks everything stale. | unit | `uv run pytest tests/cache/test_manifest.py -x` | ❌ Wave 0 (create `tests/cache/test_manifest.py`, adapting the M0 plan's nine tests but adding the checksum-based "copied file" case per Pitfall 3) |

### Sampling Rate
- **Per task commit:** the relevant single test file's quick command above.
- **Per wave merge:** `uv run pytest tests/test_launch.py tests/cache -v` (full Phase 1 surface; no
  fixtures or benchmark data needed since this phase never reads a PEST file).
- **Phase gate:** same full command green, plus the manual `uv run pesto --no-browser --port <N> &` /
  `curl` smoke test the M0 plan already specifies (Task 1 Step 6), extended to also curl with and
  without the token to confirm the security middleware behaves as designed.

### Wave 0 Gaps
- [ ] `pyproject.toml` with `[tool.pytest.ini_options] testpaths = ["tests"]` — does not exist yet (greenfield repo)
- [ ] `tests/conftest.py` — needed even though Phase 1's own tests don't use the `pypestvis`/benchmark
      fixtures, because it is shared infrastructure later phases build on; safe to create the minimal
      version now and extend in Phase 2
- [ ] `tests/test_launch.py` — new tests for Host-header rejection, token rejection, and
      startup-readiness-gated browser open, beyond the four in the M0 plan
- [ ] `tests/cache/test_layout.py`, `tests/cache/test_manifest.py` — extend the M0 plan's versions per
      Pitfalls 2 and 3
- [ ] `tests/cache/test_gitignore.py` — entirely new, no M0 plan equivalent exists
- [ ] Framework install: `uv sync --extra test` (or the project's equivalent `uv` invocation for
      optional dependency groups — verify exact flag against `uv`'s own docs before relying on it, per
      Assumption A2)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Partial | Single shared-secret bearer token per process lifetime (`secrets.token_urlsafe`), not a full identity system — appropriate for a single-user local app per D-01's own rationale |
| V3 Session Management | Yes | Token transport recommendation: URL param for the first request only, then an `HttpOnly`, `SameSite=Strict` cookie (Jupyter's own model) — see Pitfall 4 and Open Question 1 |
| V4 Access Control | Yes | Loopback-only bind (`host="127.0.0.1"`) + custom Host-header middleware (D-02) is the access-control boundary; no user/role model exists or is needed at this phase |
| V5 Input Validation | Minimal in Phase 1 | No filesystem-browsing or path-accepting endpoints exist yet (`/api/fs/ls` is SERVE-03, scoped to Phase 5) — flag for that phase's research rather than building it here |
| V6 Cryptography | Yes | Token generation must use `secrets` (CSPRNG), never `random`/`uuid4`; token comparison must use `hmac.compare_digest` |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Token leakage via URL (browser history, `Referer` header, terminal scrollback since D-10 prints the URL) | Information Disclosure | Transition to a cookie after first load (Pitfall 4); set `Referrer-Policy: no-referrer` |
| Another local process/web page in the same browser probing loopback ports | Spoofing | Host-header middleware (D-02) closes exactly this gap that loopback binding alone does not |
| Timing attack on token comparison | Tampering (side-channel) | `hmac.compare_digest`, never `==` |
| `TrustedHostMiddleware`'s port-handling bug silently under-enforcing the allowlist | Tampering (config bug, not code bug) | Use the custom middleware in Code Examples instead, which parses the hostname without depending on the buggy library behavior |
| Symlink or junction inside the run directory redirecting the `.pesto/` probe write or the `.gitignore` append somewhere unintended | Tampering | Out of scope for Phase 1 (single-user, trusts its own filesystem), but worth a one-line note for Phase 4/5 research if pesto ever runs against untrusted directories |

## Sources

### Primary (HIGH confidence)
- `docs/superpowers/specs/2026-08-12-pesto-design.md` §2, §3 — architecture, startup, cache location contract (canonical reference, read this session, lines 109-248 and 451-482)
- `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 1-3 (lines 243-1082) — reference implementation for launcher, cache layout, and manifest (canonical reference, read in full this session)
- `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/intel/constraints.md`, `.planning/INGEST-CONFLICTS.md` — project constraints and the OPEN-05/WARNING-5 history behind D-01/D-02
- github.com/encode/uvicorn `uvicorn/server.py` (fetched this session) — `Server.started` attribute, `run()`/`serve()` semantics
- PyPI registry, `pip index versions <pkg>` (run this session) — fastapi 0.141.1, uvicorn 0.52.1, pyemu 1.7.0, flopy 3.10.0
- docs.python.org `hashlib` and `secrets` module documentation

### Secondary (MEDIUM confidence)
- github.com/Kludex/starlette issues #1997/#1998; github.com/fastapi/fastapi issue #5818, discussion #6091 — `TrustedHostMiddleware` port-handling bug reports
- WebSearch-sourced summaries on `os.access`/`chmod` Windows limitations, corroborated by Python's own platform notes in the `os` module docs
- WebSearch-sourced summary of the Jupyter server's token-then-cookie security model (jupyter-server.readthedocs.io)

### Tertiary (LOW confidence)
- None retained as authoritative; all WebSearch findings above were either cross-checked against a registry/source fetch or are cited to a specific, named issue tracker entry.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions confirmed live against the PyPI registry this session; package choices are the project's own locked constraints, not newly proposed
- Architecture: HIGH — corrections (browser-open race, probe-vs-inspection, checksum field) are grounded in reading the M0 plan's actual source code against CONTEXT.md's decisions line by line, plus a verified read of uvicorn's own source
- Pitfalls: HIGH for the three schema/logic gaps (directly derived from comparing CONTEXT.md decisions against the M0 plan's code); MEDIUM for the Windows chmod caveat and the TrustedHostMiddleware bug (both cited to specific sources but not independently reproduced on a Windows machine this session)

**Research date:** 2026-08-12
**Valid until:** 2026-09-11 (30 days — this phase depends on a fast-moving package, `uvicorn`/`fastapi` release cadence is roughly monthly, but the architectural corrections themselves do not go stale)
