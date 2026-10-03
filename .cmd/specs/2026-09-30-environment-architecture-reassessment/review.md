# Review: Environment and Architecture Reassessment

## Cycle 1 — 2026-09-30
Reviewing: Group 3 implementation for the Group 4 general review gate

### Critical
- [`src/environment-preflight.ts:113`] The timeout wrapper races an operation against an abort notification but does not guarantee that the losing operation settles before cleanup runs or before the preflight returns. This makes `Cleanup: PASS` unsound for the resource-owning OpenCode stage: `runOpenCodeInference` can time out while `createDisposableEnvironment()` or `launchAuthenticatedOpenCodeServer()` is still pending (`src/environment-preflight.ts:468-475`), cleanup can observe `environment` or `server` as undefined and report PASS, and the losing operation can then finish later and leave a temporary repository or OpenCode child process orphaned. The same race lets cleanup execute concurrently with a partially completed session operation. Replace the detached `Promise.race` behavior with cancellation plus explicit settlement/ownership handoff (including cancellation during environment and server creation), and add a typed-fake regression test whose operation deliberately ignores or delays abort and allocates a resource after the deadline; the test must prove the preflight does not report cleanup PASS or return while that resource can still appear.

### Warning
- None.

### Suggestion
- [`src/environment-preflight.ts:191`] Consider separating a cheap transport/status reachability request from model-list parsing in a later refinement. The present `Endpoint reachability` row calls the model-discovery endpoint and requires its JSON schema, so a reachable endpoint with a malformed or incompatible model response is labeled as endpoint failure rather than a model-discovery failure. This remains fail-closed and does not affect the current gate verdict.

### Verification Evidence
- `npm run typecheck` — PASS (exit 0).
- `npm test -- --reporter=dot` — PASS: 5 files, 81 tests (exit 0).
- `git diff --check` — PASS (exit 0).
- `npm run verify:live` was not run, as required.
- The implementation emits the approved eight named rows in stable order plus exactly one `Environment Readiness` verdict, and readiness becomes PASS only when every row is PASS.
- Explicit `{ providerID: "ollama", id: "qwen3-coder:30b" }` binding is present for the first live-probe session, the post-deletion isolation session, and the preflight OpenCode session; integration assertions cover both live-probe session-creation calls.
- The published defaults are 10,000 ms discovery, 60,000 ms inference, and 180,000 ms whole-run. Output evidence is fixed/redacted rather than derived from thrown errors, configuration content, model content, or server diagnostics.
- Declared and installed SDK/CLI versions are both checked against exact `1.18.33` pins. JSONC tests cover comments, trailing commas, and comment-like/trailing-comma-like substrings inside header strings.

### Variant Hunting
- Inspected every use of `bounded()`: dependency verification, configuration loading, endpoint/model discovery, direct inference, OpenCode model discovery, OpenCode inference, and cleanup all inherit the non-settlement behavior.
- The highest-impact variants are the only stage that allocates owned resources (`runOpenCodeInference`) and cleanup itself. The current timeout tests at `tests/unit/environment-preflight.test.ts:127-166` reject promptly when their abort signal fires, so they do not exercise the uncooperative/delayed-settlement case and cannot detect late resource creation.
- Checked failure prerequisites and PASS construction: downstream work is skipped after failed prerequisites, all missing rows are filled as FAIL, cleanup failure forces readiness FAIL, and no readiness row is presented as one of the nine Milestone 0 capability predicates.
- Checked explicit model-selection variants: both model-executing feasibility sessions and the preflight session use the same exported `LIVE_MODEL` value.

### Remaining Risks
- Until the critical finding is corrected, a timed-out preflight can claim deterministic cleanup while work remains active and can create owned resources after the command has produced its verdict.
- The real OpenCode inference path remains FAIL in the recorded environment. That is an expected NO-GO result, not a defect in readiness-versus-capability separation.
- Security properties of configuration, endpoint trust, process environment, and credential handling remain for the separately required Group 5 security review after this general review passes.

### Verdict: FAIL

# Review: OpenCode/Ollama Environment and Architecture Reassessment

## Cycle 2 — 2026-09-30

Reviewing: Group 3 and Fix Group 1 implementation, with emphasis on the Group 4 gate and Cycle 1 critical finding.

### Critical

- [src/environment-preflight.ts:103] The revised `bounded` helper aborts at the stage or whole-run deadline but then waits without any upper bound for `operation(controller.signal)` to settle. An operation that ignores abort permanently prevents cleanup, output, and process completion. The regression at [tests/unit/environment-preflight.test.ts:168] proves only a manually released late operation; it does not prove the approved 10/60/180-second finite contract against an uncooperative operation. This fixes detached rejection/resource creation by replacing it with a potentially infinite wait, contrary to the spec and Fix Group 1’s constraint not to weaken the deadline contract. Add an explicit bounded ownership-handoff protocol so resource-owning work transfers all cleanup handles by the deadline, or otherwise provide a second finite settlement boundary that fails conservatively without allowing late resource acquisition.
- [src/environment-preflight.ts:526] Authenticated server cleanup calls a synchronous `closeServer` function that only sends `SIGTERM`; it does not await child exit. `launchAuthenticatedOpenCodeServer` exposes no termination promise, and `cleanup` can immediately report `Cleanup: PASS` while the OpenCode child is still alive or ignores termination. The typed-fake late-resource tests replace `cleanup` wholesale and therefore do not cover the real server lifecycle. This does not satisfy Fix Group 1’s requirement that cleanup cannot pass while a server remains owned. Make server ownership include an awaitable, finite termination operation, with escalation or conservative cleanup failure when confirmed exit is not observed, and add driver-level coverage for delayed/non-terminating child shutdown.

### Warning

None.

### Suggestion

- [tests/unit/environment-preflight.test.ts:127] Add explicit elapsed-time assertions around cooperative stage and whole-run timeout cases after the ownership protocol is corrected. The existing assertions verify classification and cleanup invocation but not the public timing bound.

### Verification Evidence

- `npm run typecheck` — PASS
- `npm test -- --reporter=dot` — PASS; 5 files, 84 tests
- `git diff --check` — PASS
- `npm run verify:live` — not run, as required
- The implementation preserves explicit `{ providerID: "ollama", id: "qwen3-coder:30b" }` binding for both model-executing live-probe sessions.
- The preflight retains the eight required rows, one readiness verdict, fixed credential-safe evidence, exact dependency checks, readiness/capability separation, HTTPS provider validation, string-safe JSONC parsing, and the declared 10/60/180 constants.
- Cycle 1’s detached losing-promise behavior is improved: delayed settlement and late rejection are now observed, and cleanup failure remains conservative. The two findings above prevent that improvement from satisfying the complete finite-lifecycle contract.

