# Roadmap: pesto

## Overview

This roadmap decomposes **M0 only** — one thin slice, end to end, built as a risk probe. The journey
runs in one direction: an app shell that opens instantly and knows where its cache lives; a reader
that copes with every shape pestpp-ies writes an ensemble in; a MODFLOW 6 grid turned into GPU
buffers with parameters resolved onto cells; an ingest that turns a whole run into a compact float32
cache without one bad file taking the app down; then the payoff — the browser fetching those buffers
and drawing a million coloured cells that respond to a slider the way a video game responds to a
camera drag. The last phase measures it, because the whole point of a risk probe is the number it
comes back with.

M1-M4 are recorded under Future Milestones and deliberately **not** decomposed into phases — M1's
content depends on what M0 measures.

## Open Decisions Carried Into This Roadmap

Five contradictions between the source specs were carried forward unresolved. **None is locked and
none is decided** — the ingest produced zero locked decisions. Each is attached to the phase whose
planning must resolve it, so `/gsd-discuss-phase` surfaces it before that phase is planned. Full
detail: `.planning/INGEST-CONFLICTS.md`, summarised in PROJECT.md § Open Decisions.

| ID | Resolve during | Subject |
|----|----------------|---------|
| OPEN-05 | Phase 1 | Session token on the launcher URL |
| OPEN-02 | Phase 3 | `SpatialAdapter` surface — where `locate_par` lives |
| OPEN-03 | Phase 4 | Parameter ensemble storage orientation — per-group or per-file |
| OPEN-04 | Phase 5 | Header configuration chips at M0, or deferred to M1 |
| OPEN-01 | Phase 6 | Which M0 exit criteria govern (the developer-facing success metric) |

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Launcher, Server and Cache Foundation** - The app opens instantly on loopback and knows where its cache lives and when it is stale
- [ ] **Phase 2: Reading a PEST++ Run** - Any pestpp-ies run directory can be read and described, whatever shape its files are in
- [ ] **Phase 3: The Grid and Parameters on Cells** - A MODFLOW 6 grid becomes GPU-ready buffers and every parameter resolves to a layer and cell
- [ ] **Phase 4: Ingest into the Cache** - A whole run becomes a compact float32 cache, artifact by artifact, with failures isolated and progress reported
- [ ] **Phase 5: Serving and Drawing the Map** - The user picks a directory, watches it ingest, and drags sliders over a coloured grid that answers instantly
- [ ] **Phase 6: Measuring M0 Against Its Budgets** - The benchmark runs produce the numbers that decide whether M1 proceeds as designed

## Phase Details

### Phase 1: Launcher, Server and Cache Foundation
**Goal**: pesto starts from the command line, opens a browser window on a free loopback port before
any heavy library has finished importing, and knows where each run's cache lives and whether it is
stale.
**Depends on**: Nothing (first phase)
**Requirements**: LAUNCH-01, LAUNCH-02, LAUNCH-03, LAUNCH-04
**Success Criteria** (what must be TRUE):
  1. User runs pesto and a browser window appears in about 150 ms — verifiably before pyemu and
     flopy have imported, because nothing at module load touches them and the imports happen on a
     background thread started once the port is bound.
  2. The server accepts connections on `127.0.0.1` and refuses them from any other address.
  3. Opening a run directory produces a cache root at `.pesto/` inside it, or a stable path under
     `~/.cache/pesto/` when that directory is read-only, on a network share or short on space; an
     explicit override wins over both.
  4. Touching a source file marks only the artifacts derived from it as stale (by size, mtime and
     checksum), and bumping `CACHE_VERSION` marks everything stale.
**Plans**: TBD
**Open Decisions**: **OPEN-05 — session token.** Design spec §2 requires the URL to carry a session
token so nothing is reachable "not from another machine, **not from another user on the same
machine**". M0 plan Task 1 implements loopback binding and a random port but no token, and no
document defers it to a later milestone. Resolve before planning: build token issuance and checking
into the launcher now, or record an explicit deferral to M4 packaging along with the residual
exposure. This is decided here because this is where the URL is minted; if the answer is "build it",
request-side enforcement lands in Phase 5.
**Notes**: Design spec §3 states that when the run directory is a git repository, pesto adds
`.pesto/` to its `.gitignore`. No source document schedules this. Cache location is this phase, so
it is the natural home — otherwise it moves to M4.

