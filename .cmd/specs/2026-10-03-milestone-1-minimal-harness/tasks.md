# Tasks: Milestone 1 — Minimal Harness

Spec: `.cmd/specs/2026-10-03-milestone-1-minimal-harness/spec.md`

Groups execute sequentially. No task authorizes `npm run verify:live` or `npm run verify:harness` against the real model without the user's explicit authorization. Bounded scratch diagnostics in Group 1 are authorized by the user's request to research the design.

## Group 1: Verify contracts the harness depends on (diagnostics only)

- [x] Verify the default model and the reject paths, live | `docs/tech.md`, `.cmd/specs/2026-10-03-milestone-1-minimal-harness/decisions.md`
  - **Packages**: None.
  - **Accept**: Bounded scratch diagnostics (outside the repository, sanitized output, full cleanup) record:
    - **The default model.** Whether `ollama/glm-4.7-flash:latest` completes an OpenCode Core V2 turn with an exact sentinel and performs a structured `write` tool call, sampled at least 3 times.
    - **Rejected permissions.** What a rejected `permission.v2.asked` does to an in-flight model turn: whether the session goes idle, which events follow, and whether the final message carries an error.
    - **Rejected questions.** The `question.v2.asked` payload shape, so question text can be displayed.
    - **Interrupt on a real prompt.** The interrupt-then-idle behaviour for an ordinary long-running prompt (not the tokenized fixture).
    - **Cwd independence.** That a server launched from a directory other than this repository works when the binary is resolved from the package location.

    Raw model replies appear only in scratch output.
  - **Verify**: `rg -n 'glm-4.7-flash|permission|question|interrupt|cwd' .cmd/specs/2026-10-03-milestone-1-minimal-harness/decisions.md && git diff --check`
  - **Constraints**: No repository source changes. No user-config changes. If the default model is unreliable, stop and escalate the model choice.
  - **Completed evidence**:
    - `glm-4.7-flash:latest`: exact sentinel 3/3, and a structured `write` with an exact file and reply 3/3.
    - Rejected permission and rejected question: each ends the turn with an incomplete assistant message.
    - Interrupt: the session is idle within about 11 ms, with `step.failed` and "Provider turn interrupted".
    - Cwd-independent launch works.
    - Payload shapes are recorded in `decisions.md` and `docs/tech.md`.

## Group 2: Extract shared OpenCode modules

- [x] Move the launcher, adapter usage, and event monitor into reusable modules without behaviour change | `src/`, `tests/`
  - **Accept**: The authenticated launcher, owned-child termination, and run-long event monitor live in shared modules, generalized where the harness needs it: the monitor is scoped to registered sessions, and question and permission handling is pluggable. The probe imports them. Binary and manifest resolution use the package location, not `process.cwd()`. The existing probe and preflight tests pass unchanged in intent, and the new module tests cover location-independent resolution.
  - **Verify**: `npm run typecheck`, `npm test -- --reporter=dot`, `npm run verify:environment`, and `git diff --check`, run separately.
  - **Constraints**: No `verify:live`. The probe's behaviour and journal contract are unchanged.
  - **Completed evidence**:
    - **`src/package-root.ts` (new).** `findPackageRoot` walks up from the module location to the `package.json` named `quoder`, so `package.json` now has `name`, `version` and `private`. It also provides `packagePath` and `opencodeExecutablePath`.
    - **`src/opencode-server.ts` (new).** The authenticated launcher, owned-child termination and its dependencies were moved verbatim from `live-probe.ts`; only the binary path changed, to the package-relative one.
    - **`src/event-monitor.ts` (new).** `startEventMonitor` is the probe's run-long monitor, generalized with an `isOwnSession` predicate, an `onPermissionAsked` report (action and resource count), an `onQuestionRejected` report (question content and outcome), and configurable bounds. The journal markers are unchanged. The rejection `.finally` chain now ends in `.catch`, which closes the carried-forward unhandled-rejection suggestion.
    - **Probe and preflight.** The probe driver delegates to the shared monitor. The preflight resolves the manifests and the OpenCode binary from the package root, which closes the carried-forward `process.cwd()` security suggestion.
    - **Tests.** The existing 139 tests pass with only their import paths changed. Seven new tests cover package-root resolution (nested, cwd-independent under `process.chdir`, a foreign package rejected) and the monitor callbacks (own-session scoping, permission reports, question reports, a throwing callback without an unhandled rejection, monitor-ended waits). Mutation checks (cwd-relative executable; unguarded `.finally` chain) each failed the tests.
    - **Results.**
      - `npm run typecheck` passed.
      - `npm test -- --reporter=dot` passed 146/146.
      - The real `npm run verify:environment` passed.
      - The compiled preflight run **from `/tmp`** also passed all eight rows; previously it would have failed the pin and binary lookups.
      - `git diff --check` passed.
      - No `verify:live`.