### Variant Hunting

- Inspected all uses of `bounded`; the same indefinite post-abort wait applies to dependency checks, configuration reads, HTTP discovery/inference, CLI discovery, OpenCode inference, and cleanup.
- Inspected disposable-environment creation: ownership is handed off immediately after temporary-root creation, cancellation is checked between creation steps, and partial-root removal is attempted on failure.
- Inspected authenticated-server startup and cleanup: close ownership is handed off immediately after spawn, but ownership consists only of a signal-sending callback and has no child-exit acknowledgement.
- Inspected late-resource, late-rejection, and cleanup-failure tests. They validate ordering for eventually settled fakes but do not cover a never-settling operation or actual child termination.
- No evidence was found that readiness results are being used to claim any of the nine Milestone 0 capabilities.

### Remaining Risks

- Real network, filesystem, SDK, or child-process operations may fail to honor abort promptly or at all; the command can exceed its advertised whole-run bound indefinitely.
- A process that remains alive after `SIGTERM` can outlive a reported `Cleanup: PASS`.
- Behavioral validation of the real preflight remains the later QA role’s responsibility after review and security gates pass.

### Tests

- [x] All tests passing
- [ ] Test coverage adequate for the finite resource-lifecycle contract

### Verdict: FAIL

# Review: OpenCode/Ollama Environment and Architecture Reassessment

## Cycle 3 — 2026-09-30

Reviewing: Group 3, Fix Group 1, and Fix Group 2 implementation, with emphasis on the final Group 4 review gate and Cycle 2 critical findings.

### Critical

- [src/live-probe.ts:876] Authenticated-server startup failures still reject before owned-child termination has settled. The timeout, child-error, malformed-listening-output, and premature-exit paths call `void close()` and immediately reject the startup promise. A caller that has no separately published close handle—particularly the existing `createAuthenticatedOpenCodeDriver` path—cannot await confirmed termination. If the bounded SIGTERM/SIGKILL sequence subsequently rejects, these `void close()` calls can also produce an unhandled rejection. The preflight normally receives the close callback through its ownership hook and awaits it during cleanup, but the exported launcher and live-probe path remain unsafe after this shared lifecycle change. Restructure startup failure handling so `launchAuthenticatedOpenCodeServer` awaits the idempotent close promise before rejecting, and add injected-child/launcher coverage for startup timeout or error with delayed exit and failure to terminate.

### Warning

None.

### Suggestion

- [src/environment-preflight.ts:131] The internal timeout implementation reserves up to 50 ms from each nominal stage deadline for settlement. Documenting that internal split would make the relationship between the published stage maximum and cancellation point easier to maintain, although it remains within the advertised upper bound.

### Verification Evidence

- `npm run typecheck` — PASS, exit 0.
- `npm test -- --reporter=dot` — PASS: 5 files, 86 tests, exit 0.
- `git diff --check` — PASS, exit 0.
- `npm run verify:live` was not run, as required.
- The never-settling-operation test returns finitely and forces `Cleanup: FAIL`.
- The ownership gate closes at cancellation; production environment and server acquisition callbacks reject late handoff and initiate producer-side cleanup.
- Incomplete settlement/handoff forces conservative cleanup failure.
- Normal cleanup awaits the stored server close promise.
- `terminateOwnedChild` waits for exit after SIGTERM, escalates only against its directly supplied owned child using SIGKILL, waits again, and rejects finitely when exit is not confirmed.
- Timing assertions cover cooperative stage timeout, whole-run timeout, and non-terminating child shutdown.
- Explicit `{ providerID: "ollama", id: "qwen3-coder:30b" }` binding remains present for both live-probe model sessions and the preflight session.
- The approved eight rows, single readiness verdict, exact dependency validation, readiness/capability separation, fixed redaction, HTTPS validation, and string-safe JSONC parsing remain intact.

### Variant Hunting

- Inspected every `bounded` call. Each operation is aborted before its hard boundary, observed during a finite settlement window, and classified as incomplete when it does not settle.
- Inspected both production resource-acquisition points. Disposable-environment ownership is offered immediately after temporary-root creation, and rejected ownership removes the root. Server close ownership is offered immediately after spawn, and rejected ownership awaits termination before returning.
- Inspected normal server cleanup and direct termination tests. Delayed exit and SIGTERM/SIGKILL non-termination are covered.
- Inspected all launcher failure branches. The post-launch authentication failure awaits `close()`, but startup timeout/error/exit branches do not, exposing the critical variant above.
- Inspected readiness construction. Every row must pass for readiness PASS, and cleanup failure or incomplete ownership handoff forces readiness FAIL.
- No readiness result is presented as evidence that any of the nine Milestone 0 capability predicates passed.

### Remaining Risks

- The real OpenCode inference layer remains an expected readiness failure pending later QA; this does not weaken the review semantics.
- Security properties remain for Group 5 only after the general review gate passes.
- Until the critical startup-failure path is corrected, an OpenCode server spawned by the shared launcher can remain alive briefly after its caller receives failure, and failed termination can surface outside controlled result handling.

### Tests

- [x] All tests passing
- [ ] Test coverage adequate for all changed owned-child lifecycle paths

### Verdict: FAIL

# Review: OpenCode/Ollama Environment and Architecture Reassessment

## Cycle 4 — 2026-10-02
Reviewing: Fix Group 3 (user-authorized exceptional cycle) for the Group 4 general review gate

### Critical
- None.

### Warning
- None.

### Suggestion
- [tests/integration/live-probe.test.ts:779] The new lifecycle block has no direct launcher test for the ownership-rejection branch (`src/live-probe.ts:924-926`). In particular, nothing tests ownership rejection combined with a child that never terminates, which should now produce `SERVER_TERMINATION_UNCONFIRMED_MESSAGE`. This branch already awaited `close()` when Cycle 3 reviewed it. The only change is that it now goes through `closeThenFail`, which the timeout, cancellation and error tests already cover. Fix Group 3's Accept list does not require this test, so this is non-blocking. A small fake-child case (`acceptCloseOwnership: () => false`, plus a delayed-exit or non-terminating child) would complete the branch coverage.
- [tests/integration/live-probe.test.ts:963] The non-terminating cases prove ordering indirectly: the fixed termination text can only appear after both the SIGTERM and SIGKILL waits finish. They also bound elapsed time with `< 200` ms. The ordering proof holds. The 200 ms ceiling is generous next to the roughly 15 ms of fake timers, so the risk of a flaky result is low, but it is still a wall-clock assertion on a shared runner.

