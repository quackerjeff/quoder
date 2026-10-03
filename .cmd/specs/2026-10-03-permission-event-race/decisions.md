# Decisions: Permission Event Race

## 2026-10-03 — Fix the observed race instead of rerunning

**Context**: The authoritative run passed 8 of 9 predicates. Permission handling failed because of the accepted subscription race. With a warm server, the race looks systematic rather than rare.

**Decision**: The user authorized fixing it by reusing the run-long global subscription. This supersedes the earlier acceptance of the race.

**Rationale**: The run-long subscription is connected long before any permission request exists, which removes the race without weakening correlation.

## 2026-10-03 — Final state (Group 5 close-out)

**Context**: All gates passed: general review at Cycle 2, security review at Cycle 1, and QA at Cycle 1 with `Authoritative Run: GO`. On the real server, QA observed 27/27 permission events with the pre-connected monitor and 0/27 with the former late-reader design, which deterministically reproduces the 2026-10-03 Permission handling FAIL.

**Decision**: Close this spec. The permission stage observes `permission.v2.asked` through the run-long event monitor. That monitor is confirmed connected via `server.connected` before any session exists, matches the exact session and created request ID, and replies `once` only after observation. Unobserved outcomes journal `permission.not-observed.timeout` or `permission.not-observed.monitor-ended`.

**Precise next action**: run `npm run verify:environment`. Then, only with explicit user authorization, run `npm run verify:live`. Milestone 0 passes only if all nine predicates PASS. A failure caused only by model nondeterminism (estimated about 0.7 joint cooperation per run) justifies a rerun; a deterministic failure needs diagnosis first, using the journal markers.

**Carried forward**:
- the review Cycle 2 suggestions: a connect-timeout-path test, guarding the rejection `.finally` chain against a throwing journal write, and a test-comment wording;
- the driver's monitor has not yet run end to end against the real server; the first authorized `verify:live` will exercise it;
- the run-deadline residual;
- deletion of an active session, still unverified;
- the prior specs' carried-forward items.