## Group 3: Implement the `quoder` CLI

- [x] Project resolution, the session runner, the REPL, Ctrl-C handling, commands, packaging, and a live acceptance script | `src/`, `scripts/`, `tests/`, `package.json`
  - **Accept**: The spec's Design is implemented: launch, per-prompt execution, the event monitor, Ctrl-C and exit, commands, module structure, packaging, and output sanitization. Typed-fake tests cover every path listed under Verification. `npm run verify:harness` exists and is bounded, but it is not run in this group.
  - **Verify**: `npm run typecheck`, `npm test -- --reporter=dot`, `npm run build`, `npm run verify:environment`, and `git diff --check`, run separately.
  - **Constraints**: No `verify:live` or `verify:harness` against the real model.
  - **Completed evidence**:
    - **New modules** under `src/harness/`:
      - `project.ts`: Git root, or the launch directory, plus the project name for the prompt label.
      - `terminal-text.ts`: strips CSI and OSC escape sequences, 8-bit CSI, other ESC sequences, C0/C1 controls and bidirectional overrides; keeps newlines and tabs.
      - `session-runner.ts`: `runPrompt` creates a fresh session bound to the project root and model, submits the prompt, and waits with no fixed execution timeout (cancellable, with bounded API calls and a 30 s no-response bound). It classifies the turn as answered, permission rejected, question rejected, cancelled or failed, and always deletes and verifies the session, after an interrupt and settle when cancelled. `SessionTracker` scopes the monitor to the harness's own sessions.
      - `format.ts`: sanitized output, the turn-ending explanations, and the deletion warning.
      - `repl.ts`: the `Harness` runs one server at launch and starts a new one on the next prompt after an unexpected exit. Its monitor rejects every permission request and reports it, and rejects and reports questions. It handles `/help` and `/exit` and rejects other `/` commands. Ctrl-C aborts and returns during a prompt and exits when idle; SIGTERM and SIGHUP cancel, clean up and exit. Piped input is processed line by line. The optional trace records fixed event names, session IDs and outcome kinds only.
    - **CLI.** `src/cli.ts` parses `--model provider/id` (default `ollama/glm-4.7-flash:latest`), `--help` and `--version`. Its entry detection uses real paths, so the `npm link` symlink works, and `QUODER_TRACE_FILE` enables the trace.
    - **Launcher.** `opencode-server.ts` exposes an optional `exited` promise on the launch handle.
    - **Packaging.** `bin.quoder` is `dist/cli.js`, built by `tsconfig.build.json` (`npm run build`). `dist/` is git-ignored.
    - **Acceptance script.** `scripts/verify-harness.ts` (`npm run verify:harness`) runs the built CLI as a subprocess from a disposable project with two piped prompts. It checks the exit criterion from the trace (one server, two distinct sessions both deleted, both answered, clean exit, no residual Quoder server) and treats exact model replies as informational. It has not been run against the model.
    - **Tests.** New unit tests cover the terminal sanitizer (escape-sequence attacks), project resolution (including real git), CLI arguments, formatting, and every runner path. New integration tests drive the real `Harness` and adapter through piped streams against a fake OpenCode: multiple prompts on one server with distinct, deleted sessions; commands; permission rejection, never approval; question display; step errors; Ctrl-C cancel-and-continue; Ctrl-C exit when idle; SIGTERM; server-loss relaunch; and launch failure. Mutation checks (approving permissions `once`; skipping settle and deletion on cancel) each failed the tests.
    - **Results.**
      - `npm run typecheck` passed.
      - `npm test -- --reporter=dot` passed 193/193.
      - `npm run build` and `npm run build:live` passed.
      - `git diff --check` passed.
      - `quoder --version` works through a symlink, as `npm link` installs it.
      - A real CLI smoke run from a temporary directory (`/help`, `/exit`; no model call) launched the real server, showed the help and the project-name prompt, traced `server.started` and `server.stopped`, exited 0, and left no residual server.
      - No `verify:live` or `verify:harness` was run.

