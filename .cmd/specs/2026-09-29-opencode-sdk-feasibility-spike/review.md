# Review: OpenCode SDK Feasibility Spike

## Cycle 1 — 2026-09-29
Reviewing: Groups 2–4 implementation

### Critical
- [src/live-probe.ts:308] The second session is created before the first session is deleted; both sessions are deleted only in the shared `finally` block at lines 316–325. This violates the specified isolation protocol (“After deleting session one, session two...”) and allows the isolation capability to PASS without proving isolation after disposal. Delete and verify the first session before creating the second, retain deletion evidence, and test this ordering.
- [src/live-probe.ts:410] Cancellation evidence is synthesized rather than observed: the interrupt and terminal sequences are arithmetic values, the event stream is closed before interruption, and no post-interrupt OpenCode events are inspected. Consequently, a normal-completion event after interruption cannot be detected, despite the required cancellation predicate. Keep collecting structured evidence through interruption/idle, derive terminal ordering from observed results, and explicitly reject post-interrupt normal completion.
- [src/live-probe.ts:297] The first prompt’s admitted input is discarded, and the final response check at lines 302–303 accepts any non-empty latest assistant text. This does not correlate the response to the admitted input or verify the required exact `TOKEN_STORED` acknowledgement, so “Local model invocation” can falsely PASS. Preserve the admitted input identifier, correlate the projected assistant result, and enforce the exact acknowledgement required by the scenario.
- [tests/unit/capabilities.test.ts:1] The critical `OpenCodeAdapter` boundary has no automated tests. No test double verifies request payloads, abort timeouts, error diagnostics, permission reply semantics, stream cleanup, or the legacy-delete/Core-V2-404 assertion. This fails the Group 2 requirement for adapter calls through a test double and leaves the most version-sensitive behavior untested. Add focused adapter tests using a typed fake client, including success and failure paths.

### Warning
- [src/live-probe.ts:87] Project-directory confinement is effectively self-referential: `projectPaths[0]` becomes the trusted root, and the live driver supplies the expected repository and `hello.txt` path itself rather than deriving all observed file activity from OpenCode evidence. A driver could report an arbitrary root and still PASS. Evaluate paths against the independently created `environment.repository` and add a negative integration test for activity outside that repository.

### Suggestion
- None.

### Tests
- [x] All tests passing
- [ ] Test coverage adequate for changes

Commands run successfully:

- `npm run typecheck`
- `npm test -- --reporter=dot` — 33/33 tests passed
- `npm run verify:live:smoke`
- `git diff --check`

### Verdict: FAIL

## Cycle 2 — 2026-09-29
Reviewing: Groups 2–4 and Cycle 1 fixes

### Critical
- [src/live-probe.ts:446] The permission request is started as a bare promise and is only awaited after a permission event is found. If the event stream ends, aborts, or throws before yielding the expected event, the function returns or propagates without observing `request`; that request can later reject as an unhandled promise rejection and destabilize the probe instead of producing a controlled capability failure. Join the request and event operations so both promises are always settled, retain the request diagnostic, and add regression coverage for stream failure/no matching event plus request rejection.
- [src/live-probe.ts:520] The post-interrupt idle wait is similarly started without guaranteed settlement while the event stream is consumed. If `waitUntilIdle` rejects before the stream yields `session.idle`, it can become an unhandled rejection; if stream processing fails, the function exits without awaiting the pending wait. Ensure the stream and idle-wait branches are always joined/settled and add tests for each branch failing first.

### Warning
- None.

### Suggestion
- [tests/integration/live-probe.test.ts:132] The Cycle 1 regression tests validate exported helpers but do not exercise `OpenCodeLiveDriver.run` with a fake adapter/client. Adding a driver-level orchestration test would better protect the actual deletion-before-create, event-consumption, and prompt-correlation wiring from future regressions.

### Tests
- [x] All tests passing
- [ ] Test coverage adequate for changes

Cycle 1 verification:

- Session one is deleted and Core V2 deletion is verified before session two is created.
- Cancellation now retains the structured stream through interruption and derives terminal idle from an observed event.
- Post-interrupt fixture completion is rejected.
- The first response must equal `TOKEN_STORED` and follow the admitted user input in projected messages.
- Confinement evaluation now receives the independently created repository root.
- Typed adapter tests cover request shapes, request timeout, diagnostics, permission reply semantics, stream cleanup, and deletion verification.

Commands run successfully:

- `npm run typecheck`
- `npm test -- --reporter=dot` — 47/47 tests passed
- `npm run verify:live:smoke`
- `git diff --check`

### Verdict: FAIL

## Cycle 3 — 2026-09-29
Reviewing: Groups 2–4 and all Cycle 1–2 fixes

### Critical
- [src/live-probe.ts:394] The initial structured-event observation is still started as a detached promise before prompt submission. If `this.#adapter.prompt(...)` rejects at line 402, control exits through `finally` without ever awaiting or settling `firstExecutionEvent`. The stream can subsequently reject on server closure or its finite abort timeout as an unhandled promise rejection, recreating the same failure class fixed for permission and cancellation operations. Join prompt submission and event observation so both always settle, preserve diagnostics from both branches, and add first-failing-order regression tests.
- [src/live-probe.ts:481] Permission evidence is not correlated to the permission request created by the probe. `settlePairedOperations` returns both the observed event and the `createPermission` result, but the latter is discarded; the code neither requires matching request IDs nor verifies the returned effect. An unrelated `permission.asked` event for the same session can therefore be replied to and reported as proof that this probe’s `external_directory` request produced an ask. Compare the observed event ID with the created request ID, require the expected ask result, and add negative tests for mismatched IDs/effects.

