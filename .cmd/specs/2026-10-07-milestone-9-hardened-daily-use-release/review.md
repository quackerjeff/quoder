# Review: Milestone 9 — Hardened Daily-Use Release

## Cycle 1 — 2026-10-07
Reviewing: Groups 4–6

### Critical
- None.

### Warning
- [src/harness/session-runner.ts:263] Ledger failures during `prepare()` or `markCreated()` are caught by the same handler as OpenCode request failures and reported with category `OpenCode` ([line 297]). A ledger write failure is a Quoder-owned local-state failure. This gives the user the wrong recovery guidance and violates the approved failure categories. Track ledger-operation failures separately, report them as `Local state`, and add coverage for failed `prepare()` and `markCreated()`.

### Suggestion
- None.

### Tests
- [x] `npm test` — 33 files passed, 628 tests passed.
- [x] `npm run typecheck` passed.
- [x] `npm run build` passed.
- [ ] Coverage is not adequate for the local-state failure category on ledger write/update failures; add the cases described above.

### Verdict: FAIL

---

## Review: Milestone 9 — Hardened Daily-Use Release

### Cycle 3 — 2026-10-07
Reviewing: Groups 4–6 and the Group 7b fix, against the approved fail-closed ledger decision

### Critical
- None.

### Warning
- None.

### Suggestion
- None.

### Review findings

- Cleanup eligibility is restricted to ledger records in the `created` state. The only transition to that state follows a successful session-create response whose ID matches the requested ID. Reconciliation then checks the exact ID and project location and requires explicit confirmation.
- Intent and ambiguous entries remain report-only. If persisting `markAmbiguous()` fails, `runAttempt()` reports a sanitized `Local state` failure; the integration regression simulates a subsequent server restart and verifies the intent is not offered or deleted.
- The Group 7a fix classifies failed `prepare()` and `markCreated()` operations as sanitized `Local state` failures, with focused regression coverage.
- Groups 4–6 otherwise match the recorded recovery, state-preservation, logging, configuration-validation, and failure-reporting decisions. I found no additional critical findings or warnings.

### Tests
- No tests were executed during this read-only review.
- Inspected the Group 7b integration regression: `does not offer deletion after an ambiguous create and failed quarantine write across server restart`.
- Earlier recorded test results are in Cycles 1–2; they predate the Group 7b fix and are not treated as verification of that fix.

### Verdict: PASS

---

# Review: Milestone 9 — Hardened Daily-Use Release

## Cycle 2 — 2026-10-07
Reviewing: Groups 4–6 and the Group 7a fix

### Critical
- None.

### Warning
- [src/harness/session-runner.ts:282,306] If persisting an ambiguous session-creation outcome with `markAmbiguous()` fails, the error is swallowed and the ledger intent remains eligible for cleanup. On a later startup, reconciliation treats matching `intent` records as cleanup candidates. A conflicting or ambiguous create could therefore lead Quoder to offer deletion of a session it cannot safely establish it owns, contrary to the approved ledger protocol. Fail closed when quarantine persistence fails, and add coverage showing that this case can never become a cleanup candidate.

### Suggestion
- None.

### Tests
- [x] `npm test` — 33 files passed, 630 tests passed.
- [x] `npm run typecheck` passed.
- [x] `npm run build` passed.
- [ ] Test coverage is incomplete for failure to persist the ambiguous ledger state; add the case described above.
- [x] Group 7a regression tests cover failed `prepare()` and `markCreated()` classification as sanitized `Local state` failures.

### Verdict: FAIL