## Group 4: General review gate

- [x] Fresh review | `.cmd/specs/2026-10-03-milestone-1-minimal-harness/review.md`
  - **Accept**: PASS with zero critical findings and zero warnings, persisted verbatim. Maximum 3 cycles.

  - **Failed cycle 1**: Two critical findings, both reproduced by the reviewer: queued non-prompt lines or `/exit` in piped mode crash or hang the harness, and a signal during startup leaks the server or is ignored. Five warnings: a failed turn deletes a possibly running session; the monitor is unconfirmed, and its loss and reply failures are silent; a rejected permission is unreported when the turn also answers; the server's working directory is not the project root; lifecycle paths are untested. See `review.md`.

## Fix Group 1: Address review Cycle 1

- [x] Rebuild the REPL lifecycle as one sequential consumer and close every Cycle 1 finding | `src/harness/`, `src/event-monitor.ts`, `src/opencode-server.ts`, `src/cli.ts`, `scripts/verify-harness.ts`, `tests/`, `docs/tech.md`
  - **Accept**:
    - **Sequential input loop.** One loop handles every line in order, so a queued blank line, `/help`, an unknown command or `/exit` never crashes or hangs, and EOF always shuts down. Nothing is queued after SIGTERM. Every detached async call routes errors to shutdown.
    - **Startup.** A shutdown request during startup aborts or awaits the launch and closes whatever it produced; Ctrl-C during startup exits.
    - **Failed turns.** The runner interrupts and settles before deleting whenever the turn did not end idle, and checks cancellation before creating a session.
    - **Event monitor.**
      - An unconfirmed monitor fails the launch.
      - Monitor loss, a failed reject reply, or a failed question rejection stops the running prompt with an explanation and marks the server for relaunch.
      - Questions are recorded when asked.
    - **Reporting.** Rejected permissions and questions are reported alongside an answer too.
    - **Server working directory.** It is the project root (an optional `cwd` on the launcher).
    - **Deletion retry.** Session IDs whose deletion is unverified after a server loss are retried on the next server.
    - **CLI exit codes.** SIGTERM exits 143 and SIGHUP 129.
    - **`verify:harness`.** It tracks and cleans up its own descendant processes and handles spawn errors.
    - **Tests.** Every path the review listed is tested.
  - **Verify**: `npm run typecheck`, `npm test -- --reporter=dot`, `npm run build`, `npm run verify:environment`, and `git diff --check`, run separately.
  - **Constraints**: No `verify:live` or `verify:harness` against the model. Then a fresh Review Cycle 2.
  - **Completed evidence**:
    - **REPL rewritten as one sequential loop.** `#nextLine` drains queued lines in order; EOF, `/exit` and exit requests end the loop, and only its exit path runs a single memoized shutdown. Lines received after an exit request are ignored, terminal mode refuses lines while busy, and `run()` routes any internal error to shutdown.
    - **Startup.** An exit request during startup aborts a per-launch `AbortController` that is passed to the launcher. That controller is never aborted once a server is up, so a SIGTERM during a prompt still settles and deletes the session. Shutdown awaits any pending launch and closes whatever it produced.
    - **Event monitor.**
      - `confirmed` is false: the start fails.
      - `onEnded`, a failed reject reply, or a failed question rejection marks the server unhealthy. A running prompt is stopped with a `StopRequest` reason, and the notice is shown after its result unless the outcome already shows it; otherwise it is shown immediately. The server is replaced before the next prompt.
      - Questions are recorded on arrival (`onQuestionAsked`).
      - Monitor callbacks that throw cannot end the monitor.
    - **Runner.**
      - It checks cancellation before creating a session.
      - It settles (interrupt, then idle) before deleting whenever the turn did not end idle, not only on cancel.
      - Stop reasons are reported as failures.
      - Rejected permissions and questions are carried on every result, and the formatter prints them as notes beside an answer.
    - **Server working directory and deletion retries.**
      - The server's working directory is the project root, via the launcher's new optional `cwd`. This was confirmed live from a subdirectory of a temporary Git repository: the server child's cwd was the repository root.
      - Sessions whose deletion is unverified are retried on the next server, and again at shutdown.
    - **CLI.** SIGTERM exits 143, SIGHUP exits 129.
    - **`verify:harness`.** It tracks the CLI's own OpenCode child by parent PID, terminates any still running at the end, and reports a spawn error as NOT MET.
    - **Tests.** The harness integration tests (23) cover:
      - queued blank, `/help`, unknown and `/exit` lines after a prompt at EOF;
      - `/exit` with later lines;
      - permission plus answer;
      - permission-reply failure, server replaced;
      - Ctrl-C during `createSession`;
      - SIGTERM during a prompt (143);
      - SIGTERM and Ctrl-C during startup;
      - a launch completing after an exit request;
      - server loss mid-prompt (warning, then retried deletion on the next server);
      - monitor loss mid-prompt;
      - an unconfirmed monitor;
      - the project-root cwd.

      New runner, format, monitor and launcher tests cover settling on poll and prompt failure, no interrupt after an idle end, cancel before create, stop reasons, carried rejections, notes formatting, `onQuestionAsked` ordering, `onEnded` versus `stop()`, `confirmed`, throwing callbacks, and the `cwd` configuration.
    - **Mutation checks** (each failed the tests): an exit request that does not abort the launch; settling only on cancel; no project-root cwd.
    - **Real-CLI lifecycle checks** (no model calls):
      - From a subdirectory, queued `/help`, a blank line, `/nope` and `/exit` gave exit 0, `server.started` then `server.stopped`, and a server cwd at the repository root.
      - SIGTERM during startup gave exit 143 with no server started.
      - SIGTERM at an idle prompt gave exit 143, `server.started` then `server.stopped`.
      - No residual server remained.
    - **Results.** `npm test -- --reporter=dot` passed 218/218 three times in a row. `npm run typecheck`, `npm run build`, `npm run build:live` and `git diff --check` passed. The real `npm run verify:environment` passed. No `verify:live` or `verify:harness` was run.

  - **Failed cycle 2**: All Cycle 1 findings resolved; the reviewer reproduced the old Critical cases against the new build, and 200 randomized lifecycle interleavings found no hangs, leaks, silent deletions, or unhandled rejections. Zero critical findings and one warning: interactive (TTY) mode has no automated tests. Seven suggestions. See `review.md`. Cycle 3 is the last allowed cycle.

