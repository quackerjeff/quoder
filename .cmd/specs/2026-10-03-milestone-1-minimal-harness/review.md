# Review: Milestone 1 — Minimal Harness

## Cycle 1 — 2026-10-03
Reviewing: Groups 1–3

### Critical

- **[src/harness/repl.ts:133-143, 145-167, 196-205, 279-281] In piped (non-terminal) mode, a queued blank line, `/help`, unknown command or `/exit` crashes or permanently hangs the harness.**
  - **Cause.** When a prompt is running in non-terminal mode, `#onLine` queues later lines. After the prompt, `#runPrompt` hands the next queued line to `void this.#handle(next)` and returns. For anything other than a prompt, `#handle` then only calls `#promptAgain()`. It never takes the next queued line and never checks `#inputClosed`. If stdin has reached EOF, readline is already closed, so `readline.prompt()` throws `ERR_USE_AFTER_CLOSE`. The throw happens inside a `void`ed async function, so it becomes an unhandled rejection.
  - **Reproduction.** A scratch script outside the repository drove the built `dist/harness/repl.js` with fakes (no server, no network):

    | Piped input | Result |
    | --- | --- |
    | `"a\nb\n"` | exit 0 (correct) |
    | `"a\n\nb\n"` | unhandled `ERR_USE_AFTER_CLOSE`; `b` never runs; `run()` never resolves |
    | `"a\n/help\nb\n"` | same as the line above |
    | `"a\n/exit\n"` | no exception, but `run()` never resolves: `/exit` sets `#inputClosed` and calls `close()` on an already-closed readline, so no `close` event fires and `#shutdown` is never called |
    | `"a\n\nb\n"` with stdin left open | `b` stays stuck in the queue until another line arrives, and is then processed out of order |
  - **Impact.** In the real CLI, Node's default unhandled-rejection policy ends the process with code 1 without calling `#shutdown`. The OpenCode child process is not detached, but nothing kills it, so a residual server is likely. In the `/exit` case, the CLI and its server stay up indefinitely. This breaks the spec constraint that "a failure inside the harness never leaves a server process … silently behind", in exactly the piped mode that automation and `verify:harness` use.
  - **Related.** A line that arrives after `terminate()` (SIGTERM), while the cancelled prompt is still cleaning up, is queued after the queue was cleared, and is then executed before shutdown.
  - **Fix.**
    - Make queue draining a loop that runs after every handled line, whatever its kind. Stop when shutting down.
    - At the end of the drain, call `#shutdown` if `#inputClosed`.
    - Make `/exit` call `#shutdown` directly when readline is already closed.
    - Guard `#promptAgain` against a closed readline.
    - Have `terminate()` close readline, or refuse new lines, so nothing is queued after SIGTERM.
    - Attach `.catch` to the `void`ed `#handle` and `#start` calls so an internal error turns into a shutdown, not a crash.
  - **Tests to add.** Queued blank line, queued `/help`, queued unknown command, and queued `/exit`, each followed by EOF.

- **[src/harness/repl.ts:98-131; src/cli.ts:89-91, 106-107] A signal during the initial server start leaks the server or is ignored.**
  - **SIGTERM or SIGHUP.** If one arrives while `#start` is still waiting on `#ensureServer()`, `terminate()` sees `#running === undefined` and calls `#shutdown(0)`. At that point `#server` is still `undefined`, so nothing is closed, and `#finish(0)` resolves `run()`. `main()` then calls `process.exit(0)`, while the server that `launchServer` returns moments later is never closed. Even without the exit, `#start` would go on to create readline and show a prompt after shutdown.
  - **Reproduction.** A scratch script with a 200 ms fake launch confirmed it: `terminate during startup -> exit 0 | launched 1 closed 0`.
  - **SIGINT.** Ctrl-C in the same window is a no-op: `interrupt()` closes a readline that does not exist yet. Because `cli.ts` replaced Node's default SIGINT behaviour, the developer cannot leave for up to the 15 s startup bound plus the 10 s monitor-connect bound.
  - **Fix.**
    - In `terminate()` and `interrupt()`, if `#startingServer` is pending, mark shutdown as requested.
    - In `#shutdown`, await `#startingServer` (ignoring rejection) and close whatever it produced.
    - In `#start`, check `#shuttingDown` after `#ensureServer()` returns, before creating readline.
    - Optionally pass an `AbortSignal` to `launchAuthenticatedOpenCodeServer`, whose launcher already supports it.
  - **Tests to add.** SIGTERM during startup and Ctrl-C during startup.

### Warning

