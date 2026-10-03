# Review: Permission Event Race

## Cycle 1 — 2026-10-03
Reviewing: Group 1

### Critical
None.

### Warning
- **[src/live-probe.ts:833-835, 646-649; docs/tech.md:450, 483-485] When no permission event is observed, the stage still journals `permission.complete`, and the run guidance in `docs/tech.md` is out of date.**
  - If `waitForPermissionAsked` returns `false`, `#exercisePermission` returns `undefined` without throwing. `#stage` then journals `permission.complete`, and `run()` records no not-passed marker (compare `if (!cancellationResult) this.#onProgress("cancellation.not-passed")`). A missing event, another session's event, a mismatched ID and an early monitor end all leave the same journal: `permission.start`, then `permission.complete`.
  - `docs/tech.md:450` states a general rule: "A stage that completes without its evidence journals a distinct marker." The rewritten permission stage breaks that rule.
  - This is the same gap that forced the 2026-10-03 run's diagnosis to rely on stage timing (`docs/tech.md:364-368`: "journaled `complete` with no `.failed` entry"). The behavior is inherited, but `#exercisePermission` was rewritten in this change, and the next authoritative run is the one that has to show whether the fix worked.
  - `docs/tech.md:483-485` still says: "If Permission handling fails with no observed `permission.v2.asked` event, investigate the accepted subscription race first." `decisions.md` supersedes the acceptance, and the per-stage subscription is gone, so this guidance would point an operator at a removed cause.
  - **Fix:**
    - Journal a distinct marker, for example `permission.not-observed`, when the wait resolves `false`. Optionally tell the timeout apart from a monitor end.
    - Assert that marker in the `none`, `otherSession` and `mismatchedId` scenarios and in the early-end scenario. Assert its absence in the full-PASS scenario.
    - Rewrite `docs/tech.md:483-485` to point at the new marker and at `event.monitor.ended`, and add `permission.not-observed` to the examples on line 450.

### Suggestion
- **[src/live-probe.ts:757-791] The monitor never confirms it is connected; it only dispatches the connection early.**
  - The `for await` loop calls `stream.next()` synchronously inside `#startEventMonitor`, so the SSE `fetch` is dispatched before `createSession`. Even when the initial prompt fails at once, at least three sequential round-trips separate it from `permission.create`: session create, prompt submit, and the settle status read. The race is therefore removed in practice, and a residual miss can only FAIL, never PASS.
  - Server-side registration is still not proven, though. The pinned 1.18.33 binary's `event.subscribe` handler subscribes to the bus and then emits `server.connected` as the first frame, and `ServerConnected` is a member of `V2Event`.
  - Waiting for that frame, with a bound, before `#startEventMonitor` returns would make "connected well before any permission request exists" (spec, `decisions.md`, `docs/tech.md:144`) structurally true rather than a matter of timing.
- **[tests/integration/live-probe.test.ts:56-76, 1258-1274] The fake channel buffers events pushed before its first read, so it cannot model the lazy-connect loss.**
  - The `subscribe` count of 2 (line ~715) does prove that the permission stage opens no subscription of its own.
  - But a regression that opened the monitor lazily, just before the permission stage, would still be the first `subscribe` call, would still receive the buffered events, and would pass every test.
  - Fix: have the fake drop events pushed before the stream's first `next()`, or assert that `subscribe` is called before the first `session.create`.
- **[src/live-probe.ts:780-784] Question rejection runs inside the monitor loop and can delay recording a permission event.**
  - `rejectQuestion` is awaited serially, and its adapter bound equals `#operationTimeoutMs`, the same bound as the permission wait. A hung reject that is in flight when the permission event arrives would delay recording until the permission wait has already timed out.
  - This is unlikely, because session 1 is settled to idle before the permission stage, and the result would be FAIL, not PASS. Firing the reject without awaiting it (`void ... .catch`) would remove the coupling.
