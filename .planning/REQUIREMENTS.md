# Requirements: pesto

**Defined:** 2026-08-12
**Milestone:** M0 — one thin slice, end to end (the risk probe)
**Core Value:** It has to feel instant — the way a video game feels when you drag the camera.

Derived from `.planning/intel/` (ingest of the design spec, visual design spec and M0 plan).
Requirements marked `[OPEN-nn]` depend on an unresolved decision — see PROJECT.md § Open Decisions.

## v1 Requirements

Milestone M0 only. M1-M4 are recorded under Future Milestones and are not in this roadmap.

### Launcher, Server and Cache (LAUNCH)

- [x] **LAUNCH-01**: User runs pesto from the command line and a browser window opens in about
      150 ms on a free port — nothing at module load touches pyemu or flopy; one background thread
      imports them immediately after the port is bound.

- [x] **LAUNCH-02**: The server listens only on `127.0.0.1` and is not reachable from another
      machine. `[OPEN-05 — whether a session token also blocks another user on the same machine]`

- [ ] **LAUNCH-03**: Each run caches itself under `.pesto/` in the run directory, falling back to a
      stable path under `~/.cache/pesto/` when the run directory is read-only, on a network share or
      short on space; an explicit override wins.

- [ ] **LAUNCH-04**: pesto notices when a source file has changed (size, mtime, checksum) and
      re-reads only the affected artifact; bumping `CACHE_VERSION` forces a full re-ingest.

### Reading a Run (READ)

- [ ] **READ-01**: pesto reads a parameter ensemble in any shape pestpp-ies writes it — `.csv`,
      `.jcb` or dense `.bin`, realization-major or variable-major, hash-ordered or not — and
      normalises every one to realization-major float32 `(n_real, n_entity)`.

- [ ] **READ-02**: Pointed at a run directory, pesto reports what it found — control file,
      per-iteration parameter and observation ensembles, phi files, grid file — and names anything
      unexpected rather than ignoring it (including the documented `" standard_deviation"` header
      with a leading space).

- [ ] **READ-03**: The control file yields parameter and observation tables carrying group
      membership, bounds and `partrans`, including `PstFrom` control files that reference external
      parameter data.

- [ ] **READ-04**: Realization and parameter names come from inside the ensemble file, so a run
      whose survivors are labelled `['base','34','35','176',...]` reports those names — row 1 is
      realization `34`, not `1`.

- [ ] **READ-05**: A `NOPTMAX <= 0` run — single evaluation, prior Monte Carlo, a forecast
      directory — opens as a normal case, not an edge case.

### Grid and Parameters on Cells (GRID)

- [ ] **GRID-01**: A MODFLOW 6 grid file becomes GPU-ready mesh buffers — `positions` float32
      `(n_vert, 2)`, `cell_index` float32 `(n_vert,)`, `indices` uint32 `(n_tri * 3,)` — with
      unshared vertices, polygons fanned into triangles, plus layer count, bounds, `idomain` and CRS.

- [ ] **GRID-02**: Each parameter group resolves to a layer and cell through an ordered rule table
      (`kij`, `idx-triple`, `idx-pair`, `ij-name-layer`, `ij-single-layer`), and pesto reports which
      rule fired for each group.

- [ ] **GRID-03**: Parameters that cannot be placed are marked unresolved as `-1`, never `0`; the map
      shows the grid with nothing plotted, every other view still works, and pesto says so once and
      then stops mentioning it.

- [ ] **GRID-04**: Rendering happens in model coordinates always — the mesh is never reprojected,
      because reprojecting would distort cell geometry and area.

- [ ] **GRID-05**: All MODFLOW-specific knowledge sits behind a single model boundary, so adding a
      second model type later means writing one new file rather than rewriting the app.
      `[OPEN-02 — where `locate_par` lives decides whether this holds]`

### Ingest into the Cache (INGEST)

- [ ] **INGEST-01**: Ingesting a run writes the parameter ensembles for the first and last iteration
      into the cache as float32, under the documented layout (`manifest.json`, `config.json`,
      `control/`, `phi/`, `ens/`, `reals/`, `agg/`, `grid/`, `time/`).
      `[OPEN-03 — per-group versus per-file storage orientation]`

