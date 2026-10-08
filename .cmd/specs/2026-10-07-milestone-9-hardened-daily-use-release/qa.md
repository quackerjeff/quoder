# QA Validation: Milestone 9 — Hardened Daily-Use Release

Date: 2026-10-07  
Branch: `milestone-9-hardened-daily-use-release`  
QA role: independent QA engineer  
Scope: Groups 4–8, with emphasis on the approved fail-closed ownership-ledger decision. No source files were changed during QA.

## Validation performed

### Automated checks

Ran the prescribed full validation command:

```text
npm test && npm run typecheck && npm run build
```

Results:

- `npm test`: PASS — 33 test files, 634 tests.
- `npm run typecheck`: PASS — `tsc --noEmit` exited successfully.
- `npm run build`: PASS — build TypeScript compilation and native-reader build exited successfully.
- `git diff --check`: PASS.
- No live model or provider call was made.

Inspected automated unit and integration coverage for these acceptance areas:

- **Owned-session lifecycle and recovery:** intent is persisted before create; only a matching, durable created record is cleanup-eligible; exact ID and canonical project/location are checked; old/unregistered and mismatched sessions remain untouched; successful deletion is verified before ledger removal; failed deletion remains recorded. Tests cover prompt completion, cancellation, server loss, retry/settlement, and cleanup verification failure.
- **Fail-closed transitions:** intent-only records remain report-only in TTY mode; ambiguous create plus failed `markAmbiguous()` remains report-only after a simulated server restart; failed `prepare()`, `markCreated()`, and `markAmbiguous()` are classified as sanitized `Local state` failures. No cleanup call is made for those states.
- **Cleanup confirmation and TTY/piped behavior:** piped runs list owned stale sessions and skip cleanup without blocking; TTY-stream integration tests cover explicit `y`/`yes`, default No, Ctrl-C decline, exact target scope, project mismatch, and verified/unverified delete outcomes. A created stale session is deleted only after affirmative input.
- **Corrupt state:** project memory, execution history, and ownership-ledger tests assert malformed source contents remain unchanged and return unavailable/corrupt outcomes. Integration coverage asserts manual guidance says the source was preserved and blocks prompt creation when the ledger is unavailable.
- **Startup validation:** unit tests cover valid launch input, malformed inline config, and unavailable pinned executable, with fixed sanitized diagnostics. CLI tests verify the safe category/correction text and absence of secret values.
- **Operational logging:** unit tests cover opt-in behavior, absolute destination outside the project, rejection of relative/project-contained/symlink paths, field allowlisting, forbidden content omission, and non-throwing write failure. Integration coverage confirms a logger exception does not stop prompt completion or session cleanup.
- **Failure categories:** tests cover fixed sanitized `OpenCode`, `Provider/inference`, `Configuration`, and `Local state` messages, provider classification only when explicit evidence exists, and omission of raw diagnostics/secrets.

### Manual and bounded runtime checks

- No live TTY session or real OpenCode process crash/recovery run was performed as part of this QA pass. TTY decisions were exercised through the integration harness's terminal-mode input stream; process/session lifecycle was exercised through deterministic fake-server integration cases.
- The earlier authorized bounded no-model probe is recorded in the spec. It verified the pinned SDK's custom session ID survives server restart and can be listed/deleted by exact ID. It did not verify crash recovery across every OS/process termination mode or make a model/provider request.
- Therefore the report relies on automated state-machine and fake-server evidence for this pass; a manual interactive smoke run remains a release confidence limitation, not an untested automated acceptance path.

## Findings and residual risks

### Critical

- None found in this QA pass.

### Warning

- None found in this QA pass.

### Accepted limitations / suggestions

- **Accepted create-before-confirmed-write crash window:** a server session can exist after create but before Quoder durably records `created`. Its ledger intent remains report-only and will require manual recovery. This is intentionally accepted to prevent ambiguous or unconfirmed IDs from being offered for deletion. Cleanup candidates still require exact ID/location checks and explicit confirmation; activity may be unknown and deletion could interrupt work.
- **Logger ownership suggestion from security review:** `security-review.md` records a low-confidence suggestion to explicitly verify ownership of an existing operational log file. Current code checks regular-file status and single-link count and applies mode `0600`; the review found no warning and the security verdict is PASS. Treat elevated or unusual shared-directory use as outside the validated deployment assumptions until an ownership check is added or otherwise addressed.
- **No real terminal/process smoke check:** interactive cleanup and interruption behavior are tested with harness streams, but this run did not inspect terminal restoration or OS process behavior during a real user-driven crash.

## Release confidence

The prescribed full automated checks pass. The safety-critical ledger paths—including failed ambiguous-state persistence across restart—have focused unit/integration assertions, and corrupt-state preservation, cleanup scope/confirmation, logging isolation, startup validation, and failure sanitization have test evidence. The remaining limitations are documented and do not contradict the approved M9 decisions. Confidence is **high for the tested automated flows**, with the manual TTY/process smoke limitation and the low-confidence logger-owner suggestion noted above.

## Verdict: PASS