- **[tests/integration/live-probe.test.ts:1562-1569] The path where the monitor ends during a wait is untested.**
  - The early-end scenario ends the stream before the wait starts, so the `ended` check at line 797 handles it.
  - The `for (const wake of waiters) wake()` call in `.finally` (line 788) is correct but unexercised. Deleting it would only stretch the FAIL to the full bound, and no test would notice.
  - Add a scenario that ends the stream after `permission.create` resolves and asserts the run finishes well inside the bound.
- **[src/live-probe.ts:830, 836] `correlatePermissionEvidence({ id: created.id }, created)` is called twice with identical arguments.** The second call can only return `created.id`. Using `created.id` directly would read more clearly.
- **[tests/integration/live-probe.test.ts:435-459, 1192, 1209, 1398, 1563] Some test names are stale.**
  - Two `settlePairedOperations` tests are still labeled and named for permission ("permission event observation", "retains both the permission stream…"), although permission no longer uses that helper.
  - The `guardStreamEndsEarly` option still carries the old guard name.
  - Renaming them (for example to `monitorStreamEndsEarly`, with generic operation labels) avoids confusion. Behavior is unaffected.

### Verification Evidence
- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: 5 files, 138 of 138 passed.
- `git diff --check`: clean.
- The working tree has no unstaged changes to `package.json`, lockfile or config (`package.json` is staged only, from earlier reviewed work).
- **Code inspected:**
  - `src/live-probe.ts:564-568` (`RunEventMonitor`), `575-586` (`#operationTimeoutMs`), `599`/`647-649`/`670` (monitor lifecycle in `run()`), `757-815` (`#startEventMonitor`), `818-839` (`#exercisePermission`).
  - `#findPermissionEvent` was removed; no references remain in `src` or `tests`.
  - `git show :src/live-probe.ts` and `HEAD` were used to compare the previous per-stage implementation.
- **SDK and binary (read-only):**
  - `gen/core/serverSentEvents.gen.js`: the `fetch` happens inside the async generator, so the connection opens on the first `next()`.
  - `V2Event` includes `ServerConnected`.
  - The pinned binary's v2 `event.subscribe` handler emits `server.connected` first, then the live stream.
- **Strictness confirmed:**
  - `effect: "ask"` is enforced by the first `correlatePermissionEvidence` call, before waiting. A non-`ask` effect throws, the stage journals `permission.failed.error`, and nothing is replied.
  - Only `permission.v2.asked` is recorded. The legacy `permission.asked` type is filtered out at line 769, and the correlation test publishes it.
  - The recorded key is `sessionID\0requestID` and is limited to `#sessionIDs`. The wait requires an exact key match, so another session's event or a different ID cannot satisfy it (tests `otherSession` and `mismatchedId`).
  - The reply is `once`, sent only after the wait returns `true` (order assertions at 1571-1584). No reply is sent otherwise (1586-1598, 1562-1569).
  - `create` failures journal `permission.failed.create-permission-request[.timeout]` through `findAdapterError`.
- **`waitForPermissionAsked`:**
  - An event recorded before the wait is found (fast path).
  - `finish` clears the timer and removes its waiter on every path.
  - Concurrent waiters each have their own key, timer and `wake`.
  - Deleting the current element of a `Set` during `for…of` is well defined in JS (live iteration, and the deleted entry was already visited), so the wake loops are safe.
  - The monitor's end wakes all waiters with `false`.
- **Tests:**
  - The 20 ms `afterCreate` timer is a macrotask, while the wait is registered within microtasks after `create` resolves, so the "arrives later" path is exercised deterministically.
  - The 300 ms bounds only shorten negative waits and cannot flake toward a false pass.
  - The early-end test uses the default 120 s bound, so a non-prompt failure would show up as a vitest timeout.

