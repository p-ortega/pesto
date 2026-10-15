# AGENTS.md — session log

A running note for whoever picks this repo up next, human or agent. Plain English, newest
state first. Kept at the user's request for the session of 2026-10-15.

## Goal of this session

Get pesto to a state a client could be shown: the map screen on a real PEST++ run, end to
end, as an MVP. Phase 05.1 plans 01 to 08 were already done; plan 09 is the human-eyes
check and this session does that check first, fixing what it finds.

## State at the start

- `main` at 26115be. Backend 650 tests green (2 min 24 s), frontend 257 tests green, Vite
  build green. Nothing uncommitted except an untracked `.claude/` folder.
- Three benchmark runs under `~/dev/data/pesto-bench/` already carry a `.pesto/` cache.
- A stale agent worktree sits at `.claude/worktrees/agent-adc6c68234b6e73e5` on branch
  `worktree-agent-adc6c68234b6e73e5`. Its commits are not on `main` by hash, but the same
  work (header chips, divider) landed on `main` through other commits. Its one uncommitted
  change is a comment and an `export` on `renderUnmappedRows`. Left alone; safe to delete.

## How to run it

```
npm --prefix frontend run build
uv run pesto ~/dev/data/pesto-bench/forecast_20250618105403 --no-browser --port 8765
```

The server prints the URL with its token. The run directory is never written to; the cache
lives in `<run>/.pesto`.

## What the first look at the map found

Opened the forecast run (escondida, 117,407 parameters, 494 realizations, 38 layers,
9,902 cells per layer). Loads with no console errors and every API call 200.

1. The canvas is a fixed 800 by 480 pixels whatever the window size, so the map sits in a
   small box at the top left with blank page under it. The visual contract says the map
   fills the space between the header and the status bar.
2. Only one parameter group, `dewatdrn.cond`, reaches the group picker. The field it
   draws covers almost no cells, so the map looks empty. Still finding out why the other
   groups do not place.

## Decisions taken this session

- Commit and push to this repo: allowed by the user for this session only.
- Long test runs: the quick suite was run once at the start; the slow suite was not.