### Phase 2: Reading a PEST++ Run
**Goal**: Pointed at a real pestpp-ies working directory, pesto reads it and says what is in it —
whatever shape the files happen to be in, and whatever the run's `NOPTMAX` was.
**Depends on**: Phase 1
**Requirements**: READ-01, READ-02, READ-03, READ-04, READ-05
**Success Criteria** (what must be TRUE):
  1. The same ensemble expressed as `.csv`, `.jcb` and dense `.bin`, realization-major or
     variable-major, hash-ordered or control-file-ordered, reads to identical realization-major
     float32 values.
  2. Pointed at a run directory, pesto lists the control file, per-iteration parameter and
     observation ensembles, phi files and grid file it found, and names anything it could not read
     instead of skipping it silently.
  3. A run whose survivors are named `['base','34','35','176',...]` reports those names in that
     order — row 1 is realization `34`, not `1`.
  4. Parameter and observation tables carry group, bounds and `partrans`, including for `PstFrom`
     control files that reference external parameter data.
  5. A `NOPTMAX <= 0` run — single evaluation, prior Monte Carlo, forecast directory — opens without
     the caller special-casing it.
**Plans**: TBD
**Notes**: Discovery covers observation and phi files even though M0 does not use them, so M1 need
not revisit discovery. The forbidden pyemu APIs constraint bites hardest here: use
`pyemu.Matrix.from_binary(path)` with `.x` / `.row_names` / `.col_names`, plus
`get_dense_binary_info` and `read_dense(only_rows=...)` for selective reads.

### Phase 3: The Grid and Parameters on Cells
**Goal**: A MODFLOW 6 grid file becomes buffers the graphics card can use directly, and every
parameter group either resolves to a layer and cell or is honestly marked as unplaceable — with all
MODFLOW knowledge behind one boundary.
**Depends on**: Phase 2
**Requirements**: GRID-01, GRID-02, GRID-03, GRID-04, GRID-05
**Success Criteria** (what must be TRUE):
  1. A DIS or DISV grid file yields `positions` float32 `(n_vert, 2)`, `cell_index` float32
     `(n_vert,)`, `indices` uint32 `(n_tri * 3,)`, plus layer count, bounds, `idomain` and CRS —
     with vertices unshared so each one knows its cell, and 4-to-7-sided polygons fanned into
     triangles.
  2. For each parameter group, pesto reports which resolution rule placed it — `kij`, `idx-triple`,
     `idx-pair`, `ij-name-layer` or `ij-single-layer` — including the benchmark case of `i`, `j`,
     `idx0`, `idx1`, `idx2` present but **no** `k`.
  3. A group nothing matched is marked `-1` (never `0`); the map draws the grid with nothing plotted
     on it, every other view still works, and pesto states this once rather than repeatedly.
  4. Buffers are produced in model coordinates and nothing reprojects the mesh.
  5. A run with no grid file, or a grid with no CRS, is handled as a normal state — no map, or model
     coordinates without a scale bar — not as an error.
**Plans**: TBD
**Open Decisions**: **OPEN-02 — `SpatialAdapter` surface.** Design spec §2 puts `locate_par` and
`locate_obs` on the adapter, with the invariant "nothing else in pesto knows what MODFLOW is". M0
plan Task 7 instead puts cell resolution in `ingest/parcells.py`, outside `model/`, where the rule
table encodes MODFLOW-shaped knowledge directly (`k`/`i`/`j`, `idx0`/`idx1`/`idx2`, `i * ncol + j`,
DISV having no rows or columns). Resolve before planning: either move `locate_par`/`locate_obs` back
onto the adapter and make `parcells.py` an `Mf6Adapter` implementation detail, or amend the design
spec §2 protocol and state what now guards the boundary. This is architecture, and it decides
whether "a second model type is one new file" survives.
**Notes**: Pilot points on DISV are unsupported in `PstFrom` and several pyemu paths assume
structured rows and columns, so a DISV model can be `PstFrom`-built and still arrive with no usable
cell information. That path is a designed state, not a bug.

### Phase 4: Ingest into the Cache
**Goal**: A whole run turns into a compact float32 cache — ensembles, realization index, summaries —
written artifact by artifact so one malformed file costs one artifact, with progress reported as
real figures while it happens.
**Depends on**: Phase 3
**Requirements**: INGEST-01, INGEST-02, INGEST-03, INGEST-04, INGEST-05
**Success Criteria** (what must be TRUE):
  1. Ingesting a benchmark run writes the first and last iteration's parameter ensembles as float32
     under the documented cache layout, with a manifest recording each source file's size, mtime and
     checksum.
  2. Each iteration's realization names are recorded in file order, so a later comparison between
     iteration 0 and iteration N can join by name rather than row position.
  3. Per-parameter summaries — mean, std, min, max, q05/q25/q50/q75/q95, `n_valid`, at-bounds
     fraction — exist for every ingested iteration.
  4. A deliberately malformed ensemble file fails its own artifact and its own worker process; the
     rest of the run still ingests and the failure is reported by artifact name and reason.
  5. While ingest runs, the caller sees per-artifact rows with real sizes and timings, and re-running
     ingest on an unchanged directory re-reads nothing.
