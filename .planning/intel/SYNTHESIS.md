# Synthesis

Entry point for downstream consumers. Mode: `new`. No pre-existing `.planning/` context to merge
against.

## Documents synthesized

| Source | Type | Confidence | Locked |
|---|---|---|---|
| docs/superpowers/specs/2026-08-12-pesto-design.md | SPEC | high | no |
| docs/superpowers/specs/2026-08-12-pesto-visual-design.md | SPEC | high | no |
| docs/superpowers/plans/2026-08-12-pesto-m0.md | SPEC | medium | no |

Counts by type: SPEC 3, ADR 0, PRD 0, DOC 0, UNKNOWN 0.

## Precedence applied

All three sources are SPEC, so the default `ADR > SPEC > PRD > DOC` ordering gives a three-way tie.
Ties were broken only by relationships the documents declare about themselves:

1. `2026-08-12-pesto-design.md` — authoritative on architecture and scope.
2. `2026-08-12-pesto-visual-design.md` — authoritative on UI chrome, colour and layout from the M0
   map view onward ("Replaces the placeholder chrome in the M0 plan's Task 16", confirmed by Task 16
   itself).
3. `2026-08-12-pesto-m0.md` — authoritative on M0 task sequencing and M0 acceptance checks.

No filename, date or ordinal tiebreaker was used. Cycle detection ran over the cross-ref graph:
mutual citations exist between the companion documents, but the precedence graph is a total order
and acyclic. Details in the conflicts report.

## Decisions

- Locked: **0**. No ADR sources, no `locked: true` document.
- `.planning/intel/decisions.md` lists five embedded technical decisions as candidates for promotion
  to ADRs. None currently carry decision-of-record status.

## Requirements

- Extracted from PRDs: **0** (no PRD sources).
- Preserved competing acceptance variants: **2** — `REQ-m0-exit-criteria-v1` (design spec §7 numeric
  targets) and `REQ-m0-exit-criteria-v2` (M0 plan Task 17 measured revision). Not merged.

## Constraints

**34 entries** in `.planning/intel/constraints.md`, by type:

- `protocol` — 13: python/uv, forbidden pyemu APIs, realization-name joins, name-derived ordering,
  `docs/` gitignored, commit message format, SpatialAdapter boundary (conflicted), parameter-to-cell
  rules, basemap decision table, designed states and degradation, reading pestpp's own outputs,
  workspace joins, fixtures and benchmark data.
- `schema` — 14: numeric precision, cache layout and versioning, ensemble file shapes, storage
  orientation (conflicted), mesh buffers, aggregates, selection shape, design tokens, categorical
  palette, colormaps, scale controls, layout, plan/section views, overlays.
- `api-contract` — 3: the full design endpoint surface, the M0 subset, wire formats.
- `nfr` — 4: data scale, measured performance facts, ingest parallelism, startup and lazy imports,
  network exposure, accessibility.

The hard project rules called out for capture are all present under `protocol`/`schema`: Python
`>=3.11` via `uv run`; the forbidden pyemu APIs (`*.from_binary` on ensembles, `Matrix.to_dataframe`);
float32 ensembles / float64 phi; join on realization name never row position; `docs/` gitignored and
never `git add`ed; one-line plain commit messages with no trailers or prefixes.

## Context

**11 topics** in `.planning/intel/context.md`: what pesto is, vocabulary, module map, milestone scope
(M0-M4), M0 task sequence, non-goals, differentiation from pypestvis, linked runs, visual design
principles.

## Conflicts

- **0 blockers**
- **5 warnings** (competing variants and contradictions needing a decision)
  1. Competing M0 exit criteria — two acceptance sets for the same gate
  2. SpatialAdapter surface disagrees; the MODFLOW boundary leaks into `ingest/parcells.py`
  3. Parameter ensemble storage orientation: per-group (design) versus per-file (M0 plan)
  4. Header configuration chips required at M0, but no `runconfig` task, no `/config` endpoint and no
     data in the workspace summary
  5. Session token required by the design spec, absent from the M0 launcher
- **7 auto-resolved / informational**

Full detail: `/Users/portega/dev/code/pesto/.planning/INGEST-CONFLICTS.md`

## Files

- `/Users/portega/dev/code/pesto/.planning/intel/decisions.md`
- `/Users/portega/dev/code/pesto/.planning/intel/requirements.md`
- `/Users/portega/dev/code/pesto/.planning/intel/constraints.md`
- `/Users/portega/dev/code/pesto/.planning/intel/context.md`
- `/Users/portega/dev/code/pesto/.planning/INGEST-CONFLICTS.md`

## Status

AWAITING USER — five warnings need resolution before routing. Three of them (storage orientation,
adapter surface, M0 exit criteria) change what M0 builds and should be settled before the roadmapper
encodes M0 acceptance criteria.