### Variant Hunting
- Other non-durable events consumed by a late subscriber: the cancellation stage still opens its own global subscription and reads first after `prompt`. It depends only on durable `session.next.tool.*` events and the fixture PID file, so the same race does not apply in the same way. This is unchanged and was accepted by earlier reviews.
- Other stages that fail without throwing and without a marker: initial prompt has `not-completed`, cancellation has `not-passed`, and isolation journals `skipped`. Permission is the only one without a marker (the Warning above).
- Stale guard terminology: none remains in `src` or `docs`. In tests only `guardStreamEndsEarly` remains (Suggestion above).

### Remaining Risks
- Connection readiness is achieved by ordering, not confirmed (Suggestion 1). A miss yields FAIL, not a false PASS.
- If the monitor drops mid-run (adapter 600 s bound, SSE drop), later questions block until their stage timeout and Permission FAILs. This is journaled via `event.monitor.ended`.
- The whole-run deadline can still be exceeded by summed per-operation bounds (pre-existing and documented).
- The live round-trip through the monitor has not been exercised against the real server. That is Group 4 QA's job, and `verify:live` was not run.

### Tests
- [x] All tests passing (138/138; typecheck clean; `git diff --check` clean)
- [ ] Test coverage adequate for changes: the not-observed journal outcome, the monitor ending during a wait, and the monitor's start timing relative to the first session are not pinned.

### Verdict: FAIL

# Review: Permission Event Race

## Cycle 2 — 2026-10-03
Reviewing: Group 1 and Fix Group 1

### Critical
None.

### Warning
None.

### Suggestion
- **[src/live-probe.ts:811-820; tests/integration/live-probe.test.ts:1586-1596] No test covers the connection-timeout path.**
  - `event.monitor.unconfirmed` is tested only when the stream *ends* before `server.connected` (`monitorStreamEndsEarly`, an empty generator). In that case `.finally` resolves `connected` and `!ended` yields `false`.
  - No test covers a stream that stays open but never sends `server.connected`. That is the only path where the `EVENT_MONITOR_CONNECT_TIMEOUT_MS` timer decides the outcome. If the timer were deleted, or the race's timeout branch dropped, every existing test would still pass.
  - In that regression, a server that never confirms would hang `#startEventMonitor` until the 600 s run deadline, and all nine predicates would FAIL. It would never produce a false PASS, and the live server is verified to send the frame within milliseconds, so I rate this a Suggestion rather than a Warning.
  - Fix: add a scenario whose monitor stream never yields `server.connected` (using `vi.useFakeTimers` or an injectable connect bound). Assert `event.monitor.unconfirmed`, that the run continues, and that a permission event delivered later is still observed.
- **[src/live-probe.ts:793-799] An unhandled rejection is possible, though unlikely.**
  - The `.catch` handler on `rejection` calls `this.#onProgress("question.reject.failed")`. The real journal uses `appendFileSync` (src/live-observability.ts), which can throw on an I/O error.
  - If it throws, `rejection` rejects. `Promise.allSettled` in `stop()` tolerates that. The derived `void rejection.finally(...)` promise has no handler, though, so it surfaces as an unhandled rejection, which terminates Node ≥15 by default.
  - In the Cycle 1 serial loop, the same throw was absorbed by the monitor's `.catch(() => undefined)`.
  - Fix: append `.catch(() => undefined)` to the `finally` chain, or guard the journal call.
- **[docs/tech.md:491-493] A Markdown list continuation swallows the next paragraph.**
  - The `event.monitor.unconfirmed` bullet is followed directly, with no blank line, by "Re-verify the legacy-delete/Core-V2 compatibility bridge and the `wait`/`active` contracts whenever OpenCode is upgraded."
  - Lazy continuation makes that upgrade guidance render as part of the unconfirmed bullet. Add a blank line before it.
- **[tests/integration/live-probe.test.ts:1559] The full-PASS test's comment overstates its order assertion slightly.**
  - The comment says the monitor is "subscribed, and confirmed connected, before any session". Only the subscribe order is asserted directly.
  - Confirmation is implied by the absence of `unconfirmed` together with `run()` awaiting the start, which is acceptable. An explicit `progress`-free marker is not needed, but the comment could say so.

