# Context

Source type: DOC. No documents in this ingest classified `DOC`.

The entries below are **narrative scope and milestone content extracted from SPEC-classified
sources**, recorded here because the roadmapper needs it and it is not a binding constraint. Binding
rules live in `constraints.md`. Nothing here is inferred — every entry is attributable to a source.

---

## Topic: what pesto is

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §1, §2
- A desktop app for looking at PEST++ results. Double-click an icon, it opens in the browser, and it
  asks which PEST working directory to look at. From there: how the fit improved, how well the model
  matches observations, what happened to the parameters, and where everything sits on the grid.
- "It has to feel instant. Not 'loading spinner' fast — instant, the way a video game feels when you
  drag the camera. That is the whole point of the project, and it is why the drawing is done on the
  graphics card rather than by a normal plotting library."
- Version 1 supports **MODFLOW 6** models calibrated with **pestpp-ies**. pyemu does the reading.
- Launcher picks a free port, starts the server, opens the browser, and shuts down when the last tab
  closes. Backend Python (FastAPI, pyemu, flopy); frontend TypeScript + WebGL2, prebuilt and served
  by the backend. The user never needs Node installed.
- The directory picker runs **server-side** — a web page is not allowed to learn the real path of a
  folder the user chooses.

## Topic: vocabulary

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §1
- **site** — one observation location; observations at a site share a position and differ only in time.
- **mappable group** — a group of observations or parameters that can be placed on the grid. Groups
  that cannot be placed (a global multiplier) are still perfectly usable, they just miss the map.
- **artifact** — one piece of the run read and stored independently; if one fails the others carry on.
- **run** — one PEST working directory, with its own control file, ensembles and cache.
- **workspace** — one or more runs looked at together.

## Topic: module map

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §2; docs/superpowers/plans/2026-08-12-pesto-m0.md (File Structure)
- Python: `launch.py` (port, browser, start/stop), `api/` (thin endpoints, no logic),
  `ingest/{discover,control,phi,ensembles,grid,aggregate,cache}.py`, `model/` (the MODFLOW corner).
- M0 concrete tree adds `warm.py` (lazy imports), `cache/{layout,manifest}.py`,
  `ingest/{ensfile,runconfig,parcells,runner}.py`, `model/{adapter,mf6}.py`,
  `api/{app,blobs,fs,workspace,ingest,query}.py`.
- Browser: `data/` (fetch, decode, remember), `gl/` (mesh, line, point, histogram layers, shared
  camera and axes — no knowledge of PEST), `state/` (the current selection and nothing else),
  `views/` (map, phi, observations, parameters), `ui/` (picker, progress, group tree, sliders).
- `ingest/runconfig.py` appears in the M0 File Structure but no M0 task creates it. See WARNING 4.

## Topic: milestone scope

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §7; docs/superpowers/specs/2026-08-12-pesto-visual-design.md §12
- **M0 — one thin slice, end to end.** Read the directory, control file, grid and **parameter**
  ensembles for the first and last iteration; store mappable groups realization-first; serve them;
  draw **the map and nothing else**. Launcher, directory picker, grid drawing, layer slider,
  realization slider, colour scale, click a cell and see a readout.
  - Parameters rather than observations, deliberately: a million parameters is a million coloured
    cells, so M0 is the hardest thing the app will ever have to draw — which is what a risk probe
    should be.
  - Forward-loaded into M0 because they are cheap now and expensive to retrofit: every ensemble file
    shape, and the per-iteration realization index.
  - `NOPTMAX <= 0` runs are in scope for M0.
  - From VISUAL §12: tokens for both themes and the toggle; the nine colormaps, reverse, log/linear,
    robust limits.
- **M1 — parameters, observations, histograms, and the two-way link.** Parameter view proper
  (summaries by group/type/layer, group histograms, before-and-after, drill-down under ~10,000);
  observation ensembles and view (spaghetti per site, 1:1, residual distributions); observation
  statistics as a second map colouring with the time slider; the shared selection and full two-way
  linking; the configuration panel (noise handling, noise band provenance, regularization,
  localization, whether `base` survived).
  - From VISUAL: section view, overlays (at-bounds, conflicted, failed), basemap from a local image
    already in model coordinates, discrete colour classes, symmetric scaling, texture fill.