### Verification Evidence
- `npm run typecheck`: PASS, exit 0.
- `npm test -- --reporter=dot`: PASS, 5 files and 97 tests (up from 86 in Cycle 3), exit 0.
- `git diff --check` and `git diff --cached --check`: PASS, exit 0.
- `npm run verify:live` and `npm run verify:environment` were not run, as instructed. I did not read OpenCode user configuration or credentials.
- I read `git diff` for `src/live-probe.ts` and `tests/integration/live-probe.test.ts` (unstaged Fix Group 3 changes), plus the related staged code in `src/live-probe.ts` and `src/environment-preflight.ts`.

Checked against the Fix Group 3 Accept criteria:
- **Startup settles once.** The startup wait resolves to a single `listening` or `failed` value guarded by `settled` (`src/live-probe.ts:931-946`). It never rejects, so the only path out is the single `if (startup.status === "failed") return closeThenFail(...)` (`:980`). The two cannot settle twice. A listening line that arrives after a failure is ignored, for two reasons. `finish` returns early once settled. It also swaps the parsing listener for `discardOutput`, so a late line never reaches `onOutput`. The "simultaneous failures" test checks this directly: a valid listening line arrives at 10 ms while termination is still waiting on a 30 ms exit, and the launch still rejects with the first error and never calls `verifyAuthentication`.
- **Listeners and timer are detached.** On settlement `finish` clears the startup timer and removes `onOutput`, `onExit` and `onAbort`. stdout and stderr keep draining through `discardOutput`, so a child that keeps writing cannot fill its pipe. The child `error` listener stays attached for the child's lifetime, with `startupFailure` cleared to `undefined` on settlement. That is correct: an `error` event with no listener would throw. Later errors, such as a failed `kill` after success, are ignored, and the bounded `terminateOwnedChild` policy still decides the close result. This also improves on the earlier `once("error")`, where a second error would have been uncaught. The success-path test sends a late error and a late listening line and asserts nothing reacts.
- **Every failure awaits the shared close.** Timeout, child error, invalid listening URL, premature exit, cancellation, ownership rejection and post-authentication failure all reach `closeThenFail`. It awaits the single memoized `closePromise` and only then rethrows the original failure. If termination is not confirmed it throws the fixed `SERVER_TERMINATION_UNCONFIRMED_MESSAGE` instead, which carries no credential or child data.
- **No unhandled close rejection.** Every reference to the close promise has a handler: `closeOnAbort` uses `.catch`, `closeThenFail` awaits inside `try`, and the preflight cleanup uses `.catch`. If the preflight's `bounded` gives up on settlement, a late launcher rejection is still absorbed by `operationResult`'s rejection handler.
- **Signals reach only the directly spawned child.** `terminateOwnedChild` only calls `child.kill` on the handle it is given. There is no process-group or pid-based signalling. A child that has already exited is not signalled: the premature-exit test asserts `signals === []`.
- **Ownership is still published immediately after spawn.** `acceptCloseOwnership(close)` is called synchronously after `spawnServer`. The success test asserts `published` is defined before any output and that `server.close === published`. The preflight still stores that same `close` as `closeServer`, and `cleanup` awaits `closeServer()` (`src/environment-preflight.ts:527-530, 575-576`). Publication and cleanup behave as before.
- **Success path is unchanged.** Authentication is verified with the same Basic header, the same spawn args are used, the abort-driven close is still attached, and `close` is idempotent (the second call returns the same promise, and only one SIGTERM is sent).
- **Driver construction.** `createAuthenticatedOpenCodeDriver` still awaits `hosted.close()` when client construction fails. On launch failure, the launcher itself now awaits termination before rejecting, which fixes the driver-path variant from Cycle 3.
- **Bounds are finite.** Startup waits at most 15,000 ms (injectable), termination at most 2 × 2,000 ms (injectable), and authentication verification at most 2 × 5,000 ms fetch timeouts.
- **Tests.** The new tests use injected fake children and no real process. They record `exitedWhenObserved` at the moment the caller sees the outcome, which proves the caller does not see failure before termination settles. They cover the SIGTERM-to-SIGKILL failure policy for timeout, cancellation and error, and they watch for unhandled rejections. Most timing comes from the fakes' own timers.

### Variant Hunting
- **Spawn failure with no process (e.g. ENOENT).** Node sets `exitCode` to the negative errno before it emits `error`. `terminateOwnedChild` therefore returns at once and the original error is rethrown, not a false "termination unconfirmed".
- **Synchronous pre-abort.** If the signal is already aborted, `closeOnAbort` starts termination synchronously. `onAbort` runs at the end of the executor, after `timeout` is declared, so there is no use-before-initialization. Both share one close promise.
- **Abort during authentication verification.** `closeOnAbort` starts the shared close while verification finishes under its own fetch timeouts. Any failure then awaits the same promise. This path is bounded and behaves as in earlier cycles.
- **Interaction with the preflight's `bounded` settlement window.** On cancellation during startup, the old code rejected only after the child's `exit` event, which itself followed the abort-driven SIGTERM. The new code rejects when the same termination promise settles. For a child that exits on SIGTERM the timing is effectively the same. For a stubborn child it is at most about 2 s later (the extra SIGKILL wait). This does not make the 50 ms settlement window worse in practice. When the window is missed, the outcome stays conservative (`Cleanup: FAIL`), and cleanup still awaits the same close promise.
- **Listeners left on the exit event.** The simultaneous-failure test asserts `listenerCount("exit") === 0` after settlement. `waitForOwnedChildExit` removes its own listener when it times out.
- **Mutation evidence.** Fix Group 3 reports that temporarily restoring the old non-awaited rejection made 8 of the new tests fail. That is consistent with the ordering assertions I read.

### Remaining Risks
- The listening-line parser (unchanged code) checks the accumulated output line by line. A real stdout chunk that splits `opencode server listening on http://...` partway through the URL could be read as an invalid listening URL. This is pre-existing, fails safe, and is outside this correction's scope.
- The Cycle 3 settlement-window documentation suggestion is still deliberately unimplemented, per the Fix Group 3 constraints.
- Security properties (credential-bearing environment inheritance, error-message content from spawn errors, endpoint trust) remain for the Group 5 security review.
- Real-process lifecycle behavior is left to Group 6 QA. The recorded real preflight result is still the expected readiness FAIL / NO-GO, which is not a defect.