### Verification Evidence
- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: 5 files, 139 of 139 passed (5.1 s).
- `git diff --check`: clean.
- Not run, as instructed: `verify:live` and `verify:environment`. My attempt to run mutation checks in a scratch copy was denied by the permission system, so every mutation reasoning below is static.

**Cycle 1 findings resolved**
- **Warning: resolved.**
  - `waitForPermissionAsked` returns `observed | timeout | monitor-ended`.
  - `#exercisePermission` (848-868) journals `permission.not-observed.${observation}` and returns `undefined` with no reply.
  - The marker is asserted:
    - in the `none`, `otherSession` and `mismatchedId` scenarios (`.timeout`, 1623);
    - in the early-end test (`.monitor-ended`, 1591);
    - in the during-wait test (1637).
  - Its absence is asserted in the full-PASS test (1557).
  - `docs/tech.md:450` lists both markers. Lines 483-493 replace the stale race guidance with journal-based guidance. No "accepted subscription race" text remains in the operational guidance; the historical 2026-10-03 run section correctly keeps it as the classification of that run.
- **Suggestion (connection confirmation): resolved.** `#startEventMonitor` races `connected.then(() => !ended)` against a 10 s timer before returning, and `run()` awaits it before `createSession`.
- **Suggestion (fake buffering): resolved.**
  - `eventChannel.push` drops events while `connected` is false. `connected` becomes true only when the generator body first runs, which is on the first `next()`.
  - The full-PASS test asserts `subscribe:monitor` comes before `create:session-1` (1560-1561).
  - The `beforeCreate` scenario and the correlation test push events synchronously inside `permission.create`. With a dropping fake, only a monitor already reading can observe them, so a lazily started monitor loop would now fail those tests. With the old buffering fake it would not have.
- **Suggestion (serial rejection): resolved.** Rejections are fire-and-track in `pendingRejections`, and `stop()` awaits `Promise.allSettled`.
- **Suggestion (monitor ends during a wait): resolved.**
  - The test at 1627-1640 ends the channel 20 ms after `create`, under the default 120 s bound, and asserts it finishes in under 3 s.
  - The waiter is registered within microtasks after `create` resolves, before the 20 ms macrotask, so the `wake`-in-`.finally` path is the one exercised, not the `if (ended)` fast path.
- **Suggestion (duplicate correlation): resolved.** There is one `correlatePermissionEvidence` call, and `created.id` is used directly.
- **Suggestion (stale names): resolved.**
  - `monitorStreamEndsEarly` is in use.
  - The `settlePairedOperations` labels are generic ("event observation"/"request").
  - No `guardStream`, "permission event observation" or "permission stream" remains.

**Connection confirmation**
- **Stream ends before `server.connected`.** `.finally` sets `ended = true` and then calls `confirmConnected()`, so the race resolves `false`: `event.monitor.unconfirmed` plus `event.monitor.ended` (not aborted). This is correct.
- **`server.connected` arrives, then an immediate end.** The `.then` callback was queued first, so the result is "confirmed" and the end is still journaled. This is benign.
- **Timers.** `clearTimeout(connectTimer)` runs after every race outcome. In `waitForPermissionAsked`, `finish` clears its timer and removes its waiter on every path.
- **`Promise.race` leak.** None that matters.
  - After `clearTimeout`, the losing timeout promise stays pending with no references and is collected.
  - `connected` always settles, because `.finally` runs once the monitor ends, and `stop()` guarantees that.
  - Neither race arm can reject, so `#startEventMonitor` cannot throw after the subscription exists.
- **Deadline.** The wait happens inside `activeDriver.run()`, which is raced against the whole-run deadline in `runLiveProbe`. It is bounded at 10 s against a 600 s budget, it does not fail fast, and on timeout it journals and continues.
- **Continuing when unconfirmed is sound.**
  - If the connection completes later, recording still works.
  - If it never does, the permission wait FAILs with `.timeout` and no reply.
  - No path produces a false PASS.
