# QA Report: Permission Event Race

## Cycle 1 — 2026-10-03
Validating: Groups 1–3 and Fix Group 1

### Coverage
- **Automated**:
  - `npm run typecheck`.
  - `npm test -- --reporter=dot`, 3 runs.
  - `git diff --check` and `git diff --cached --check`.
  - A review of the permission-stage scenarios in `tests/integration/live-probe.test.ts` against the spec's Tests section and the Fix Group 1 Accept criteria.
- **Manual (real environment)**:
  - The real `npm run verify:environment`, run twice, with checks for residual processes and directories.
  - A bounded scratch race-mechanism check against one authenticated disposable `opencode serve` (pinned 1.18.33). It ran twice: N=12, then N=15. It compared:
    - **pattern A**, the new design: one pre-connected global subscription;
    - **pattern B**, the old design: a new subscription that is first read after `create`.
  - The check made no model calls, approved nothing (every request was answered `reject`), and cleaned up everything it created.
- **Not covered**:
  - The driver's own private `#startEventMonitor`/`#exercisePermission` against a real server. That would require constructing `OpenCodeLiveDriver` against a real server, which is equivalent to `verify:live` and was not authorized. Pattern A reproduces the same SDK call (`client.v2.event.subscribe`, `sseMaxRetryAttempts: 0`), the same `server.connected` confirmation and the same session/ID matching, but not the adapter's timed-generator wrapper or the driver's lifecycle.
  - `npm run verify:live` (not run, by instruction).
  - Model behavior in any stage.

### Environment
| Item | Value |
| --- | --- |
| OS | macOS 26.7 (25G229), Darwin 25.6.0 |
| Node | v24.18.1 |
| npm | 12.0.2 |
| `npm ls --depth=0 @opencode-ai/sdk opencode-ai` | `@opencode-ai/sdk@1.18.33`, `opencode-ai@1.18.33` (exit 0) |
| `curl … https://llm.quackerjack.com/v1/models` (no credentials) | `200` (exit 0) |
| Baseline before validation | no `opencode serve` process; 0 `$TMPDIR/quoder-live-probe-*` |

No OpenCode configuration, credential or environment variable was read or printed.

### Results

**Automated checks**

| Check | Result | Exit | Time |
| --- | --- | --- | --- |
| `npm run typecheck` | passed | 0 | <1 s |
| `npm test -- --reporter=dot` run 1 | 5 files, 139/139 passed | 0 | 5.03 s |
| `npm test -- --reporter=dot` run 2 | 5 files, 139/139 passed | 0 | 5.18 s |
| `npm test -- --reporter=dot` run 3 | 5 files, 139/139 passed | 0 | 5.19 s |
| `git diff --check` | clean | 0 | — |
| `git diff --cached --check` | clean | 0 | — |

**Real preflight (`npm run verify:environment`)**

| Run | Rows | Verdict | Exit | Elapsed | Residual `opencode serve` | Residual `quoder-live-probe-*` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Pinned dependencies, Provider configuration, Endpoint reachability, Model discovery, Direct inference, OpenCode model discovery, OpenCode inference, Cleanup: all PASS | `Environment Readiness: PASS` | 0 | 10 s (includes `build:live`) | none (`pgrep` exit 1) | 0 |
| 2 | same 8 rows, all PASS | `Environment Readiness: PASS` | 0 | 4 s | none (`pgrep` exit 1) | 0 |

**Live race-mechanism check (no model calls)**

`npm run build:live` exited 0. The scratch script ran under `perl -e 'alarm 300'`, from outside the repository, and did the following:

- It created one disposable environment.
- It launched one authenticated server (startup took 445–460 ms).
- It created one Core V2 session.
- For each iteration, it called `client.v2.session.permission.create({ action: "external_directory", resources: [outside], save: [], agent: "build" })` and waited up to 5 s for `permission.v2.asked` with the same session and request ID.
- It replied `reject` to every request.

