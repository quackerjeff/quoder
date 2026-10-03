# Decisions: Milestone 1 — Minimal Harness

## 2026-10-03 — Scope decisions from the user

**Context**: The user opened Milestone 1 after Milestone 0 passed and decided the product name and three design questions.

**Decision**:
- **Name.** The product and command are **Quoder** (`quoder`). The prompt shows the project's name.
- **Credentials.** Withholding the server password from model-run tool environments is **deferred to Milestone 3** and documented as a known limitation.
- **Default model.** It is `ollama/glm-4.7-flash:latest` (confirmed listed by the project-local OpenCode model discovery), with a `--model` override. The probe keeps `ollama/qwen3-coder:30b`.
- **Ctrl-C.** It **aborts the current prompt and returns** to the prompt; at an idle prompt it exits.

**Rationale**: The credential exposure confers nothing beyond what default-allowed bash already does until Milestone 3 restricts the shell. The default model is the developer's choice and is verified before use. Abort-and-return reuses the cancellation contract verified for 1.18.33 and never orphans a session.

## 2026-10-03 — Research findings that shape the design

- **Server password.** OpenCode 1.18.33 reads `OPENCODE_SERVER_PASSWORD` only from the environment; `serve` has no password flag. `ShellTool.shellEnv` returns `{...process.env, ...<plugin "shell.env" output>}`, so a plugin can override it for shell commands.
- **`--pure` blocks plugins.** Under `--pure`, *all* config plugins, including `file://` plugins, are skipped (`pure ? [] : plugin_origins`).
- **Environment visibility.** On this macOS (26.7), a same-user process's environment is not readable through `ps -E`/`ps eww`, inside or outside the sandbox. A `shell.env` override would therefore be effective (relevant for Milestone 3).
- **Binary path.** The probe's launcher resolves `node_modules/.bin/opencode` from `process.cwd()`. That breaks a CLI run from another project's directory, so Milestone 1 resolves it from the package location.

## 2026-10-03 — Group 1 live verification results

Bounded scratch diagnostics ran against the real server, with sanitized output, full cleanup, and no residue. The server was launched with its working directory set to a disposable repository and the binary resolved by absolute path, which confirms that cwd-independent launch works (the first global frame was `server.connected`).

**Default model `ollama/glm-4.7-flash:latest`**:
- An exact sentinel reply in 3 of 3 runs. The first took 17.8 s (cold model load); the others took 0.6–0.8 s.
- A structured `write` tool call with an exact `hello.txt` and an exact `TOKEN_STORED` reply in 3 of 3 runs, at 1.9–2.4 s each, with the event sequence `tool.called(write)` → `tool.success` → `step.ended[tool-calls]` → `step.started` → text → `step.ended[stop]`.
- The model is accepted as the default.

**A rejected permission ends the turn.** A prompt to read a file outside the project raised `permission.v2.asked` with the keys `{id, sessionID, action, resources, save, source}` and the action `external_directory`. Replying `reject` returned 204.
- The `read` tool call then emitted `session.next.tool.failed`, and the session went idle about 0.2 s later.
- No `step.ended` followed.
- The last assistant message is **incomplete**: no `finish`, no `time.completed`, and parts `text,tool:error`.

**A rejected question ends the turn.** `question.v2.asked` carries `{id, sessionID, questions: [{question, header, options: [{label, description}], ...}], tool}`. `question.reject` returned 204; the `question` tool call then failed, the session went idle, and the assistant message was incomplete.

**Interrupting a plain long prompt** (text only, no tools) left the session idle 11 ms after `interrupt`. It emitted `session.next.step.failed`, and the final message had `finish: "error"`, `time.completed` set, and `error: { type: "unknown", message: "Provider turn interrupted" }`.

**Design consequences**:
- Completion detection (`session/active` plus an assistant message in the turn) handles all three cases.
- `finalAssistantResponseText` correctly returns nothing for them.
- The harness tracks why a turn ended (a permission rejected, a question rejected, cancelled, or a step error) and reports that reason instead of an empty response:
  - for a rejected permission, the action and the number of resources;
  - for a rejected question, the question text and option labels, sanitized for the terminal.

## 2026-10-03 — General review passed at Cycle 3; suggestions carried forward

**Context**: Review Cycle 3 returned PASS with zero critical findings and zero warnings, after Cycle 1 (two criticals, five warnings) and Cycle 2 (one warning) were resolved.

**Decision**: Do not change code after the passing review. These suggestions are carried forward for a later change:
- In `#notifyIdle`, add `&& !this.#inputClosed` before redrawing the prompt. The reviewer reproduced `ERR_USE_AFTER_CLOSE` only with an artificial same-tick ordering that real events cannot produce.
- Add tests for the failed-`close()` warning and the no-live-server shutdown summary. Both were verified by scratch reproduction.
- In `verify-harness.ts`, wrap each `process.kill` in `try`/`catch` to tolerate a server exiting between validation and the signal.
- Keep the "a new server will start" sentence when a stop reason already reports a server problem (cosmetic).
- Carried from earlier cycles: resolve the OpenCode binary through module resolution instead of `node_modules/.bin` for hoisted installs.

**Rationale**: Each item is either latent with no practical trigger or cosmetic, and none affects session deletion, permission enforcement or cleanup. Changing code now would need another review cycle.

## 2026-10-03 — Security review passed; hardening carried forward

**Context**: Security Review Cycle 1 returned PASS with zero critical findings and zero warnings. Its scratch tests confirmed the terminal sanitizer against a broad set of injection vectors (OSC 52, OSC 8, DCS/APC/PM/SOS, 8-bit C1, concealment and overwrite sequences, and the complete set of bidirectional controls).

**Decision**: These items are carried forward, not changed after the passing gates.
- **Project-root containment.** Accept `git rev-parse --show-toplevel` only when it contains the launch directory; otherwise fall back and warn. A project *archive* with a crafted `.git/config` `core.worktree` can otherwise point the root elsewhere. This must be fixed **before Milestone 3** relies on project-scoped permission rules.
- **Sanitize project labels.** Pass `project.name` and `project.root` through `sanitizeLine` before showing them in the banner and the prompt label.
- **No default grant.** Make `OpenCodeAdapter.replyPermission`'s `reply` argument required, so no default can ever grant a permission.
- **Subagent sessions (usability).** Permission or question requests raised by subagent (`task`) child sessions are not registered as Quoder's own sessions. They are ignored rather than rejected, so nothing is granted, but the turn may wait until Ctrl-C. Milestone 3, which adds interactive permissions, should register child sessions or follow `parentID`.

**Rationale**: Each item is low confidence or gives no privilege gain in Milestone 1, where bash is default-allowed and Quoder never grants anything. Containment and subagent handling become material with Milestone 3.

## 2026-10-03 — Milestone 1 closed

**Context**: All gates passed: general review (Cycle 3), security review (Cycle 1), and QA. In QA, `npm run verify:harness` recorded `Milestone 1 Exit Criterion: MET`: one server, two distinct sessions, both verified deleted, a clean exit and no residual server. Cancelling with Ctrl-C and continuing was also verified live.

**Decision**: Close the spec.
- `README.md` documents installation, usage, behaviour and the known limitations.
- `docs/tech.md` records the harness contracts and module structure.
- `SYSTEM_CONTEXT.md` now names the `quoder` CLI as the deployable unit and records that no persistent state exists yet.

The review and security items carried forward above remain open. Project-root containment and subagent-session handling must be resolved before or within Milestone 3.

**Rationale**: The Milestone 1 exit criterion is met, and no remaining item affects session deletion, permission enforcement or cleanup.
