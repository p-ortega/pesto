# Decisions and where things stand

The plans live in `.planning/`, which is not in git. This file carries the decisions that matter
and the current state, so an agent on a new machine can pick up without them. The hard rules are in
`CLAUDE.md` and the app's working notes are in `AGENTS.md`. Read those first.

Last updated 2026-11-18, on the Linux laptop.

## What pesto is

A local desktop app for exploring finished pestpp-ies runs on MODFLOW 6 models. A Python server on
loopback serves a prebuilt TypeScript/WebGL2 frontend to the browser. pyemu and flopy do the
reading, and only inside the ingest layer, which writes a compact float32 cache.

The core value is speed. It has to feel instant, like dragging a camera in a game. That is why
drawing happens on the GPU and the data is pre-processed into a cache instead of read on demand.

## Milestones

- **M0 (v1.0), shipped 2026-10-16.** Open a run, cache the grid and the first and last parameter
  ensembles, and draw the parameter field on the map. Every v2 speed limit passed. The map
  requirements MAP-01 to MAP-11 were never formally verified and stay recorded as a known gap.
- **M1 (v1.1), in progress.** Phases 7 to 14: foundations, observation ingest, parameter view and
  config panel, observation view and map colouring, two-way linking and overlays, map extras,
  section view, and a usability pass. M1 is not done until the reviews below pass.
- **M2** phi and derived diagnostics, plus the failed-realization overlay. **M3** linked runs,
  joined by a verified parameter-value hash, never by realization name alone. **M4** packaging.

## Technical constraints

- Python 3.11 or later. Run every Python command through `uv run`.
- The frontend is TypeScript, Vite, WebGL2, apache-arrow, flatbush, d3-scale, vitest and
  Playwright. Node is only needed to build, because the built frontend ships inside the Python
  package in `src/pesto/static/`. Rebuild with `npm run build` in `frontend/` after a frontend
  change, or the running app still shows the old code.
- Ensembles are stored as float32. Phi is stored as float64, because it reaches 1e11 and gets
  divided by other phi values.
- Anything that compares iterations joins on realization name, never on row position.
  Realizations leave and come back between iterations.
- Parameter and realization order comes from the names inside the ensemble file, never from the
  control file.
- Nothing relies on numpy's global random state, because importing pyemu changes it.
- The server listens only on 127.0.0.1, on a free port, behind a per-launch session token. The link
  works once. After that, a cookie carries the session.
- The cache root is the explicit `--cache-dir` if given, then `<run_dir>/.pesto`, then
  `~/.cache/pesto/<digest>`.

## Decisions the user made for M1 (2026-10-16)

1. The cache version was bumped once, in Phase 7. An M0 cache re-ingests once and says why.
2. An observation table too big to fit is refused with a reason. No `Matrix.read_dense`.
3. Zero-weight observations show everywhere as model outputs. A residual exists wherever `obsval` is
   a real number. 1e30-style sentinels are left out and counted.
4. Sigma ratio is in M1, and is refused across a reinflation boundary.
5. The failed-realization overlay moves to M2.
6. Observation dots are drawn for the current layer, with an "all layers" toggle.
7. pestpp's own `case.pdc.csv` is read. Prior-data conflict is computed only when that file is
   missing, and is then labelled computed.
8. "Type" in group/type/layer means the PstFrom parameter type tag.
9. `pillow>=11` is a declared dependency.
10. Sites are placed from the model's own MF6 observation input, joined by id or usecol name, when
    the control file cannot place them. Never by position.
11. The bench proves a cold disk read with a read-only `mincore` page check.

## Phase 14 decisions (user, 2026-10-30)

1. Colour steps sits at the top of the Colours card and leads its folded line.
2. When the left stack grows, it may fold a card the user left open, for this page only, without
   changing the stored choice.
3. Group sets come from any text column that holds one value per group, such as oname, otype or
   usecol.
4. A group set is coloured like a group: one statistic at one time, with limits pooled over the
   set. The Obs tab's tables and Group fit still show one group at a time.
5. Obs and Params sections fold like the map cards. After a site pick, Group fit folds first.
   Params notes start folded and show their counts.
6. Select base sits on the Site plots title line. The header chip's tooltip says where it is.

## How the UI talks

- Use PEST++ terms: `.rec`, `.pst`, `ies_no_noise`. Avoid words like "source", "chip" and
  "drill-down" in on-screen text.
- Layers show both numbers, like `layer 4 (index 3)`.
- Check layouts at a 1440x900 laptop window, which leaves a 763 px page. The user also works on a
  1930x1176 monitor.
- In a review, each step says which tab, card and click to use, and quotes the wording to judge.

## Benchmark data

Real runs live outside the repo in `~/dev/data/pesto-bench/`. The read-only originals sit on an
archive volume that must never be written to. Slow tests use four runs, named by folder:
`forecast_20250618105403`, `hm_20250406221554`, `hm_20250406221554_restarted` and
`hm_20251104154614`. Tests never spell a run's case name. They get it from the control file that
has a `.rec` beside it, using the `case_file` fixture in `tests/conftest.py`.

To try the app on a run without touching the run directory, pass a scratch cache:

```
uv run pesto ~/dev/data/pesto-bench/hm_20250406221554 --no-browser --port 8792 \
  --cache-dir .docs/scratch/10-bench/hm/cache
```

## Where M1 stands

Phase 14 build plans 14-01 to 14-24 are merged. The code review of the Phase 14 gap work ran on
2026-11-18 and its real findings are fixed: the Obs lists redraw when their section opens, the time
slider hides when the group sets cannot be read, a failed group-set read is retried, and noise notes
name files as the frontend does. Two Linux-only hangs are fixed too: the ingest event stream could
lose its end marker, and ingest workers now start with spawn instead of fork.

On 2026-11-18 the agent ran the open review steps in Chrome on the Linux laptop, on hm with a
scratch cache, at 1440x763 (the laptop page) and at the divider's narrowest and widest. These are
agent checks; the user has not signed them off.

- Review 10 step 3 (Group fit) and step 5 (Obs tab widths): pass after fixes.
- Review 14 re-checks 1, 3, 7 and 9: pass after fixes.
- Review 9 step 1 (Params tab widths): pass after a fix.

Fixes made on the way: Site plots no longer squeezed under Group fit's title; Obs table columns in
rem so headers line up with rows; tabs and section controls wrap on a narrow panel; the divider stops
at 608px of map and 18rem of panel; the readout never covers the legend; the open map card scrolls
inside itself when nothing is left to fold; long site names wrap; the histogram legend fits a narrow
chart.

Gates: frontend 2471 tests, fast Python suite 2451 passed (14.5 min on Linux), `mesh.spec` 14/14
with Linux baselines. On Linux run the Playwright checks with `PESTO_PW_CHANNEL=chrome`, which uses
the installed Chrome. Chrome on the laptop is maximized and will not resize; check laptop layouts by
loading the app in a 1440x763 iframe.

The open work, in order:

1. **Review 9 step 2:** noise wording, on the forecast run (not yet copied to the laptop).
2. **Slow tests** (`uv run pytest -m slow`) once all four bench runs are on the laptop.
3. **The user's own sign-off** of the agent checks above.

Known follow-ups, all advisory: a sites or times answer that names no group is still taken as
the group asked for (the server always names it; many test stubs do not); the Go-to box keeps refused text; two tests can miss a same-size CSV
edit; pesto's own control-file read can tip the cold label; a mixed group keeps one rule in the
group table; on `hm_20251104154614` the model's OBS6 input is skipped because its grid file is not
the run's.
