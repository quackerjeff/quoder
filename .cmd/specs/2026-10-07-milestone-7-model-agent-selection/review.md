# Review: Milestone 7 — Model and Agent Selection

## Review method

Reviewed the implementation diff, the pinned SDK contract notes, and focused
adapter, selection, session, history, and REPL tests. The primary implementation
agent performed this review; no separate reviewer agent was invoked in this
run.

## Scope

- Project-scoped catalog calls, enabled/visible filtering, and narrow result
  shapes.
- Exact and unique partial matching, plus missing and ambiguous selection
  behavior.
- Snapshot timing, fresh-session binding, retry behavior, and history fields.
- CLI compatibility, command help, and user-facing documentation.

## Findings

No Critical or Warning findings. The review identified that shared adapter
errors could retain raw SDK text in catalog diagnostics; catalog methods now
replace it with fixed messages and preserve only HTTP status and timeout
metadata. A focused regression test covers that behavior.

## Verification

- `npm test -- --run tests/unit/opencode-adapter.test.ts tests/integration/harness.test.ts tests/unit/session-runner.test.ts tests/unit/execution-history.test.ts tests/unit/selection.test.ts tests/unit/cli.test.ts` — PASS (6 files, 175 tests).
- `npm run typecheck` — PASS.
- `git diff --check` — PASS before the final diagnostic hardening; will be
  repeated during QA.

## Verdict

**PASS** — no Critical or Warning findings remain. QA and final documentation
reconciliation are still required before closing the milestone.

## Independent Review Cycle 1 — 2026-10-07

**Reviewer:** `/root/milestone7_independent_review` (separate agent).

**Verdict:** PASS. No correctness, regression, or acceptance findings. The
reviewer independently checked catalog scoping/projection, filtering,
selection state, fresh and retried session binding, history recording, and
sanitized UI output. No files were edited.

## Independent Review Cycle 2 — remediation delta

The reviewer rechecked the runtime catalog validation added after the security
review. **Verdict: PASS.** Valid SDK entries preserve existing selection
behavior; malformed or oversized catalogs fail closed with fixed diagnostics.
The reviewer noted the caps (500 entries, 256-character model fields, and
128-character agent IDs) are not SDK-defined and could reject an unusually
large valid catalog. This is a documented operational limit, not a blocker.
