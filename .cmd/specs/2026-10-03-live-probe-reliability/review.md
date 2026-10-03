# Review: Live Probe Reliability

## Cycle 1 — 2026-10-03
Reviewing: Groups 1–2

### Critical
None.

### Warning
- **[src/live-probe.ts:617-622, 810-822] A cancellation stage that fails without throwing is never settled, so its run can contaminate the isolation and deletion evidence.**
  - `#settleSession` runs only when a stage throws. `#exerciseCancellation` reports most of its failures by returning `false`, so `#stage` journals `cancellation.complete`:
    - `catch { return false; }` around the event loop;
    - `if (callID === undefined) return false;`, reached after the global stream's 120 s timeout while the model may still be running;
    - `if (pid === 0) return false;`, reached after a tokenized bash call was observed but no PID was written within 5 s.
  - In these paths the first session can still be active, and with `pid === 0` the fixture can also be alive: `terminateValidatedFixture(0, …)` is a no-op.
  - Isolation then calls `createIsolationSessionAfterDeletion`, which deletes an active session. Deleting an active session is not a verified 1.18.33 contract. If it fails, Session isolation (and possibly Session deletion) FAIL because of the cancellation stall. That is the "one stall hides later predicates" problem this spec set out to remove.
  - It also contradicts `docs/tech.md:410` ("Any run it left active is interrupted and settled"), and the journal reports a failed cancellation as `complete`.
  - Nothing here produces a false PASS; the problem is evidence fidelity and a leftover fixture.
  - **Fix:** settle the first session whenever cancellation did not pass, or unconditionally before isolation (`#settleSession` is cheap when idle). Make sure an observed fixture PID is terminated. Consider journaling a not-passed cancellation distinctly. Add a driver test.
- **[tests/integration/live-probe.test.ts:1313-1316, 1402-1455] The new settle path and the driver's positive evidence path are untested.**
  - Every driver fake returns `active` → `{}`, so the `isActive → interrupt → waitUntilIdle` branch of `#settleSession` (src/live-probe.ts:695-703) never runs. Removing the interrupt there would pass all 121 tests.
  - No driver scenario has the fake model write `hello.txt`. The changed line `projectPaths: helloContent === undefined ? [] : [...]` (src/live-probe.ts:667) is tested only in the negative direction, and no driver run reaches a nine-row PASS.
  - A regression that always reports `[]` would therefore surface only as a false FAIL in a costly authoritative run.
  - **Fix:** add (a) a scenario where a failed stage leaves the session active, asserting interrupt then idle before the next stage; (b) a scenario whose fake writes `hello.txt`, asserting non-empty confined `projectPaths` and, ideally, an all-PASS `evaluateLiveEvidence`.

### Suggestion
- **[src/live-probe.ts:686-688] Stage failures discard their cause.** The journal records only `<stage>.failed`, and the report evidence strings are static. A safe diagnostic would make the next authoritative FAIL actionable without re-diagnosis, which is the spec's "smallest viable outcome". For example, journal `AdapterDiagnostic.operation` and `timedOut` (not `message`, to keep redaction).
- **[src/live-probe.ts:712-729] The question guard can end silently.**
  - The guard stream uses `sseMaxRetryAttempts: 0` and has its own 600 s timeout. A dropped SSE connection, or a `QUODER_LIVE_TIMEOUT_MS` above 600 s (`liveRunTimeoutFromEnvironment` accepts any positive value), ends the guard with no journal entry, and later questions stall for 120 s.
  - The outcome is conservative, but journal `question.guard.ended` when the loop exits before `stop()`, and/or derive the guard timeout from the run timeout.
- **[src/live-probe.ts:612-638] The worst-case flow is no longer within the run deadline.**
  - With stage continuation, several 120 s operation bounds can add up past 600 s. For example: initial `waitUntilIdle` 120, then settle `interrupt` plus `waitUntilIdle` up to 240, then the cancellation stream 120, then isolation wait 120.
  - The deadline still caps the run and fails all nine conservatively, but that collapses per-predicate evidence.
  - Record this residual in `docs/tech.md`. Optionally, bound settle with a shorter timeout.
