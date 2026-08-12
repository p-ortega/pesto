# Constraints

Source type: SPEC. All three ingested documents classified `SPEC`.

Source shorthand used below (full paths given in each `source:` field):

- `DESIGN` = `docs/superpowers/specs/2026-08-12-pesto-design.md` — authoritative on architecture and scope
- `VISUAL` = `docs/superpowers/specs/2026-08-12-pesto-visual-design.md` — authoritative on UI chrome, colour and layout from the M0 map view onward (author-declared supersession over M0PLAN Task 16)
- `M0PLAN` = `docs/superpowers/plans/2026-08-12-pesto-m0.md` — authoritative on M0 task sequencing and M0 acceptance checks

Entries marked **CONFLICTED** have an open entry in `.planning/INGEST-CONFLICTS.md`.

---

## Python runtime and command execution

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md (Global Constraints)
- type: protocol
- content:
  - Python `>=3.11`.
  - Run **all** Python commands through `uv run`.
  - Stack: FastAPI, uvicorn, numpy, pandas, pyarrow, pyemu, flopy.
  - Frontend: TypeScript, Vite, WebGL2, apache-arrow, vitest, Playwright. Node is a build-time
    dependency only; the compiled frontend ships inside the Python package.

## Forbidden pyemu APIs

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md (Global Constraints); docs/superpowers/specs/2026-08-12-pesto-design.md §3
- type: protocol
- content:
  - **Never** call `pyemu.ObservationEnsemble.from_binary`, `ParameterEnsemble.from_binary`, or
    `Matrix.to_dataframe()`.
  - Use `pyemu.Matrix.from_binary(path)` and read `.x`, `.row_names`, `.col_names`.
  - Reason: the pandas path builds a table with one column per parameter, and the ensemble
    constructor runs `replace([inf, -inf], nan)` over the whole array — a full copy of ~2.4 GB.
  - `Matrix.get_dense_binary_info(path)` returns `(row_names, row_offsets, col_names, success)`
    without reading data; `Matrix.read_dense(path, only_rows=[...])` reads selected rows only.
  - `Matrix.read_binary` dispatches on the header (`itemp1 == 0 and itemp2 == icount` means dense),
    so `from_binary` transparently reads JCB, dense `.bin`, and legacy Fortran-sequential files.

## Numeric precision

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md (Global Constraints); docs/superpowers/specs/2026-08-12-pesto-design.md §3
- type: schema
- content:
  - Ensembles are stored as **float32** (~7 significant digits; halves disk cost).
  - Phi is stored as **float64** — phi can reach 1e11 and is divided by other phi values.

## Cross-iteration joins use realization name

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md (Global Constraints); docs/superpowers/specs/2026-08-12-pesto-design.md §3
- type: protocol
- content:
  - Anything comparing across iterations joins on **realization name**, never row position.
  - Realizations leave and return between iterations (`ies_bad_phi`, `ies_bad_phi_sigma`,
    `drop_violations`, failed runs, reinflation), so iteration 0 and iteration 3 hold different
    sets. `reals/` in the cache records which names each iteration holds, in file order.
  - Positional alignment does not fail loudly — it produces a plausible answer about the wrong
    realizations.
  - Empirical basis: `forecast_20250618105403` realization names are
    `['base', '34', '35', '176', '212', '234', ...]` — the original history-matching labels of the
    494 survivors out of 556, not renumbered. Row 1 is realization `34`, not `1`.

## Ordering always comes from names inside the file

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md (Global Constraints); docs/superpowers/specs/2026-08-12-pesto-design.md §3
- type: protocol
- content:
  - Parameter and realization ordering is read from the names inside the ensemble file, never from
    control-file position. Above 100,000 parameters pestpp writes hash-ordered binaries by default
    (`ies_ordered_binary` flips automatically).