| | Pattern A (pre-connected, new design) | Pattern B (late first read, old design) |
| --- | --- | --- |
| Run 1 (N=12): observed | **12/12** | **0/12** (12 missed) |
| Run 2 (N=15): observed | **15/15** | **0/15** (15 missed) |
| Combined | **27/27** | **0/27** |
| `server.connected` | first frame, 4.8 ms / 6.5 ms after first read | first frame on every late stream |
| `create` latency | median 2.5 ms; min 1.5 ms; max 615 / 670 ms (first request only, cold) | median 4.4–4.8 ms; min 1.9 ms; max 10.4 ms |
| Event latency from `create` dispatch | median 2.5–2.6 ms; max 615 / 670 ms (first request) | never observed |
| Event relative to the `create` response | ~0.1 ms after `create` returned (0/27 strictly before) | late reader's `server.connected` came 1.2–8.4 ms (median ~2 ms) **after** `create` returned, already after the event |
| `effect` | `ask` (all) | `ask` (all) |
| `reject` reply status | 204 (all) | 204 (all) |
| Script exit / elapsed | 0 / 61 s; 0 / 76 s (dominated by pattern B's 5 s misses) | — |

- **Cleanup, both runs**:
  - The session was deleted and verified 404.
  - The server was closed.
  - The environment was removed.
  - Afterwards: `pgrep -fl "opencode serve"` exit 1, and 0 `quoder-live-probe-*`.
- **Earlier aborted attempt**: a first attempt failed at the first `create` because of a scratch-script bug: it read `r.data.id` instead of the SDK's wrapped `r.data.data.id`. Cleanup still ran fully (session deleted and 404, server closed, environment removed, no residue). It is excluded from the counts.
- **Interpretation**:
  - Against a warm server, the old per-stage pattern misses `permission.v2.asked` **systematically (0/27)**. The event is published within ~0.1 ms of `create`'s response, and a lazily connecting reader registers 1–8 ms later. This reproduces the authoritative-run failure deterministically.
  - The pre-connected pattern used by the new run-long monitor observed **every** event (27/27).
  - Every event arrived just after `create` returned. Both orderings are covered by the automated scenarios.

**Automated evidence review (`tests/integration/live-probe.test.ts`)**

| Required coverage | Test | Verified |
| --- | --- | --- |
| Event published before `create` returns | `it.each(["beforeCreate", …])` "observes the permission request published %s…" (publishes inside the `create` mock), and the correlation test "observes and replies only to the correlated Core V2 permission event" | yes: `once` reply to `permission-1`, reply after emit |
| Event published after `create` returns | same `it.each`, `afterCreate` (published 20 ms later via `setTimeout`) | yes |
| None / other session / mismatched ID → FAIL, no reply, `permission.not-observed.timeout` | `it.each(["none", "otherSession", "mismatchedId"])` with a 300 ms bound | yes: `permissionRequestID` undefined, reply not called, marker present |
| Monitor ends early | "journals an event monitor that ends early…" | yes: `event.monitor.unconfirmed`, `event.monitor.ended`, `permission.not-observed.monitor-ended`, no reply |
| Monitor ends during the wait | "fails permission promptly when the monitor ends during the wait" (default 120 s bound, asserts < 3 s) | yes |
| Subscription before the first session | full-PASS test asserts `subscribe:monitor` is before `create:session-1` | yes; the `eventChannel` fake drops events pushed before its first read, so a lazily started monitor would fail |
| Full nine-row PASS path | "reports all nine predicates PASS when every stage produces its evidence" | yes: verdict PASS, no `.failed`, `not-passed`, `not-observed`, `not-completed` or `unconfirmed` markers, and no `event.monitor.ended` |

**Gates**

| Gate | Result |
| --- | --- |
| Review | Cycle 2: PASS (0 critical, 0 warnings) |
| Security review | Cycle 1: PASS (0 critical, 0 warnings, 0 suggestions) |

### Critical
None.

### Warning
None.

### Suggestion
- **[validation scope]** The driver's own monitor has not yet been exercised against a real server. Pattern A matches its mechanism, but the first authorized `verify:live` will be the first real end-to-end exercise. If Permission fails there, read the journal markers documented in `docs/tech.md` ("Remaining Live Verification Items").
- **[tests, carried forward from review Cycle 2]**
  - Add a test for the connect-timeout path: a stream that stays open but never sends `server.connected`.
  - Guard the `rejection.finally` chain against a throwing journal write, which could cause an unhandled rejection.
  - Correct the full-PASS test comment wording.
- **[test hygiene, observation]** A stale `$TMPDIR/quoder-cancellation-driver-test-EqfuOU` directory, timestamped 07:02, predates this QA's test runs (07:10 onward). It was probably left by an interrupted test or mutation run in an earlier step. The tests remove their root in `finally`, and none of this cycle's 3 test runs left a new one. QA left the directory in place.

### Residual Gaps
- **Model nondeterminism**:
  - The authoritative run still depends on `ollama/qwen3-coder:30b` cooperating in the initial, cancellation and isolation stages.
  - QA in the prior spec estimated the chance that all three cooperate in one run at about **0.7**.
  - The permission stage itself makes no model call. This fix does not change those odds.
- **Run deadline**: summed per-operation 120 s bounds can still exceed the 600 s whole-run deadline in a run with several stalled stages. The run then fails all nine predicates conservatively, and per-predicate evidence is lost. The monitor's connect wait adds up to 10 s in the worst case. This is pre-existing and documented.
- **Active-session deletion**: this cycle verified only deletion of an idle session (delete, then 404). Deleting a session that is still active during cleanup was not exercised here and remains unverified live.
- **Carried-forward review suggestions**: the connect-timeout test, the rejection `.finally` guard and the test comment wording (see Suggestion). None can produce a false PASS.
- **Upstream availability**: the endpoint returned 200 at QA time, but transient 502s were seen before. Run `npm run verify:environment` immediately before the authoritative run.

### Release Confidence
- CONDITIONAL. The race fix is validated, and the probe is ready for an authorized authoritative run. A full pass remains conditional on model cooperation, at about 0.7 per run.

Authoritative Run: GO

**Milestone statement:** this GO is a recommendation only. It does not pass Milestone 0, it does not authorize Milestone 1, and it does not authorize `npm run verify:live`, which still requires the user's explicit authorization. Milestone 0 passes only when all nine predicates pass together in one authorized `verify:live` run.

### Verdict: PASS