- **[src/harness/session-runner.ts:152-160] A failed turn deletes a session that may still be running.**
  - **Cause.** `settleCancelled` (interrupt, then `waitUntilIdle`) runs only when `cancel.aborted`. When `runTurn` throws for any other reason, the runner goes straight to `deleteSession`. Examples: a transient `isActive` or `messages` error, a 30 s poll timeout, or `prompt()` timing out after the server already admitted the input. The model may still be running and calling tools.
  - **Impact.** Deleting an active session is not a verified contract (`docs/tech.md` verifies deletion only of settled sessions). The harness then reports the turn as failed and accepts the next prompt while the earlier run may still be editing the repository.
  - **Fix.** Interrupt and settle (bounded) whenever a session exists and the turn did not end in an observed idle state, not only on cancel.
  - **Tests to add.** A poll error mid-turn, and a `prompt()` failure after creation, each followed by the interrupt-then-delete order.

- **[src/harness/repl.ts:225-238; src/event-monitor.ts:136] The monitor is not confirmed connected, and its loss is never detected, so a turn can wait silently with no limit.**
  - **Spec.** "It is confirmed connected (`server.connected`)."
  - **Unconfirmed connection.** `startEventMonitor` returns even when unconfirmed, emitting only the `event.monitor.unconfirmed` marker. The harness passes no `onProgress`, so it proceeds with a monitor that may be dead.
  - **Monitor ended.** If the subscription ends while the server lives (an SSE drop, or the 24 h bound), the harness never learns of it and does not restart the monitor.
  - **Reply failure.** If `replyPermission(..., "reject")` fails, the only effect is a `permission.rejected replied:false` trace entry.
  - **Impact.** In each of these cases the session blocks on an unanswered permission or question. Because there is deliberately no execution timeout, the developer sees an indefinite wait with no explanation, until Ctrl-C, and the outcome is then reported as "cancelled". That contradicts "every `permission.v2.asked` … is rejected and reported".
  - **Fix.**
    - Treat `event.monitor.unconfirmed` as a launch failure.
    - On `event.monitor.ended` (when not stopping), restart the monitor, or mark the server unhealthy and relaunch it.
    - Tell the developer immediately when a reject reply fails.

- **[src/harness/session-runner.ts:199-205] A rejected permission is not reported when the turn still produces an answer.**
  - **Cause.** `classifyEndedTurn` returns `answered` before looking at the tracker. If the model recovers after a rejection and replies, the developer sees only the reply.
  - **Spec.** The constraints say every Quoder-session `permission.v2.asked` "is **rejected and reported to the developer**".
  - **Fix.** Carry the rejected permissions and questions alongside every outcome, and print them, for example "Note: OpenCode asked for … and Quoder rejected it", before the answer.

- **[src/opencode-server.ts:132-139; src/harness/repl.ts:216-218] The server's working directory is not the project root.**
  - **Spec.** Design, "Command and launch": "The server's working directory and every session's location are the project root."
  - **Code.** `spawn` passes no `cwd`, so the server inherits `process.cwd()`. When `quoder` starts in a subdirectory, that is the subdirectory, not the Git root. Group 1 verified a launch whose working directory was the disposable repository; the probe shows that a different working directory works for sessions with an explicit location.
  - **Status.** The deviation is not recorded in `decisions.md`.
  - **Fix.** Either pass the project root as the spawn working directory (an optional `cwd` on `AuthenticatedServerOptions` keeps the probe unchanged), or document why the launch directory is acceptable.

- **[tests/integration/harness.test.ts] Important lifecycle paths have no tests.**
  - **Server loss mid-prompt.** The spec's Verification lists server loss on the deletion path, but the existing test loses the server only *between* prompts. Server loss *during* a prompt is untested: the runner continues on a dead adapter, deletion fails, and a warning must appear.
  - **Ctrl-C during `createSession` or `prompt`.** Abort before or during these calls is untested.
  - **Signals during startup** (see the second Critical finding).
  - **Queued commands and blank lines in piped mode** (see the first Critical finding).
  - **Permission plus answer.** A turn with both a rejected permission and a final answer is untested.

  The existing tests pass but did not catch either Critical defect.

### Suggestion

- **[src/harness/session-runner.ts:145]** Check `options.cancel.aborted` before `createSession`. Ctrl-C while `#ensureServer` is relaunching currently creates a session only to interrupt and delete it.
- **[src/harness/repl.ts:250-257, src/harness/session-runner.ts:158-165]** After server loss mid-prompt, the session persists in OpenCode storage with deletion unverified. It is reported, not silent, so the behaviour complies. Remembering such session IDs and retrying deletion on the next server would close FR-15 more fully.
- **[src/event-monitor.ts:104-110]** `onQuestionRejected` fires only after the reject request resolves, and the harness ignores the `rejected` flag.
  - The question is recorded on a separate HTTP response from the idle poll, so a narrow ordering race could classify the turn as a generic failure.
  - A failed rejection is still recorded as "question-rejected".
  - Consider recording the question when it is asked, and recording the reject result separately.