## Fix Group 2: Address review Cycle 2

- [x] Cover interactive mode and close the cheap Cycle 2 suggestions | `src/harness/`, `scripts/verify-harness.ts`, `tests/`
  - **Accept**:
    - **TTY tests.** Integration tests with `terminal: true` drive readline itself: a line typed while busy is refused; `\x03` during a prompt cancels it; a second `\x03` while cleaning up prints the hint; `\x03` at idle and `\x04` (Ctrl-D) exit. The harness wiring for a failed question rejection is tested.
    - **Notes wording.** Notes say a request was *not granted* or *not answered*, never "rejected", so they stay true when a reject reply fails.
    - **Failed `close()` reported.** A failed `close()` when retiring a server or after a failed launch is reported.
    - **Shutdown summary.** Shutdown summarizes unverified deletions even when no server is live.
    - **One notice per failure, prompt redrawn.** A server failure produces one idle notice, not two, and the prompt is redrawn after an idle notice in terminal mode.
    - **Validated kill.** `verify:harness` re-validates a tracked PID's command line before signalling it.
  - **Verify**: `npm run typecheck`, `npm test -- --reporter=dot`, `npm run build`, `npm run verify:environment`, and `git diff --check`, run separately.
  - **Constraints**: No `verify:live` or `verify:harness` against the model. Then Review Cycle 3 (final); if it fails, stop and escalate.
  - **Completed evidence**:
    - **TTY tests.** Three integration tests use `terminal: true` and drive readline with real keystrokes:
      - `slow task\r`, then a line refused while busy, then `\x03` cancels, then a second `\x03` during gated cleanup shows the hint, then the session is deleted, then `\x03` at idle exits 0 and closes the server;
      - `\x04` at an empty prompt exits 0;
      - the prompt is redrawn after an idle notice.
    - **Other new tests.** A failed question rejection is wired to replace the server, and a monitor drop followed by a server exit at idle produces exactly one notice.
    - **Notes wording.** Notes now say a permission was "not granted" and a question "not answered". The permission outcome says "the request was not granted and the turn ended".
    - **Failed `close()` reported.** A failed `close()` while retiring a server or after a failed launch now writes a warning.
    - **Shutdown summary.** Shutdown summarizes unverified deletions even when no server is live.
    - **One notice per failure.** `#onServerExit` stays silent for a server already reported unhealthy; idle notices redraw the terminal prompt.
    - **Validated kill.** `verify:harness` re-validates a tracked PID's command line (`ps -p`) before SIGTERM or SIGKILL.
    - **Mutation checks** (each failed the TTY test): no readline `SIGINT` wiring; no busy-line refusal.
    - **Results.**
      - `npm test -- --reporter=dot` passed 223/223 three times in a row.
      - `npm run typecheck`, `npm run build`, `npm run build:live` and `git diff --check` passed.
      - The real `npm run verify:environment` passed.
      - The real CLI with `/help`, a blank line, `/nope` and `/exit` exited 0 with `server.started` then `server.stopped`, and left no residual server.
      - No `verify:live` or `verify:harness` was run.

  - **Passed cycle 3**: PASS with zero critical findings and zero warnings. The Cycle 1 critical reproductions and the fixes from earlier cycles still hold, and mutation runs confirm the TTY tests guard readline Ctrl-C, busy-line refusal, prompt redraw, one-notice, and failed-question wiring. Four suggestions carried forward in `decisions.md`. See `review.md`.

