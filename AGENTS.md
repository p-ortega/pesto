# AGENTS.md — session log

A running note for whoever picks this repo up next, human or agent. Plain English, newest
state first. Kept at the user's request for the session of 2026-10-15.

## Goal of this session

Get pesto to a state a client could be shown: the map screen on a real PEST++ run, end to
end, as an MVP. Phase 05.1 plans 01 to 08 were already done; plan 09 is the human-eyes
check. This session did that check first with a real browser, fixed what it found, and
left the three checkpoints for the user to approve.

## How to run the demo

```
npm --prefix frontend run build
uv run pesto                                   # picker first: last run, then browse
uv run pesto ~/dev/data/pesto-bench/forecast_20250618105403   # straight to the map
```

The server prints its URL with the token. The run directory is never written to; the cache
lives in `<run>/.pesto`. To see the estimate and ingest screens on a run that already has a
cache, point the cache elsewhere: `--cache-dir /some/empty/folder`.

## What changed this session (all on `main`)

1. The canvas follows the box it sits in, at the device pixel ratio, instead of a fixed
   800 by 480 island at the top left. The map screen is one window tall: header, frame,
   status bar. The camera keeps its centre and scale on a resize. Dragging the divider
   now resizes the map too.
2. The group picker's "N groups unmapped" disclosure and the Params panel's unmapped list
   were empty on every real run. The map block only holds parameters that placed, so a
   group none of whose parameters placed never appeared in it. The groups now come from
   the control table; only the placed set comes from the block. The forecast run now says
   "88 groups unmapped" and names them.
3. Header chips have a surface, the parameter table has a header row, the floating
   controls shrink to their content, and both unmapped lists scroll inside a capped box.
4. The visual spec derives its pixel positions from the canvas's size, and the picker
   spec waits for the benchmark listing before tabbing and accepts a warm open. That
   second one was failing before this session: it assumed the forecast run had never been
   ingested on this machine.
5. The estimate screen ("Before ingesting: a projected cost") was bare text at the page
   edge; it now sits in the same header-and-panel frame as the picker and the ingest
   screen, in both themes.

Frontend 262 unit tests, 10 Playwright checks and the backend quick suite (650) are green.

## Plan 09 checks, done by the agent in Chrome on 2026-10-15

Still for the user to approve or reject; the agent cannot stand in for human eyes.

- Theme: Dark, Light and System each change chrome and canvas together on the map and on
  the picker. Not checked: changing the OS appearance while the control reads System.
- Keyboard: Tab walks Theme, Fit to extent, Layer, Statistic, Realization, Colormap,
  Reverse, Value scale, Limits, Parameter group, canvas, Resize panel, then the parameter
  rows. Every stop shows the accent ring. Arrow keys on the divider move it in 2% steps.
- Real run (forecast, escondida): chips read 117407 par, 494 reals, base alive, 1 iter,
  no crs, which matches `.pesto/config.json`. Each `grid/values` fetch took 7 to 9 ms for
  30 KB; six slider moves coalesced into eight fetches. The legend's end values hold across
  layer and realization changes and move with the statistic. Clicking a drain cell at
  layer 12 names the parameter, its group, the value, the cell, the layer and `base`.
  Colormap, scale, group, statistic and the divider position survive a reload.
- Cold flow, with the cache pointed at an empty scratch folder: estimate screen, then the
  ingest rows (par_ens, par_agg, control, grid, config), then the map, in 37 s.
- Not checked: closing the laptop lid. Nothing in the run directory changed (file sizes
  and mtimes compared before and after, cache folder excluded).

## The one big decision left open

Every benchmark run on this machine can draw only boundary-condition groups: the forecast
and April runs draw `dewatdrn.cond` alone (a few hundred drain cells per layer), the
November run draws four groups on a handful of cells. Pilot-point groups, which carry the
fields a modeller actually wants to see, are not placeable on cells by this milestone's
rule table, so the map reads as mostly empty grid. Drawing them needs interpolation from
pilot points to cells, which is new scope. The user decides whether the MVP ships as is or
waits for that.