- **[src/package-root.ts:34]** `node_modules/.bin/opencode` under Quoder's root is correct for a repository checkout and for `npm link`, where ESM resolves the symlink to the real path. It would break if Quoder were installed so that `opencode-ai` is hoisted. `createRequire(import.meta.url).resolve("opencode-ai/package.json")` plus the bin entry would be more robust. Not needed for the documented install path.
- **[scripts/verify-harness.ts]**
  - **Residual server on timeout.** After the 300 s timeout, a SIGKILL of the CLI can orphan its OpenCode server. The script detects that, but never removes it. Consider recording the server PIDs that appear during the run, and terminating them during cleanup.
  - **Process count scope.** `ps` counting matches any `opencode serve --pure --hostname=127.0.0.1 --port=0`, so a concurrent probe or preflight distorts the before/after comparison.
  - **No `error` listener on the spawned child.** If `dist/cli.js` is missing, the error crashes the script instead of producing a NOT MET row.
- **[src/cli.ts]** SIGTERM and SIGHUP exit with code 0. A conventional `128+signal` code, or 1 if cleanup failed, would make external supervision clearer. The process-level signal handlers are never removed, which is harmless because `process.exit` follows `run()`.

### Verification Evidence

- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: 13 files, 193/193 passed.
- `npm run build`: passed. `dist/cli.js` has the `#!/usr/bin/env node` shebang and is executable.
- `git diff --check`: clean.
- Scratch reproductions (outside the repository, against the built `dist/` modules with fake clients; no server, no network, no repository writes):
  - **Queue defect:** `ERR_USE_AFTER_CLOSE` unhandled rejection, then a hang; `/exit` queued hangs; a queued blank line stalls the queue when stdin stays open.
  - **Startup defect:** SIGTERM during startup gives `exit 0, launched 1, closed 0`; Ctrl-C during startup is ignored.
- **Probe and preflight behaviour preserved.**
  - The shared monitor emits the same journal markers as before: `question.rejected`, `question.reject.failed`, `event.monitor.ended` and `event.monitor.unconfirmed`.
  - The probe's `isOwnSession` keeps the same `#sessionIDs.includes` check.
  - The launcher was moved verbatim, plus `exited` and the package-relative executable.
  - The preflight's manifest and binary paths come from `packagePath`. `findPackageRoot` is correct from `src/` (vitest), `dist/` and `.live-build/src/`, and walks up to the nearest package named `quoder`. A different `quoder` package higher in the tree cannot be chosen first, because Quoder's own manifest is always the nearer ancestor.
- **Classification behaves correctly in these cases:**
  - Permission notes are recorded synchronously on the event that triggers the rejection, so they precede idle.
  - The tracker is per session (it resets on `register` and is removed on `unregister`), so no notes go stale across turns.
  - Every adapter call is bounded at 30 s, and deletion at 60 s, so cancel and cleanup are finite even when the server hangs.
- **Constraints met:**
  - No dependency changes; only package metadata, scripts and bin.
  - `--pure` is kept.
  - Permissions are only ever replied `reject`.
  - No Git writes.
  - Model text is sanitized before display.
  - The trace writer is wrapped in try/catch.

### Variant Hunting

- **`void` async calls without `.catch` (variants of the first Critical finding).** `void this.#start()` (repl.ts:79), `void this.#handle(...)` (142, 198), `void this.#shutdown(...)` (103, 128) and `void server.monitor.stop()` (253). Any throw inside them becomes a process-ending unhandled rejection that bypasses server cleanup.
- **Pending startups (variants of the second Critical finding).** Every path that shuts down while `#startingServer` is pending: SIGTERM, SIGHUP, and Ctrl-C/EOF in `#start`. The relaunch inside `#runPrompt` is safe, because `#running` is set and the prompt finishes before shutdown.
- **Cleanup only on cancel (variants of the first Warning).** Every non-cancel failure after a session exists: a prompt timeout, a poll error, a messages error, and server loss.

### Remaining Risks

- Interrupting in the window after a prompt is admitted but before its run is scheduled: `waitUntilIdle` without `afterInputID` returns immediately on an idle session, and deletion follows. Whether a late-starting run is fully prevented is not verified live.
- Deleting an active session is not a verified OpenCode 1.18.33 contract.
- `verify:harness` checks trace entries the harness writes itself, rather than independently querying OpenCode. This is acceptable because the 404 verification inside the adapter is proven, but it is not independent evidence. It also requires both outcomes to be `answered`, so model nondeterminism can produce NOT MET.
- The untracked `claude-handoff.md` at the repository root is outside this review and should not be committed accidentally.

### Tests
- [x] All tests passing (193/193, typecheck and build clean)
- [ ] Test coverage adequate for changes. Missing:
  - queued non-prompt lines and `/exit` in piped mode;
  - signals during startup;
  - server loss mid-prompt;
  - Ctrl-C during create or prompt;
  - poll and messages errors with settle-before-delete;
  - a permission plus an answer in one turn.

### Verdict: FAIL

# Review: Milestone 1 — Minimal Harness

## Cycle 2 — 2026-10-03
Reviewing: Groups 1–3 and Fix Group 1

### Critical

None. I reproduced both Cycle 1 Critical findings against a fresh `dist/` build, and neither occurs any more. Evidence is below.

