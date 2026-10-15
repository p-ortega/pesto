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

## Pilot-point fields — in progress (started 2026-10-15)

The user chose pilot-point interpolation as the next step. Design approved, plan approved,
executing inline on branch `pilot-point-fields` (nothing merged yet).

- Spec: `docs/superpowers/specs/2026-10-15-pilot-point-fields-design.md`
- Plan: `docs/superpowers/plans/2026-10-15-pilot-point-fields.md` (11 tasks)
- Ledger: `.superpowers/sdd/2026-10-15-pilot-point-fields/progress.md` says which tasks are done.
- To resume in a fresh session: say "continue the pilot-point fields plan"; the agent loads
  superpowers:executing-plans, reads the ledger, and takes the first task without a
  "complete" line. Permissions already given for this session: commit and push; add the
  `pypestutils` dependency.

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
