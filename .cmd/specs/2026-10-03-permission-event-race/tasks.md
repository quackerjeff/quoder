# Tasks: Permission Event Race

Spec: `.cmd/specs/2026-10-03-permission-event-race/spec.md`

## Group 1: Implement run-long permission-event observation

- [x] Observe `permission.v2.asked` through the run-long monitor | `src/live-probe.ts`, `tests/`, `docs/tech.md`
  - **Accept**: Implements the spec's Decision and Tests sections, and updates `docs/tech.md`. `npm run typecheck` and `npm test` pass, and `npm run verify:environment` still passes.
  - **Verify**: `npm run typecheck`, `npm test -- --reporter=dot`, `npm run verify:environment`, and `git diff --check`, run separately.
  - **Constraints**: No `verify:live`.
  - **Completed evidence**:
    - **Event monitor**: `#startQuestionGuard` became `#startEventMonitor`. Its single run-long global subscription rejects questions for the probe's own sessions, as before, and now records `permission.v2.asked` keyed by session ID and request ID, for its own sessions only.
    - **Waiting**: `waitForPermissionAsked` resolves `true` if the event is already recorded or arrives later. It resolves `false` at its bound (the driver operation timeout) or when the monitor ends.
    - **Permission stage**: `#exercisePermission` creates the request, checks `effect: "ask"`, waits on the monitor for exactly that session and request ID, then replies `once`. The per-stage subscription and `#findPermissionEvent` were removed.
    - **Journal**: the marker was renamed to `event.monitor.ended`.
    - **Tests**: a run-long `eventChannel` fake replaced the old guard helper. The permission correlation test now publishes the legacy and Core V2 asked events *before* `create` returns (the observed race) and asserts only two subscriptions. New scenarios cover the event before or after `create` (PASS with a `once` reply); no event, another session's event, or a mismatched ID (Permission FAIL within the bound, no reply); and an early monitor end (journaled, Permission FAIL, no reply).
    - **Mutation checks**: not recording, not scoping to the session, ignoring the request ID, and an unbounded wait each failed the tests.
    - **Results**: 138/138 tests passed in 3 runs. `npm run typecheck` passed. The real `npm run verify:environment` passed. `git diff --check` passed. `docs/tech.md` was updated.
    - **Cleanup**: 18 temp directories left by intentionally timed-out mutation runs were inspected and removed.

## Group 2: General review gate

- [x] Fresh review | `.cmd/specs/2026-10-03-permission-event-race/review.md`
  - **Accept**: PASS with zero critical findings and zero warnings, persisted verbatim. Maximum 3 cycles.

  - **Failed cycle 1**: Zero critical findings and one warning: an unobserved permission journals `permission.complete` with no marker, and `docs/tech.md` still points at the removed race. Six suggestions. See `review.md`.

## Fix Group 1: Address review Cycle 1

- [x] Journal unobserved permissions, confirm monitor connection, and close the test gaps | `src/live-probe.ts`, `tests/`, `docs/tech.md`
  - **Accept**:
    - An unobserved permission journals `permission.not-observed.timeout` or `permission.not-observed.monitor-ended`. This is asserted in every negative scenario and its absence in the full-PASS scenario.
    - The monitor waits, within a bound, for the server's first `server.connected` frame before returning. Otherwise it journals `event.monitor.unconfirmed` and continues.
    - The fake channel drops events pushed before its first read, and a test asserts the monitor subscribes before the first session is created.
    - Question rejection no longer blocks permission recording; in-flight rejections are awaited on stop.
    - A test ends the monitor during a permission wait and shows a prompt FAIL.
    - The duplicate correlation call is removed.
    - Stale test names are renamed.
    - `docs/tech.md` guidance is corrected.
  - **Verify**: `npm run typecheck`, `npm test -- --reporter=dot`, `npm run verify:environment`, and `git diff --check`, run separately.
  - **Constraints**: No `verify:live`. Then fresh Review Cycle 2.
  - **Completed evidence**:
    - **Readiness check**: a live check against the pinned server (no model call) confirmed that `server.connected` is the first frame of every v2 global subscription, within 1–7 ms.
    - **Monitor connection**: the monitor now waits up to `EVENT_MONITOR_CONNECT_TIMEOUT_MS` (10 s) for that frame before returning; if it does not arrive, it journals `event.monitor.unconfirmed` and continues. The connection wait also resolves if the monitor ends.
    - **Not-observed marker**: `waitForPermissionAsked` returns `observed`, `timeout`, or `monitor-ended`. The permission stage journals `permission.not-observed.timeout` or `permission.not-observed.monitor-ended` and sends no reply. The duplicate correlation call is gone.
    - **Question rejections**: they run concurrently, so they cannot delay permission recording; stop awaits any in flight.
    - **Docs**: `docs/tech.md` covers the connection confirmation, the new markers, and journal-based guidance for a Permission FAIL, replacing the stale race guidance.
    - **Test fake**: the channel now models the SDK and server: not connected until the first read (earlier events are lost), then `server.connected` first, plus `end()`.
    - **Tests**:
      - negative scenarios assert `permission.not-observed.timeout`;
      - the early-end scenario asserts `event.monitor.unconfirmed`, `event.monitor.ended`, and `permission.not-observed.monitor-ended`;
      - a new scenario ends the monitor during the wait at the default 120 s bound and finishes in under 3 s;
      - the full-PASS scenario asserts no failure, not-passed, not-observed, not-completed, or unconfirmed markers, and that `subscribe:monitor` comes before `create:session-1`.
    - **Renames**: stale labels were renamed (`monitorStreamEndsEarly`, generic `settlePairedOperations` labels).
    - **Mutation checks**: not journaling an unconfirmed connection, not waking waiters on monitor end, and omitting the not-observed marker each failed the tests.
    - **Results**: 139/139 tests passed in 3 runs. `npm run typecheck` passed. The real `npm run verify:environment` passed. `git diff --check` passed.

  - **Passed cycle 2**: PASS with zero critical findings and zero warnings. Of the four suggestions, the docs blank line was fixed (docs only). Carried forward: a connect-timeout-path test, guarding the rejection `.finally` chain against a throwing journal write, and a test-comment wording. See `review.md`.

## Group 3: Security review gate

- [x] Fresh security review | `.cmd/specs/2026-10-03-permission-event-race/security-review.md`
  - **Accept**: PASS with zero critical findings and zero warnings, persisted verbatim.

  - **Passed cycle 1**: PASS with zero critical findings, zero warnings, and no suggestions. See `security-review.md`.

## Group 4: QA

- [x] Independent QA | `.cmd/specs/2026-10-03-permission-event-race/qa.md`
  - **Accept**: Automated suite and real preflight validated, plus a bounded scratch check of the permission round-trip through the implemented monitor. Exactly one `Authoritative Run: GO|NO-GO`.

## Group 5: Documentation and closure

- [x] Document and close | `README.md`, `docs/tech.md`, `.cmd/specs/2026-10-03-permission-event-race/decisions.md`
  - **Completed evidence**: `README.md` and `docs/tech.md` record the fix, QA's 27/27 vs 0/27 comparison, and the GO recommendation. `decisions.md` records the final state and what carries forward. One leftover test temp directory from earlier mutation runs was inspected and removed.
