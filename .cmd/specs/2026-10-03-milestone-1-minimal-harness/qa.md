# QA Report: Milestone 1 — Minimal Harness

## Cycle 1 — 2026-10-03
Validating: Groups 1–5 and Fix Groups 1–2

### Coverage
- **Automated:**
  - `npm run typecheck`;
  - `npm test -- --reporter=dot`, three consecutive runs;
  - `npm run build`;
  - `git diff --check`;
  - the real `npm run verify:environment`;
  - the real `npm run verify:harness` against `ollama/glm-4.7-flash:latest`, which is the Milestone 1 exit-criterion evidence;
  - a review of the test suite against the spec's Verification list.
- **Manual, against the built `dist/cli.js`, all in a disposable directory that was deleted afterwards:**
  - `--help`, `--version`, a bad `--model`, and an unknown argument;
  - the project label from a subdirectory of a temporary Git repository;
  - `/help`, an unknown command, a blank line and `/exit`, with no model;
  - in **one** harness process, a real sentinel prompt, then a real long prompt interrupted with SIGINT, then `/help`, then `/exit`. That is two model prompts in total;
  - interactive TTY mode through `script -q /dev/null`, with no model: `/help`, `/nope`, then Ctrl-C at an idle prompt;
  - a residue check.
- **Not covered:**
  - Ctrl-C during a real prompt in **TTY** mode. Only piped-mode SIGINT was exercised live; TTY Ctrl-C during a prompt is covered by the automated `terminal: true` integration test.
  - Real permission and question rejection through the harness. These were verified live at the OpenCode contract level in Group 1 and are covered by fake-server integration tests. The live acceptance prompts do not trigger them by design.
  - Real server loss or monitor loss. These are covered only by automated tests and earlier review reproductions.
  - SIGHUP. It is mapped in `cli.ts` but not exercised.
  - `npm link` installation. This was not repeated; Group 3 recorded it.
  - `npm run verify:live` was **not** run, as prohibited.

### Environment
| Item | Value |
| --- | --- |
| OS | macOS 26.7 (25G229), arm64 |
| Node / npm | v24.18.1 / 12.0.2 |
| Pinned packages | `@opencode-ai/sdk@1.18.33`, `opencode-ai@1.18.33` (`npm ls --depth=0`) |
| Endpoint | `https://llm.quackerjack.com/v1/models` → HTTP 200 in 0.09 s (no credentials) |
| Branch / HEAD | `milestone-1-minimal-harness` / `cf82b9d` (with the uncommitted Milestone 1 working tree) |
| Model | `ollama/glm-4.7-flash:latest` (the CLI default) |
| Baseline | No `opencode serve` process before testing. `git status --short` showed 23 entries before and after QA, apart from this report and the Group 6 checkbox. |

### Results

**Automated checks**

| Command | Exit | Time | Result |
| --- | --- | --- | --- |
| `npm run typecheck` | 0 | <1 s | Passed |
| `npm test -- --reporter=dot` (run 1) | 0 | 5 s | 13 files, 223/223 |
| `npm test -- --reporter=dot` (run 2) | 0 | 6 s | 13 files, 223/223 |
| `npm test -- --reporter=dot` (run 3) | 0 | 5 s | 13 files, 223/223 |
| `npm run build` | 0 | <1 s | Passed |
| `git diff --check` | 0 | — | Clean |
| `npm run verify:environment` | 0 | 11 s | All 8 rows PASS; `Environment Readiness: PASS` |

`verify:environment` rows: Pinned dependencies, Provider configuration, Endpoint reachability, Model discovery, Direct inference, OpenCode model discovery, OpenCode inference, and Cleanup. All were PASS.

**`npm run verify:harness`: run 1, exit 0, 13 s including the builds.** No second run was needed.

| Row | Result | Evidence |
| --- | --- | --- |
| Harness launch and exit | PASS | exit code 0 |
| Single OpenCode server | PASS | 1 started, 0 lost |
| Fresh session per prompt | PASS | 2 sessions, 2 distinct |
| Prompts completed | PASS | outcomes: answered, answered |
| Session deletion | PASS | 2 of 2 verified deleted |
| Server cleanup | PASS | stopped 1, 1 tracked, 0 left running |
| Model replies (informational) | — | 2 of 2 exact |
| **Milestone 1 Exit Criterion** | **MET** | |

Afterwards, no `opencode serve` process remained and no `quoder-harness-acceptance-*` directory was left behind.

**Manual CLI checks**

| Check | Result |
| --- | --- |
| `--help` | Exit 0; the usage text shows the default model. |
| `--version` | Exit 0; `quoder 0.1.0`. |
| `--model bad` | Exit 2, with the message `--model expects provider/model …` and the usage text. |
| `--model /x` | Exit 2. |
| `--bogus` | Exit 2; `Unknown argument: --bogus`. |
| Project label | Launched from `LabelRepo/sub/dir` in a fresh `git init` repository. The banner is `Quoder — LabelRepo (<…>/LabelRepo)` and the prompt label is `LabelRepo > `. |
| Commands, piped, no model | `/help` printed the help, `/nope` printed "Unknown command. Type /help …", the blank line was ignored and `/exit` gave exit 0. The trace showed `server.started` then `server.stopped`, and no server remained. |
| Real prompt 1 (sentinel) | Displayed "Starting fresh OpenCode session…", then the exact sentinel reply, then "Completed in 2.8s.". The trace showed `session.created` then `session.deleted verified:true`, outcome `answered`, 2839 ms. |
| Real prompt 2 (300-word paragraph), SIGINT about 1.0 s after the session was created | The same server process was used for both prompts. The display showed "Cancelling OpenCode execution…" then "Execution cancelled.". A different session ID was created, then `session.deleted verified:true`, outcome `cancelled`, 1116 ms. The process stayed alive and accepted `/help` afterwards, and `/exit` gave exit 0. The trace showed `server.stopped`, and the server child was gone 0.5 s later. |
| TTY via `script -q /dev/null`, no model | Readline drew `LabelRepo > `. `/help` and `/nope` were answered, and the prompt was redrawn after each. `\x03` at the idle prompt exited 0, and the server stopped about 7.0 s after launch, matching the keystroke's timing. |
| Residue | After all runs, no `opencode serve` or `dist/cli.js` process remained, and the disposable project directory was deleted. |