- [ ] **INGEST-02**: The per-iteration realization index is recorded in file order, so any later
      cross-iteration comparison can join on name rather than row position.

- [ ] **INGEST-03**: Per-parameter summaries — mean, std, min, max, q05/q25/q50/q75/q95, `n_valid`
      and at-bounds fraction — are computed for each ingested iteration in a single `np.partition`
      pass, not one `np.quantile` call per percentile.

- [ ] **INGEST-04**: Each artifact is read in its own process and records its own success or failure,
      so a malformed file that crashes a C extension kills a worker rather than the app and the rest
      of the run still ingests.

- [ ] **INGEST-05**: Ingest progress is streamed while it happens as per-artifact rows with real
      sizes and timings — no progress theatre.

### Serving the Cache (SERVE)

- [ ] **SERVE-01**: Tables with named columns are served as Arrow
      (`application/vnd.apache.arrow.stream`); pure numeric blocks are served as raw little-endian
      bytes with an `X-Pesto-Meta` JSON header carrying `shape` and `dtype`, so they go straight into
      WebGL2 buffers with no parsing.

- [ ] **SERVE-02**: Errors come back as `application/problem+json` naming the artifact involved;
      immutable resources (grid shapes, summaries) are marked permanently cacheable.

- [ ] **SERVE-03**: The user browses the filesystem and picks a run directory through a server-side
      picker — a web page is never allowed to learn the real path of a folder it was not given.

### The Map (MAP)

- [ ] **MAP-01**: The user sees the model grid drawn on the graphics card, coloured by a chosen
      parameter group's field for a chosen iteration and layer.

- [ ] **MAP-02**: Dragging the layer or realization slider redraws the field without a visible wait;
      the realization slider can show one realization's field or a statistic across realizations.

- [ ] **MAP-03**: The user can pick any of the nine colormaps, reverse any of them, and switch the
      value scale between linear and log10 defaulted from the parameter's own `partrans`, with
      robust 2-98% limits by default and min-max or manual as alternatives.

- [ ] **MAP-04**: The user clicks a cell and sees a readout of its value; the selected cell is marked
      by a ring — identity never rests on colour alone.

- [ ] **MAP-05**: Theme is Dark / Light / System, persisted, applied across chrome **and** the map
      canvas, using only tokens from the visual contract. No colour is written outside the tokens.

- [ ] **MAP-06**: Every state is a designed state, never a blank panel — choosing a directory,
      ingesting, no grid file, no projection, no cell mapping for a group, an artifact failed, no
      WebGL2. Views name the missing file and the error. A run with no CRS is a normal state (model
      coordinates, no scale bar or north arrow), not a warning.

- [ ] **MAP-07**: Inactive cells are drawn as absence — a hairline outline and nothing else — never a
      colour that could be misread as a low value.

- [ ] **MAP-08**: A lost graphics context (a laptop waking from sleep) is re-established and the
      buffers re-uploaded, rather than leaving a blank window.

- [ ] **MAP-09**: The map is on the left and always present, not a tab; controls, legend and readout
      float over it; the divider is draggable and its position is remembered per run. The status bar
      carries ingest time, cache size, mesh size and the current selection as real figures.

- [ ] **MAP-10**: The header carries the run's configuration as chips — parameter count, realization
      count and whether `base` is still alive, iteration count with `noptmax`, whether a projection
      exists, and `⚠ no measurement noise` in warning ink.
      `[OPEN-04 — may be deferred to M1 with the configuration panel]`

- [ ] **MAP-11**: Every control is keyboard reachable, sliders included; the map pans by arrow keys
      and zooms by `+`/`-`; motion is limited to state transitions and dropped entirely under
      `prefers-reduced-motion`.

- [ ] **MAP-12**: The compiled frontend ships inside the Python package — the user never needs Node
      installed.

### M0 Exit Gate (GATE) — competing variants, unresolved