### Warning

- **[src/harness/repl.ts:144-145, 159-164, 101-102; tests/integration/harness.test.ts:157] Interactive (TTY) mode has no automated coverage.**
  - **What is untested.** Every harness test builds the `Harness` with `terminal: false` (`startHarness`, line 157). `grep -rn "terminal: true"` over `tests/` finds nothing. Three branches therefore have no regression guard, and they are what a developer uses at a real prompt:
    - refusing a line typed while a prompt runs ("still running the previous prompt");
    - wiring readline's `SIGINT` to `interrupt()`, which is the only Ctrl-C path when stdin is a TTY in raw mode;
    - the spec's "a second Ctrl-C while cleanup is in progress is ignored, with a hint" ("Still cleaning up the cancelled prompt…").
  - **Why it matters.** The tests call `harness.interrupt()` directly, which bypasses readline. A regression in the `readline.on("SIGINT", …)` wiring or the busy guard would leave the suite green and break Ctrl-C cancellation in the main interactive mode.
  - **Behaviour today is correct.** A scratch run with `terminal: true` on a `PassThrough` confirmed it:
    - a line typed while busy was refused;
    - `\x03` during a slow prompt gave interrupt, then delete, then "Execution cancelled.";
    - `\x03` at idle exited 0 with the server closed;
    - `\x04` (Ctrl-D) exited 0.
  - **Fix.** Add two or three integration tests with `terminal: true` that do exactly this: write `"slow…\r"`, then a second line, then `"\x03"`, then `"\x03"` again. Assert the refusal text, the cancellation, the second-Ctrl-C hint, and the idle exit.

### Suggestion

- **[src/harness/format.ts:14-23; src/harness/repl.ts:284-290] The output contradicts itself when a reject reply fails.**
  - `notePermission` records the request before the reply is sent, so the notes still say "Quoder rejected it." Reproduced: the output showed "Note: OpenCode asked for permission (bash, 1 resource); Quoder rejected it." directly above "The prompt did not complete: Quoder could not reject OpenCode's permission request. The prompt was stopped."
  - The same happens for a failed question rejection ("Quoder rejected the question").
  - Nothing is ever granted, so this is only a wording problem. Consider recording the reply result, or wording the note neutrally ("…was not granted").
- **[src/harness/repl.ts:313-314, 346-350] `#retire` and the launch-failure path swallow a failed `launch.close()`.** Shutdown reports the same failure ("did not confirm termination", exit 1), but these two paths stay silent. This conflicts with the spec's "never leaves a server process … silently behind". It is practically unreachable, since it needs SIGKILL to fail to take effect within 2 s. Writing the same warning there would make the paths consistent.
- **[src/harness/repl.ts:353-367] A retried deletion of a session that is already gone is never counted as deleted.** Suppose the old server deleted the session but died before the 404 check. On the new server the legacy delete fails, the ID stays queued, and shutdown warns "could not be verified as deleted" about a session that no longer exists. This is conservative, not silent. Consider checking `v2.session.get` first and treating `SessionNotFoundError` as verified.
- **[src/harness/repl.ts:378-384] Shutdown with no live server skips both the retry and the summary warning.** For example: the server is lost mid-prompt, then EOF. The prompt's own result already warned, so nothing is silent. A closing summary of unverified sessions would still be clearer.
- **[src/harness/repl.ts:293-296, 331, 335-343] Duplicate notices, and no prompt redraw.**
  - When the server dies, the SSE drop (`onEnded`) usually fires before the child's `exit`. At idle the developer then sees two notices: "lost its connection…" and "stopped unexpectedly…".
  - Notices written at idle in TTY mode are not followed by `readline.prompt()`, so the `P > ` label is not redrawn.
  - Both are cosmetic.
- **[scripts/verify-harness.ts:56-65] `stopResidualServers` signals tracked PIDs after only an `isAlive` check.** The probe already has a validated-kill pattern (`terminateValidatedFixture` re-reads `ps -p <pid> -o command=` before killing). Reusing it would rule out signalling a reused PID. The risk is negligible on macOS within one run.
- **Carried forward from Cycle 1 (still open, acceptable).** `package-root.ts:34` assumes `node_modules/.bin/opencode` under Quoder's root. That is fine for a checkout and for `npm link`.

### Verification Evidence

- **Commands.**
  - `npm run typecheck`: passed.
  - `npm test -- --reporter=dot`: 13 files, 218/218 passed. It passed on four separate runs (once, then three more), with no flakiness.
  - `npm run build`: passed. `dist/cli.js` has the shebang and is executable.
  - `git diff --check`: clean. A trailing-whitespace grep over the untracked source and test files is clean.
  - `git status` is unchanged by this review. No `verify:live`, `verify:environment` or `verify:harness` was run, no server was started, and there was no network access.
