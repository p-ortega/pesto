# Phase 1: Launcher, Server and Cache Foundation - Context

**Gathered:** 2026-08-12
**Status:** Ready for planning

<domain>
## Phase Boundary

The app shell and the cache bookkeeping, nothing else. A command that starts a server on loopback,
opens a browser fast, and the code that decides where a run's cache lives and whether it is still
valid.

No PEST file is read, no grid is drawn, no ensemble is parsed. Those are Phases 2 to 5. This phase
ends when pesto opens in a browser, knows where a given run's cache belongs, and can say whether that
cache is up to date.

</domain>

<decisions>
## Implementation Decisions

### Session token (resolves OPEN-05)

- **D-01:** The launcher mints a random session token at startup and puts it in the URL it opens. The
  server rejects any request that does not carry it. Built now, in Phase 1 — not deferred to M4.
  — **Reversibility:** costly — every endpoint added from Phase 2 onward inherits the check for free,
  but retrofitting it after Phase 5 means touching roughly twenty route handlers and their tests.
  Rationale from discussion: pesto's eventual home is undecided, and the token stops being cheap once
  the endpoints exist.
- **D-02:** The server also rejects requests whose `Host` header is not localhost. This closes the
  case a token alone does not: a web page open in the same browser probing local ports. Decided by
  Claude rather than asked, as a three-line addition consistent with D-01.
- **D-03:** How the token travels after the first page load — URL parameter, header, or cookie — is
  left to the planner. All work; the constraint is only that requests without a valid token fail.

### Where the cache goes, and what pesto writes into your directories

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
  — **Reversibility:** reversible — it is one file write in the user's repo, and removing the
  behaviour later leaves no artifact beyond a `.gitignore` line.

### How pesto decides the cache is stale

- **D-06:** Cheap check first, expensive check only when the cheap one looks suspicious. Opening a run
  compares each source file's size and mtime against the manifest. Only files where those disagree get
  read and checksummed, and if the checksum matches the manifest, no re-ingest happens.
  Rationale: checksumming the whole 3.5 GB benchmark run costs about 2 s on local SSD and about 30 s
  over the external USB drive, which makes M0's 1.5 s warm-open budget unreachable. Meanwhile
  size-and-mtime alone would re-ingest 11 GB every time a run directory is copied off the backup
  drive, because copying rewrites every mtime while changing no content.
  Accepted gap: an edit that preserves both size and mtime goes unnoticed. That takes deliberate
  effort to produce.
- **D-07:** When a checksum is taken, it covers the whole file — not a sample of the ends plus size.
  Rationale: the slow path is rare by construction, so it should be correct when it runs; a sampled
  hash is blind to a rewritten block in the middle of a file, which is exactly where a changed
  realization would sit. Decided by Claude, consistent with D-06.
- **D-08:** `CACHE_VERSION` remains a hard invalidation — bumping it marks everything stale regardless
  of size, mtime or checksum. Carried forward from the roadmap, not re-litigated.

### The command line and startup failures

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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

Note: everything under `docs/` is gitignored. Read it, never `git add` it.

### Architecture and scope
- `docs/superpowers/specs/2026-08-12-pesto-design.md` §2 — the server boundary: loopback only, random
  port, session token in the URL. Source of OPEN-05, resolved above by D-01.
- `docs/superpowers/specs/2026-08-12-pesto-design.md` §3 — cache location, and the statement that
  pesto adds `.pesto/` to a git-tracked run directory's `.gitignore`. Source of D-05.

### Implementation detail for this phase
- `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 1 (lines 243-605) — project skeleton, CLI and
  launcher. Carries `pyproject.toml` contents, the deferred-import design in `src/pesto/warm.py`, and
  the four launch tests. Note it has no session token; D-01 overrides that omission.
- `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 2 (lines 606-829) — cache location and layout.
  Carries `CACHE_VERSION`, `resolve_cache_root`, `CacheLayout` and its tests. Its fallback test covers
  only the read-only case; D-04 generalises it to try-and-catch.
- `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 3 (lines 830-1082) — manifest, source
  fingerprints and staleness. D-06 and D-07 govern where it disagrees.

### Project-wide constraints
- `.planning/PROJECT.md` § Constraints — Python 3.11+ via `uv run`, forbidden pyemu APIs, float32/
  float64 split, realization-name joins, commit message format.
- `.planning/intel/constraints.md` — the full 34 constraints extracted from the source specs.
- `.planning/INGEST-CONFLICTS.md` — the five spec contradictions. OPEN-05 belongs to this phase and is
  now resolved; the other four belong to Phases 3, 4, 5 and 6.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

None. The repository contains `README.md`, `LICENSE`, `.gitignore` and the `.planning/` directory.
There is no `src/`, no `pyproject.toml`, no test suite. This phase writes the first line of code in
the project.

### Established Patterns

None from code. The binding patterns come from documents rather than precedent:

- Nothing at module import time may touch pyemu, flopy or matplotlib. Importing pyemu mutates global
  state and has historically seeded numpy's global RNG. `src/pesto/warm.py` owns all deferred imports,
  and anything needing randomness constructs its own `np.random.default_rng(...)`.
- All Python runs through `uv run`. No bare `python` or `pip` anywhere, including in test commands and
  helper scripts.
- Commit messages: one line, plain language, no `Co-Authored-By` trailer, no conventional-commit
  prefix.

### Integration Points

- `pesto.cache.layout` is consumed by every later phase's ingest code (Phases 2, 3 and 4). Its
  interface is the durable output of this phase; the launcher is not.
- The token check established in D-01/D-02 becomes the gate every route added in Phase 5 passes
  through.

</code_context>

<specifics>
## Specific Ideas

- Jupyter's token-in-the-URL model was named during discussion as the reference for D-01 — a random
  token generated per launch, carried in the URL the app opens, checked on every request.
- Benchmark data lives at `~/dev/data/pesto-bench/`. The originals on `/Volumes/Gandalf/intera` are
  read-only — never write to that volume. The measured figures behind D-06 come from these runs:
  about 2 GB/s on local SSD, 85-123 MB/s over external USB.

</specifics>

<deferred>
## Deferred Ideas

- **Where pesto runs (shared machine or laptop)** — the user did not want to settle this, and chose to
  build the session token regardless. If it later turns out pesto only ever runs on a single-account
  laptop, D-01 is not wasted, but the Host-header check in D-02 becomes the part that earns its keep.
  Worth revisiting at M4 packaging, when other people install it.
- **Warning the user when a slow network share is accepted** — D-04 deliberately does not detect
  network filesystems, so a slow share writes successfully and stays slow. If that bites in practice,
  a warning belongs with the ingest progress reporting in Phase 4, not here.

</deferred>

---

*Phase: 1-Launcher, Server and Cache Foundation*
*Context gathered: 2026-08-12*