### Tests
- [x] All tests passing
- [x] Test coverage adequate for changes

### Verdict: PASS

# Review: OpenCode/Ollama Environment and Architecture Reassessment

## Cycle 5 — 2026-10-02
Reviewing: Fix Group 4 (Core V2 completion, message ordering, and cancellation contract)

### Critical
- **[src/live-probe.ts:317-341, :583-588; docs/tech.md:188; tests/integration/live-probe.test.ts:526-547] Ascending correlation picks the first step's assistant message, not the turn's final result. This makes "Local model invocation" fail falsely for the live probe's first prompt.**
  - In the pinned 1.18.33 bundle, every LLM step creates a new assistant message. The step recorder mints a new `assistantMessageID` on `session.next.step.started`, and the projector's `"session.next.step.started"` handler marks the previous assistant as completed and then appends a new `type:"assistant"` message. `SessionRunner.run` loops through the steps (`while(U){... U=T_.needsContinuation ...}`).
  - The first live-probe prompt asks the model to "Create hello.txt … Then reply TOKEN_STORED". That needs a tool step (the write) and then a reply step, so the turn holds at least two assistant messages.
  - With `order: "asc"`, `correlatedAssistantResponse` breaks on the first assistant after the admitted input. That is the tool-call step, which usually has no text or non-sentinel text. `finalResponse === "TOKEN_STORED"` (`src/live-probe.ts:120`) therefore fails even when OpenCode worked correctly. The expensive, separately authorized `verify:live` run would get a false FAIL.
  - This contradicts the Fix Group 4 Accept item that ascending order makes "the preflight and live-probe correlation … correct". It also contradicts the docs line "The final result is that correlated assistant message".
  - The driver test only uses single-assistant transcripts, so it cannot catch this.
  - The preflight sentinel prompt (`src/environment-preflight.ts:553`) and the isolation prompt run in a single step, so they are not affected in practice.
  - Fix: take the **last** assistant message before the next user message, ideally requiring it to be completed (`time.completed`/`finish`). Add a test with a tool-step assistant followed by a final-text assistant. State the rule in `docs/tech.md`.

### Warning
- **[src/live-probe.ts:695-776] The rewritten `#exerciseCancellation` flow has no driver-level test.**
  - The pure predicates are well tested (`fixtureToolCallID`, `cancellationFromObservedEvents`, `cancellationPassed`). The orchestration is not.
  - The only driver test supplies an empty cancellation stream, so it returns `false` in the first loop and never reaches the new code.
  - Nothing proves these behaviours:
    - finding the tokenized `callID` from a durable `tool.called` and skipping non-durable events;
    - the interrupt happening only after the PID file appears;
    - observation stopping at that call's `tool.failed`/`tool.success`;
    - `waitUntilIdle` being called only after the terminal event (the main ordering claim in the code comment and tasks evidence);
    - the stream being returned and the fixture terminated on each path.
  - Add a fake-client driver test: a stream yielding a delta, the tokenized `tool.called`, an unrelated `tool.failed`, then the matching `tool.failed`; a fake `active` that records call order; and a fixture/PID stub. Include a late-success variant.

### Suggestion
- **[src/live-probe.ts:738-739, :437-442] The interrupt sequence is synthetic, and the terminal event's cause is not checked.** `interruptSequence` is the highest observed seq plus 1. Durable events left unread in the stream during the PID wait of up to 5 s can carry higher seqs even though they happened before the interrupt. So a `tool.failed` for the call caused by something else (for example the fixture dying on its own) would count as post-interrupt. This was already true in the old design and is now narrower thanks to `callID` correlation, which is why it is not a blocker. To tighten it, also require the failure's `error` to indicate interruption (live: "Tool execution interrupted"), or compare the event `timestamp` with a local timestamp taken when the interrupt was requested.
- **[src/opencode-adapter.ts:234-252] The timeout message for a hung poll is slightly misleading.** A poll that hangs fails with `list active sessions` / `timed out after <remaining>ms`, where `<remaining>` is however much of the overall wait was left. The result is bounded and correct, but the message can show an odd number like `37ms`. Consider mapping poll timeouts to `wait for session` / `timed out after ${this.#timeoutMs}ms`.
- **[src/opencode-adapter.ts:41-46, src/live-probe.ts:763] `waitUntilIdle` without `afterInputID` returns as soon as the session is inactive.** That is safe at its only caller, which is chained after the interrupted tool's terminal event. Say in the JSDoc that the option-less form is only valid once execution is known to have started.
- **[src/live-probe.ts:737-740] The global stream is not closed if `interrupt` throws** (the throw happens before `observeInterruptedTool` exists). This was already the case before, and it is bounded by the adapter's 120 s abort timer and by server close. A `stream.return` in that path would tidy it up.
- **[decisions.md "Reclassify…" item 1] The decision and the implementation describe idle corroboration differently.** The decision says idle is corroborated by `session.next.step.ended`. The implementation corroborates it with an assistant message in the admitted turn, which is the stronger choice. The tasks evidence and docs describe the implementation, but the decision entry still reads differently.

### Verification Evidence
- `npm run typecheck`: PASS, exit 0.
- `npm test -- --reporter=dot`: PASS, 5 files and 108 tests, exit 0.
- `git diff --check` and `git diff --cached --check`: both exit 0.
- `npm run verify:live` and `npm run verify:environment` were not run. I did not read any OpenCode user configuration or credentials.
- Pinned versions: `opencode-darwin-arm64` and `@opencode-ai/sdk` are both 1.18.33. Fix Group 4 makes no unstaged `package.json` or lockfile change.
- Bundle checks (from `strings` output of `node_modules/opencode-darwin-arm64/bin/opencode`):
  - **`wait` is a stub:** `wait:W.fn("V2Session.wait")(function*(K){return yield*j.get(K),yield*new K$({operation:"wait"})})`. It is unconditional after the session lookup, and HTTP maps it to "Session wait is not available yet". Confirmed.
  - **`active` lists running sessions:** the `session.active` handler returns `Object.fromEntries(active → [id,{type:"running"}])`. `active` is `new Set($.keys())` over the run coordinator's map. Confirmed.
  - **No unscheduled gap after admission:** `V2Session.prompt` admits the input and then `yield*X.wake(sessionID)`. `wake` adds the coordinator map entry synchronously, before the HTTP response. The entry is deleted only when the drain exits, and the drain (`SessionRunner.run`) loops over every step. So after admission, the session cannot look inactive before the run is scheduled or between steps, and the "stays listed between steps" claim in the docs holds.
  - **Message ordering:** the default order is `desc` and the default `limit` is 50 (`m.query.limit??kX`, `kX=50`). For these short sessions, `asc` without a cursor returns the oldest 50, so pagination does not affect correlation.
  - **Tool events are durable:** `tool.called`, `tool.failed`, `tool.success` and `tool.progress` are defined with `durable:{aggregate:"sessionID"}`. `SessionNextToolCalled.data` carries `callID`, `tool` and `input`. Ignoring non-durable events is therefore safe for this evidence.