- **Cycle 1 Critical 1 (queued lines in piped mode).** Scratch fakes drove `dist/harness/repl.js`, with an `unhandledRejection` listener attached:

  | Piped input | Result |
  | --- | --- |
  | `a\nb\n` + EOF | exit 0; 2 created, 2 deleted, `b` answered; server closed |
  | `a\n\nb\n` + EOF | same |
  | `a\n/help\nb\n` + EOF | same |
  | `a\n/nope\nb\n` + EOF | same |
  | `a\n/exit\nb\n` + EOF | exit 0; 1 created, 1 deleted, `b` never run |
  | `a\n\nb\n`, stdin left open | `b` processed in order, then waits for input (correct) |
  | empty + EOF | exit 0 |
  | `/exit` with stdin open | exit 0 |

  There were no unhandled rejections. **Resolved.**
- **Cycle 1 Critical 2 (signals during startup).** I used a 200 ms fake launch and signalled at 10 ms and at 150 ms, with launches that either honour or ignore the abort.
  - SIGTERM exits 143 and Ctrl-C exits 0 in every combination.
  - `launched == closed` (or 0/0 when aborted), no "Ready", and no session created.
  - A queued "should not run" line was never run.

  **Resolved.**
- **Every other Cycle 1 finding is resolved.**
  - **Settle before delete.** `session-runner.ts:200` settles whenever `!endedIdle`. That covers prompt failure, poll error, no-response timeout, cancel-after-create and stop requests. Tests cover each case, plus the case where no interrupt follows an idle end.
  - **Monitor confirmation and loss.** `confirmed` gates the launch (`repl.ts:298`). `onEnded`, a failed permission reply and a failed question rejection all call `#markUnhealthy`, which stops the running prompt with an explanation and replaces the server.
  - **Permission reported alongside an answer.** Fixed via `rejectedPermissions` and `rejectedQuestions` plus the format notes.
  - **Server working directory.** The `cwd` passes through `authenticatedServerProcessConfig` to `spawn`, and a test asserts it.
  - **Lifecycle tests.** The ones Cycle 1 asked for exist.
  - **Cycle 1 suggestions addressed.** Cancel before create, deletion retry, `onQuestionAsked` on arrival, exit codes 143 and 129, the `verify:harness` spawn-error listener, and PPID-scoped tracking.
- **REPL lifecycle analysis.**
  - **No lost wake-up.** `#nextLine` checks the exit code, the queue and `#inputClosed`, then installs `#wakeLoop` in the same synchronous turn, so a wake cannot fall between the check and the wait. A stale resolver called again is a harmless no-op.
  - **Shutdown runs exactly once.** `#shutdownOnce` is memoized, and every path out of `#main` (EOF, `/exit`, an exit request, a startup failure, an internal throw via `run().catch`) reaches it.
  - **No prompt after an exit request.** `#receive` drops lines once `#exitCode` is set, `#requestExit` clears the queue, `#nextLine` returns `undefined`, and the loop re-checks after each `#handle`.
  - **`#launchAbort` is scoped correctly.**
    - It is set only around the `launchServer` await and cleared in its `finally`.
    - The only gap between a launch resolving and that clear is microtasks, so no signal (a macrotask) can abort it once a server is up.
    - The launcher's leftover `closeOnAbort` listener is therefore inert.
    - A SIGTERM during a prompt settled and deleted the session before closing the server (tested, and reproduced in scratch).
  - **Races between server exit, unhealthy marking, retirement and a running prompt.**
    - `#markUnhealthy` ignores servers that are no longer current.
    - `#onServerExit` ignores retired servers, and servers already taken by shutdown.
    - The notice queue holds at most one notice per server, is drained after each result, and is suppressed when the stop reason already states it. It is drained after the prompt's result even if the prompt was already cancelled.
  - **Fuzzing.** 200 randomized interleavings of prompts, blank lines, `/help`, unknown commands, `/exit`, Ctrl-C, SIGTERM, server exit (with the server alive or dead), monitor loss and startup delays, with and without abort support, gave:
    - zero hangs, apart from intended unbounded slow prompts, which Ctrl-C ended;
    - zero leaked servers;
    - zero undeleted sessions without a warning;
    - zero unhandled rejections.
  - **Real `startEventMonitor`.** I fed it streams that end, or throw, immediately after `server.connected`. In all four orderings the loss was detected (`monitor.lost` traced, notice shown, server relaunched). The window between confirmation and the assignment of `server` is not hit in practice.
- **Retried deletions make sense.** The server inherits the user's environment and no data directory is overridden, so sessions live in OpenCode's shared on-disk storage for the same project. A session from a dead server is idle on the new one, and deleting it there is valid. The integration fake models this with a shared `deleted` set.
- **Event monitor.**
  - The probe's journal markers are unchanged: `question.rejected` before rejection, `question.reject.failed`, `event.monitor.ended` (only when not stopped) and `event.monitor.unconfirmed`. The probe's `isOwnSession` keeps its `#sessionIDs.includes` check.
  - `onPermissionAsked`, `onQuestionAsked` and `onEnded` are each wrapped in try/catch. A throw from `onQuestionRejected` is absorbed by the `.finally().catch()` chain and does not cause an unhandled rejection.
  - `onEnded` fires only when the internal controller was not aborted. `stop()` does not trigger it; the subscription bound does.
