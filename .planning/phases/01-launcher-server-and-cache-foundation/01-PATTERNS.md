# Phase 1: Launcher, Server and Cache Foundation - Pattern Map

**Mapped:** 2026-08-12
**Files analyzed:** 13 (10 source, 5 test files, some grouped)
**Analogs found:** 0 in-repo / 13 total

## Repository state

The working tree contains only `README.md`, `LICENSE`, `.gitignore`, `.claude/`, `.superpowers/`,
`.planning/` and the gitignored `docs/`. There is no `src/`, no `pyproject.toml`, no test suite.
**This phase writes the first line of code in the project — there is no in-repo analog for any file
listed below.** Every "closest analog" column below points instead at RESEARCH.md's own
Architecture Patterns / Code Examples sections, which already contain corrected, verified code
excerpts (checked against uvicorn's source and Python's `hashlib`/`secrets` docs), and at the
canonical reference plan under `docs/superpowers/plans/2026-08-12-pesto-m0.md` (gitignored — read
it, never `git add` it).

Because RESEARCH.md's patterns are themselves *corrections* to the M0 plan's reference
implementation (browser-open race, probe-vs-inspection, missing checksum field), the planner should
treat **RESEARCH.md as primary** and the M0 plan as background only, not the reverse.

## File Classification

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|-----------------|---------------|
| `src/pesto/__init__.py` | config | — | none (deliberately empty) | no analog |
| `src/pesto/warm.py` | utility (lazy loader) | event-driven (one-shot import trigger) | RESEARCH.md "Pattern 1: Deferred import via a lock-guarded loader module" | no in-repo analog; doc pattern only |
| `src/pesto/launch.py` | service (process orchestration) | event-driven (startup lifecycle) | RESEARCH.md "Pattern 2: Startup-event-driven warm-up and browser open" | no in-repo analog; doc pattern only |
| `src/pesto/cli.py` | controller (CLI entry point) | request-response (argv in, process out) | none; stdlib `argparse` idiom, no project precedent | no analog |
| `src/pesto/api/app.py` | controller (FastAPI app factory) | request-response | none; RESEARCH.md "Code Examples → Host + token middleware" | no in-repo analog; doc pattern only |
| `src/pesto/api/security.py` | middleware | request-response | RESEARCH.md "Code Examples → Host + token middleware" and "Token minting (D-01)" | no in-repo analog; doc pattern only |
| `src/pesto/cache/layout.py` | model + service (cache root/layout) | file-I/O | RESEARCH.md "Pattern 3: Cache root resolution as a real probe" | no in-repo analog; doc pattern only |
| `src/pesto/cache/manifest.py` | model (fingerprint/staleness) | file-I/O, batch (per-file compare) | RESEARCH.md "Pattern 4: Cheap-then-expensive staleness" | no in-repo analog; doc pattern only |
| `src/pesto/cache/gitignore.py` | utility | file-I/O | RESEARCH.md "Pattern 5: Idempotent `.gitignore` mutation" | no in-repo analog; doc pattern only |
| `pyproject.toml` | config | — | `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 1 (lines 243-605), with the `pyemu>=1.7` correction from RESEARCH.md's Standard Stack table | doc pattern only, with a version-pin correction |
| `tests/conftest.py` | test | — | none; minimal shared fixture scaffold, no project precedent | no analog |
| `tests/test_launch.py` | test | request-response / event-driven | `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 1's four launch tests, extended per RESEARCH.md's Phase Requirements → Test Map | doc pattern only, extended |
| `tests/cache/test_layout.py`, `tests/cache/test_manifest.py`, `tests/cache/test_gitignore.py` | test | file-I/O | `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 2-3 tests, extended per Pitfalls 2 and 3 | doc pattern only, extended |

## Pattern Assignments

### `src/pesto/warm.py` (utility, event-driven)

**No in-repo analog. Follow RESEARCH.md "Pattern 1" verbatim** (sourced from the canonical M0 plan,
Task 1, and unmodified by CONTEXT.md's decisions):

```python
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

Rule this file exists to enforce: nothing anywhere else in the codebase imports `pyemu`/`flopy` at
module top level (LAUNCH-01). Every later phase's ingest modules import through this module, not
directly.

### `src/pesto/launch.py` (service, event-driven startup)

