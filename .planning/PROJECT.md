# pesto

## What This Is

A local desktop app for exploring PEST++ (pestpp-ies) results. A Python backend binds a free port on
loopback and serves a prebuilt TypeScript/WebGL2 frontend to the browser; pyemu and flopy do the
reading, confined to an ingest layer that writes a compact float32 cache. Version 1 supports
MODFLOW 6 models calibrated with pestpp-ies. It is for the modeller who has just finished a run and
wants to see how the fit improved, how the parameters moved, and where all of it sits on the grid.

## Core Value

It has to feel instant — the way a video game feels when you drag the camera, not the way a plotting
library feels when you wait for a figure. That is why the drawing happens on the graphics card and
why the data is pre-processed into a purpose-built cache instead of read on demand.

## Requirements

Full requirement list with IDs and phase mapping: `.planning/REQUIREMENTS.md`.

### Validated

(None yet — M0 is the first milestone.)

### Active

Milestone **M0 — one thin slice, end to end.** Read the run directory, control file, grid and
parameter ensembles for the first and last iteration; store them in a cache; serve them; draw the
map and nothing else. Launcher, directory picker, grid drawing, layer slider, realization slider,
colour scale, click a cell and see a readout.

M0 deliberately probes the hardest thing the app will ever draw: parameters rather than
observations, because a million parameters is a million coloured cells. Two things are forward-loaded
into M0 because they are cheap now and expensive to retrofit — every ensemble file shape, and the
per-iteration realization index.

### Out of Scope

- **Watching a running calibration** — pesto is pointed at a finished run.
- **Heavy maths (FOSM, Schur complements, data worth)** — needs a Jacobian, so a different kind of
  run (pestpp-glm). Cheap summaries only.
- **Being a notebook library** — pypestvis already fills that role; pesto is a standalone app.
- **Model types other than MODFLOW 6** — they plug in at the model adapter boundary later.
- **Stitching time series across runs** — explicitly out of scope until asked for.
- **Observation ensembles, phi views, parameter histograms, linked runs, CSV streaming for very
  large text ensembles, selective-iteration UI** — out of M0 specifically, scheduled M1-M4.

## Context

- **Prior art in the same niche:** pypestvis is a ~2000-line Jupyter library around one `VisHandler`
  class — a map of observations with layer/time/ensemble selectors. It has no parameters, no phi
  convergence, no lambda trials, no 1:1 or residual plots; it needs structured grids with hand-added
  `k,i,j`, and it draws one polygon per cell so it runs out of road around 10,000-100,000 cells.
  pesto covers what it covers plus what it lacks, at 10-100x the cell count.
- **Why linked runs matter (M3):** on big models, history matching and forecasting live in separate
  directories and share only their realizations. `runId` is in the selection from day one even
  though version 1 opens a single run.
- **Data scale:** 100,000-1,000,000 parameters, 100-500 realizations, 3-6 iterations. One
  observation table for one iteration can be 1.2 GB; a whole run ~11 GB. The
  `forecast_20250618105403` benchmark holds 2,167,174 observations — the design spec's stated
  1,000,000 ceiling is wrong and budgets should quote the real figure. Nothing may load a whole
  table into memory or send one to the browser.
- **Ingest is disk-bound, measured not assumed:** `Matrix.from_binary` reads a 1.1 GB JCB in 0.57 s
  on local SSD (~2 GB/s) and 577 MB in 4.7 s over external USB (~123 MB/s). Extra worker processes
  cannot beat the device. The process pool exists for fault isolation, not throughput.
- **The GPU is probably not the M0 risk for this model class:** `ncpl` is 9,902 / 17,726 on the
  benchmarks, and the mesh is ~40,000 triangles reused across all layers.
- **Source documents** (all under a gitignored directory, referenced by path only, never committed):
  - `docs/superpowers/specs/2026-08-12-pesto-design.md` — architecture and scope
  - `docs/superpowers/specs/2026-08-12-pesto-visual-design.md` — UI chrome, colour, layout from the
    M0 map view onward; supersedes the M0 plan's Task 16 placeholder chrome by author declaration
  - `docs/superpowers/plans/2026-08-12-pesto-m0.md` — M0 task sequencing and acceptance checks
- **Ingested intel:** `.planning/intel/` (synthesis, constraints, requirements, context) and
  `.planning/INGEST-CONFLICTS.md` (0 blockers, 5 warnings carried forward as open decisions,
  7 informational).

## Constraints

- **Tech stack**: Python `>=3.11`; FastAPI, uvicorn, numpy, pandas, pyarrow, pyemu, flopy —
  the reading is a solved problem and pyemu already solved it.
- **Tooling**: run **all** Python commands through `uv run`. No bare `python`/`pip`.
- **Frontend**: TypeScript, Vite, WebGL2, apache-arrow, vitest, Playwright. Node is a build-time
  dependency only — the compiled frontend ships inside the Python package so the user never installs
  Node.