- **`verify-harness`.**
  - `node_modules/.bin/opencode` links to `opencode-ai/bin/opencode.exe`, a native Mach-O arm64 binary. It is the CLI's direct child, and its `ps` command line contains `opencode serve --pure --hostname=127.0.0.1 --port=0`, so PPID tracking finds it.
  - A spawn error resolves to `null`, which gives a FAIL row and NOT MET.
  - A timeout sends SIGTERM to the CLI (exit 143, FAIL) and SIGKILL after 10 s. Tracked servers are terminated at the end in every case.
- **Constraints met.**
  - No dependency changes: `package.json` only adds `name`, `version`, `private`, `bin` and scripts.
  - `--pure` is kept.
  - Permissions are only ever replied `"reject"`, and a test asserts that no reply other than reject occurs.
  - No Git writes.
  - Model text, questions, options and actions are sanitized. Trace events carry fixed names, IDs and outcome kinds only.

### Variant Hunting

- **Swallowed failures (variants of the "never silently" constraint).** `#retire` and the launch catch path drop a failed `close()`; reported above as a Suggestion. `#onServerExit`'s `monitor.stop().catch` is fine, because the server is already gone.
- **"Rejected" wording when the reply failed.** Both permission and question notes are affected; one Suggestion covers both.
- **Exit-code overwrite.** A SIGTERM during an EOF-initiated shutdown still exits 0, because the shutdown is memoized with code 0. This is harmless and not reported.
- **Ctrl-C during a mid-prompt relaunch.** It waits for the launch (bounded at 15 s plus 10 s) and then reports "cancelled" without creating a session. This is acceptable.

### Remaining Risks

- **Deleting an active session.** It is still not a verified contract. This is now mitigated, since deletion follows a bounded interrupt and wait-for-idle.
- **Session created but unknown.** A `createSession` that times out after the server created the session leaves an ID Quoder never learns, so it cannot be deleted. The window is narrow.
- **Truncated output on exit.** `process.exit()` right after `run()` may truncate buffered stdout when it is a pipe on macOS. The trace uses `appendFileSync`, so acceptance evidence is unaffected.
- **Model dependence of `verify:harness`.** It still requires both outcomes to be `answered`, so model nondeterminism can yield NOT MET.
- **Untracked handoff file.** The untracked `claude-handoff.md` at the repository root should not be committed accidentally.

### Tests
- [x] All tests passing (218/218 on four runs; typecheck and build clean)
- [ ] Test coverage adequate for changes. Missing: interactive (`terminal: true`) mode, meaning the busy-line refusal, readline `SIGINT` to interrupt, and the second-Ctrl-C hint. Minor additionally: the harness wiring for a failed question rejection.

### Verdict: FAIL

# Review: Milestone 1 — Minimal Harness

## Cycle 3 — 2026-10-03
Reviewing: Groups 1–3, Fix Groups 1–2

### Critical

None.

### Warning

None.

The Cycle 2 warning (interactive mode had no tests) is resolved. Mutation runs confirmed that the new `terminal: true` tests exercise readline's real `SIGINT` path and the busy-line refusal. Every adopted Fix Group 2 suggestion is implemented correctly. No regressions were found.

### Suggestion

- **[src/harness/repl.ts:412-415] `#notifyIdle` does not check that readline is still open.**
  - **The gap.** It calls `this.#readline?.prompt(true)` when `#running` and `#shutdown` are both unset. It does not check `#inputClosed`, unlike the loop's own guard at line 154.
  - **Reproduction.** A scratch fake drove the built `dist/` (terminal mode). It sent `\x04` (Ctrl-D) and resolved the launch's `exited` promise in the same macrotask. The `#onServerExit` microtask then ran after readline's `close` but before `#shutdownOnce` was set, so `prompt(true)` threw `ERR_USE_AFTER_CLOSE` inside the `launch.exited.then(...)` callback. The result was an unhandled rejection; the harness itself still resolved 0.
  - **Why this is not a Warning.** I found no real-world way to hit it:
    - The real `exited` promise resolves from the child's `exit` event (`opencode-server.ts:159-161`), which is its own macrotask.
    - The same holds for the permission-reply `.then` that can call `#markUnhealthy`.
    - Readline's `close` reaches `#shutdownOnce` within microtasks of the same tick, because the loop is either waiting in `#nextLine` or `#running` is set.
  - **Fix.** Add `&& !this.#inputClosed` to the condition. That costs one line and removes a latent copy of the Cycle 1 `ERR_USE_AFTER_CLOSE` class of defect.