- **[docs/tech.md "Probe Prompts And Stage Isolation"] Document deletion with a single session.** State that Session deletion can PASS with one session created and deleted (isolation skipped). It is consistent with PRD requirement 11 ("Deleting the OpenCode session"), with deletion verified by the adapter's 404 check. The 2026-09-30 matrix wording ("both required sessions") could otherwise read as a contradiction.
- **[tests/unit/opencode-adapter.test.ts] Unit tests for the new adapter options are missing.** There is no direct test for the `globalEvents` `timeoutMs` and `signal` options (including an already-aborted signal and listener removal) or for `rejectQuestion`. They are covered only indirectly by the driver fake (`questionGuardEvents`).

### Verification Evidence
- `npm run typecheck`: exit 0.
- `npm test -- --reporter=dot`: 121/121 passed, run three times with consistent results (about 2.3 s each).
- `git diff --check`: clean.
- No unstaged change to `package.json` or the lockfile. The staged `package.json` change belongs to the prior, already-reviewed spec, and the pins remain exact `1.18.33`.
- **SDK runtime shape (pinned bundle):** `node_modules/@opencode-ai/sdk/dist/v2/gen/core/serverSentEvents.gen.js`.
  - For each SSE chunk the stream runs `data = JSON.parse(rawData)` and then `yield data`; it yields the raw string only when the JSON parse fails.
  - Consumers therefore receive the server's parsed payload, not `{ id, event, data: string }`. This confirms the claimed runtime shape for both `v2.session.events` and `v2.event.subscribe`, even though `V2SessionEventsResponses` declares `data: SessionDurableEventStream` (= `string`).
  - `sessionStreamEvent` rejects a raw non-JSON string item safely, because it is neither an object nor an object with string `data`.
- **SDK abort behavior:**
  - `abortHandler` calls `reader.cancel()`, so a pending `read()` resolves `done` and the generator exits.
  - An abort during `fetch` rejects into the `catch`. With `sseMaxRetryAttempts: 0` (set in both `events()` and `globalEvents()`), `attempt >= 0` breaks immediately, with no backoff sleep.
  - The guard therefore stops promptly on `controller.abort()`. `await guard` waits at most for an in-flight `rejectQuestion`, which is bounded at 120 s.
- **Question API:**
  - `Session2.question.reject` posts to `/api/session/{sessionID}/question/{requestID}/reject`.
  - In the V2 event union, `question.v2.asked` carries `data: { id, sessionID, questions, tool? }`, matching the guard's field reads.
  - The guard never touches `permission.*`, so it is not a permission decision. Permission handling still requires a correlated `permission.v2.asked` with `effect: "ask"` and a `once` reply.

**Per-predicate no-false-PASS analysis**, across failure of the initial, permission, cancellation, and isolation stages, alone or combined:

| Predicate | Why a failed stage cannot produce a false PASS |
| --- | --- |
| Fresh session creation | IDs are pushed only on successful creation, and `hasFreshSessionIDs` needs at least two unique IDs. A skipped or early-failed isolation leaves one ID → FAIL. |
| Project directory | Now needs a real `hello.txt` read through lstat and realpath confinement. Nothing in the probe writes `hello.txt`, so absence → `[]` → FAIL. |
| Local model invocation | `finalResponse` and `responseInputID` are assigned only as the stage's last statements. Any earlier failure leaves `""` → FAIL. `INITIAL_PROMPT_SENTINEL === "TOKEN_STORED"` is shared by the prompt and the predicate. |
| Streaming events | Set only after `settlePairedOperations` succeeds with a real structured event from an admitted prompt. A later `waitUntilIdle` failure leaving it `true` reflects genuine observed evidence. |
| Permission handling | Independent of the initial stage, and its correlation is unchanged. |
| File modification | Exact content only. |
| Cancellation | Requires the per-run token, the PID file, a `tool.failed` for the same call ID with sequence above N+0.5 and a timestamp at or after the interrupt, process exit, and no success or marker. A preceding settle interrupt cannot supply any of these: the stream subscribes after the settle, and timestamps are checked against the stage's own interrupt time. |
| Session deletion | Every created ID must pass the delete plus 404 check. PASS with one session is genuine evidence for requirement 11, while Fresh session creation and Session isolation correctly FAIL. |
| Session isolation | An empty response (skipped or failed) → `unexpected-response` FAIL. A response containing the nonce → `nonce-leaked` FAIL, so the new prompt's "reply only that nonce" semantics still detect a leak. |