- **M2 — phi and the derived diagnostics.** All six phi histories and the phi view; brushing
  realizations to recolour the map (brings in the map-ordered second copy and in-browser subset
  arithmetic); spread shrinkage, at-bounds counts, prior distance, RMSE and mean error by group;
  PDC and PCS read from pestpp's own files; which realizations were dropped, when, and why.
  - From VISUAL: basemaps from a tile service (adds `pyproj`, corner reprojection, provider
    registry); export the view as a pyemu snippet.
- **M3 — linked runs.** Opening a workspace of several directories; declaring what each run is;
  verifying the realization join by parameter hash and reporting the result honestly; selection
  propagation across runs; filtering a forecast ensemble by history-matching survival or phi
  threshold; colouring a forecast map by history-matching misfit.
- **M4 — packaging and rough edges.** Double-clickable app with an icon; Python package carrying the
  compiled frontend; chunked CSV reader; iteration-selection UI with size and time estimates;
  configurable cache location and read-only fallback; confirming the no-CRS and no-cell-information
  paths behave as described.

## Topic: M0 task sequence

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md (Self-review, task headings)
- 1 project skeleton, CLI, launcher · 2 cache location and layout · 3 manifest, fingerprints,
  staleness · 4 read an ensemble file whatever shape it is in · 5 work out what is in a run
  directory · 6 control file into parameter and observation tables · 7 put parameters on the grid by
  rule · 8 grid into GPU-ready buffers behind an adapter · 9 parameter ensembles into the cache ·
  10 per-parameter summaries in one pass · 11 run the ingest, isolate failures, report progress ·
  12 the HTTP surface · 13 query endpoints · 14 frontend scaffold, data client, selection store ·
  15 draw the grid on the graphics card · 16 the map view, controls, shipping the frontend in the
  wheel · 17 measure M0 against its budgets.
- Deliberately not in M0: observation ensembles, phi views, parameter histograms, linked runs, CSV
  streaming for very large text ensembles, selective-iteration UI. Task 5 discovers observation and
  phi files anyway so M1 need not revisit discovery.
- Two gaps knowingly carried into M1: `grid/values` re-runs `resolve` on every request (Task 13
  Step 5 measures whether it matters; the fix is caching to `grid/par_cell.parquet` during ingest);
  `MeshLayer.pickAtWorld` is a linear scan over triangles — fine at 9,902 cells, wrong at a million.

## Topic: non-goals for version 1

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §1, §8
- Does **not** watch a running calibration. You point it at a finished run.
- Does **not** do heavy maths — no FOSM, Schur complements, or data worth. Cheap summaries only.
- Is **not** a notebook library — pypestvis already fills that role.
- Deliberately later: live monitoring; FOSM/Schur views (need a Jacobian, so pestpp-glm, a different
  kind of run); model types other than MODFLOW 6 (they plug in at the adapter boundary); stitching
  time series across runs.

## Topic: how this differs from pypestvis

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §1
- pypestvis is a ~2000-line Jupyter library around one `VisHandler` class: a map of observations with
  layer/time/ensemble selectors and click-to-get-a-time-series.
- It has no parameters (`self.par_dict = {}  # not yet implementing pars`), no phi convergence, no
  lambda trials, no 1:1 plots, no residual plots. It needs structured grids and hand-added `k,i,j`
  columns, and it draws one map polygon per cell so it runs out of road around 10,000-100,000 cells.
- pesto is a standalone app covering everything pypestvis covers plus the views it lacks, at 10-100x
  the cell count.

## Topic: linked runs and why they exist

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §1
- On big models, history matching and forecasting are split across directories. What they share is
  the **realizations** — forecast realization 47 was produced by history-matching realization 47's
  parameters.
- "The central question in ensemble decision support is which futures are consistent with the past,
  and you cannot answer it while the past and the future are in two different windows."
- Linking arrives in M3; the structure that makes it possible is in place from the start (`runId` is
  in the Selection from day one even though version 1 opens a single run).

## Topic: design principles (visual)

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §1
- Chrome recedes; only data is saturated.
- Colour is assigned by the job it does, not by taste — magnitude gets a sequential ramp, polarity a
  diverging ramp with a neutral middle, identity a fixed categorical order, state the reserved
  status colours.
- The display must match the data. A non-monotone colormap invents boundaries that are not in the
  parameter field; a colour blended over imagery is no longer the colour in the legend. Both are
  correctness failures, not aesthetic preferences.
- Identity never rests on colour alone.
- Absence is drawn as absence.
- Say what was inferred — state the conclusion in a line the user can correct, rather than applying
  it silently.
