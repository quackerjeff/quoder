# Decisions: Milestone 2 — Streaming and Live Activity

## 2026-10-03 — Scope decisions from the user

**Context**: After trying the Milestone 1 `quoder` shell, the developer said what made it feel "meh": the silent wait and the boring monochrome UI.

**Decision**:
- **UI.** A styled line shell now: colour, a spinner and status line, coloured activity lines and streamed text. A full-screen TUI may follow later "when and if this really works". The event model is therefore kept separate from presentation.
- **Markdown.** Answers are rendered as terminal Markdown, with syntax-highlighted code blocks.
- **Reasoning.** Reasoning appears dimmed and collapsed, as a live preview in the status line, and is not kept in scrollback.

**Rationale**: Streaming addresses the silent wait (FR-6), and styling addresses the monochrome output. Keeping readline avoids a framework migration while the harness is still proving itself.

## 2026-10-03 — Research findings

- **Event types.** `@opencode-ai/sdk` 1.18.33 declares these `session.next.*` events: `text.{started,delta,ended}`, `reasoning.{started,delta,ended}`, `tool.input.{started,delta,ended}`, `tool.{called,progress,success,failed}`, `step.{started,ended,failed}` and `retried`. Payloads include `callID`, `tool`, `input`, `structured`, `content`, `error` and `tokens` (`v2/gen/types.gen.d.ts`). Only the declarations have been checked so far; live coverage on the global stream is Group 1's job.
- **Durability.** Text deltas carry no durable sequence (already recorded in `docs/tech.md`). The already-connected run-long global monitor is therefore the preferred source, because it cannot miss early events.
- **Rendering dependencies.**
  - `marked` 18.0.14 and `highlight.js` 11.12.0 both have no dependencies of their own.
  - `marked-terminal` (chalk, cli-highlight, node-emoji, and others) and `shiki` (several packages, wasm) were rejected as too heavy for NFR-6 and the supply-chain surface.
  - Node 24's built-in `util.styleText` covers colour, so no chalk is needed.

## 2026-10-03 — Group 1 live results (`ollama/glm-4.7-flash:latest`, OpenCode 1.18.33)

**Context**: The user authorized the Group 1 live check. Four scratch runs were made outside the repository:
- **Run 1:** text, tools, and a failing shell command.
- **Runs 2–4:** text and reasoning prompts, with the order varied.

Only event names, field names, string lengths, counts and timings were recorded. Every session was verified deleted, and no server was left running.

**Findings**:
- **Global stream coverage: confirmed.** The run-long global subscription delivers every `session.next.*` event for a session: `step.*`, `text.*`, `tool.input.*`, `tool.called` and `tool.success`/`.failed`. **The global monitor is the event source**, and no per-session stream is needed.
- **Text deltas.** They are token-sized: about 5 characters each, about 75 per second (for example, 297 deltas over 3.9 s). The first delta arrived 1.5–10 s after `prompted`. `text.ended` carries the full block `text`.
- **No reasoning events.** glm-4.7-flash through the `ollama` provider emitted none (`tokens.reasoning` was 0 in every step). The reasoning preview stays, cheap and generic, for models that do emit reasoning. For glm, the status line shows "Thinking…" until the first delta.
- **Parallel tool calls and interleaving.** One step issued 7 tool calls: all `tool.input.started` and `tool.called` events came first, then the results. The step's `text.ended` arrived *after* the `tool.called` events. **Consequence for the design:**
  - the permanent activity line is printed when a tool **finishes** (success or failure), with its result;
  - running tools appear in the status line;
  - open text is flushed before any activity line.
- **Tool shapes** (`input` → `structured` on success):
  - **read:** `{path}` → `{uri, name, content, encoding, mime}`
  - **grep:** `{pattern, path?}` → `{value: [{entry, line, offset, text, submatches}]}` (match count = `value.length`)
  - **glob:** `{pattern}` → `{value: [{path, type}]}`
  - **bash:** `{command, timeout?, description?}` → `{exit: number, truncated: boolean}`, with output in `content: [{type: "text", text}]` (2 items). A failing command such as `ls` on a missing directory is a tool **success** with `exit: 1`.
  - **edit:** `{path, oldString, newString, replaceAll?}` → `{files: [{file, patch, additions, deletions, status}], replacements}`
  - **write:** `{path, content}` → `{operation, target, resource, existed}`
  - **A failed tool** (an edit that did not match) has `error: {type, message}`.
  - The model did not call `list`; it used bash `ls`.
- **Ordering at completion.** Every display event, including the final `step.ended`, arrived before the session left `active`: about 70–80 ms before, and before the next 250 ms poll. Only `session.deleted` came later. Reconciliation is still kept as a safety net.
- **Discovered defect (affects Quoder's robustness, not Milestone 1's results).** When the session `directory` is the *non-canonical* `/var/folders/…` path while the server's cwd resolves to `/private/var/folders/…`, the **first** prompt on a fresh server is silently dropped. It is admitted, then goes idle with no assistant message and no error event (reproduced 3 of 3). Later prompts work, and the canonical path works first time (3 of 3). Quoder already passes a canonical root (Git's top level or `process.cwd()`), and the Milestone 1 runner turns such a stall into "OpenCode did not start a response" after 30 s.

**Decision**:
- Keep the global monitor as the source.
- Print activity lines on completion.
- Treat reasoning as optional.
- **Group 5 adds `realpath` canonicalization of the project root** in `resolveProject`, so the server cwd and session directory always match exactly.

## 2026-10-03 — Found while verifying Group 5: a closed output pipe orphaned the server