- **[src/harness/repl.ts:357-366, 397-399] Two new reporting paths have no tests.** In a scratch copy outside the repository, both of these mutations left all tests passing:
  - removing the "did not confirm termination" warning from `#closeLaunch`;
  - restricting the shutdown summary to the case where a server is live.

  I confirmed by scratch reproduction that both behaviours work today:
  - A failed `close()` on retire is reported; it appeared twice, once for the retired server and once at shutdown, with exit 1.
  - A failed `close()` after an unconfirmed monitor is reported.
  - Losing the server mid-prompt and then sending EOF prints the "1 OpenCode session(s) could not be verified as deleted" summary.

  The Fix Group 2 Accept criteria did not ask for tests of these paths, and both are secondary reporting (a failed close is practically unreachable, and the summary repeats a per-prompt warning). Two small integration tests (`closeFails` on retire; server lost mid-prompt, then EOF) would lock them in.
- **[scripts/verify-harness.ts:69, 74] A server that exits between the check and the kill fails the script.** `process.kill(pid, …)` runs after the `isAlive` and `isTrackedServer` checks but is not wrapped. If the process exits in between, `ESRCH` rejects `main()`, which prints NOT MET even if every row passed, and skips signalling the remaining tracked PIDs. The window is tiny. Wrapping each kill in `try`/`catch` would make it robust. The validated kill is otherwise correct and bounded (see Verification Evidence).
- **[src/harness/repl.ts:225-227] One sentence is dropped when the stop reason already shows the notice.** The "A new OpenCode server will start with your next prompt." sentence is never shown in that case. This is cosmetic, because the next prompt does relaunch.
- **[src/package-root.ts:34] Carried forward from Cycles 1 and 2 (acceptable).** The code assumes `node_modules/.bin/opencode` under Quoder's root. That holds for a checkout and for `npm link`.

### Verification Evidence

- **Commands.**
  - `npm run typecheck`: passed.
  - `npm test -- --reporter=dot`: 13 files, 223/223 passed.
  - `tests/integration/harness.test.ts` re-run 8 more times: 28/28 every time, no flakiness.
  - `npm run build`: passed (`dist/` is git-ignored).
  - `git diff --check`: clean.
  - `git status` is unchanged (23 entries before and after).
  - No `verify:live`, `verify:environment` or `verify:harness` was run, no server was started, there was no network access, and no `opencode serve` process remains.
- **Cycle 2 warning (interactive mode): resolved.** The three tests in `harness.test.ts:490-538` build readline with `terminal: true` over a `PassThrough` and send real keystrokes. Mutation checks ran in a scratch copy outside the repository:
  - **Removing `readline.on("SIGINT", …)`.** The TTY test fails: readline's default closes the interface on `\x03` and never cancels.
  - **Removing the busy-line refusal (`#receive`).** The TTY test fails.
  - **Removing the `prompt(true)` redraw in `#notifyIdle`.** The redraw test fails.
  - **Removing the `if (server.unhealthy) return` in `#onServerExit`.** The one-notice test fails.
  - **Removing the question-rejection wiring (`if (!rejected) this.#markUnhealthy`).** The failed-question test fails.
  - **Determinism.**
    - Each step waits for an observable effect, such as `prompt:ses_1` before the busy line.
    - A `deleteGate` holds cleanup open, so the second `\x03` deterministically finds `#running` aborted and prints the hint.
    - Ctrl-D at an empty line closes readline, and the loop then exits 0 with the server closed.
- **Fix Group 2 changes are correct.**
  - **`#notifyIdle`.**
    - **Piped mode.** It writes the notice only, with no prompt (scratch: 0 redraws).
    - **Terminal mode.** It redraws once (scratch: one notice, one redraw).
    - **During shutdown.** It is suppressed, because `#shutdown` is set synchronously in `#shutdownOnce`.
    - **Typed text.** `prompt(true)` preserves partially typed input.
  - **`#onServerExit`.**
    - It ignores non-current servers, stops the monitor, and returns quietly during shutdown.
    - It stays silent only for a server already marked unhealthy. `#markUnhealthy` is the only place `unhealthy` is set, and it always reports: either a stopped prompt plus a queued notice, or an idle notice.
  - **Shutdown summary.** `#performShutdown` prints it whether or not a server is live, retries deletions only on a healthy live server, and still closes an unhealthy live server.
  - **`#closeLaunch`.** It reports a failed close for retirement, for launch failure (an unconfirmed monitor) and for shutdown; shutdown then exits 1.
  - **Wording.** Notes say "Quoder did not grant it" and "Quoder did not answer it". The permission outcome says "the request was not granted and the turn ended". No user-facing string claims "rejected".
- **Challenge: does the one-notice logic hide anything?** I traced and reproduced these sequences:
  - Unhealthy at idle, then the server exits: one notice, which says a new server will start; the next prompt relaunches.
  - Unhealthy mid-prompt (a failed permission reply), then the server dies during cleanup: the prompt's failure reason is shown. A deletion failure would still raise the per-prompt warning, the deletion is retried on the next server, and the shutdown summary covers it.
  - Retirement of an unhealthy server: its `exit` is ignored because it is no longer current.

  The developer always sees the failure, any unverified deletion, and its retry. The only thing suppressed is a redundant second cause.