- **Guard scoping and race:** filtering uses `#sessionIDs`. Each ID is pushed right after creation and before any prompt to that session, so a question cannot arrive for an unregistered own session. Questions from other sessions are ignored, which the test asserts.
- **Deadline:** if `runLiveProbe`'s deadline fires, it closes the driver (killing the server) and reports all nine FAIL.
  - Cleanup still runs: the idempotent `close` is awaited and the environment is removed.
  - The abandoned `run()` fails fast because its streams end without retry. Its `finally` stops the guard, which clears the 600 s timer through the generator's `finally`.
  - Its rejection is handled by `Promise.race`.

### Variant Hunting
- There is no other `JSON.parse(item.data)` on stream items in `src/` or `scripts/`. The only remaining parse is `sessionStreamEvent`'s guarded fallback.
- The permission and cancellation global-stream consumers already read V2 events as parsed objects (`event.data.*`, `event.durable?.seq`), which is consistent with the verified shape.
- The non-throwing-failure variant of the settle gap appears only in `#exerciseCancellation`.
  - `#exercisePermission` returning `undefined` (no event observed) leaves a pending API-created permission request but no running turn.
  - The isolation stage is last.
- The preflight's inference prompt (`src/environment-preflight.ts`) has no question guard. That is outside this spec, and its outcome is conservative: a 120 s preflight FAIL.

### Remaining Risks
- Deleting an active session in 1.18.33 is unverified. It is reachable via the settle gap above, or when a settle itself fails.
- Model nondeterminism: about 1 in 10 cancellation samples emitted a text tool call, with a 120 s stream wait. This fails conservatively.
- Accumulated per-stage timeouts can hit the 600 s deadline and collapse to an all-FAIL report.
- The guard does not retry on stream loss.
- The permission-subscription race was accepted previously.