- **SDK.** `sseMaxRetryAttempts: 0` (adapter:211) means a connection failure ends the stream rather than looping with backoff, so the "ended" path, not the timer, handles a refused connection.

**Concurrent rejections**
- The `rejection` promise cannot reject except through the journal-throw edge case in Suggestion 2.
- `pendingRejections` holds only in-flight calls. Each self-removes on settle and is bounded by the adapter's `#operationTimeoutMs`, so growth is bounded by the number of questions concurrently in flight. Questions block the model's turn, so that is in practice at most a few per session.
- `stop()` aborts the stream, which cancels the reader through the SDK's abort handler or rejects the pending fetch, then awaits rejections. Its worst case is one operation bound (120 s), the same as the Cycle 1 serial loop. It is not a regression, and it is covered by the run deadline.
- Not awaiting in the loop is correct, because recording permissions is now independent of reject latency.

**Strictness (unchanged)**
- `effect: "ask"` is checked by `correlatePermissionEvidence` before the wait. Anything else throws, journals `permission.failed.error`, and sends no reply.
- Only `permission.v2.asked` is recorded. The legacy `permission.asked` is filtered at 783 and is published in the correlation test, which still sees exactly one reply.
- The key is exactly `sessionID\0requestID`, and only for `#sessionIDs`.
- `once` is sent only after `observed`. The reply order is asserted at 1611, and its absence in every negative scenario.

**Journal**
- All new markers are fixed literals or come from the closed `PermissionObservation` union: `event.monitor.unconfirmed`, `event.monitor.ended`, `permission.not-observed.timeout` and `permission.not-observed.monitor-ended`.
- None contains error text or IDs, so they are credential-safe.
- All are documented (docs/tech.md:144, 450, 454, 487-492).

### Variant Hunting
- **Other non-durable consumers that subscribe late.** The cancellation stage still opens its own global subscription after `prompt`. It relies only on durable `session.next.tool.*` events plus the fixture PID file. This is unchanged and was accepted earlier, and the correlation test asserts exactly two subscriptions.
- **Other stages completing without a marker.** None remain:
  - initial prompt: `not-completed`;
  - permission: `not-observed.*`;
  - cancellation: `not-passed`;
  - isolation: `skipped`.
- **Other promise chains with unguarded journal calls in handlers.** Only the rejection `.catch` (Suggestion 2). The monitor's `.finally` journal call is awaited through `monitor` in `stop()`, so a throw there surfaces as a run error, not an unhandled rejection.
- **Other bounds that are implemented but untested.** Only the connect timer (Suggestion 1). The permission wait timeout is covered by the 300 ms negative scenarios.
- **Regressions.** None found.
  - Stage isolation, `#stage` classification and settling after every stage are unchanged.
  - `stop()` still runs in `run()`'s `finally` before cleanup.
  - The cancellation stage's own subscription is unchanged.
  - No predicate can be satisfied by the new code paths: `permissionRequestID` is set only on `observed` plus a successful reply.

### Remaining Risks
- A hung `question.reject` can lengthen `stop()` by up to one operation bound, because it is not aborted on stop. This is bounded, pre-existing, and covered by the run deadline.
- If `server.connected` ever stops being the first frame (after an OpenCode upgrade), each run adds 10 s and journals `unconfirmed`. It still functions.
- The whole-run deadline can still be exceeded by summed per-operation bounds (pre-existing and documented). It now has an extra 10 s worst case.
- The permission round-trip through the monitor has not yet been exercised against the real server. That is Group 4 QA's job, and `verify:live` was not run.

### Tests
- [x] All tests passing (139/139; typecheck clean; `git diff --check` clean)
- [x] Test coverage adequate for changes. The new behavior and every Fix Group 1 Accept item are covered deterministically, including the dropping fake, subscription before the first session, the end during a wait, and the not-observed and unconfirmed markers. The only gap is the connect-timer path (Suggestion 1).

### Verdict: PASS