- **Cycle 1 Critical reproductions, re-run against a fresh `dist/` with scratch fakes (no network).**

  | Case | Result |
  | --- | --- |
  | `a\nb\n`, `a\n\nb\n`, `a\n/help\nb\n`, `a\n/nope\nb\n` + EOF | exit 0; 2 created, 2 deleted; 1 launched, 1 closed |
  | `a\n/exit\nb\n` + EOF | exit 0; 1 created, 1 deleted; `b` not run |
  | empty + EOF | exit 0; server closed |
  | SIGTERM during startup, at 10 ms (abort honoured) and 150 ms (abort ignored) | exit 143; launched == closed; no "Ready"; no session created |
  | Ctrl-C during startup, same two timings | exit 0; launched == closed; no session created |
  | SIGTERM while retiring an unhealthy server (slow `monitor.stop`) | exit 143; launched 1, closed 1. The loop awaits the retirement before shutdown, so there is no early `process.exit` |
  | Two permission prompts | replies were `reject,reject` only |

- **Regression check of the Cycle 1 and Cycle 2 verified points: all still hold.**
  - **Sequential loop and single memoized shutdown.** `#main` is the only shutdown path, apart from `run().catch`.
  - **Startup abort scoping.** `#launchAbort` is set only around the `launchServer` await.
  - **Settle before delete.** `session-runner.ts:200` (`if (!endedIdle) await settle(...)`) is unchanged.
  - **Monitor confirmation and loss.** An unconfirmed monitor fails the launch; `onEnded` and failed reject replies mark the server unhealthy.
  - **Rejection reporting.** Rejections are carried on every result.
  - **Server working directory.** The `cwd` is the project root.
  - **Deletion retry.** It runs on the next server, then again at shutdown.
- **`verify-harness`: the validated kill.**
  - `isTrackedServer` re-reads `ps -p <pid> -o command=` and requires `opencode serve --pure --hostname=127.0.0.1 --port=0`. A missing PID makes `ps` exit non-zero, which counts as false.
  - The PID is validated before SIGTERM, and again before SIGKILL.
  - **Bounds.** The run is capped at 300 s, then SIGTERM to the CLI, then SIGKILL 10 s later. The residual-server wait is 5 s, and `ps` calls are short.
- **Constraints.**
  - **No dependency changes.** `package.json` only adds `name`, `version`, `private`, `bin` and scripts.
  - **`--pure` kept** (`opencode-server.ts:75`).
  - **Permissions only ever rejected.** The harness's only `replyPermission` call uses `"reject"`. The probe's `"once"` reply is pre-existing Milestone 0 fixture code, unchanged since HEAD.
  - **No Git writes.** The only Git call is `git rev-parse --show-toplevel`.
  - **Sanitized output.** Model text, questions, options and actions go through `sanitizeForTerminal` or `sanitizeLine`. The trace carries fixed names, IDs and outcome kinds only.

### Variant Hunting

- **Readline used after close (the Cycle 1 class).** Call sites of `readline.prompt` are line 150 (just after creation), line 154 (guarded by `!#inputClosed`) and line 414 (`#notifyIdle`, not guarded; reported as a Suggestion). `#notifyIdle` is reached from `#markUnhealthy` and `#onServerExit`, and all their callers are driven by macrotask-sourced events (child `exit`, the HTTP reply rejection, the monitor stream end). I found no practical interleaving.
- **Swallowed `close()` failures.** All three close sites now route through `#closeLaunch`. Monitor `stop().catch` remains only where the server is already gone or being closed.
- **Duplicate notices.** The only remaining pair (monitor loss, then server exit) is now collapsed. A notice queued during a prompt is suppressed only when the failure reason already begins with it.

### Remaining Risks

- **Deleting an active session.** It is still not a verified OpenCode contract. This is mitigated, because deletion follows a bounded interrupt and wait-for-idle.
- **Session created but unknown.** A `createSession` that times out after the server created the session leaves an ID Quoder never learns.
- **Truncated output on exit.** `process.exit()` right after `run()` may truncate piped stdout. The trace uses synchronous appends, so the acceptance evidence is unaffected.
- **`verify:harness` limits.**
  - It requires both outcomes to be `answered`, so model nondeterminism can yield NOT MET.
  - It polls server children every 500 ms, so a server launched in the final half-second before a timeout SIGKILL could escape tracking.
- **Untracked handoff file.** The untracked `claude-handoff.md` at the repository root should not be committed accidentally.

### Tests
- [x] All tests passing (223/223; harness integration 28/28 on 9 runs; typecheck and build clean)
- [x] Test coverage adequate for changes. Interactive mode, the failed-question wiring, the one-notice rule and the prompt redraw are each guarded, as shown by the mutation runs above. The failed-`close()` warning and the shutdown summary are verified only by scratch reproduction; a Suggestion above proposes tests for them.

### Verdict: PASS