- Adapter: there are no remaining production calls to `v2.session.wait`. Every poll and message fetch is limited by the remaining deadline (`Math.max(1, …)`), so the whole wait is bounded by `timeoutMs` plus at most one poll interval. A hung poll is aborted and raises an error. In the preflight, the 60 s stage abort closes the server first, so polling fails fast.
- `hasAssistantResponseAfter` only accepts an assistant message inside the admitted input's turn. Combined with inactivity, a stale assistant message from an earlier turn cannot report completion.
- The cancellation predicate is at least as strict as before:
  - The start event is tied to the bash call that carries the random token.
  - The terminal event must have the same `callID`, come after the interrupt, and be confirmed idle afterwards.
  - The fixture must have terminated.
  - A late `tool.success` or the completion marker forces failure.
  - Stream observation is bounded by the adapter's 120 s abort of the global SSE subscription, and the fixture is always terminated in `finally`.
- Spec constraints are kept: explicit `LIVE_MODEL` binding, permission correlation and deletion verification are unchanged; the 10/60/180 preflight contract and redaction are untouched; no dependency or config change; readiness PASS is recorded as readiness only.

### Variant Hunting
- Other correlation sites:
  - The preflight's inline correlation takes the first assistant after the input. Correct for its single-step sentinel prompt.
  - The isolation prompt is single-step text.
  - `hasAssistantResponseAfter` only detects completion, where any assistant message in the turn is the right test.
  - Only the first live-probe prompt is multi-step, which is the Critical above.
- Leftover dependence on removed contracts: nothing in `src`, `scripts` or `tests` calls `session.wait`. `session.idle` appears only in an old adapter streaming test fixture, as opaque data. `session.next.shell.started` is still only one alternative in `isStructuredExecutionEvent`, alongside `step.started` and `tool.called`, so it is harmless.
- Timer-based tests use fake timers, which `afterEach` resets. The one real-time test (`idlePollIntervalMs: 1`) has no timing assertion, so the new tests are not timing-flaky.

### Remaining Risks
- The cancellation contract rests on a single bounded live diagnostic of model behaviour: the model must issue one bash call containing the token, run in the foreground. A model that wraps or rewrites the command fails safely (false FAIL), bounded by the 120 s stream abort.
- The interrupt sequence is synthetic (Suggestion 1). The risk of a false PASS is low but not zero.
- Real-process behaviour of the whole probe stays with the separately authorized `verify:live`. Security review (Group 5) has not started.

### Tests
- [x] All tests passing
- [ ] Test coverage adequate for changes (no multi-step correlation test; no driver-level cancellation orchestration test)

### Verdict: FAIL

# Review: OpenCode/Ollama Environment and Architecture Reassessment

## Cycle 6 — 2026-10-02
Reviewing: Fix Groups 4–5 (Core V2 completion, final-response correlation, and cancellation orchestration)

### Critical
- **[src/live-probe.ts:726, src/live-probe.ts:427, src/capabilities.ts:123; tests/integration/live-probe.test.ts:284, :307, :1177] The synthetic interrupt sequence makes a genuine interrupt fail when `tool.failed` is the next durable event after `tool.called`. That is the most likely live sequence.**
  - `interruptSequence` is set to `max(observed seq) + 1`. Phase 1 stops reading at the fixture's `tool.called`, so the highest observed sequence is that event's seq, N, and `interruptSequence` becomes N+1.
  - The terminal event must satisfy `event.sequence > interruptRequestedAtSequence`, and `cancellationPassed` requires `interruptRequestedAtSequence < terminalAtSequence`.
  - In the pinned 1.18.33 bundle, durable seqs are dense per session aggregate. The event store assigns `d+1` and dies with "Sequence mismatch … expected ${d+1}" otherwise.
  - `session.next.tool.progress` is defined and projected but never published. The runner's `step-finish` handling only flushes open text or reasoning parts. While the bash fixture runs, then, the session usually emits no durable event: the step settles only after the tools join (`raceFirst(join, awaitEmpty)`), and only then come `failUnsettledTools("Tool execution interrupted")` and the step end.
  - So the interrupted `tool.failed` usually gets seq N+1, which equals `interruptSequence` and fails the strict comparison. This matches the recorded FG4 diagnostic sequence: `tool.called` → (interrupt) → `tool.failed` → `step.ended`, with nothing in between. It would pass only when an unrelated durable event happens to come in between, such as a late `text.ended` flush.
  - Result: the separately authorized `verify:live` would report a false Cancellation FAIL even though OpenCode cancelled correctly.
  - The tests hide this:
    - The unit "verified" case uses a gap (`fixtureCall(15)`, interrupt 16, `interrupted(17)`).
    - The driver fixture puts an unrelated `call-glob` failure at seq 8, so the fixture failure lands at 9.
    - The unit case labelled `failureBeforeInterrupt` (`fixtureCall(15)`, `interrupted(16)`, interrupt 16 → `false`) is exactly the consecutive live case, asserted as a rejection.
  - Fix: place the synthetic interrupt strictly between the last pre-interrupt observation and any later event, either by requiring `terminal.sequence > maxObservedBeforeInterrupt` or by setting the interrupt position to `max + 0.5`. Rely on the new timestamp check for causality. Add unit and driver tests where `tool.failed` immediately follows `tool.called` (seq N, N+1), and replace the `failureBeforeInterrupt` case with one whose timestamp precedes the interrupt.

### Warning
- None beyond the Critical above.

### Suggestion
- **[tests/integration/live-probe.test.ts:1119-1282] Driver-level cancellation coverage covers two of the six exit paths.**
  - The success and late-success scenarios assert that the stream is closed. The no-fixture-call path is exercised only implicitly by the permission driver test, which does not assert closure. The no-PID, `interrupt`-throws and observation-failure paths are not exercised.
  - The fixture PID is an already-exited process, so `terminateValidatedFixture` is always a no-op and `fixtureTerminated` is trivially true. The driver's own termination is never exercised at driver level, although the helper is unit-tested.
  - The `finally` structure is simple and correct on inspection (see Verification Evidence), so this is not blocking.