**Plans**: TBD
**Open Decisions**: **OPEN-03 — parameter ensemble storage orientation.** Design spec §3 requires a
**per-group** choice: groups that appear on the map stored realization-first, groups that do not
stored parameter-first, "and it costs nothing extra on disk". M0 plan Task 9 writes one
`StoredEnsemble` per iteration with a single file-wide `layout`, chosen by
`any(group in mappable for group in par_group)`. These are different on-disk formats, not a
narrowing: on any real run with at least one mappable group, the whole ensemble becomes
realization-first, so `read_par_across_reals` — the access pattern M1's group histograms and
per-parameter drill-down depend on — becomes a strided read across the entire file. Resolve before
planning: this format is expensive to change once caches exist in the field.
**Notes**: Ingest is measured to be disk-bound (~2 GB/s local SSD, ~85-123 MB/s external USB), so
the process pool buys fault isolation, not throughput. The sources disagree on the worker default
(`min(4, cores)` versus `1`); the M0 plan's `workers=1` signature is measurement-backed and still
gives process-level isolation.

### Phase 5: Serving and Drawing the Map
**Goal**: The user opens pesto, browses to a run directory, watches it ingest, and then drags layer
and realization sliders over a parameter field drawn on the graphics card that answers instantly —
with the colour, scale and theme controls the visual contract puts in M0.
**Depends on**: Phase 4
**Requirements**: SERVE-01, SERVE-02, SERVE-03, MAP-01, MAP-02, MAP-03, MAP-04, MAP-05, MAP-06,
MAP-07, MAP-08, MAP-09, MAP-10, MAP-11, MAP-12
**Success Criteria** (what must be TRUE):
  1. User browses the filesystem from inside the app and picks a run directory; the picker runs
     server-side, so the browser never learns a path it was not handed.
  2. User sees the model grid drawn on the graphics card coloured by a chosen parameter group's
     field, and dragging the layer or realization slider — or switching between a single
     realization's values and a statistic across realizations — redraws without a visible wait.
  3. User can pick any of the nine colormaps, reverse any of them, and switch the value scale
     between linear and log10 defaulted from the parameter's own `partrans`, with robust 2-98%
     limits by default.
  4. User clicks a cell and sees its value; the selected cell is marked with a ring, inactive cells
     are drawn as a hairline outline and nothing else, and the Dark/Light/System theme applies to
     chrome and canvas alike using only the visual contract's tokens.
  5. Every state the user can reach is a designed state that names what is missing and why —
     choosing a directory, ingesting, no grid file, no projection, no cell mapping, an artifact
     failed, no WebGL2 — and a graphics context lost to laptop sleep is re-established and
     re-uploaded rather than left blank.
