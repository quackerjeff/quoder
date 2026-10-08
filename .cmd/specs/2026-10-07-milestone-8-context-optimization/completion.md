# Milestone 8 Completion Record

Date: 2026-10-07

## Delivered

- Context and current-request sizes are reported in Unicode code points. The
  existing M5 context assembly, 4,096-code-point bound, and pruning behavior
  remain unchanged.
- SDK-reported input and output usage are independently summed from valid
  numeric step-event fields for a prompt run and shown on answered completion
  summaries when available. Missing or malformed values are omitted; reported
  zero remains visible. No new usage metrics are persisted.
- The fixed synthetic 20-turn comparison passes the approved threshold:
  Quoder supplied 15,645 code points versus 128,561 for the complete transcript
  baseline (12.17% of baseline, 87.83% less). Synthetic continuity checks cover
  follow-up references, saved developer decisions and constraints, and live Git
  state, while preserving the M5 previous-developer-request-only policy.

## Evidence and gates

- Group 4 prescribed automated suite: five test files, 146 tests passed;
  `npm run typecheck` and `npm run build` passed. See `review.md` and `qa.md`.
- General review: PASS, zero critical findings and zero warnings; see `review.md`.
- Security review: PASS, zero critical findings and zero warnings; see
  `security-review.md`. Its documentation suggestion about the former
  missing-value coercion was addressed in `docs/tech.md`.
- QA: PASS, release confidence READY; see `qa.md`.
- Group 8 final verification: `npm run typecheck`, `npm run build`,
  `git diff --check`, and PASS-verdict checks for all three reports passed.

## Limits

The fixture measures supplied Unicode code points, not provider tokenization,
model quality, total OpenCode system/tool context, or an observed long-running
OpenCode conversation. No live model/provider call or interactive TTY visual
run was performed. SDK usage semantics may vary or be absent by model/provider;
the displayed values are SDK-reported event counts, not a claim about billing.
No usage data is added to execution-history storage.
