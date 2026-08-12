## Conflict Detection Report

Mode: new. Precedence: ADR > SPEC > PRD > DOC. All three ingested documents classified SPEC, so the
default ordering produces a three-way tie. Ties were broken only by **author-declared** relationships
stated inside the documents themselves, never by filename, date or arbitrary order:

- `2026-08-12-pesto-design.md` is authoritative on architecture and scope.
- `2026-08-12-pesto-visual-design.md` declares in its own header: "Applies to: the M0 map view
  onward. Replaces the placeholder chrome in the M0 plan's Task 16." It is therefore authoritative
  over the M0 plan on UI chrome, colour and layout.
- `2026-08-12-pesto-m0.md` is authoritative on M0 task sequencing and M0 acceptance checks.

No document carries `locked: true`. No LOCKED-vs-LOCKED contradiction is possible in this set.

### BLOCKERS (0)

None. No locked decisions, no UNKNOWN or low-confidence classifications, and no precedence cycle.

Cycle detection was run over the `cross_refs` graph. Three edges form mutual citations:
`design <-> visual-design` (design §4 links the visual contract; visual-design cites "main spec")
and `visual-design <-> m0-plan` (visual-design cites "M0 plan Task 16"; m0-plan Task 16 cites the
visual contract). These are **citation** cycles of depth 1 between companion documents, not
precedence cycles: the precedence graph declared above (design > visual on architecture, visual >
m0-plan on chrome, design > m0-plan on scope) is a total order and is acyclic. Traversal depth never
exceeded 2 against a cap of 50. Synthesis proceeded; nothing was suppressed.

### WARNINGS (5)

[WARNING] Competing M0 exit criteria — two acceptance-criteria sets for the same gate
  Found: docs/superpowers/specs/2026-08-12-pesto-design.md §7 requires ingest of 1e6 par x 300 reals
    x 2 iterations in 10 minutes or less, and 30 fps or better stepping realizations on a million
    cells, and states "If these targets are not met, the design changes before M1 begins."
  Found: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 17 Step 5 replaces both. Ingest becomes a
    scaling check for accidental quadratic behaviour (`large < small * 10`) because ingest is
    disk-bound at ~2 GB/s local and ~85-123 MB/s over USB, so a wall-clock ceiling only measures the
    disk. Frame rate is replaced by slider-to-frame latency because `ncpl` is 9,902 on the DISV
    benchmark, not 1e6. Three criteria (1.5 s warm open, 100 ms query p95, 1.5x cache size) are kept
    and a correctness criterion is added.
  Impact: These are the gate that decides whether M1 proceeds. Picking one silently discards either a
    stated design gate or a measured rationale. Both are preserved verbatim in
    .planning/intel/requirements.md as REQ-m0-exit-criteria-v1 and REQ-m0-exit-criteria-v2.
  → Choose one variant as the M0 gate, or accept v2 and mark the design spec's §7 table superseded in
    the same explicit way the visual-design spec supersedes Task 16.

[WARNING] SpatialAdapter surface disagrees — the MODFLOW boundary leaks
  Found: docs/superpowers/specs/2026-08-12-pesto-design.md §2 defines the boundary as
    `grid_mesh()`, `locate_obs(meta)`, `locate_par(meta)`, `layers()`, `crs()`, with the invariant
    "all the MODFLOW-specific code lives in one small corner of the codebase behind a clearly defined
    boundary. Nothing else in pesto knows what MODFLOW is."
  Found: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 8 defines
    `grid_mesh()`, `grid_shape()`, `idomain()`, `crs()`. `locate_par` is not on the adapter — Task 7
    puts the mapping in `src/pesto/ingest/parcells.py`, outside `model/`, where the rule table
    encodes MODFLOW-shaped knowledge directly (`k`/`i`/`j`, `idx0`/`idx1`/`idx2`, `i * ncol + j`,
    DISV having no rows or columns).
  Impact: The design spec's stated purchase for supporting other model types later — "Adding a second
    model type later means writing one new file, not rewriting the app" — does not hold if cell
    resolution lives outside the adapter. This is architecture, where the design spec is
    authoritative, so it cannot be waved through as M0 scoping.
  → Decide before M1: either move `locate_par`/`locate_obs` back onto `SpatialAdapter` and have
    `parcells.py` be an `Mf6Adapter` implementation detail, or amend the design spec §2 protocol to
    match and state what now guards the boundary.