## Pilot-point fields (2026-10-15)

Pilot-point groups now reach the map, on branch `pilot-point-fields`. Spec:
`docs/superpowers/specs/2026-10-15-pilot-point-fields-design.md`. Plan:
`docs/superpowers/plans/2026-10-15-pilot-point-fields.md`. Ledger with every ruling made
during the build and the review's deferred minors: `docs/superpowers/plans/2026-10-15-pilot-point-fields-ledger.md`.

What was built:

- A sixth placement rule, `xyz-host-cell`, puts a parameter that carries `x` and `y` on
  the cell containing that point, with its layer from `z`, from a layer number in its
  names, or from a one-layer grid. Escondida's `iid.*` and `hyp.*` groups (about 101,500
  points) now draw as dots; the run's 72 `ghb.pp.boundary.*` groups stay unplaced with
  "no layer number in its name".
- A `pp_factors` ingest artifact links each PstFrom text factor file to its template and
  control-table names, and lists every group it cannot link, with the reason.
- Three routes: `/api/run/grid/pp` (the index), `/api/run/grid/field` (one value per cell
  for a realization or statistic) and `/api/run/grid/field/cell` (the points behind one
  cell). The map offers such groups as "<group> · interpolated", draws the field on the
  group's own layer, and the click readout names the three largest contributors.

Cache layout: the index is `grid/pp/index.json`. Computed fields are memoised at
`grid/pp/fields/<group>/<iteration>/<ensemble cache tag>/<realization or stat>.f32`; a
re-ingest changes the tag, so a stale field is never served. A field with no tag is
computed fresh and never memoised.

What each benchmark run shows:

- `hm_20251104154614` (pl253): 272 interpolable text-factor groups. `npfklayer3pp` draws on
  layer index 2; the first field takes about 312 ms and the memo serves repeats under
  100 ms. The run has two grid files and discovery picks `org.grb`; the factors fit it.
- `forecast_20250618105403` (escondida): no interpolable group. Its 88 binary factor
  files interpolate to boundary points or to 3-D hyperparameter points, not to one layer
  of cells, and each is listed with its target count.

Out of scope: escondida's run-time 3D kriging of K; binary factor files whose targets are
not the grid cells; a family view across `npfklayer1pp` to `npfklayer17pp`.

Fixed after the merge: an interpolated group opens on its own layer; a restored statistic
shows in the Statistic menu; the Params panel's notes scroll in their own box; and six of
the review's seven deferred minors (stale memo and index sources, `..` names, factor files
outside the run folder, points-file ties, z with no elevations, the binary readout).

On a grid file with an offset or rotation, a group's x/y are tried both as given (the
map's real-world frame) and as grid coordinates moved by the file's offset and rotation.
The reading that lands on the grid wins, with a note when the points were moved; when both
land, the group is refused as `frame_unclear`. No bench grid has an offset, so this is
covered by tests only.

Still open:

- On escondida layer 30, large outer cells that each hold many `iid.k` points draw as one
  wide striped band.
- The review's last minor: `idomain` from the grid file could answer "in the model"
  instead of the finite-value rule.

## Leftovers

- A stale agent worktree sits at `.claude/worktrees/agent-adc6c68234b6e73e5` on branch
  `worktree-agent-adc6c68234b6e73e5`. Its work is on `main` through other commits. Its
  one uncommitted change is a comment and an `export` on `renderUnmappedRows`. Safe to
  delete with `git worktree remove --force`.
- The picker lists `hm_20250406221554_restarted` as "not a run" because no control file
  sits beside its parameter ensemble. Not investigated.
- The unmapped rows all say "no placement rule matched" because no route exposes the
  placement note the ingest recorded. A known gap from plan 05.1-06.

## Permissions given this session

- Commit and push to this repo, this session only.