**Plans**: TBD
**UI hint**: yes
**Open Decisions**: **OPEN-04 — header configuration chips.** Visual spec §6, which explicitly
"applies to the M0 map view onward", requires the header to carry the run's configuration as chips:
parameter count, realization count and whether `base` is alive, iteration count with `noptmax`,
whether a projection exists, and `⚠ no measurement noise` in warning ink — "the one fact that
changes what every other figure means". But no M0 task creates `ingest/runconfig.py`, Task 13's
route list has no `.../config`, and `OpenRun.summary()` returns none of the fields. Resolve before
planning: either add a runconfig ingest step plus a `.../config` endpoint to M0 and extend the
workspace summary, or record in the visual contract that the chips arrive in M1 with the
configuration panel and state what the M0 header shows instead. **If the answer is "ship them in
M0", the runconfig artifact belongs in Phase 4** — decide early enough to avoid an insertion.
**Notes**: The visual contract supersedes the M0 plan's Task 16 chrome by author declaration, and
Task 16 agrees. Four known deviations in Task 16 must be corrected in this phase's favour of the
contract: robust limits are **2-98%**, not the 1-99% in `map-view.ts`; the picker offers **nine**
ramps with a reverse switch, not three; the linear/log10 control must actually be wired to
`partrans` (`applyValueScale` is currently defined and never called); and the canvas clear colour
must be themed rather than the hardcoded `gl.clearColor(0.09, 0.09, 0.11, 1)`. Also note
`grid/values` takes `realization` rather than `time` in M0, and `Selection.stat` needs `'value'`
(a single realization's field), which the design spec's enum lacks.

### Phase 6: Measuring M0 Against Its Budgets
**Goal**: M0 is measured on the real benchmark runs, and the numbers — not an opinion — decide
whether M1 proceeds as designed or the design changes first.
**Depends on**: Phase 5
**Requirements**: REQ-m0-exit-criteria-v1, REQ-m0-exit-criteria-v2
**Success Criteria** (what must be TRUE):
  1. Opening a benchmark run that has already been ingested completes in 1.5 s or less. *(Agreed by
     both exit variants.)*
  2. The `grid/values` request the map makes on every slider move has a p95 of 100 ms or less.
     *(Agreed by both exit variants.)*
  3. The cache is no more than 1.5x the size of the source files it was built from. *(Agreed by both
     exit variants.)*
  4. Ingest cost and rendering responsiveness are measured on both benchmark runs
     (`forecast_20250618105403`, DISV `nlay 38 ncpl 9902`, dense 494 x 117407, 2,167,174 obs; and
     `hm_20250406221554`, DISV `nlay 36 ncpl 17726`, JCB 500 x 141163) with disk time and processing
     time recorded separately — and judged against whichever exit variant OPEN-01 selects.
  5. The measured results are written up (to `docs/superpowers/plans/m0-results.md`, which is
     **not** committed because `docs/` is gitignored) and M1 is either green-lit or the design
     changes before it begins.
**Plans**: TBD
**Open Decisions**: **OPEN-01 — which M0 exit criteria govern. This is the developer-facing success
metric for the milestone and it is deliberately left open.** Design spec §7
(`REQ-m0-exit-criteria-v1`) sets fixed numeric targets on a real million-parameter run — 10 minutes
to read 1e6 par x 300 reals x 2 iterations, 30 fps stepping realizations on a million cells — and
states "if these targets are not met, the design changes before M1 begins". M0 plan Task 17 Step 5
(`REQ-m0-exit-criteria-v2`) replaces both: ingest becomes a scaling assertion
(`large < small * 10`) because ingest is disk-bound and a wall-clock ceiling only measures the disk;
frame rate becomes slider-to-frame latency because `ncpl` is 9,902 on the DISV benchmark, not 1e6.
v2 also adds a correctness criterion v1 lacks. Both are carried verbatim and unmerged in
REQUIREMENTS.md. Resolve before planning: choose one variant, or accept v2 and mark design spec §7's
table superseded in the same explicit way the visual-design spec supersedes Task 16. Picking one
silently discards either a stated design gate or a measured rationale.

## Future Milestones

Recorded, **not** decomposed into phases. M1's content depends on what M0 measures, so decomposing
it now would be guessing. Full detail in REQUIREMENTS.md § Future Milestones.

- 📋 **M1 — parameters, observations, histograms, and the two-way link.** Parameter view proper;
  observation ensembles and view; observation statistics as a second map colouring with a time
  slider; the shared selection and full two-way linking; the configuration panel. From the visual
  contract: section view, overlays, local-image basemap, discrete colour classes, symmetric scaling,
  texture fill. Also absorbs two gaps knowingly carried out of M0 — caching the parameter-to-cell
  resolve, and replacing `MeshLayer.pickAtWorld`'s linear triangle scan.
- 📋 **M2 — phi and the derived diagnostics.** All six phi histories and the phi view; brushing
  realizations to recolour the map; spread shrinkage, at-bounds counts, prior distance, RMSE and
  mean error by group; PDC and PCS read from pestpp's own files; which realizations were dropped,
  when and why. Plus tile-service basemaps and pyemu-snippet export.
- 📋 **M3 — linked runs.** Opening a workspace of several directories; declaring what each run is;
  verifying the realization join by parameter hash and reporting the result honestly; selection
  propagation across runs; filtering a forecast ensemble by history-matching survival or phi
  threshold.
- 📋 **M4 — packaging and rough edges.** Double-clickable app with an icon; chunked CSV reader;
  iteration-selection UI with size and time estimates; configurable cache location and read-only
  fallback; confirming the no-CRS and no-cell-information paths behave as described.

## Progress

**Execution Order:** Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Launcher, Server and Cache Foundation | 0/TBD | Not started | - |
| 2. Reading a PEST++ Run | 0/TBD | Not started | - |
| 3. The Grid and Parameters on Cells | 0/TBD | Not started | - |
| 4. Ingest into the Cache | 0/TBD | Not started | - |
| 5. Serving and Drawing the Map | 0/TBD | Not started | - |
| 6. Measuring M0 Against Its Budgets | 0/TBD | Not started | - |