### Warning
- None.

### Suggestion
- [tests/integration/live-probe.test.ts:143] The earlier suggestion remains applicable: tests cover exported helpers but not `OpenCodeLiveDriver.run` orchestration with a fake client. A driver-level test would better protect prompt/event settlement, permission correlation, deletion-before-create ordering, and cleanup wiring.

### Tests
- [x] All tests passing
- [ ] Test coverage adequate for changes

Cycle 2 finding verification:

- Permission request and event observation are now joined with `Promise.allSettled`; both branches settle and combined diagnostics are retained.
- Cancellation idle waiting and post-interrupt event observation are now joined with `Promise.allSettled`; both first-failing orders are covered.
- All Cycle 1 repairs remain present: verified deletion precedes session-two creation, cancellation uses post-interrupt observations and rejects completion, final response is exact and input-correlated, adapter behavior has typed fake-client coverage, and confinement is evaluated against the independently created repository root.

Commands run successfully:

- `npm run typecheck`
- `npm test -- --reporter=dot` — 51/51 tests passed
- `npm run verify:live:smoke`
- `git diff --check`

### Remaining Risks
- The authoritative OpenCode/Ollama live scenario has intentionally not been run and remains reserved for QA.
- The initial prompt/event failure path and exact permission-request correlation remain unproven until the critical findings above are corrected.

### Verdict: FAIL

## Cycle 4 — 2026-09-29

Reviewing: Groups 2–4 and Fix Groups 1–6, with emphasis on the Cycle 3 findings.

### Critical

- [src/live-probe.ts:526] The permission observer listens for the legacy `"permission.asked"` event, but the probe creates the request through the Core V2 `Permission2.create` API. The pinned SDK declares the corresponding Core V2 event as `"permission.v2.asked"` (`node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:4595`), while `"permission.asked"` is the distinct legacy event with a different payload (`node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:4846`). Consequently, a real event emitted for the request created at [src/live-probe.ts:495] will not enter the correlation branch and the live permission scenario will wait until the stream timeout instead of observing, correlating, and replying to that request. Update the observer and probe-owned classification/tests to use the verified Core V2 event and payload.

### Warning

- None.

### Suggestion

- [tests/integration/live-probe.test.ts:308] The permission tests exercise only the extracted correlation helper with synthetic `{ id }` values. Add a driver-level fake-client test that emits the pinned SDK’s `"permission.v2.asked"` event and proves `OpenCodeLiveDriver` correlates and replies to it. That test would have caught the legacy/Core V2 event mismatch above.

### Tests

- [x] All tests passing
- [ ] Test coverage adequate for changes

Commands run successfully:

- `npm run typecheck`
- `npm test -- --reporter=dot` — 56/56 tests passed
- `npm run verify:live:smoke`
- `git diff --check`

Cycle 3 finding verification:

- Initial prompt submission and structured-event observation are now joined through `Promise.allSettled`, preserving both branch diagnostics.
- The permission correlation helper correctly requires `effect === "ask"` and matching created/observed IDs.
- The production permission event path does not complete that fix because it observes the wrong event family.

### Remaining Risks

- The authoritative OpenCode/Ollama live scenario has intentionally not been run and remains reserved for QA.
- Permission handling cannot currently pass against the verified Core V2 event contract.
- Per the exceptional-cycle decision, Cycle 4 failure must stop progression; security review remains blocked and no Cycle 5 should be created.

### Verdict: FAIL

## Cycle 5 — 2026-09-30

Reviewing: Fix Group 8 — only the user-directed correction of the Cycle 4 Core V2 permission-event finding.

### Critical

- None.

### Warning

- None.

### Suggestion

- None.

### Tests

- [x] `npm run typecheck` passed.
- [x] `npm test -- --reporter=dot` passed: 4 test files, 57/57 tests.
- [x] `npm run verify:live:smoke` passed and produced the expected conservative nine-capability FAIL report for its unavailable-runtime path.
- [x] `git diff --check` passed.
- [x] Test coverage is adequate for the scoped correction.

### Scope Verification

- [x] `@opencode-ai/sdk` remains pinned to `1.18.33` in `package.json` and `package-lock.json`.
- [x] The pinned SDK declares Core V2 `PermissionV2Asked` with discriminator `permission.v2.asked` and payload fields `data.id`, `data.sessionID`, `data.action`, and `data.resources`.
- [x] The production observer narrows the typed `V2Event` union on `permission.v2.asked` and reads `event.data.sessionID` and `event.data.id`.
- [x] The observed request ID must equal the ID returned by `Permission2.create`.
- [x] Permission evidence requires the create result’s effect to be exactly `ask`.
- [x] The one-time permission reply is sent only after successful request-ID and effect correlation.
- [x] The driver-level typed-fake test emits a legacy `permission.asked` event before the correlated `permission.v2.asked` event and proves the legacy event is ignored.
- [x] The driver-level test completes normally, observes the Core V2 event, records the correlated ID, and sends exactly one reply for that ID without reaching the event timeout.
- [x] Probe-owned classification accepts `permission.v2.asked`, requires its `id` payload property, and rejects legacy `permission.asked`.
- [x] No capability predicate was weakened.
- [x] The authoritative live OpenCode/Ollama scenario was not run.
- [x] Security review and behavioral QA were not performed as part of this review.

### Remaining Risks

- The authoritative live OpenCode/Ollama scenario remains intentionally unexecuted and reserved for QA.
- This narrowly scoped review does not reassess unrelated implementation, security, or behavioral QA concerns.

### Verdict: PASS
