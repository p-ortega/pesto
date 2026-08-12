# Phase 1: Launcher, Server and Cache Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-12
**Phase:** 1-Launcher, Server and Cache Foundation
**Areas discussed:** Session token (OPEN-05), What pesto writes into your run directory, What staleness checking costs, The command line and startup failures

---

## Session token (OPEN-05)

The first framing of this question was rejected by the user, who asked why a token was necessary at
all. The question was reformulated to ask about deployment environment instead, since that is what
the answer actually depends on.

**First attempt (not answered):**

| Option | Description | Selected |
|--------|-------------|----------|
| Build it now | Token generated at launch, in the URL, rejected if absent | |
| Defer to M4 packaging | Loopback only; exposure recorded as a known gap | |
| Build it now, and check the Host header too | Token plus rejecting non-localhost Host headers | |

**Reformulated question — where will pesto actually run?**

| Option | Description | Selected |
|--------|-------------|----------|
| My laptop only, for now | Single account; shared-machine risk nil, only browser probing remains | |
| Sometimes on a shared or remote machine | Login nodes or forwarded ports; other accounts can reach it | |
| Don't know yet — build it anyway | Cheap now, already in the design spec, expensive after Phase 5 | ✓ |

**User's choice:** Don't know yet — build it anyway.
**Notes:** The explanation given was that the requirement originates in the user's own design spec
§2, not from Claude; that it buys protection in exactly two situations (another account on a shared
machine, and a web page probing local ports from the same browser); and that it costs roughly twenty
lines now versus retrofitting twenty endpoints after Phase 5. The Host-header addition was folded in
by Claude rather than asked separately, on the grounds that it is three lines and covers the half of
the problem that applies to a single-user laptop.

---

## What pesto writes into your run directory

**Question 1 — how hard should pesto try to detect a bad cache location?**

| Option | Description | Selected |
|--------|-------------|----------|
| Just try it and catch the failure | Probe write; fall back on any failure. Simple, catches unforeseen cases. Slow network shares succeed and stay slow | ✓ |
| Probe writability plus free space | Adds `statvfs` arithmetic against estimated cache size; skips network detection | |
| Full detection including network shares | Adds mount-type inspection; matches roadmap wording but fragile across platforms | |

**User's choice:** Just try it and catch the failure.

**Question 2 — where does the `.gitignore` write land?**

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 1, alongside cache creation | Silent write; keeps cache creation and its ignore entry together | ✓ |
| Phase 1, but only offer it | Tell the user rather than editing their repo; costs UI, they may ignore it | |
| Defer to M4 | Cheapest now; leaves a window where a multi-gigabyte cache can be staged by accident | |

**User's choice:** Phase 1, alongside cache creation.
**Notes:** This resolves the roadmap's deferred item, which had listed Phase 1 or M4 as candidates.

---

## What staleness checking costs

The first framing was rejected — the user asked for an explanation in two sentences, plain English.
The question was re-asked with the setup cut to two sentences and the options reworded without
reference to checksums, mtimes or manifests.

**Question (as answered) — how should pesto check whether files changed since it last processed them?**

| Option | Description | Selected |
|--------|-------------|----------|
| Cheap check first, slow check only if suspicious | Size and timestamp are instant; read the file fully only when those disagree | ✓ |
| Always do the slow check | Safest; adds ~2 s local and ~30 s over USB, breaking M0's 1.5 s target | |
| Only ever do the cheap check | Fastest to build; copying a run rewrites every timestamp, forcing an 11 GB reprocess | |

**User's choice:** Cheap check first, slow check only if suspicious.
**Notes:** A second question — whether the checksum covers the whole file or samples the ends — was
dropped and decided by Claude in favour of whole-file, on the grounds that the slow path is rare by
construction and a sampled hash is blind to a rewritten block mid-file.

---

## The command line and startup failures

**Question 1 — what does typing `pesto` on its own do?**

| Option | Description | Selected |
|--------|-------------|----------|
| Opens the app, you pick the directory inside it | Matches the design spec's double-click story; the picker is needed for M4 regardless | ✓ |
| Wants a path: `pesto /path/to/run` | Faster in a terminal, skips building a picker now | |

**User's choice:** Opens the app, you pick the directory inside it. Passing a path remains available
as a shortcut.

**Question 2 — if the browser doesn't open on its own, what happens?**

| Option | Description | Selected |
|--------|-------------|----------|
| Always print the URL too | Costs nothing; covers remote sessions and silent auto-open failures | ✓ |
| Print it only when auto-open fails | Cleaner output, but launching a browser usually reports success even when nothing appears | |

**User's choice:** Always print the URL too.

---

## Claude's Discretion

- Token transport after the first page load — URL parameter, header or cookie.
- Whether the Host-header check is middleware or per-route.
- The exact shape of the fallback path under `~/.cache/pesto/`; only stability per run directory is
  required.
- Whole-file versus sampled checksum — decided as whole-file.
- CLI flag names beyond the fixed behaviour.

## Deferred Ideas

- **Where pesto runs (shared machine or laptop)** — left unsettled deliberately. Worth revisiting at
  M4 packaging, when other people install it.
- **Warning when a slow network share is accepted** — a consequence of choosing try-and-catch over
  mount detection. If it bites, it belongs with ingest progress reporting in Phase 4.

## Process Notes

Two of the four areas had their first question rejected as too long or unclear. The user asked for
plain English and a two-sentence maximum before the question. Later questions in this session follow
that shape, and the preference has been recorded so it persists.