Two acceptance-criteria sets cover the same gate. They are **preserved unmerged** because merging
them would silently discard either a stated design gate or a measured rationale. One must be chosen
during Phase 6 planning (OPEN-01). See WARNING 1 in `.planning/INGEST-CONFLICTS.md`.

- [ ] **REQ-m0-exit-criteria-v1** — source: `docs/superpowers/specs/2026-08-12-pesto-design.md` §7
      *M0 must be measured against fixed numeric targets on a real million-parameter run. If the
      targets are not met, the design changes before M1 begins.*

  - Reading 1e6 params x 300 reals x 2 iterations from binary: 10 minutes or less
  - Opening a run that has already been read: 1.5 seconds or less
  - Stepping through realizations on a million cells: 30 frames per second or better
  - Typical request: 100 ms or less
  - Cache size versus original files: no more than 1.5x
  - Also record how much of ingest was disk and how much was processing

- [ ] **REQ-m0-exit-criteria-v2** — source: `docs/superpowers/plans/2026-08-12-pesto-m0.md` Task 17
      Step 5. *The v1 criteria were written before anything was measured; two of them are stated to
      be the wrong question. This variant revises them against measured hardware behaviour.*

  - Ingest: **replaced**. No wall-clock ceiling. Assert absence of pathology instead — 4x the data
    must cost well under 16x the time (`test_ingest_scales_with_size_and_not_worse`, asserts
    `large < small * 10`). Rationale: ingest is disk-bound (~2 GB/s local SSD, ~85-123 MB/s USB);
    a wall-clock ceiling only measures the disk.

  - Opening a warm run: 1.5 s or less — **kept**
  - Frame rate: **replaced** by slider-to-frame latency. Rationale: `ncpl` is 9,902 on the DISV
    benchmark, not 1e6; the mesh is ~40,000 triangles reused across all layers, so frame rate is not
    the risk for this model class.

  - Query p95: 100 ms or less — **kept**, narrowed specifically to `grid/values`
  - Cache size: 1.5x source or less — **kept**
  - Correctness (**added**, absent from v1): every ensemble file shape yields identical values;
    dropped realizations still align by name; the two benchmark runs are refused a join

  - Note: v2 also asserts the 1e6-observation ceiling quoted in v1's source is wrong — the
    `forecast_20250618105403` benchmark holds 2,167,174 observations.

## Future Milestones

Recorded, not scheduled. M1's content depends on what M0 measures, so it is deliberately not
decomposed here.

### M1 — parameters, observations, histograms, and the two-way link

- Parameter view proper: summaries by group/type/layer, group histograms, before-and-after,
  drill-down under ~10,000 parameters

- Observation ensembles and observation view: spaghetti per site, 1:1, residual distributions
- Observation statistics as a second map colouring, with the time slider
- The shared selection object and full two-way linking between views
- Configuration panel: noise handling, noise band provenance, regularization, localization, whether
  `base` survived

- Section view; overlays (at-bounds, prior-data-conflict, failed realizations) as hatching; basemap
  from a local image already in model coordinates; discrete colour classes; symmetric scaling;
  texture fill

- Carried-forward gaps from M0: cache the parameter-to-cell `resolve` result to
  `grid/par_cell.parquet` instead of re-running it per request; replace `MeshLayer.pickAtWorld`'s
  linear triangle scan (fine at 9,902 cells, wrong at a million)

### M2 — phi and the derived diagnostics

- All six phi histories (`actual`, `meas`, `regul`, `composite`, by group, lambda trials) and the phi
  view — when regularization is on, composite phi decided acceptance

- Brushing realizations to recolour the map (brings in the map-ordered second copy and in-browser
  subset arithmetic)

- Spread shrinkage, at-bounds counts, prior distance, RMSE and mean error by group; reinflation
  boundaries marked and spread-shrinkage across one declined

- PDC and PCS read from pestpp's own `case.pdc.csv` / `case.N.pcs.csv` rather than recomputed, with
  pesto saying which of the two happened

- Which realizations were dropped, when, and why
- Basemaps from a tile service (adds `pyproj`, corner reprojection, provider registry, server-side
  tile caching, no default provider); export the view as a pyemu snippet