- **[tests/integration/live-probe.test.ts:1276-1281] The late-success driver variant does not show that a `tool.success` is rejected.** That scenario has no matching `tool.failed`, so `terminalAtSequence` is 0 and the test would fail cancellation even if the success handling were deleted. It does show that observation stops at the success event and that the stream is closed. The unit `successBefore` case is the one that actually covers success rejection. To make the variant meaningful, add a matching `tool.failed` after the success.
- **[tests/integration/live-probe.test.ts:1145-1148] The PID-ordering assertion is deterministic for a correct implementation, but only probabilistic as a mutation detector.** The driver cannot read the PID file before it is written, so `pid-written < interrupt` always holds when the code is correct. An implementation that skipped the PID wait would be caught only if it reached `interrupt` within 50 ms. A promise-gated PID write that the test releases explicitly would make the check exact.
- **[src/opencode-adapter.ts:111] "Completed" also covers failed steps.** In 1.18.33, `session.next.step.failed` sets `time.completed` together with `finish: "error"`. An errored final step whose partial text equals the sentinel would be accepted. This is unlikely, but rejecting `finish === "error"` or an `error` field would align the check with "completed successfully".
- **[src/opencode-adapter.ts:278] Poll timeouts are recognised by the message prefix `"timed out"`.** A server-supplied error message that starts with that text would be relabelled as the wait timeout. The original error is kept as `cause`, so nothing is lost. A structured flag on `OpenCodeAdapterError` (for example `timedOut: true`, set in `#toError`) would be more robust.
- **[src/live-probe.ts:694-698] The stream is not returned if `prompt` throws.** The prompt is submitted before the `try`. This predates these groups and is bounded by the adapter's 120 s abort timer, which fires even if the generator never started. Moving the prompt inside the `try` would complete "returns the stream on every path".
- **[docs/tech.md, Cancellation step 3] Wording.** Step 3 says the terminal `tool.failed` is "followed by `session.next.step.ended`". The implementation does not require `step.ended`; it confirms idle through `active`. Mark `step.ended` as observed rather than required.

### Verification Evidence
- `npm run typecheck`: exit 0.
- `npm test -- --reporter=dot`: 5 files, 111/111 passed. `tests/integration/live-probe.test.ts` was then run 5 more times in a row, all exit 0.
- `git diff --check` and `git diff --cached --check`: both exit 0.
- `npm run verify:live` and `npm run verify:environment` were not run. I read no OpenCode user configuration or credentials.
- No unstaged `package.json` or lockfile change. The only staged `package.json` change is the previously reviewed `verify:environment` script. The pins stay at 1.18.33.

**Cycle 5 Critical (final-response correlation): resolved.**
- `assistantMessagesInTurn` bounds the turn between the admitted user input and the next user message.
- `finalAssistantResponseText` takes the last assistant message in that turn and returns `undefined` unless `time.completed` is set.
- The live probe (`correlatedAssistantResponse`) and the preflight (`runOpenCodeInference`) both use this one helper.
- Bundle check: `step.started` completes the previous assistant message and appends a new one, and `step.ended` and `step.failed` set `time.completed`. Once `active` drops the session, the final message is therefore complete.
- An earlier turn cannot be misattributed, because a later user message ends the turn.
- Tests cover a tool step followed by the final text, an incomplete final message, a missing input, and a later input. The driver transcript now models a two-step turn.

**Cycle 5 Warning (no driver-level cancellation test): resolved, apart from the coverage notes in the Suggestions.**
- One global stream is read through explicit `next()` calls across both phases, and there is no early exit from a `for await` loop.
- `stream.return` is in the outer `finally`, so it runs on every path inside the `try`: no fixture call, phase-1 error, no PID, `interrupt` throwing, observation or idle failure, and success. In each case nothing else is reading the stream when `return()` runs, so it cannot queue behind a pending read.
- `terminateValidatedFixture` runs afterwards in the same `finally`. In the SDK, `return()` at a suspended `yield` only runs `releaseLock`, so in practice it does not throw before termination.
- The SDK's SSE generator swallows errors when `sseMaxRetryAttempts: 0` and simply ends. Both phases are therefore bounded by the adapter's 120 s abort of the subscription. The rest is bounded as follows: `waitUntilIdle` by 120 s, the PID wait and process-exit wait by 5 s each, and the whole run by the 600 s end-to-end deadline.

**Error propagation compared with the prior code.**
- Phase-1 failures still return `false`.
- An `interrupt` failure and post-interrupt observation or idle failures still throw through `settlePairedOperations`.
- The idle wait now starts only after the terminal event, or after the stream ends, instead of running concurrently. This is the ordering Fix Group 5 authorized.
- No other semantics changed.

**Timestamp check.**
- In the SDK types, `SessionNextToolFailed.data.timestamp: number`, and `durableProbeEvent` maps `data` into `properties`.
- The bundle stamps it with `uT.now` at `failUnsettledTools`, after the interrupt is received. The projector copies the same field into message `time.*` values.
- The server is a child process on the same host, and the local `interruptRequestedAt` is taken before the request, so `>=` accepts a same-millisecond event.
- An event without a timestamp is rejected. That is conservative, and the schema always includes one.
- The timestamp check does not reject genuine interrupts. The sequence check does (see Critical).
- "Any `tool.success` fails" does not over-reject: an interrupted bash call in 1.18.33 ends with `tool.failed`, and the 60 s fixture cannot succeed earlier.

**Poll-timeout mapping.**
- A timeout of an `active` or `messages` poll becomes `wait for session` / `timed out after ${timeoutMs}ms`, with the poll error kept as `cause`.
- A non-timeout failure (the 401 test) keeps its original diagnostic.

**Constraints preserved:** authentication, permission correlation, deletion verification, redaction, `LIVE_MODEL` binding, the 10/60/180 preflight contract, and the separation between readiness and Milestone 0 are all untouched by these groups. The JSDoc for the option-less `waitUntilIdle` and the `decisions.md` entry are present.