## Repository hygiene: docs/ is gitignored

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md (Global Constraints, Task 17 Step 6)
- type: protocol
- content:
  - `docs/` is gitignored. **Never** `git add` anything under `docs/`.
  - This applies to generated plan outputs too — `docs/superpowers/plans/m0-results.md` is written
    but not committed.

## Commit message format

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md (Global Constraints)
- type: protocol
- content:
  - One line, plain language, minimal jargon.
  - No `Co-Authored-By` trailer. No `feat:` / `chore:` / conventional-commit prefixes.
  - Example: `add cache layout with fallback location`.

## Cache location, layout, and versioning

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §3; docs/superpowers/plans/2026-08-12-pesto-m0.md Task 2, Task 3
- type: schema
- content:
  - Default cache root `.pesto/` inside the run directory; falls back to `~/.cache/pesto/` when the
    run directory is read-only, on a network share, or short on space; an explicit override wins.
    The fallback path is stable for a given run directory.
  - Layout: `manifest.json`, `config.json`, `control/`, `phi/`, `ens/`, `reals/`, `agg/`, `grid/`,
    `time/`.
  - Per-iteration file names: `par_{n}.f32`, `par_{n}.reals.json`, `par_{n}.parquet`.
  - `CACHE_VERSION` is an integer constant; bumping it forces a full re-ingest.
  - The manifest records each source file's size, mtime and checksum; only the affected artifact is
    re-read when one changes.
  - The cache is derived data — deleting it costs only rebuild time. Each run caches itself
    independently with no knowledge of any other run.

## Ensemble file shapes that must be handled

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §3; docs/superpowers/plans/2026-08-12-pesto-m0.md Task 4
- type: schema
- content:
  - Three switches change the file, and two are the default at target scale:
    `ies_save_binary` (CSV vs JCB), `save_dense` (a different binary format, `.bin`),
    `ies_csv_by_reals(false)` (rows become variables, columns become realizations),
    `ies_ordered_binary` (hash-ordered above 100,000 parameters).
  - Discovery must recognise `.csv`, `.jcb`, `.bin` and **detect** orientation rather than assume it.
  - `read_ensemble` normalises everything to realization-major float32,
    shape `(n_real, n_entity)`, regardless of how the file was written.
  - CSV headers get whitespace stripped; anything unexpected is reported, never ignored (a
    documented pestpp issue records a user running for a year with `" standard_deviation"`).

## Parameter ensemble storage orientation — CONFLICTED

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §3; docs/superpowers/plans/2026-08-12-pesto-m0.md Task 9
- type: schema
- content:
  - DESIGN: "groups that appear on the map are stored realization-first, and groups that do not are
    stored parameter-first. It is a **per-group** choice made at ingest, and it costs nothing extra
    on disk."
  - M0PLAN Task 9: one `StoredEnsemble` per iteration carries a single
    `layout: 'realization_first' | 'parameter_first'`, chosen file-wide by
    `any(group in mappable for group in par_group)`.
  - These are different on-disk formats. See WARNING 3 in `.planning/INGEST-CONFLICTS.md`.

## Scale of the data

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §1, §3; docs/superpowers/plans/2026-08-12-pesto-m0.md (Benchmark runs)
- type: nfr
- content:
  - Parameters 100,000 to 1,000,000; realizations 100 to 500; iterations usually 3 to 6.
  - Observations: DESIGN states "up to 1,000,000". M0PLAN measured 2,167,174 in
    `forecast_20250618105403` and states the ceiling is wrong (see INFO 3).
  - 1e6 observations x 300 realizations x 4 bytes = 1.2 GB for one table, one iteration. A whole
    run can reach ~11 GB. Nothing may load a whole table into memory or send one to the browser.
  - By default read **iteration 0 and the last iteration** only; fetch intermediates on demand.
  - `NOPTMAX <= 0` runs (single evaluation, prior Monte Carlo, forecast directories) are a normal
    case, not an edge case, and are in scope for M0.