The manual run used two model prompts in total, which is within the authorized limit. Raw replies were kept only in scratch output outside the repository.

**Automated evidence review**

| Required coverage | Tests |
| --- | --- |
| A fresh session per prompt, deleted on every path | `session-runner.test.ts` covers different sessions per prompt, deletion after answer, permission, question, step error, empty response, cancel, poll failure, and unverified deletion reported. `harness.test.ts:209` covers several prompts on one server, each fresh and deleted. The adapter's `deleteSession` requires 404 `SessionNotFoundError`. |
| Permission rejection, never approval | `harness.test.ts:265` asserts `permission:…:reject` and that no non-reject reply is sent. Lines 277 and 287 cover a rejection alongside an answer, and a failed reject reply that replaces the server. |
| Question display | `harness.test.ts:298` and 449; `format.test.ts:30` covers sanitized question text and options. |
| Ctrl-C, piped | `harness.test.ts:319`, 335 and 351 cover cancel and continue, cancel during `createSession`, and exit when idle. |
| Ctrl-C, TTY | `harness.test.ts:491` covers a line refused while busy, `\x03` cancel, a second `\x03` hint, and `\x03` exit at idle. Lines 516 and 526 cover Ctrl-D and the prompt redraw. |
| SIGTERM | `harness.test.ts:361` (exit 143, session deleted while the server is up). |
| Startup signals | `harness.test.ts:375` (`it.each`: SIGTERM and Ctrl-C during startup), and 390 (a launch that completes after the exit request). |
| Server or monitor loss | `harness.test.ts:402`, 417, 434, 460 and 473. |
| Sanitization | `terminal-text.test.ts` and `format.test.ts`. The security review also exercised a broad vector set in scratch. |

### Critical
None.

### Warning
None.

### Suggestion
- **[`src/cli.ts`, signal wiring]** The `process.on("SIGINT" | "SIGTERM" | "SIGHUP")` mappings in `cli.ts` have no automated test. The `cli.test.ts` tests cover argument parsing only.
  - Piped SIGINT was confirmed live in this cycle, and SIGTERM was confirmed against the real CLI in Fix Group 1.
  - SIGHUP (exit 129) has not been exercised anywhere.
  - A small subprocess test against a fake server would lock these mappings in.
- **[UX, FR-12 wording]** After a cancel, Quoder prints "Execution cancelled." and then redraws the prompt. FR-12's example also shows "Harness session remains active." This is Milestone 2 scope, so it is noted only for that milestone.

### Residual Gaps
- **Model nondeterminism.**
  - `verify:harness` requires both outcomes to be `answered`, so a non-cooperating model reply can yield NOT MET even when the harness is correct.
  - In this cycle, 2 of 2 replies were exact on the first run, and the manual sentinel was also exact.
  - Exact-reply matching is informational only.
- **Security items deferred to Milestone 3** (`decisions.md`):
  - project-root containment against a crafted `core.worktree`, which is required before Milestone 3 relies on project-scoped rules;
  - sanitizing the project name and root in the banner and prompt;
  - making the `replyPermission` reply argument required;
  - registering subagent (`task`) child sessions. Their asks are currently ignored rather than rejected, so nothing is granted, but a turn may wait until Ctrl-C.
- **Deferred server-credential exposure.** Model-run shell commands can read `OPENCODE_SERVER_PASSWORD`. This was accepted by the user and deferred to Milestone 3 because `--pure` blocks the `shell.env` mitigation. It gives no privilege beyond Milestone 1's default-allowed bash.
- **Review suggestions carried forward** (`decisions.md`):
  - guard `#notifyIdle` with `!#inputClosed`;
  - add tests for the failed-`close()` warning and the no-live-server shutdown summary;
  - wrap the `process.kill` calls in `verify-harness.ts` in `try`/`catch`;
  - keep the "a new server will start" sentence when a stop reason already reports a server problem;
  - resolve the OpenCode binary through module resolution, so hoisted installs work.
- **Live coverage limits.**
  - Real permission and question rejection, server or monitor loss, and TTY Ctrl-C during a live prompt were not exercised live in this cycle. They rely on Group 1's live contract verification and on fake-server integration tests.
  - A `createSession` that times out after the server has created the session would leave a session Quoder never learns about. This is the review's remaining risk.
  - Deleting a session that is still running is not a verified OpenCode contract. It is mitigated by interrupting and waiting for idle before every deletion that does not follow an observed idle state.

### Release Confidence
- READY. The live exit-criterion check passed on the first run, and the manual checks corroborate it: one server, distinct verified-deleted sessions per prompt, cancel-and-continue, and clean exit with no residue. The suite is stable at 223/223 across three runs. The residual risks above are documented and deferred by design.

Milestone 1 Exit Criterion: MET

### Verdict: PASS