### Variant Hunting
- Synthetic sequence arithmetic appears only in `#exerciseCancellation`'s `interruptSequence` and the completion re-sequencing in `cancellationFromObservedEvents`, which derives from the same value. No other capability uses a synthetic sequence.
- The correlation sites (live-probe first prompt, isolation prompt, preflight) all go through `finalAssistantResponseText`. `hasAssistantResponseAfter` only detects completion.
- No production call to `session.wait`. `session.idle` and `session.next.shell.started` are no longer part of cancellation evidence.
- Tests using a strict sequence gap: unit lines 281-322 and the driver fixture. All of them put a gap between the last pre-interrupt event and the terminal failure, which is why the Critical went unnoticed.

### Remaining Risks
- The cancellation path rests on how the model behaves in a single live run: one foreground bash call that contains the token. Real-process behaviour, including the timestamp clock, remains unverified until the separately authorized `verify:live`.
- Even after the Critical is fixed, a durable event stamped before the interrupt but read after it is excluded only by the timestamp check. That is acceptable for a same-host server.
- Security review (Group 5) and QA (Group 6) have not started.

### Tests
- [x] All tests passing
- [ ] Test coverage adequate for changes (no consecutive-sequence cancellation case, and the existing `failureBeforeInterrupt` test asserts the wrong result for it; driver tests cover only 2 of 6 exit paths)

### Verdict: FAIL

# Review: OpenCode/Ollama Environment and Architecture Reassessment

## Cycle 7 — 2026-10-02
Reviewing: Fix Group 6 (interrupt-ordering boundary) with regression check of Fix Groups 4–5

### Critical
- None. The Cycle 6 Critical is resolved (see Verification Evidence).

### Warning
- None.

### Suggestion
- **[tests/integration/live-probe.test.ts:1341-1346] The late-success driver scenario still cannot tell whether `tool.success` is rejected.** This repeats a Cycle 6 suggestion that was not adopted.
  - The scenario has no matching `tool.failed`, so `terminalAtSequence` is 0 and cancellation fails regardless of how success is handled.
  - The driver also stops reading at the success event, so adding a later `tool.failed` would not help at driver level.
  - The rejection is properly covered by the unit `successBefore` case (`tests/integration/live-probe.test.ts:302-310`). There, called is 15, success 16, failed 18, and the last event read is 17: the ordering holds, and only the re-sequenced completion at 18.5 rejects it.
  - The unit `successAfter` case has the same weakness as the driver scenario, since it has no terminal failure either. Consider a comment, or dropping the claim that these two cases prove success rejection.
- **[tests/integration/live-probe.test.ts:1348-1354] The "fails and closes the stream when the fixture call never starts" assertion is vacuous for closure.**
  - In this scenario the fake generator runs to completion on its own, so its `finally` sets `cancellationStreamClosed` even if the driver never calls `stream.return`.
  - The other five scenarios suspend the generator at a `yield`, so their closure assertions are meaningful.
  - Making the no-fixture-call stream also block (for example `await new Promise(() => undefined)` after seq 6, behind a short adapter timeout) would make this one exact as well.
- **[tests/integration/live-probe.test.ts:276-280, src/live-probe.ts:433] The `>=` timestamp boundary has no test.**
  - Every accepting case stamps the failure at `interruptAt + 5`, so a mutation to `>` would survive.
  - On a same-host server, a same-millisecond stamp is realistic, and the regression would be a sporadic false FAIL.
  - Add one case with `timestamp === interruptAt`.
- **[docs/tech.md:189 (Final Result)] The docs do not mention the new failed-step rejection.** They say the final result is the last assistant message "with `time.completed` set". They do not say that `finish: "error"` or an `error` field disqualifies it. The JSDoc at `src/opencode-adapter.ts:104-107` does say so. Add one clause to the docs.
- **[src/opencode-adapter.ts:196-212; src/live-probe.ts:706-712, :763] Returning a not-yet-started stream leaves the abort timer armed.** This predates these groups and is bounded.
  - Now that the prompt is inside the `try`, a `prompt` rejection calls `stream.return()` before the stream's first `next()`.
  - Returning an unstarted async generator skips its body, so `timedStream`'s `finally` (`clearTimeout`/`abort`) never runs. The 120 s timer stays armed until it fires.
  - The SDK's SSE generator is lazy (`serverSentEvents.gen.js`, where `fetch` happens on the first `next()`), so no connection is held open. This is harmless today. Moving the timer and controller setup into the generator body, or clearing them on an unstarted return, would make "returned on every path" release everything.
- **[tasks.md Fix Group 6, Completed evidence] "The only change on the preflight path since the last PASS is the stricter final-response check" is slightly imprecise.**
  - The structured `timedOut` mapping in `waitUntilIdle` and `#toError` is also on the preflight path.
  - That change affects only failure-path diagnostics, which the preflight redacts to fixed evidence strings anyway, so the readiness conclusion is unaffected.
- **[tests/integration/live-probe.test.ts:1157, :1192-1200] Minor remaining test-harness determinism caveats.** Neither is blocking.
  - The completion marker is written with an unawaited `writeFile` inside the 200 ms timer. In practice it finishes long before the driver reads it.
  - The "already-exited" PID from `spawnSync` could in theory be reused by another process. That would make `terminateValidatedFixture` refuse and throw.
  - As noted in Cycle 6, the driver's own fixture termination is still never exercised at driver level; it is unit-tested separately.

### Verification Evidence
- **Commands run:**
  - `npm run typecheck`: exit 0.
  - `npm test -- --reporter=dot`: 5 files, 117/117 passed.
  - `tests/integration/live-probe.test.ts` repeated 5 more times: 50/50 each run, stable.
  - `git diff --check` and `git diff --cached --check`: both exit 0.
  - No unstaged `package.json` or lockfile change; the pins stay at 1.18.33.
  - `npm run verify:live` and `npm run verify:environment` were not run. No OpenCode user configuration or credentials were read.

**Cycle 6 Critical: resolved.**
- **How the interrupt position is set:** `cancellationFromObservedEvents` (`src/live-probe.ts:411-454`) sets `interruptRequestedAtSequence = lastSequenceReadBeforeInterrupt + 0.5`.
- **What counts as "read before the interrupt":** `#exerciseCancellation` computes `lastSequenceReadBeforeInterrupt` as the maximum durable sequence in `events` just before `Date.now()` and `interrupt` (`:730-732`).
  - `events` only grows when `nextEvent()` is called, and no read happens during the PID wait. So `events` holds exactly the phase-1 reads, and it is non-empty because a `callID` was found.