### M3 — linked runs

- Opening a workspace of several directories and declaring what each run is
- Verifying the realization join by parameter-value hash and reporting the result honestly; runs left
  unlinked when nothing matches (real negative fixture on disk shares 421/500 names and 0/40
  bit-identical parameter vectors)

- Selection propagation across runs; filtering a forecast ensemble by history-matching survival or
  phi threshold; colouring a forecast map by history-matching misfit

### M4 — packaging and rough edges

- Double-clickable app with an icon; Python package carrying the compiled frontend
- Chunked CSV reader for very large text ensembles
- Iteration-selection UI with size and time estimates
- Configurable cache location and read-only fallback confirmed in the field
- Confirming the no-CRS and no-cell-information paths behave as described
- Adding `.pesto/` to the run directory's `.gitignore` when it is a git repository (unscheduled by
  every source document — Phase 1 or M4)

- Possibly OPEN-05's session token, if deferred there

## Out of Scope

| Feature | Reason |
|---------|--------|
| Watching a running calibration | pesto is pointed at a finished run |
| FOSM, Schur complements, data worth | Needs a Jacobian, so pestpp-glm — a different kind of run |
| Being a notebook library | pypestvis already fills that role |
| Model types other than MODFLOW 6 | They plug in at the model adapter boundary later |
| Stitching time series across runs | Explicitly out of scope forever-until-asked |
| Merging linked runs | Runs are linked, never merged — separate caches, joined on realization identity only |
| Observation ensembles, phi, histograms in M0 | M1/M2 scope; M0 discovers the files anyway so discovery need not be revisited |
| A generated hue beyond the eight categorical slots | The palette is never cycled; more than three touching series folds to "Other" or facets |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| LAUNCH-01 | Phase 1 | Complete |
| LAUNCH-02 | Phase 1 | Complete |
| LAUNCH-03 | Phase 1 | Pending |
| LAUNCH-04 | Phase 1 | Pending |
| READ-01 | Phase 2 | Pending |
| READ-02 | Phase 2 | Pending |
| READ-03 | Phase 2 | Pending |
| READ-04 | Phase 2 | Pending |
| READ-05 | Phase 2 | Pending |
| GRID-01 | Phase 3 | Pending |
| GRID-02 | Phase 3 | Pending |
| GRID-03 | Phase 3 | Pending |
| GRID-04 | Phase 3 | Pending |
| GRID-05 | Phase 3 | Pending |
| INGEST-01 | Phase 4 | Pending |
| INGEST-02 | Phase 4 | Pending |
| INGEST-03 | Phase 4 | Pending |
| INGEST-04 | Phase 4 | Pending |
| INGEST-05 | Phase 4 | Pending |
| SERVE-01 | Phase 5 | Pending |
| SERVE-02 | Phase 5 | Pending |
| SERVE-03 | Phase 5 | Pending |
| MAP-01 | Phase 5 | Pending |
| MAP-02 | Phase 5 | Pending |
| MAP-03 | Phase 5 | Pending |
| MAP-04 | Phase 5 | Pending |
| MAP-05 | Phase 5 | Pending |
| MAP-06 | Phase 5 | Pending |
| MAP-07 | Phase 5 | Pending |
| MAP-08 | Phase 5 | Pending |
| MAP-09 | Phase 5 | Pending |
| MAP-10 | Phase 5 | Pending (OPEN-04) |
| MAP-11 | Phase 5 | Pending |
| MAP-12 | Phase 5 | Pending |
| REQ-m0-exit-criteria-v1 | Phase 6 | Pending (competing variant, OPEN-01) |
| REQ-m0-exit-criteria-v2 | Phase 6 | Pending (competing variant, OPEN-01) |

**Coverage:**

- v1 (M0) requirements: 36 total (34 scoped + 2 competing gate variants)
- Mapped to phases: 36
- Unmapped: 0 ✓
- Duplicated across phases: 0 ✓

---
*Requirements defined: 2026-08-12 from doc ingest*
*Last updated: 2026-08-12 after M0 roadmapping*