[WARNING] Parameter ensemble storage orientation — per-group versus per-file
  Found: docs/superpowers/specs/2026-08-12-pesto-design.md §3 requires "groups that appear on the map
    are stored realization-first, and groups that do not are stored parameter-first. It is a
    per-group choice made at ingest, and it costs nothing extra on disk."
  Found: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 9 writes one file per iteration with one
    orientation for all parameters: `_choose_layout` returns `realization_first` if
    `any(group in mappable for group in par_group)`, else `parameter_first`. `StoredEnsemble` carries
    a single `layout` field.
  Impact: A different on-disk format, not a narrowing. On any real run with at least one mappable
    group the whole ensemble becomes realization-first, so `read_par_across_reals` — the access
    pattern that M1's group histograms and per-parameter drill-down depend on — becomes a strided
    read across the entire file. That is precisely the cost the per-group split exists to avoid, and
    the file format is expensive to change once caches exist in the field.
  → Confirm which format governs. If per-group, Task 9 needs two output files (or grouped offsets)
    and `StoredEnsemble` needs per-group layout metadata. If per-file, amend design spec §3 and state
    what M1's parameter-first queries will read instead.

[WARNING] The header configuration chips are required at M0 but nothing supplies them
  Found: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §6 (which "applies to the M0 map
    view onward") requires the header to carry the run's configuration as chips: parameter count,
    realization count and whether `base` is still alive, iteration count with `noptmax`, whether a
    projection exists, and `⚠ no measurement noise` in warning ink — "the one fact that changes what
    every other figure means".
  Found: docs/superpowers/plans/2026-08-12-pesto-m0.md ships the CSS for exactly this (`.chip`,
    `.chip.warn`, with the comment "the one fact that changes what every figure means") but:
    `ingest/runconfig.py` is listed in the File Structure and **no task creates it**; `query.py` is
    described in the File Structure as serving "config, reals, meta, ..." but Task 13's route list
    has no `.../config`; and `OpenRun.summary()` in Task 12 returns `noptmax`, `iterations`,
    `has_grid`, `phi_kinds`, `cache_root`, `cache_ready`, `artifacts` — no noise path, no `base`
    status, no parameter count, no CRS.
  Impact: The M0 map view cannot render its mandated header. The noise chip in particular is the
    honesty requirement of design spec §4 given visual form; shipping a map without it means every
    figure is read without the one fact that changes its meaning. Note the design spec independently
    schedules the configuration panel for M1, so the two specs also disagree on when this lands.
  → Either add a `runconfig` ingest task plus a `.../config` endpoint to M0 and extend the workspace
    summary, or record in the visual contract that the chips arrive in M1 with the configuration
    panel and state what the M0 header shows instead.

[WARNING] Session token absent from the M0 launcher
  Found: docs/superpowers/specs/2026-08-12-pesto-design.md §2: "The server only listens on
    `127.0.0.1`, on a random port, and the URL carries a session token. Nothing is reachable from the
    network — not from another machine, not from another user on the same machine."
  Found: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 1 implements loopback binding
    (`serve(host='127.0.0.1', port=None, ...)`, free-port selection) but there is no session token
    anywhere in the plan. The only `token` in the frontend is a request-sequence counter in
    `map-view.ts`.
  Impact: Loopback binding alone satisfies "not from another machine" but not "not from another user
    on the same machine", which the design spec states explicitly. The launcher is built in M0 and
    the design spec assigns the token to no later milestone, so it is not deferred by any document.
  → Add token issuance and checking to Task 1, or record an explicit decision to defer it to M4
    packaging and note the residual exposure.

### INFO (7)

[INFO] Auto-resolved: visual-design supersedes the M0 plan on chrome, by author declaration
  Note: docs/superpowers/specs/2026-08-12-pesto-visual-design.md states in its header "Replaces the
  placeholder chrome in the M0 plan's Task 16", and Task 16 of
  docs/superpowers/plans/2026-08-12-pesto-m0.md agrees: "Build this against
  ...2026-08-12-pesto-visual-design.md. That document is the design contract ... do not invent
  colours outside it." Treated as a declared supersession, not a conflict. All token, palette,
  colormap, scale, layout, overlay, basemap, state and accessibility content in
  .planning/intel/constraints.md is taken from the visual contract.

[INFO] Auto-resolved: the M0 plan narrows the design spec's scope, by derivation
  Note: docs/superpowers/plans/2026-08-12-pesto-m0.md is the implementation plan derived from
  docs/superpowers/specs/2026-08-12-pesto-design.md §7's M0 definition. Its omissions of observation
  ensembles, phi, histograms, linked runs, CSV streaming and the selective-iteration UI are
  intentional milestone scoping, confirmed by the plan's own Self-review section, and were not
  treated as contradictions.

[INFO] Corrected by measurement: the observation ceiling
  Note: docs/superpowers/specs/2026-08-12-pesto-design.md §1 states observations "up to 1,000,000".
  docs/superpowers/plans/2026-08-12-pesto-m0.md measured 2,167,174 observations in
  `forecast_20250618105403` and states "the design holds, since nothing in it keeps observations in
  memory, but the stated ceiling is wrong and budgets should quote the real figure." Recorded as an
  author-declared correction; both figures are carried in .planning/intel/constraints.md. The
  design's derived size arithmetic (1.2 GB per table per iteration, ~11 GB per run) is based on the
  1e6 figure and would roughly double at the measured scale.

[INFO] `grid/values` signature differs between the two specs
  Note: docs/superpowers/specs/2026-08-12-pesto-design.md §3 lists
  `GET .../grid/values?iter=&layer=&time=&stat=&group=`; Task 13 of the M0 plan implements
  `?iter=&layer=&realization=&stat=&group=`. `time` is dropped because observations are not in M0 so
  there is no time axis; `realization` is added because design spec §7 puts a realization slider in
  M0 and the enumerated signature has no way to name one. Relatedly, `Selection.stat` in design spec
  §4 is `'mean'|'std'|'q50'|'sigma_ratio'|'rmse'|'pdc'` while the M0 plan uses
  `'value'|'mean'|'std'|'q50'|'at_bounds'` — `'value'` (a single realization's field) is required by
  the M0 map and is missing from the design spec's enum. Resolved in favour of the M0 plan on
  concrete signatures; the design spec's enum should gain `'value'`.

[INFO] Ingest worker default: min(4, cores) versus 1
  Note: docs/superpowers/specs/2026-08-12-pesto-design.md §3 sets a "deliberately modest" default of
  `min(4, cores)`, configurable, and defers the question to M0 measurement. The M0 plan measured
  ingest as disk-bound and concludes the pool exists "for fault isolation only", but its own prose
  says "the `min(4, cores)` default in the spec is right for the wrong reason" while its signature is
  `ingest_run(..., workers: int = 1)` and every call site passes `workers=1`. Resolved in favour of
  the M0 plan's signature (measurement-backed, and one worker still gives process-level fault
  isolation), but the plan contradicts itself in prose and should say `workers=1` outright.

[INFO] Numeric drift against the visual contract, auto-resolved in the contract's favour
  Note: three small deviations in docs/superpowers/plans/2026-08-12-pesto-m0.md Task 16 against
  docs/superpowers/specs/2026-08-12-pesto-visual-design.md, which is authoritative on chrome and
  colour: (a) `scaleLimits(values, 'auto', 0.01)` in `map-view.ts` gives robust 1-99% limits where
  §5 specifies **2-98%**; (b) the colormap picker in `controls.ts` offers three options
  (`viridis`, `magma`, `diverging`) and `Task 14` types `COLORMAPS` as three entries, while
  `colormap.ts` in Task 15 defines all nine ramps and §12 puts "the nine colormaps, reverse,
  log/linear, robust limits" in **M0** — so the M0 plan is internally inconsistent as well as short
  of the contract; (c) `map-view.draw()` hardcodes `gl.clearColor(0.09, 0.09, 0.11, 1)`, a colour
  outside the token set and fixed regardless of theme, so the map canvas stays dark in light mode.
  Also unwired: `applyValueScale` / `ValueScale = 'linear'|'log10'` is defined in `colormap.ts` and
  never called, and `controls.ts` renders no scale control — yet Task 16's own preamble names
  "log₁₀ scaling defaulted from `partrans`" as one of three contract items landing in M0, and both
  specs call it the single highest-impact control. The visual contract wins on all four; Task 16
  needs the nine-ramp picker, the reverse switch, the linear/log10 control wired to `partrans`, a
  2-98% default, and a themed canvas clear colour.

[INFO] Two dangling or unscheduled references
  Note: (a) `docs/superpowers/plans/m0-results.md` is listed in the M0 plan's `cross_refs` and does
  not exist — it is an output of Task 17 Step 5 and is deliberately never committed because `docs/`
  is gitignored. No action needed. (b) design spec §3 states "If the run directory is a git
  repository, pesto adds `.pesto/` to its `.gitignore`" — no M0 task does this and no milestone
  claims it. Cache location and layout is M0 Task 2, so it is the natural home; otherwise assign it
  to M4.