## Measured performance facts

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md (Measured, not assumed)
- type: nfr
- content:
  - Local SSD cold: `Pst` load (141,163 par / 124,156 obs) 1.12 s; `MfGrdFile(...).modelgrid` DISV
    0.05 s; `Matrix.from_binary` 1.1 GB JCB 0.57 s (~2 GB/s); 454 MB dense `.bin` 0.26 s;
    float64->float32 cast of 0.43 GiB ~0.00 s.
  - External USB cold: `Matrix.from_binary` 577 MB in 4.7 s (~123 MB/s);
    `get_dense_binary_info` 8.3 GB in 98 s (~85 MB/s).
  - Conclusion: ingest is **disk-bound**. Extra worker processes cannot beat the device.
  - Conclusion: the mesh is small (`ncpl` 9,902 / 17,726, ~40,000 triangles reused across layers),
    so the GPU is not the M0 risk for DISV models.
  - Startup: pyemu import 0.54 s, flopy 0.49 s warm; 16.8 s with no cached bytecode. Imports are
    serialized on a lock, so threads do not help throughput.

## Ingest parallelism and fault isolation

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §3; docs/superpowers/plans/2026-08-12-pesto-m0.md Task 11
- type: nfr
- content:
  - Each iteration and each kind of table is a separate job in a separate **process**, writing its
    own file and recording its own success or failure. Processes rather than threads specifically so
    a malformed file that crashes a C extension kills a worker, not the app.
  - DESIGN: worker default `min(4, cores)`, configurable.
  - M0PLAN: process pool retained for fault isolation only; `ingest_run(..., workers: int = 1)`.
    See INFO 5.
  - Progress is streamed to the browser as it happens.
  - Compute every percentile in a single `np.partition` pass, not `np.quantile` per percentile.

## Startup and lazy imports

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §2; docs/superpowers/plans/2026-08-12-pesto-m0.md Task 1
- type: nfr
- content:
  - Nothing at module load may touch pyemu or flopy. Binding the port, serving the frontend and
    browsing directories use FastAPI and the stdlib only. Window appears in ~150 ms.
  - Immediately after the port is bound, one background thread imports pyemu and flopy.
  - Importing pyemu mutates global state — it has historically set matplotlib rcParams and
    **seeded numpy's global RNG**. Nothing in pesto may rely on numpy's global generator; anything
    needing randomness must use its own `np.random.default_rng(...)` instance.

## Network exposure

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §2; docs/superpowers/plans/2026-08-12-pesto-m0.md Task 1
- type: nfr
- content:
  - One process on the user's own machine. The server listens only on `127.0.0.1`, on a free port
    chosen at launch.
  - DESIGN additionally requires that "the URL carries a session token. Nothing is reachable from
    the network — not from another machine, **not from another user on the same machine**."
    M0PLAN implements loopback binding and a random port but no session token. See WARNING 5.

## HTTP surface — full design contract

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §3
- type: api-contract
- content:
  ```
  GET  /api/fs/ls?path=
  POST /api/workspace {paths}
  GET  /api/workspace/{ws}/runs
  POST /api/workspace/{ws}/run/{id}/ingest        + live progress events
  GET  .../meta                                   parameter and observation tables
  GET  .../config                                 how the run was set up
  GET  .../reals?iter=
  GET  .../phi?kind=actual|meas|regul|composite|group|lambda
  GET  .../obs/series?group=&site=&iters=&reals=
  GET  .../obs/agg?iter=&group=
  GET  .../obs/1to1?iter=&group=&real=
  GET  .../obs/mapframe?group=&iter=&time=
  GET  .../par/hist?iter=&group=&bins=
  GET  .../par/agg | .../par/sigma_ratio
  GET  .../grid/mesh
  GET  .../grid/values?iter=&layer=&time=&stat=&group=
  GET  .../resid?iter=&group=
  ```

