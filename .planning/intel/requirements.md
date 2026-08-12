# Requirements

Source type: PRD. Populated from documents classified `type: PRD`.

**No PRD-classified sources in this ingest.** No document contains user stories or PRD-style
acceptance criteria. Feature scope was extracted to `context.md`; binding technical rules to
`constraints.md`.

One exception is recorded here because it is genuinely an **acceptance-criteria set with two
competing variants**, and the synthesis contract forbids merging competing variants. Both are
preserved verbatim under separate IDs. Downstream must pick one before routing.

---

## REQ-m0-exit-criteria-v1

- source: docs/superpowers/specs/2026-08-12-pesto-design.md §7 (M0)
- description: M0 must be measured against fixed numeric targets on a real million-parameter run.
  If the targets are not met, the design changes before M1 begins.
- acceptance:
  - Reading 1e6 params x 300 reals x 2 iterations from binary: 10 minutes or less
  - Opening a run that has already been read: 1.5 seconds or less
  - Stepping through realizations on a million cells: 30 frames per second or better
  - Typical request: 100 ms or less
  - Cache size versus original files: no more than 1.5x
  - Also record how much of ingest was disk and how much was processing
- scope: M0 exit gate, performance budgets

## REQ-m0-exit-criteria-v2

- source: docs/superpowers/plans/2026-08-12-pesto-m0.md Task 17 Step 5
- description: The v1 criteria were written before anything was measured; two of them are stated to
  be the wrong question. This variant revises them against measured hardware behaviour.
- acceptance:
  - Ingest: **replaced**. No wall-clock ceiling. Assert absence of pathology instead — 4x the data
    must cost well under 16x the time (`test_ingest_scales_with_size_and_not_worse`, asserts
    `large < small * 10`). Rationale: ingest is disk-bound (~2 GB/s local SSD, ~85-123 MB/s USB);
    a wall-clock ceiling only measures the disk.
  - Opening a warm run: 1.5 s or less — **kept**
  - Frame rate: **replaced** by slider-to-frame latency. Rationale: `ncpl` is 9,902 on the DISV
    benchmark, not 1e6; the mesh is ~40,000 triangles reused across all layers, so frame rate is
    not the risk for this model class.
  - Query p95: 100 ms or less — **kept**, narrowed specifically to `grid/values`
  - Cache size: 1.5x source or less — **kept**
  - Correctness (**added**, absent from v1): every ensemble file shape yields identical values;
    dropped realizations still align by name; the two benchmark runs are refused a join
- scope: M0 exit gate, performance budgets
- note: v2 also asserts that the 1e6-observation ceiling quoted in v1's source is wrong — the
  `forecast_20250618105403` benchmark holds 2,167,174 observations. See INFO 3 in
  `.planning/INGEST-CONFLICTS.md`.

**Unresolved:** v1 and v2 cover the same scope with non-identical acceptance criteria. Not merged.
See WARNING 1 in `.planning/INGEST-CONFLICTS.md`.
