# Decisions

Source type: ADR. Populated from documents classified `type: ADR`.

**No ADR-classified sources in this ingest.** All three documents classified `SPEC`
(`confidence: high, high, medium`). No document carries `locked: true`, no document uses
Context/Decision/Consequences structure, and no document carries an ADR sequence number.

Consequently:

- There are **no locked decisions** in this ingest set.
- Nothing here is protected from being overridden by later ADRs.
- Technical decisions embedded in the SPEC prose were extracted to
  `constraints.md` (their correct destination for a SPEC source), not here.

If any of the embedded technical decisions below should become non-overridable, they must be
promoted to ADRs and re-ingested. Candidates, listed for the roadmapper's awareness only — these
are **not** decisions of record and carry no locked status:

- Pre-process into a purpose-built cache rather than reading PEST files on demand
  (source: docs/superpowers/specs/2026-08-12-pesto-design.md §3)
- Confine pyemu/flopy to `ingest/`; no query path touches them
  (source: docs/superpowers/specs/2026-08-12-pesto-design.md §2)
- Join runs by verified parameter-value hash, never by realization name alone
  (source: docs/superpowers/specs/2026-08-12-pesto-design.md §4)
- Isolate all MODFLOW knowledge behind `SpatialAdapter`
  (source: docs/superpowers/specs/2026-08-12-pesto-design.md §2) — CONTRADICTED, see
  `.planning/INGEST-CONFLICTS.md` WARNING 2
- Store big tables realization-adjacent, sorted group/site/time
  (source: docs/superpowers/specs/2026-08-12-pesto-design.md §3)
