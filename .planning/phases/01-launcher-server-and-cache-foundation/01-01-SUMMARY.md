---
phase: 01-launcher-server-and-cache-foundation
plan: 01
subsystem: infra
tags: [dependency-approval, pypi, package-legitimacy, fastapi, uvicorn, numpy, pandas, pyarrow, flopy, pyemu, httpx, pytest, hatchling]

# Dependency graph
requires:
  - phase: null
    provides: "RESEARCH.md Package Legitimacy Audit (eleven packages, all SUS false positives per researcher)"
provides:
  - "Human-approved list of eleven PyPI packages, recorded by name, for plan 01-02's pyproject.toml"
  - "Confirmation that pyemu is pinned >=1.7 from the PyPI registry rather than the git+develop branch"
affects: [01-02, pyproject.toml, dependency-installation]

actuals:
  tokens: 700
  tasks: 1
  commits: 1

tech-stack:
  added: []
  patterns: ["Blocking human checkpoint before any package install runs"]

key-files:
  created: [".planning/phases/01-launcher-server-and-cache-foundation/01-01-SUMMARY.md"]
  modified: []

key-decisions:
  - "All eleven packages approved as presented, no name changes"
  - "pyemu pinned >=1.7 from PyPI registry, not git+develop branch — human left it unchanged when asked"

patterns-established: []

requirements-completed: [LAUNCH-01]

coverage:
  - id: D1
    description: "Human confirmed all eleven PyPI package names against expected project homes before any install command runs"
    requirement: "LAUNCH-01"
    verification:
      - kind: manual_procedural
        ref: "Human typed 'approve' in response to the checkpoint:human-verify task presenting the eleven-package table"
        status: pass
    human_judgment: true
    rationale: "Package-legitimacy verification is exactly the class of decision that must be made by a human, not inferred by the executor — a wrong package name is arbitrary code execution at install time."

duration: 3min
completed: 2026-08-12
status: complete
---

# Phase 01 Plan 01: Package Legitimacy Checkpoint Summary

**Human approved all eleven PyPI packages by name, including the pyemu >=1.7 registry pin over the git+develop branch, clearing the gate before any install command runs.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-08-12T13:10:13Z
- **Completed:** 2026-08-12T13:13:00Z
- **Tasks:** 1 completed
- **Files modified:** 1 (this SUMMARY.md — no source files, no pyproject.toml, no uv.lock)

## Accomplishments
- Human reviewed RESEARCH.md's Package Legitimacy Audit and the eleven-package table this plan presented
- Human responded "approve" — no package name was corrected or rejected
- The pyemu `>=1.7` PyPI registry pin was explicitly surfaced (versus the M0 plan's `git+develop` branch pin) and the human left it as `>=1.7`, unchanged
- Approved dependency list recorded below, unambiguous for plan 01-02 to write into `pyproject.toml`

## Approved Package List

| Package | Expected home | Status |
|---------|---------------|--------|
| fastapi | github.com/fastapi/fastapi | Approved |
| uvicorn | github.com/Kludex/uvicorn | Approved |
| numpy | github.com/numpy/numpy | Approved |
| pandas | github.com/pandas-dev/pandas | Approved |
| pyarrow | Apache Arrow (arrow.apache.org) | Approved |
| flopy | github.com/modflowpy/flopy | Approved |
| pyemu | github.com/pypest/pyemu | Approved — pinned `>=1.7` from PyPI registry, NOT the `git+develop` branch |
| httpx | github.com/encode/httpx | Approved |
| pytest | github.com/pytest-dev/pytest | Approved |
| pytest-cov | github.com/pytest-dev/pytest-cov | Approved |
| hatchling | github.com/pypa/hatch | Approved |

All eleven packages are cleared for plan 01-02 to write into `pyproject.toml` and install via `uv sync`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Confirm the eleven PyPI packages before any install runs** - (this SUMMARY.md commit) (docs)

**Plan metadata:** (same commit — single-task plan)

## Files Created/Modified
- `.planning/phases/01-launcher-server-and-cache-foundation/01-01-SUMMARY.md` - written record of the human package-legitimacy approval

## Decisions Made
- All eleven packages approved exactly as presented in the plan — no substitutions.
- `pyemu` stays pinned `>=1.7` from the PyPI registry rather than switching back to the `git+develop` branch. The human was asked explicitly ("If you would rather keep tracking the branch, say so now") and did not request the branch pin, so the registry pin stands.

## Deviations from Plan

None - plan executed exactly as written. The single `checkpoint:human-verify` task was presented, the human responded "approve," and the decision is recorded here.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Plan 01-02 can now write `pyproject.toml` with all eleven approved packages and run `uv sync` / `uv add` — no install command has run yet, and no `pyproject.toml` or `uv.lock` exists ahead of this plan.
- Package list is unambiguous: plan 01-02 should use the table above verbatim, including the `pyemu>=1.7` registry pin.

---
*Phase: 01-launcher-server-and-cache-foundation*
*Completed: 2026-08-12*