**No in-repo analog. Follow RESEARCH.md "Pattern 2" — this is a *correction* to the M0 plan**, not
a copy of it. The M0 plan's `threading.Timer(0.3, webbrowser.open, ...)` scheduled before
`uvicorn.run()` is called does not satisfy LAUNCH-01 (see RESEARCH.md "Common Pitfalls → Pitfall 1").
Use `uvicorn.Server` directly (not `uvicorn.run()`) so `.started` is available as a real readiness
signal:

```python
def serve(host="127.0.0.1", port=None, open_browser=True, run_dir=None) -> None:
    port = find_free_port() if port is None else port
    app, token = create_app()
    url = f"http://{host}:{port}/?token={token}"
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)

    def _after_startup() -> None:
        while not server.started:
            time.sleep(0.005)
        threading.Thread(target=_warm_up_stack, daemon=True, name="pesto-warmup").start()
        print(f"pesto serving {url}")  # D-10: always print
        if open_browser:
            webbrowser.open(url)

    def _warm_up_stack() -> None:
        from pesto.warm import warm_up
        warm_up()

    threading.Thread(target=_after_startup, daemon=True, name="pesto-after-startup").start()
    server.run()
```

`find_free_port()` idiom (RESEARCH.md, same section, and standard across the M0 plan too):

```python
def find_free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
```

### `src/pesto/api/security.py` (middleware, request-response)

**No in-repo analog — entirely new relative to the M0 plan** (D-01/D-02 postdate it). Follow
RESEARCH.md "Code Examples → Host + token middleware" and "Token minting (D-01)" verbatim:

```python
import hmac
from fastapi import FastAPI, Request
from starlette.responses import JSONResponse

LOCAL_HOSTNAMES = {"127.0.0.1", "localhost", "::1", "[::1]"}

def _hostname_only(host_header: str) -> str:
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
                status_code=400, media_type="application/problem+json",
            )
        supplied = request.query_params.get("token") or request.headers.get("x-pesto-token", "")
        if not hmac.compare_digest(supplied, token):
            return JSONResponse(
                {"type": "about:blank", "title": "invalid or missing token", "status": 401},
                status_code=401, media_type="application/problem+json",
            )
        return await call_next(request)
```

```python
import secrets
def mint_token() -> str:
    return secrets.token_urlsafe(32)
```