## Group 5: Security review gate

- [x] Fresh security review | `.cmd/specs/2026-10-03-milestone-1-minimal-harness/security-review.md`
  - **Accept**: PASS with zero critical findings and zero warnings, persisted verbatim.

  - **Passed cycle 1**: PASS with zero critical findings and zero warnings. Three low-confidence suggestions and one usability observation are carried forward in `decisions.md`. See `security-review.md`.

## Group 6: QA gate

- [x] Independent QA, including the live acceptance check with user authorization | `.cmd/specs/2026-10-03-milestone-1-minimal-harness/qa.md`
  - **Accept**: QA validates the automated suite, the build, the preflight, and — **only after explicit user authorization** — `npm run verify:harness` against the real model, which proves the Milestone 1 exit criterion. A manual interactive check is recorded where practical. Exactly one `Milestone 1 Exit Criterion: MET|NOT MET`.

## Group 7: Documentation and closure

- [x] Document the harness and close the spec | `README.md`, `docs/tech.md`, `SYSTEM_CONTEXT.md`, `.cmd/specs/2026-10-03-milestone-1-minimal-harness/decisions.md`
  - **Accept**: The README documents installing and using `quoder`, the Milestone 1 behaviour, and its known limitations (rejected permissions and questions, the credential exposure deferred to Milestone 3, model nondeterminism). `docs/tech.md` records the verified contracts. `SYSTEM_CONTEXT.md` changes only for material facts. `currentspec.md` is removed after all gates pass.