## HTTP surface — M0 subset

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 12, Task 13
- type: api-contract
- content:
  ```
  GET  /api/health
  GET  /api/fs/ls?path=
  GET  /api/fs/home
  POST /api/workspace {paths} -> {workspace_id, runs: [...]}
  GET  /api/workspace/{ws}/runs
  POST /api/workspace/{ws}/run/{id}/ingest              202, returns immediately
  GET  /api/workspace/{ws}/run/{id}/ingest/events       server-sent progress
  GET  .../meta?kind=par|obs|pargroups|obsgroups        arrow
  GET  .../reals?iter=                                  json: names, and which is base
  GET  .../par/agg?iter=&group=                         arrow
  GET  .../grid/mesh                                    json meta + three blob URLs
  GET  .../grid/mesh/{buffer}                           positions|cellindex|indices|idomain
  GET  .../grid/values?iter=&layer=&realization=&stat=&group=   f32 blob, one per cell
  ```
  - Intentionally out of M0: phi, obs/*, par/hist, par/sigma_ratio, resid.
  - **Not** in the M0 subset despite being listed in M0PLAN's own File Structure for `query.py`:
    `.../config`. See WARNING 4.
  - `grid/values` is the endpoint the map calls on every slider move.

## Wire formats

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §3; docs/superpowers/plans/2026-08-12-pesto-m0.md Task 12
- type: api-contract
- content:
  - Tables with named columns: Arrow, media type `application/vnd.apache.arrow.stream`.
  - Pure numeric blocks: raw little-endian bytes with an `X-Pesto-Meta` JSON header carrying
    `shape` and `dtype` — they go straight into WebGL2 buffers with no parsing.
  - Errors: `application/problem+json`, naming the artifact involved.
  - Immutable resources (grid shapes, summaries) marked permanently cacheable.

## SpatialAdapter boundary — CONFLICTED

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §2; docs/superpowers/plans/2026-08-12-pesto-m0.md Task 7, Task 8
- type: protocol
- content:
  - DESIGN: all MODFLOW-specific code lives behind one boundary; nothing else in pesto knows what
    MODFLOW is. Protocol surface:
    `grid_mesh() -> MeshBuffers`, `locate_obs(meta) -> DataFrame`, `locate_par(meta) -> DataFrame`,
    `layers() -> int`, `crs() -> str | None`. Version 1 ships one implementation, `Mf6Adapter`.
  - M0PLAN: `grid_mesh() -> MeshBuffers`, `grid_shape() -> GridShape`,
    `idomain() -> np.ndarray | None`, `crs() -> str | None`. `locate_par` is replaced by a
    model-agnostic rule engine in `ingest/parcells.py`; `locate_obs` is absent (no observations in
    M0); `layers()` is folded into `grid_shape()`.
  - See WARNING 2 in `.planning/INGEST-CONFLICTS.md`.

## Grid mesh buffer format

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 8
- type: schema
- content:
  - `MeshBuffers(positions, cell_index, indices, n_cells, nlay, bounds, crs)`; `positions` float32
    `(n_vert, 2)`, `cell_index` float32 `(n_vert,)`, `indices` uint32 `(n_tri * 3,)`.
  - Vertices are expanded to be unshared so each vertex knows its cell; polygons (4 to 7 sided in
    the benchmark) are fanned into triangles.
  - Written as `mesh.positions.f32`, `mesh.cellindex.f32`, `mesh.indices.u32`, `mesh.json`,
    `idomain.u8`.
  - `MfGrdFile(grb).modelgrid` returns `StructuredGrid`/`VertexGrid`/`UnstructuredGrid`; all three
    expose `.iverts` and `.verts`.
  - Rendering always happens **in model coordinates**; imagery is transformed into that space,
    never the reverse, because reprojecting the mesh would distort cell geometry and area.

## Parameter-to-cell resolution rules

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 7
- type: protocol
- content: Ordered rules, tried per group, with the rule that fired reported per group.

  | Rule | Condition | Layer from | Cell from |
  |---|---|---|---|
  | `kij` | `k`, `i`, `j` present | `k` | `i * ncol + j` |
  | `idx-triple` | `idx0`,`idx1`,`idx2` present, `ncol` known | `idx0` | `idx1 * ncol + idx2` |
  | `idx-pair` | `idx0`,`idx1` present, `ncol` unknown (DISV) | `idx0` | `idx1` |
  | `ij-name-layer` | `i`,`j` present, layer parsed from `pname`/`pargp` | regex | `i * ncol + j` |
  | `ij-single-layer` | `i`,`j` present and `nlay == 1` | `0` | `i * ncol + j` |
  | `unmapped` | nothing matched | `-1` | `-1` |

  - Both benchmark fixtures have `i`, `j`, `idx0`, `idx1`, `idx2`, `pname`, `pargp` but **no `k`**.
  - Unresolved is `-1`, never 0. When the mapping is missing, the map shows the grid with nothing
    plotted and every other view works; pesto says so once and then stops mentioning it.
  - DISV specifically: pilot points on DISV are not supported in `PstFrom` and several pyemu paths
    assume structured rows/columns, so a DISV model can be `PstFrom`-built and still arrive without
    usable cell information.

## Aggregate summaries

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 10
- type: schema
- content:
  - `PERCENTILES = (5, 25, 50, 75, 95)`; `summarise(values)` returns `mean`, `std`, `min`, `max`,
    `q05`, `q25`, `q50`, `q75`, `q95`, `n_valid` from a single `np.partition` pass.
  - `at_bounds_fraction(values, lower, upper, tol=1e-6)`.

## Selection state shape

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §4; docs/superpowers/plans/2026-08-12-pesto-m0.md Task 14
- type: schema
- content:
  - DESIGN: `Selection { runId, iteration, layer, timeIdx, cells: Set<CellId>, obsGroups, parGroups,
    reals: Set<string> | 'all', stat: 'mean'|'std'|'q50'|'sigma_ratio'|'rmse'|'pdc' }`.
  - Every view draws from one shared selection object; every click changes it; no view ever calls
    another view.
  - `reals` is deliberately workspace-scoped, not run-scoped — the realization axis is what links a
    history-matching run to its forecast.
  - Clearing rules: changing iteration/layer/time never clears cell, realization or group selection;
    changing observation group clears cells only if the new group has nothing in them; clicking the
    map replaces the cell selection, shift-click adds; realization selection resets only on an
    explicit clear.
  - M0PLAN narrows `Stat` to `'value' | 'mean' | 'std' | 'q50' | 'at_bounds'` — `'value'` (a single
    realization's field) is added and is not in DESIGN's enum. See INFO 4.

## Design tokens

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §2
- type: schema
- content:
  - Both modes are selected, not flipped. Theme control is **Dark / Light / System**, persisted per
    user.

  | Role | Light | Dark |
  |---|---|---|
  | Page plane | `#f9f9f7` | `#0d0d0d` |
  | Surface | `#fcfcfb` | `#1a1a19` |
  | Primary ink | `#0b0b0b` | `#ffffff` |
  | Secondary ink | `#52514e` | `#c3c2b7` |
  | Muted ink | `#898781` | `#898781` |
  | Gridline | `#e1e0d9` | `#2c2c2a` |
  | Axis / baseline | `#c3c2b7` | `#383835` |
  | Hairline border | `rgba(11,11,11,.10)` | `rgba(255,255,255,.10)` |
  | Accent | `#2a78d6` | `#3987e5` |

  - Status colours are fixed and never themed: good `#0ca30c`, warning `#fab219`, serious `#ec835a`,
    critical `#d03b3b`. Each always ships with an icon and a word.
  - System sans throughout; `font-variant-numeric: tabular-nums` on axis ticks, table columns and
    any number that updates in place.
  - Chrome recedes; only data is saturated. No colour may be written outside these tokens.

## Categorical palette and the caps it imposes

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §3
- type: schema
- content:
  - Eight slots, fixed order, assigned in sequence, **never cycled**.
    Light: `#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #4a3aa7 #e34948`.
    Dark: `#3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767`.
  - Lines, bars, stacked charts: all eight pass (worst adjacent pair dE 8.4, simulated CVD, dark).
  - **Scatter, and anything where two marks can touch: only the first three pass** (a fourth fails
    at dE 4.8 deuteranopia, 10.6 unsimulated). At most three series; more means folding to "Other"
    or faceting, never a generated hue.
  - A recorded run in this project has **372 observation groups**. Phi-by-group ranks the top seven
    by contribution and folds the remainder into "Other".
  - Series colour follows the entity, never its rank. Text always wears text tokens.

## Colormaps

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §4
- type: schema
- content: Nine ramps. The label on each is a measured property — lightness reversals counted over
  64 samples.

  | Ramp | Job | Reversals |
  |---|---|---|
  | viridis (default) | sequential | 0 |
  | magma | sequential | 0 |
  | cividis | sequential | 0 |
  | greys | sequential | 0 |
  | RdBu | diverging | 1 |
  | coolwarm | diverging | 1 |
  | BrBG | diverging | 1 |
  | turbo | rainbow | 1 |
  | **jet** | rainbow | **3 — flagged in the picker** |

  - Every ramp has a **reverse** switch rather than a reversed duplicate in the list.
  - jet stays because existing reports use it; it is flagged, it is not the default, and the picker
    offers turbo as the same vivid look with one reversal instead of three.
  - Defaults: parameter field -> viridis, log10 when the parameter is log-transformed; spread ->
    viridis matching the field; sigma ratio -> RdBu symmetric about 1, log10; residuals / PDC
    distance -> RdBu symmetric about 0, linear; at-bounds fraction -> magma, linear 0-1.
  - Selecting a diverging quantity switches the ramp to a diverging one automatically.

## Scale controls

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §5; docs/superpowers/specs/2026-08-12-pesto-design.md §4
- type: schema
- content:
  - Value scale **linear / log10 / symlog**, defaulted from each parameter's own `partrans`. This
    is the single highest-impact control on the panel — a conductivity field spanning six orders of
    magnitude puts nearly every cell in the lowest bin on a linear scale, and no colormap repairs
    that.
  - Limits: **robust 2-98% by default**, with min-max and manual alternatives. One runaway
    realization must not flatten the map. (M0PLAN calls `scaleLimits(..., 0.01)` = 1-99%; see
    INFO 6.)
  - Classes: continuous, or 7 / 9 / 11 discrete.
  - Also: reverse ramp; symmetric about the middle (diverging only, on by default there); grey out
    inactive cells rather than colouring them; hatch cells at their bounds; texture fill instead of
    colour for print and CVD.
  - Settings apply to this view, all views, or save as the default.

## Layout

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §6; docs/superpowers/specs/2026-08-12-pesto-design.md §4
- type: schema
- content:
  - Map on the left and **always present** — it is not a tab. Tabs on the right.
  - Map controls, legend and readout **float over the map** rather than occupying a sidebar.
  - The divider is draggable and its position is remembered per run.
  - The header carries the run's configuration as **chips**: parameter count, realization count and
    whether `base` is still alive, iteration count with `noptmax`, whether a projection exists, and
    `⚠ no measurement noise` in warning ink. (No M0 endpoint supplies this data; see WARNING 4.)
  - The status bar carries ingest time, cache size, mesh size and current selection. No progress
    theatre — real figures.

## Views: plan and section

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §7; docs/superpowers/specs/2026-08-12-pesto-design.md §4
- type: schema
- content:
  - Plan: one layer of the mesh, coloured by the current field.
  - Section: pick two ends on the plan; every layer along that line at once, same ramp, same legend,
    same click-to-select, with vertical exaggeration stated. Pinched-out layers drawn as absence.
    The selected layer is marked across the section. (M1.)

## Overlays

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §8
- type: schema
- content:
  - Parameters at their bounds — hatched 45 degrees.
  - Observations in prior-data conflict — hatched 135 degrees.
  - Failed or dropped realizations — the cells whose parameters they carried, stippled.
  - Hatching rather than colour, so overlays never consume the channel the field is using. Each is a
    toggle with a count in the header. (M1.)

## Basemaps

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §9; docs/superpowers/specs/2026-08-12-pesto-design.md §4
- type: protocol
- content:
  - One **Add basemap** button; the user never chooses an implementation path. pesto works out what
    to do from what it is given and states what it concluded.
  - Decision table: image + world file overlapping the model extent -> treat as model coordinates,
    confirm four numbers; extent elsewhere with a CRS -> reproject corners, ask nothing; extent
    elsewhere without a CRS -> cannot place, ask; image with no georeference -> ask for corners;
    tile service with a CRS -> fetch, cache, reproject; tile service without a CRS -> option greyed.
  - Rendering in model coordinates always. Tiles fetched and cached **by the local server**, so the
    browser never contacts a provider and the second visit works offline.
  - **No provider ships as a default.** OpenStreetMap available but must be enabled deliberately
    with its usage policy shown.
  - Basemaps render **desaturated**; the field stays **opaque**. Below 100% the legend is marked
    "blended — colours approximate". An **outlines only** mode exists.
  - Background maps are **off by default** (network dependency, field/firewalled machines, and a
    tile request tells a provider which piece of the world you are studying).
  - Three things only the user can supply: where an image goes when nothing on disk says so; the
    model's CRS when tiles are wanted and the grid declares none; and the **length unit** — the
    `mines` benchmark leaves `lenuni = 0` and the scale bar needs it regardless.

## Designed states and degradation

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §10; docs/superpowers/specs/2026-08-12-pesto-design.md §5
- type: protocol
- content:
  - Every state is a designed state, not a blank panel: choosing a directory; ingesting (per-artifact
    rows with sizes and timings, failures in critical ink); no grid file; no projection; no cell
    mapping for a group; an artifact failed; graphics context lost; no WebGL2; everything missing.
  - Each artifact records whether it was read and, if not, why. Views name the missing file and the
    error rather than showing an empty panel.
  - Missing-but-fine: grid file (no map, everything else works); CRS (model coordinates, no scale
    bar or north arrow — a **normal state, not a warning**); cell information (grid only); lambda
    trials file; later iterations; `base` (noted, with the last iteration it survived); `pdc.csv` /
    `pcs.csv` (computed here instead, and labelled as such); regularization and composite phi files.
  - Laptops lose their WebGL context on sleep — re-establish and re-upload rather than showing a
    blank window.

## Accessibility

- source: docs/superpowers/specs/2026-08-12-pesto-visual-design.md §11
- type: nfr
- content:
  - Primary and secondary ink clear 4.5:1 on their surfaces; marks clear 3:1 or carry visible labels.
  - Identity is **never colour-alone** anywhere — selected cell gets a ring, observed data a distinct
    marker, status a glyph and a word.
  - Texture fill (one hand-drawn line pattern at 45 and 135 degrees) for print, forced-colors and
    CVD; on a value scale its rotation is ordered with magnitude.
  - Every control keyboard reachable, sliders included; map pannable by arrow keys, zoomable by
    `+`/`-`.
  - Motion limited to state transitions, dropped entirely under `prefers-reduced-motion`.
  - Absence is drawn as absence: inactive cells, pinched-out layers and unmapped parameters show a
    hairline outline and nothing else — never a colour that could be misread as a low value.

## Reading what pestpp already worked out

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §3
- type: protocol
- content:
  - `case.pdc.csv` (prior-data conflict) and `case.N.pcs.csv` (per-group parameter change) are read
    rather than recomputed. If `ies_drop_conflicts` was on, `pdc.csv` records what pestpp actually
    removed; a recomputed number could disagree and ours would be the wrong one.
  - pesto computes them itself only when the file is absent, and says which of the two happened.
  - Six phi files, not four: `actual`, `meas`, `regul`, `composite`, by group, lambda trials. When
    regularization is on, **composite phi decided acceptance**, so showing only actual would
    misexplain the run.
  - Reinflation (`ies_n_iter_reinflate`) resets ensemble variance and breaks iteration arithmetic.
    pesto marks those boundaries and **declines** to report a spread-shrinkage ratio spanning one.
  - Run configuration must be surfaced before anything is drawn — in particular that since pestpp-ies
    5.2.10 a run with none of `ies_no_noise`, `obscov`, `ies_observation_ensemble` or a
    `standard_deviation` column **quietly runs with no noise**.

## Workspace joins

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §1, §4; docs/superpowers/plans/2026-08-12-pesto-m0.md (The realization join, tested on real data)
- type: protocol
- content:
  - Runs are **linked, never merged**. Separate caches, separate observation names, separate
    parameter sets, joined on realization identity only.
  - Names are not sufficient: `pyemu/en.py:1206` names drawn realizations `np.arange(num_reals)`, so
    `0..499` can mean entirely different things in two directories.
  - The join is **verified against parameter values** — hash the shared parameter vector per
    realization. Result reported, never assumed; if nothing matches, the runs are left unlinked.
  - Real negative fixture, already on disk: `hm_20250406221554/escondida.1.par.jcb` vs
    `forecast_20250618105403/pt_pe_forecast.jcb` share **421 of 500 realization names** and
    **0 of 40** sampled bit-identical parameter vectors. Must not be joined.
  - Real positive fixture: `pt_pe_forecast.jcb` vs `escondida.0.par.bin` in the same directory —
    494/494 names, 117,407 shared parameters, 40/40 bit-identical.
  - Explicitly out of scope forever-until-asked: stitching time series across runs.

## Test data and fixtures

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §6; docs/superpowers/plans/2026-08-12-pesto-m0.md (Fixtures, Benchmark runs)
- type: protocol
- content:
  - Repo fixtures, cloned into `tests/fixtures/` with a gitignored payload:
    `pypestvis/examples/lheg_ies` (dense `.bin`, `noptmax 6`, `standard_deviation` column,
    `crs None`, DIS `nlay 1 ncpl 8910`, 3179 par) and `pypestvis/examples/freyberg_ies`
    (CSV, `noptmax -1`, `x`/`y` par columns, 9766 par, 3 layers).
  - Benchmark working copies at `~/dev/data/pesto-bench/` (9 GB):
    `forecast_20250618105403` (DISV `nlay 38 ncpl 9902`, dense 494 x 117407, 2,167,174 obs) and
    `hm_20250406221554` (DISV `nlay 36 ncpl 17726`, JCB 500 x 141163, `noptmax 10` with only
    iterations 0 and 1 on disk).
  - Originals live on an external backup at `/Volumes/Gandalf/intera` — **read-only, never write to
    that volume.**
  - `escondida.par_data.csv` is essential: these are `PstFrom` control files referencing external
    parameter data and `pyemu.Pst()` fails without it.
  - A synthetic generator produces awkward cases on purpose (every file shape, dropped realizations,
    `NOPTMAX -1` and `-2`, reinflation schedule, all four noise paths, `" standard_deviation"` with
    the leading space, and an unrelated run pair that must be refused a join).
  - Drawing is tested by headless screenshot comparison in CI — "the drawing is the product; it does
    not go untested."