- **Consecutive N, N+1:** the start (N) is below N+0.5, and the terminal event (N+1) is above it. In `cancellationPassed` (`src/capabilities.ts:119-130`), both strict comparisons hold.
- **A failure read before the interrupt** has seq ≤ N, so it is below N+0.5 and excluded. The unit `failureReadBeforeInterrupt` case covers this (last = 16, failed at 16).
- **Re-sequencing of completion events:**
  - A `tool.success` is moved to `max(seq, N+1.5)`, and the marker to `max(N+1.5, terminal)`. Both are always above N+0.5, so `lateCompletion` fires.
  - The fractional values are used only in these comparisons. They are never reported or serialised: `interruptRequestedAtSequence` appears only in `src/capabilities.ts:41,122-126`.
- **Mutation check against the driver's default scenario:** reads at seqs 5, 6 and 7 give last = 7, and the fixture `tool.failed` is at 8. With the old `+1` boundary, 8 > 8 is false and the scenario fails. That is exactly the claimed mutation result.

**Timestamp causality guard.**
- `SessionNextToolFailed.data.timestamp` is required in the SDK types. The server stamps it after it receives the interrupt.
- The local `interruptRequestedAt` is taken before the request on the same host's wall clock, so `>=` correctly accepts an event in the same millisecond.
- An event with no timestamp is rejected, which is conservative because the schema always includes one.
- An already-queued event (seq > N but produced before the request) is excluded only by this check. That is appropriate for a same-host child server.

**Failed final step rejection.** The 1.18.33 bundle was inspected for what each step outcome sets.
- In the V2 projector, only the `session.next.step.failed` handler sets `finish = "error"` and `error`.
- `step.ended` copies `finish` from the step settlement (`S={finish:K.reason,…}`). It never sets `error`, and it is published only when `!hasProviderError()`.
- The OpenAI-compatible mapper used for Ollama (`Z7`) returns only `stop`, `length`, `content-filter`, `tool-calls` or `unknown`, never `error`.
- No other V2 projector handler sets `error`. A genuine success therefore cannot be rejected.
- Unit tests cover `finish: "error"`, an `error` field, and `finish: "stop"`, which is accepted.

**`timedOut` flag.**
- Set only in `#toError` when the cause `instanceof Error && name === "AbortError"`. The only abort source is the adapter's local timeout controller.
- An HTTP error body (`result.error`) is not an `Error` instance, so a server message such as "timed out upstream" keeps its own diagnostic. The new unit test covers this.
- In `waitUntilIdle`, poll and message timeouts carry `timedOut` and become `wait for session` / `timed out after ${timeoutMs}ms`, with the poll error kept as `cause`. Other failures propagate unchanged.

**Prompt inside the `try`.**
- A `prompt` rejection still propagates out of `#exerciseCancellation`, because the inner `catch` wraps only the phase-1 loop. Error semantics are therefore unchanged from before.
- The `finally` now also runs `stream.return` and `terminateValidatedFixture(0, …)`, which is a no-op for PID 0.
- On every other path the behaviour is as verified in Cycle 6: `stream.return`, then fixture termination. In the SDK, `return` at a suspended `yield` only runs `releaseLock`.

**Driver scenarios.** All six pass deterministically:
- **PID ordering:** the 200 ms PID timer makes the `pidFileExistedAtInterrupt` assertion an exact detector for a skipped PID wait, since an immediate interrupt would find no file. The driver polls every 50 ms for up to 5 s.
- **Idle after terminal:** "active after terminal" is deterministic because the idle wait is chained on `observeTerminalToolEvent`.
- **Consecutive terminal event:** the default scenario is the N, N+1 case.
- **Completion marker:** this scenario genuinely depends on the marker check, because its terminal event is otherwise valid.
- **`interrupt` throwing:** the scenario asserts propagation of "interrupt session" and that the suspended stream was returned.

**Other Cycle 6 suggestions delivered:**
- `docs/tech.md` Cancellation step 3 marks `step.ended` as "observed, but it is not required".
- The six driver scenarios are present.
- `failureBeforeInterrupt` was replaced with read-before and timestamped-before cases.

**Fix Groups 4–5, no regression:**
- No production call to `session.wait`.
- `messages` uses `order: "asc"`.
- `waitUntilIdle` stays bounded and requires a turn-scoped assistant message when given `afterInputID`.
- `finalAssistantResponseText` is still the single helper shared by `correlatedAssistantResponse` and `runOpenCodeInference`.
- The single-stream `next()` design is intact.

**Constraints:**
- No dependency or config change.
- Authentication, permission correlation (`#exercisePermission`), deletion verification, redaction, `LIVE_MODEL` binding, and the 10/60/180 contract are untouched by this group.
- Readiness stays distinct from Milestone 0.

**tasks.md outage note:** it is accurate and appropriately conservative.
- It does not claim readiness PASS.
- It records that Endpoint reachability failed, downstream rows were skipped, and Cleanup passed.
- It calls for a rerun once the endpoint is restored.
- Group 6 QA must run `verify:environment` independently in any case.
- The only imprecision is noted in the Suggestions.

### Variant Hunting
- **Other synthetic or ordering arithmetic:** none outside `cancellationFromObservedEvents`. `cancellationPassed` is the only consumer, and no other capability uses fractional or synthetic sequences.
- **Other places that read finish or completion state:**
  - `hasAssistantResponseAfter` deliberately still accepts any assistant message in the turn, which is correct for detecting completion.
  - The preflight, the first live prompt and the isolation prompt all go through `finalAssistantResponseText`.
- **Other message-text timeout checks:** none. The `"timed out"` prefix match was removed. Only `diagnostic.timedOut` is consulted.
- **Other streams returned before they are started:** `#exercisePermission` creates its stream and immediately iterates it, so the unstarted-return case does not arise there. The same `globalEvents` timer note applies only where a stream could be returned before its first `next()`.

### Remaining Risks
- **Cancellation still rests on model behaviour in a single live run:** one foreground bash call that carries the token. Real-process timing, including the same-host clock relationship, is unverified until the separately authorized `verify:live`.
- **Readiness is not re-confirmed since Fix Group 6,** because the endpoint was unavailable. The stricter final-response check only rejects failed steps, so the risk of a regression on the pass path is low, but Group 6 QA must re-run the preflight.
- **Security review (Group 5) and QA (Group 6) have not started.**

### Tests
- [x] All tests passing (117/117; live-probe suite stable across 5 repeats)
- [x] Test coverage adequate for changes (consecutive and intervening sequences, read-before and timestamped-before exclusions, failed-step rejection, structured timeout mapping, six driver exit paths; remaining gaps are nonblocking Suggestions)

### Verdict: PASS