- **Forbidden pyemu APIs**: never call `pyemu.ObservationEnsemble.from_binary`,
  `ParameterEnsemble.from_binary`, or `Matrix.to_dataframe()`. Use `pyemu.Matrix.from_binary(path)`
  and read `.x`, `.row_names`, `.col_names` — the pandas path builds one column per parameter and the
  ensemble constructor runs `replace([inf, -inf], nan)` over the whole array, a full copy of ~2.4 GB.
- **Numeric precision**: ensembles stored **float32** (~7 significant digits, halves disk cost); phi
  stored **float64** (phi reaches 1e11 and is divided by other phi values).
- **Cross-iteration joins**: anything comparing across iterations joins on **realization name**,
  never row position. Realizations leave and return between iterations, so iteration 0 and iteration
  3 hold different sets. Positional alignment does not fail loudly — it produces a plausible answer
  about the wrong realizations.
- **Ordering**: parameter and realization ordering comes from the names inside the ensemble file,
  never from control-file position. Above 100,000 parameters pestpp writes hash-ordered binaries by
  default.
- **Global RNG**: importing pyemu mutates global state and has historically seeded numpy's global
  RNG. Nothing in pesto may rely on it — anything needing randomness uses its own
  `np.random.default_rng(...)`.
- **Network exposure**: one process on the user's own machine, listening only on `127.0.0.1` on a
  free port chosen at launch. (Session-token hardening is OPEN-05.)
- **Read-only data**: benchmark originals live at `/Volumes/Gandalf/intera` — **never write to that
  volume.** Working copies at `~/dev/data/pesto-bench/`.
- **Repository hygiene**: `docs/` is gitignored — **never** `git add` anything under `docs/`. This
  includes generated outputs such as `docs/superpowers/plans/m0-results.md`.
- **Commit messages**: one line, plain language, minimal jargon. No `Co-Authored-By` trailer, no
  `feat:`/`chore:`/conventional-commit prefixes. Example: `add cache layout with fallback location`.

## Open Decisions

Five contradictions between the source specs were carried forward deliberately rather than resolved
at ingest. **None of these is decided, and none is locked** — no ingested document carried
`locked: true` and no ADR exists for this project. Each is attached to the phase whose planning must
resolve it, so `/gsd-discuss-phase` surfaces it before that phase is planned.

| ID | Open question | Resolve during |
|----|---------------|----------------|
| OPEN-01 | Which M0 exit criteria govern — design spec §7's numeric targets (`REQ-m0-exit-criteria-v1`) or the M0 plan Task 17 measured revision (`REQ-m0-exit-criteria-v2`)? Both carried unmerged in REQUIREMENTS.md. | Phase 6 |
| OPEN-02 | Does `locate_par`/`locate_obs` live on `SpatialAdapter` (design spec §2), or does cell mapping live in `ingest/parcells.py` (M0 plan Task 7), leaking MODFLOW knowledge outside `model/`? Architecture. | Phase 3 |
| OPEN-03 | Parameter ensemble storage orientation: per-group layout (design spec §3) or one layout per file (M0 plan Task 9)? An on-disk format decision, expensive to change once caches exist in the field. | Phase 4 |
| OPEN-04 | Header configuration chips are required at M0 by visual spec §6, but no M0 task creates `ingest/runconfig.py`, no `/config` route exists, and `OpenRun.summary()` lacks the fields. Add a runconfig task + endpoint to M0, or defer the chips to M1? | Phase 5 |
| OPEN-05 | Session token: design spec §2 requires the URL to carry one so nothing is reachable "not even from another user on the same machine". M0 plan Task 1 has loopback binding only. Build it, or defer to M4 packaging and record the residual exposure? | Phase 1 |

The **developer-facing success metric for M0 is deliberately left open** — it is OPEN-01, and
choosing it now would silently discard either a stated design gate or a measured rationale.

## Key Decisions

No decisions of record exist yet. The ingest produced **zero** locked decisions: all three source
documents classified as SPEC, none used ADR structure, none carried `locked: true`.

The following technical choices are embedded in the design spec's prose. They are listed for
awareness and are **not** protected from being overridden — promote them to ADRs and re-ingest if
they should become non-overridable.

| Choice | Rationale | Outcome |
|--------|-----------|---------|
| Pre-process into a purpose-built cache rather than reading PEST files on demand | Instant is the product; reading on demand cannot be instant at 11 GB | — Pending |
| Confine pyemu/flopy to `ingest/`; no query path touches them | Import cost and global-state mutation stay off the hot path | — Pending |
| Join runs by verified parameter-value hash, never by realization name alone | `pyemu/en.py:1206` names drawn realizations `np.arange(num_reals)`, so `0..499` can mean different things in two directories | — Pending |
| Isolate all MODFLOW knowledge behind `SpatialAdapter` | Adding a second model type should mean writing one file, not rewriting the app | ⚠️ Contradicted — see OPEN-02 |
| Store big tables realization-adjacent, sorted group/site/time | Matches the access pattern the map makes on every slider move | ⚠️ Orientation contested — see OPEN-03 |

---
*Last updated: 2026-08-12 after doc ingest and M0 roadmapping*