**Context**: A local check (`printf '/exit\n' | node dist/cli.js | head -1`, with no model call) made Quoder crash on an unhandled `EPIPE` `error` event on stdout. The crash skipped the orderly shutdown and left `opencode serve` running with parent PID 1. This defect predates Milestone 2: Milestone 1's harness had no output-error handling either. Every orphan this created was terminated after its identity was checked; a separate server owned by the developer's own running `quoder` was left untouched.

**Decision**:
- **CLI.** `process.stdout` and `process.stderr` `error` events now call `harness.terminate(141)`, the conventional SIGPIPE code, so the normal shutdown deletes sessions and closes the server.
- **Launcher safety net.** `launchAuthenticatedOpenCodeServer` registers a synchronous process-`exit` hook that sends SIGTERM to a still-running server child. The hook is unregistered when the child exits, and is injectable as `onProcessExit` for tests. Any Quoder process exit (an uncaught error, `process.exit`) therefore stops its server. Only a SIGKILL of Quoder itself can still orphan one.

**Verification**: A new launcher test covers the hook. Repeating the closed-pipe run twice left no orphan; 303 tests pass.

## 2026-10-03 — Multi-line prompts with Shift+Return (user request)

**Context**: The developer asked for Shift+Return to insert a line break without submitting the prompt. (They first wrote Command+Return, then corrected it.) Their terminal is iTerm2. Terminals encode Shift+Return in different ways, and by default many send the same `\r` as plain Return.

**Decision**:
- `src/harness/line-keys.ts` (`LineEndingKeys`) sits between the terminal and readline, in interactive mode only. It reports each line ending in order as `submit` (`\r`, `\r\n`) or `continue`, and forwards `\r` to readline.
- These count as `continue`: `ESC[13;2u` (CSI u / kitty), `ESC[27;2;13~` (xterm modifyOtherKeys), `ESC \r` (an iTerm2 key mapping, or Option+Return with Option as Meta), and a bare `\n` (Ctrl+J, or newlines in pasted text, so a pasted block becomes one prompt).
- The harness accumulates continued lines under a dim `…` continuation prompt aligned with `❯`, and submits them joined with `\n` on Return.
- Ctrl-C at a continuation line discards the unfinished prompt and keeps Quoder running.
- Because readline now reads through a filter, the harness puts the TTY into raw mode itself and restores it at shutdown.
- Piped input is unchanged: each line is one prompt.
- No terminal mode (kitty keyboard protocol, modifyOtherKeys) is switched on. Those modes also re-encode Ctrl+C and Ctrl+D, which readline relies on.

**Verification**:
- 4 unit tests (each encoding, ordering, pass-through) and 3 integration tests (continuation and submission, Ctrl-C discard, piped lines unchanged). 313 tests pass.
- A real pseudo-terminal check (`script`, with no model call): `/he`, then `ESC[13;2u`, then `lp` and Return were shown on two lines and submitted as one prompt.
- If iTerm2 sends a plain `\r` for Shift+Return, the developer adds a key mapping that sends `ESC [13;2u`. This is documented in the README in Group 8.

## 2026-10-03 — Shift+Return without terminal setup: the kitty keyboard protocol (supersedes part of the entry above)

**Context**: The developer pointed out that OpenCode and Codex get Shift+Return in iTerm2 with no configuration. Those tools request the kitty keyboard protocol. The previous entry rejected terminal modes because they re-encode Ctrl+C and Ctrl+D; that is solved by translating keys back, so asking the developer for an iTerm2 key mapping is withdrawn.

**Decision**:
- In interactive mode, the harness writes `CSI > 1 u` (push the "disambiguate" flag) at startup, and `CSI < u` (pop) at shutdown. A process-`exit` hook pops it if Quoder exits any other way. Terminals without the protocol ignore both.
- In that mode Shift+Return arrives as `CSI 13;2 u`. `LineEndingKeys` now decodes every `CSI <code>;<mods> u` key into legacy bytes for readline:
  - plain Return submits; modified Return continues;
  - Ctrl+letter and Ctrl+`[\]^_` become C0 controls (so Ctrl+C is `\x03` and Ctrl+D is `\x04`);
  - Esc becomes `\x1b`, Alt+key becomes `ESC key`, Shift+Tab becomes `ESC[Z`, and Alt+Backspace becomes `ESC DEL`;
  - keys with no legacy encoding are dropped.
- The legacy encodings (`ESC[27;2;13~`, `ESC \r`, `\n`) are still accepted.
- Ctrl+Z no longer suspends Quoder: readline's `SIGTSTP` gets a no-op listener. Suspending would leave the shell in raw mode with the keyboard protocol on.

**Verification**:
- 11 new decoding tests. The integration tests now send kitty-encoded Shift+Return and Ctrl+C, and check that the protocol is pushed and popped. 325 tests pass.
- A real pseudo-terminal run without a model call: `CSI > 1 u` was written at startup, `/he` with `CSI 13;2 u` and `lp` continued the prompt, a kitty-encoded Ctrl+D (`CSI 100;5 u`) exited, `CSI < u` was written at exit, and no server was left behind.
- Confirming in iTerm2 itself is part of QA's manual terminal check.

## 2026-10-03 — Cursor navigation in multi-line prompts deferred

**Decision**: The developer asked for cursor navigation across the lines of a multi-line prompt, to be implemented in the future rather than in Milestone 2. It is recorded in `docs/backlog.md`. That file is new: it is the single place for agreed but unscheduled work, and it points to the hardening items carried forward in earlier specs.