**Do not use `TrustedHostMiddleware`** — RESEARCH.md's "Alternatives Considered" documents a
port-stripping bug (github.com/Kludex/starlette #1997/#1998) that makes it unsuitable given pesto's
per-launch port. **Do not compare tokens with `==`** — use `hmac.compare_digest` (timing
side-channel; RESEARCH.md "Don't Hand-Roll").

Open question the planner must resolve explicitly (RESEARCH.md Open Question 1): whether
`/api/health` is exempt from the token check. RESEARCH.md's own assumption (A3) is that it should
stay reachable without a token for liveness probes — either confirm this or update the verification
command.

### `src/pesto/cache/layout.py` (model + service, file-I/O)

**No in-repo analog. Follow RESEARCH.md "Pattern 3" — a correction to the M0 plan's
`os.access(path, os.W_OK)` check**, which D-04 explicitly rejects as inspection rather than a real
probe:

```python
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
        return _fallback_root(Path(run_dir))
    return candidate
```

`CacheLayout` itself (the directories it creates: `control/ phi/ ens/ reals/ agg/ grid/ time/`) is
carried from `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 2 (lines 606-829) unchanged —
only `resolve_cache_root`'s *mechanism* changes per D-04.

### `src/pesto/cache/manifest.py` (model, file-I/O + batch)

**No in-repo analog. Follow RESEARCH.md "Pattern 4" — a correction to the M0 plan's
`SourceFingerprint`**, which has no `checksum` field and therefore cannot implement D-06/D-07:

```python
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
        return cls(path=path.name, mtime_ns=info.st_mtime_ns, size=info.st_size,
                   checksum=digest.hexdigest())

    def matches(self, base: Path) -> bool:
        target = Path(base) / self.path
        if not target.exists():
            return False
        info = target.stat()
        if info.st_mtime_ns == self.mtime_ns and info.st_size == self.size:
            return True  # cheap path
        with open(target, "rb") as f:
            digest = hashlib.file_digest(f, "sha256")
        return digest.hexdigest() == self.checksum
```

`CACHE_VERSION` hard-invalidation (D-08) and the `Manifest`/`Artifact` container shapes are carried
from `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 3 (lines 830-1082) unchanged — only
`SourceFingerprint` gains the `checksum` field and `matches()` gains the two-tier check.

### `src/pesto/cache/gitignore.py` (utility, file-I/O)

**No in-repo analog — entirely new, no M0 plan equivalent** (D-05 postdates the M0 plan). Follow
RESEARCH.md "Pattern 5" verbatim:

```python
def ensure_gitignored(run_dir: Path) -> None:
    if not (run_dir / ".git").exists():  # file (worktree/submodule) or dir — check existence, not is_dir()
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

### `pyproject.toml` (config)

**No in-repo analog. Follow `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 1 (lines
243-605)** for the skeleton (`[build-system]` = hatchling, `[project]` metadata, `requires-python
= ">=3.11"`, `[tool.pytest.ini_options] testpaths = ["tests"]`), with one correction from
RESEARCH.md's Standard Stack table: replace the M0 plan's `pyemu` `git+develop` source pin under
`[tool.uv.sources]` with `pyemu>=1.7` — pyemu now has a released PyPI version (confirmed 1.7.0 live
against the registry).

### Test files

**No in-repo analog — no test suite exists.** `docs/superpowers/plans/2026-08-12-pesto-m0.md`
Tasks 1-3 carry reference test bodies, but RESEARCH.md's Phase Requirements → Test Map explicitly
flags each of these as needing extension, not a straight copy:
- `tests/test_launch.py` — M0 plan's four tests, plus new tests for Host-header rejection, token
  rejection, and startup-readiness-gated browser open (none exist in the M0 plan, which predates
  D-01/D-02).
- `tests/cache/test_layout.py` — M0 plan's tests, but replace the `chmod`-only fallback test with a
  monkeypatched `OSError` on the probe write (RESEARCH.md Pitfall 2 — `chmod` does not reliably
  simulate unwritability on Windows).
- `tests/cache/test_manifest.py` — M0 plan's nine tests, plus a new case: copy a fixture file to a
  new path (same content, new mtime) and assert it is *not* stale (RESEARCH.md Pitfall 3).
- `tests/cache/test_gitignore.py` — entirely new, no M0 plan equivalent.

## Shared Patterns

### Session token check
**Source:** RESEARCH.md "Code Examples → Host + token middleware" (no in-repo source; this is the
first time this pattern exists in the project)
**Apply to:** `src/pesto/api/app.py`, every route file added from Phase 2 onward
**Constraint:** compare with `hmac.compare_digest`, never `==`; mint with `secrets.token_urlsafe(32)`,
never `random`/`uuid4`.

### Host-header validation
**Source:** RESEARCH.md "Code Examples → Host + token middleware" (`_hostname_only` + middleware)
**Apply to:** `src/pesto/api/app.py`
**Constraint:** do not use Starlette's `TrustedHostMiddleware` (documented port-handling bug); use
the five-line custom middleware.

### Deferred import discipline
**Source:** RESEARCH.md "Pattern 1" / `src/pesto/warm.py`
**Apply to:** every module in the project, present and future — nothing outside `pesto.warm` may
import `pyemu`, `flopy`, or `matplotlib` at module top level.

### Probe-based filesystem writability check
**Source:** RESEARCH.md "Pattern 3"
**Apply to:** `src/pesto/cache/layout.py` only in this phase, but the try/except-around-a-real-write
idiom (never `os.access`) is the project's standing convention for any future "can I write here"
question.

## No Analog Found

Every file in this phase has no in-repo analog — this is a greenfield phase. All of them are
covered above by RESEARCH.md patterns or the gitignored M0 plan reference; none require inventing
a pattern from scratch.

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/pesto/cli.py` | controller | request-response | No project precedent at all, even in the M0 plan's own excerpted patterns section; plain `argparse` idiom per RESEARCH.md's Standard Stack table (D-09's directory-picker fallback is new relative to the M0 plan, which assumed a required path argument) |
| `tests/conftest.py` | test | — | No fixtures needed yet (Phase 1 never reads a PEST file); RESEARCH.md's Wave 0 Gaps flags this as "create the minimal version now, extend in Phase 2" |

## Metadata

**Analog search scope:** entire working tree (`find . -maxdepth 3`, excluding `.git`, `.planning`,
`docs`) — confirmed empty of source code.
**Files scanned:** 0 source files found; RESEARCH.md (830 lines) and CONTEXT.md (181 lines) read in
full instead.
**Pattern extraction date:** 2026-08-12
</content>