### Tests
- [x] All tests passing (121/121; typecheck clean; `git diff --check` clean)
- [ ] Test coverage adequate for changes (the settle-with-active-session branch and the driver's positive project-path/full-PASS path are untested; see Warnings)

### Verdict: FAIL

# Review: Live Probe Reliability

## Cycle 2 — 2026-10-03
Reviewing: Groups 1–2 and Fix Group 1

### Critical
None.

### Warning
- **[src/live-probe.ts:505-523, 687-700; docs/tech.md:409] The adopted "credential-safe failure cause" is not delivered for paired-operation failures, and `docs/tech.md` misstates the journal contract.**
  - `#stage` derives the cause only when the caught error is itself an `OpenCodeAdapterError`. `settlePairedOperations` rejects with a plain `new Error(failures.join("; "))` and attaches no `cause`, so every adapter failure that passes through it is journaled as `<stage>.failed.error`.
  - That covers several of the most likely real failures:
    - initial prompt submission rejected or timed out: `session.initial.prompt.failed.error` instead of `...failed.submit-prompt[.timeout]`;
    - `createPermission` failure, timeout, or correlation mismatch: `permission.failed.error`;
    - the post-interrupt cancellation idle wait timing out: `cancellation.failed.error` instead of `...failed.wait-for-session.timeout`.
  - Fix Group 1's Accept says that stage failures journal "the adapter operation and a timeout flag". `docs/tech.md:409` says `.failed.error` applies only to "non-adapter errors". Both statements are false for these paths.
  - No test asserts any `<stage>.failed.*` journal entry. The `initialPromptFails` scenario (tests/integration/live-probe.test.ts:1430-1456) would have exposed this.
  - Impact is diagnostic only: no false PASS, and nothing credential-bearing is journaled. But this was the remedy adopted for the spec's "smallest viable outcome" (actionable per-predicate evidence).
  - **Fix:**
    - Have `settlePairedOperations` preserve the rejection reasons, for example `new Error(msg, { cause: firstAdapterError })` or an `AggregateError`.
    - Have `#stage` take the operation and `timedOut` from the first `OpenCodeAdapterError` it finds (directly or via `cause`/`errors`), never the message.
    - Add driver assertions for one direct case (initial `waitUntilIdle` timeout → `...failed.wait-for-session.timeout`) and one paired case (initial prompt 500 → `...failed.submit-prompt`).

### Suggestion
- **[src/live-probe.ts:737-742] `question.guard.ended` has no test.**
  - The logic is correct. `stop()` aborts the caller controller before awaiting the guard, so a normal stop never journals it. The adapter's own 600 s timeout, an SSE drop, or a stream error ends the loop with the caller signal un-aborted, so those do journal it.
  - However, inverting or deleting the `!controller.signal.aborted` check passes all 128 tests.
  - Add one scenario whose guard stream ends early and asserts the entry, and assert its absence in the normal full-PASS scenario.

### Verification Evidence
- `npm run typecheck`: exit 0.
- `npm test -- --reporter=dot`: 128/128 passed, three consecutive runs (about 2.5 s each).
- `git diff --check` and `git diff --cached --check`: clean.
- Dependencies:
  - pins are still exact `@opencode-ai/sdk` and `opencode-ai` `1.18.33`;
  - no unstaged `package.json` or lockfile change (the staged `verify:environment` script belongs to the prior, reviewed spec);
  - no config changes.
- Not run, per instructions: `verify:live`, `verify:environment`, any OpenCode server, any network access.

**Cycle 1 Warnings: resolved.**
- **Warning 1 (unsettled non-throwing cancellation): resolved.**
  - `#settleSession(first.id)` now runs unconditionally after the initial, permission, and cancellation stages (src/live-probe.ts:613, 618, 624).
  - `cancellation.not-passed` and `session.initial.prompt.not-completed` are journaled.
  - `docs/tech.md:411` now matches the code.
- **Warning 2 (untested settle branch and positive path): resolved.**
  - The test "settles a session left running…" (tests/integration/live-probe.test.ts:1458) drives `isActive → interrupt → waitUntilIdle` and proves the idle wait. Without `waitUntilIdle`, the first `active` read after the interrupt would be the isolation session's poll, after `create:session-2`, and line 1468 would fail.
  - The "all nine predicates PASS" test (line 1473) asserts the confined `projectPaths` `[repository, hello.txt]` and a PASS verdict for all nine rows.

**Adopted suggestions:**
- **Settle with unbounded time:** the deadline residual is recorded (`docs/tech.md:421`).
- **Single-session deletion:** documented (`docs/tech.md:419`).
- **Adapter unit tests: delivered** (tests/unit/opencode-adapter.test.ts:493-574):
  - `rejectQuestion` success, and its diagnostic on failure;
  - caller abort with a pending read, plus listener removal;
  - an already-aborted signal;
  - a custom timeout overriding the default, using fake timers that the `afterEach` restores.
- **Guard-end journaling:** delivered (untested; see the Suggestion).
- **Failure-cause journaling:** partially delivered (see the Warning).

**Settling after every stage (challenge points):**
- **Idle no-op.** `#settleSession` interrupts only when `isActive` is true, so a successful stage costs one `active` read. Even a race in which the session finishes between that read and the interrupt is harmless: the pinned bundle annotates `v2.session.interrupt` as "Idle interruption is a no-op".
- **Permission stage.** The bundle describes `session.active` as "foreground Session drains currently owned by this OpenCode process". An API-created permission request creates no drain, so a leftover pending request does not make settle interrupt anything.
- **Cancellation.** The settle runs after `#exerciseCancellation`'s `finally`, which closes the stream and terminates the validated fixture. A second interrupt therefore targets only a run still active after that, for example after an idle-wait timeout or `callID`/`pid === 0` returns.
  - The settle cannot contaminate cancellation evidence: it runs after the verdict is computed.
  - The settle before cancellation precedes that stage's subscription, and the stage checks timestamps against its own interrupt time.
- **Time.** Each settle is bounded by three operations, at most 360 s. The 600 s run deadline caps the total and fails all nine conservatively. This residual is documented.

**Journal-name safety.**
- Stage names are literals.
- Every `OpenCodeAdapter` operation string is a fixed literal: create session, submit prompt, subscribe to events, subscribe to global events, create/reply permission request, reject question request, interrupt session, list active sessions, wait for session, list session messages, delete session, verify session deletion, decode OpenCode response.
- The guard journals only the fixed strings `question.rejected` and `question.reject.failed`, never IDs or event content.
- No message text reaches the journal.

**Cycle 1's verified points, with no regressions:**
- **Stream parsing:** `sessionStreamEvent` and its tests are unchanged.
- **Guard scoping:** the `#sessionIDs` filter is unchanged, and the test asserts that an unrelated session's question is ignored.
- **Deadline and cleanup:** `runLiveProbe` and the `finally` cleanup are unchanged.
- **No false PASS for any predicate:** each evidence assignment is still the last statement of its stage, and settling adds no evidence.
- **Unchanged constraints:**
  - permission correlation and the `once` reply;
  - deletion verified by delete plus a 404 check;
  - Basic-auth server launch;
  - the `LIVE_MODEL` binding;
  - redaction of server output;
  - the preflight files, untouched by this spec's unstaged hunks to `live-probe.ts` and `opencode-adapter.ts`.

**Test determinism:**
- The new driver tests use in-memory fakes, a 200 ms timer for the PID file, and a PID that has already exited. The "settles" scenario has no PID timer at all.
- Results matched across three runs.

### Variant Hunting
- Other callers of `settlePairedOperations` that lose the cause: only the three driver call sites (594, 765, 851). Its unit tests check the message text, not the cause, so preserving the cause would not break them.
- Other `#stage` failure sources that are not adapter errors: `terminateValidatedFixture` and `correlatePermissionEvidence` throw plain `Error`s. `error` is correct for those.
- `question.guard.ended` also fires after `run.timeout`, when `driver.close` kills the server. That is a genuine end and harmless.

### Remaining Risks
- `#startQuestionGuard` subscribes before the `try`. A failed global subscription at run start rejects `run()` and reports all nine FAIL. This is conservative, but it is the one remaining fail-fast point.
- Accumulated stage and settle bounds can still hit the 600 s deadline (documented).
- Deleting an active session remains unverified. It is now reachable only if a settle itself fails, which journals `session.settle.failed`.
- Model nondeterminism: about 1 in 10 cancellation samples emits a text tool call. This fails conservatively.

### Tests
- [x] All tests passing (128/128, three runs; typecheck clean; `git diff --check` clean)
- [ ] Test coverage adequate for changes: the stage failure-cause journal and `question.guard.ended` are untested, and the missing cause assertions hid the Warning above.

### Verdict: FAIL

# Review: Live Probe Reliability

## Cycle 3 — 2026-10-03
Reviewing: Groups 1–2 and Fix Groups 1–2

### Critical
None.

### Warning
None.

### Suggestion
- **[tests/integration/live-probe.test.ts:1589-1595] Optional: add a self-referential cause case to the `findAdapterError` tests.**
  - `findAdapterError` (src/live-probe.ts:547-559) already terminates on cycles, because `depth >= 4` bounds the recursion whatever the graph looks like.
  - A one-line case such as `e.cause = e` or an `AggregateError` that contains itself would pin that property against a future refactor, for example one that replaces the depth limit with a visited set. This does not block the verdict.

### Verification Evidence
- `npm run typecheck`: exit 0.
- `npm test -- --reporter=dot`: 133/133 passed in three consecutive runs (about 3.4 s each).
- `git diff --check` and `git diff --cached --check`: clean.
- Pins are still exact (`@opencode-ai/sdk` and `opencode-ai` at `1.18.33`). There is no unstaged `package.json` or lockfile change.
- Not run, per instructions: `verify:live`, `verify:environment`, any OpenCode server, any network access, and no reads of user configuration.

**1. Cycle 2 Warning: resolved.**
- **Causes are preserved.** `settlePairedOperations` (src/live-probe.ts:505-526) builds exactly the same message (`failures.join("; ")` from `errorMessage(reason)`). It now also attaches `cause: new AggregateError(reasons)`, holding only the rejected reasons in first-then-second order.
- **Classification.** `#stage` (711-724) journals `operation.replaceAll(" ", "-")` plus `.timeout` when `diagnostic.timedOut === true`, or `error` when no adapter error is found. A paired error is found at depth 2: Error, then its `AggregateError` cause, then that aggregate's `errors[i]`.
- **Call sites.** All three paired call sites now classify correctly:
  - initial prompt (618): `submit-prompt`;
  - permission (790): `create-permission-request`, or `error` for a correlation mismatch, which is a plain `Error`;
  - cancellation (876): `wait-for-session[.timeout]`.
- **The wait timeout is attributed correctly.** `waitUntilIdle` throws an outer "wait for session" `timedOut` error whose cause is the poll's "list active sessions" error. `findAdapterError` returns the outermost adapter error first, so the journal reads `wait-for-session.timeout`.
- **Paired test** (1506-1511). `initialPromptFails` makes the prompt return HTTP 500 while the stream resolves `true`. The test asserts `session.initial.prompt.failed.submit-prompt` and the absence of `.failed.error`. Dropping the cause would turn this into `.failed.error`, so the test catches that regression.
- **Direct-timeout test** (1513-1522). The first `active` poll hangs until its abort signal and then rejects with an `AbortError`, at `operationTimeoutMs: 300`. The test asserts `session.initial.prompt.failed.wait-for-session.timeout` and an empty `finalResponse`. The failure is direct: `waitUntilIdle` throws in the stage body, outside any paired operation.
- **Docs.** `docs/tech.md:409` now describes the contract accurately: the first adapter error found directly or through `cause` or aggregated reasons, `.failed.error` otherwise, and never any text. The permission-correlation example is correct, because `correlatePermissionEvidence` throws a plain `Error` on both paths.

**2. Cycle 2 Suggestion (test `question.guard.ended`): delivered.**
- **Early-end test** (1524-1528). With `guardStreamEndsEarly`, the guard generator returns at once, the controller is not aborted, and the entry is journaled.
- **Absence test** (1500). The full-PASS scenario asserts the entry is absent, because `stop()` aborts before it awaits.
- **Mutation coverage.** Inverting the check would fail the full-PASS test. Deleting the check would fail it too, since a normal stop would then journal the entry.
- **Guard behaviour.** The guard still uses `LIVE_PROBE_RUN_TIMEOUT_MS` explicitly, so it is unaffected by the test-only operation timeout.

**3. Visible effects of `cause: AggregateError(reasons)`: none.**
- **Message text is unchanged.** The existing `settlePairedOperations` tests (380-487) assert message text through `rejects.toThrow(...)` and all pass.
- **`runLiveProbe` output is unchanged.**
  - Its catch (src/live-probe.ts:189-192) renders only `${error.name}: ${error.message}`, never `cause`.
  - Paired errors no longer reach it anyway, because every paired call runs inside `#stage`, which catches. `run()` now throws only from `#startQuestionGuard` or `createSession`, both direct adapter errors.
- **Redaction.** No new text reaches stdout or the journal.
  - The journal receives only literal stage names and fixed adapter operation literals.
  - `verify-live.ts` writes only `outcome.output`. Its rethrow path is reachable only if journaling itself fails, because `runLiveProbe` catches everything.
  - The reasons attached as `cause` are the same objects whose text was already embedded in the unchanged message. No new data is retained or exposed.

**4. `findAdapterError` safety: bounded and safe.**
- An adapter error is returned before the depth check, so one at depth 4 is still found, and the search stops there.
- Non-object causes (strings, `undefined`, `null`) return `undefined`.
- Cycles terminate because of the depth bound. The branching is at most `errors.length + 1` per level, which here is 2 reasons plus 1 cause, so the work is trivial.
- Traversal is depth-first and visits `errors` before `cause`, which matches the documented "first adapter error found".
- The tests cover the direct case, the cause case, paired aggregation, a non-adapter error, a non-object input, and the depth bound (six wrappers).

**5. `operationTimeoutMs`: safe.**
- It is an optional fourth constructor argument (571-578), and the default is `LIVE_PROBE_TIMEOUT_MS` (120 s).
- The production path (`createAuthenticatedOpenCodeDriver`, line 1150) does not pass it, and `LiveProbeDriverOptions` does not expose it, so it cannot be set from the environment or the CLI.
- It is used only at tests/integration/live-probe.test.ts:1375/1517.
- `OpenCodeAdapter` still validates that the value is positive and finite.
- `tasks.md` records it as a test hook.

**6. Cycles 1–2 verified points: intact.**
- **Stage structure.** `run()` (582-702) is structurally unchanged since Cycle 2:
  - each evidence assignment is still the last statement in its stage;
  - the first session is settled after the initial, permission and cancellation stages;
  - isolation is skipped without an admitted input;
  - the `finally` stops the guard and then deletes every created session.
- **Unchanged code.**
  - `sessionStreamEvent` and its tests;
  - the guard's `#sessionIDs` scoping (with the unrelated-session test);
  - `#settleSession`;
  - the cancellation ordering and timestamp checks;
  - the deadline and cleanup in `runLiveProbe`;
  - deletion plus the 404 check;
  - permission correlation with the `once` reply;
  - Basic-auth launch, the `LIVE_MODEL` binding and server-output redaction.
- **No false PASS.** The per-predicate analysis from Cycle 1 still holds. Fix Group 2 changed only failure classification, which adds no evidence. The full-PASS test now also asserts that no `.failed` or `not-passed` markers appear.

**7. Test determinism: confirmed.**
- **The 300 ms timeout scenario.** The hang is unconditional (it resolves only on abort), so the asserted outcome cannot race.
  - Every other fake answers immediately.
  - `fixtureCall: false` makes the cancellation stream end at once, so no PID timer is armed and nothing waits 120 s.
  - A spurious 300 ms timeout elsewhere under heavy load could change only unasserted journal entries.
- **The 200 ms PID timer.** It is used only where the driver waits up to 5 s for the PID file, which leaves a wide margin.
- **Stability.** Three consecutive runs gave identical results.

**8. Constraints: preserved.**
- No user-config change, no `verify:live`, exact pins.
- The only unstaged changes to the preflight and capabilities files belong to the prior, already-reviewed reassessment spec: the `finalAssistantResponseText` refactor and the `terminalAtSequence` rename.

### Variant Hunting
- **Other error paths that could drop a cause.**
  - `#exerciseCancellation`'s inner `catch { return false; }` and the silent stream-end paths report `cancellation.not-passed` or "structured event not observed" without an operation. This was pre-existing and reviewed in Cycle 1. It is conservative, fails the predicate as it should, and has no false-PASS impact.
  - No other `new Error(...)` wraps an adapter error in `src/live-probe.ts`.
- **Session-stream timeouts end silently.** The SDK abort leads to `reader.cancel()`, so the stream finishes as `done` and throws nothing. A stalled structured-event observation therefore resolves `false` and yields no `.timeout` journal entry. Streaming events then FAILs from its evidence. This is diagnostic only and consistent with the documented contract, which covers thrown adapter errors.
- **Duplicate reasons in the cancellation pair.** When `observeTerminalToolEvent` rejects, both reasons are the same object, because the second promise chains on the first. Classification is unaffected.

### Remaining Risks
- Accumulated 120 s stage and settle bounds can still exceed the 600 s run deadline, collapsing the report to all-FAIL (documented at `docs/tech.md:421`).
- `#startQuestionGuard` subscribes before the `try`, so a failed initial global subscription is the one remaining fail-fast point. It is conservative.
- Deleting an active session in 1.18.33 is unverified. It is reachable only if a settle itself fails, which journals `session.settle.failed`.
- Model nondeterminism: about 1 in 10 cancellation samples emits its tool call as text, which fails conservatively.

### Tests
- [x] All tests passing (133/133 in three runs; typecheck clean; `git diff --check` clean)
- [x] Test coverage adequate for changes. The following are now covered:
  - paired cause classification;
  - direct timeout classification;
  - absence of `.failed.error` when an adapter cause exists;
  - `question.guard.ended`, both present and absent;
  - `findAdapterError`'s direct, cause, aggregate, non-adapter and depth-bound cases.

### Verdict: PASS
