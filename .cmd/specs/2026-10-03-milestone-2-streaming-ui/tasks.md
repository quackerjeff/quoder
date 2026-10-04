# Tasks: Milestone 2 — Streaming and Live Activity

Spec: `.cmd/specs/2026-10-03-milestone-2-streaming-ui/spec.md`

Groups run in order. No task authorizes a real-model run (Group 1 diagnostics, `verify:harness`, `verify:live`) without the user's explicit authorization.

## Group 1: Verify streaming contracts (diagnostics only)

- [x] Capture live event shapes and ordering | `docs/tech.md`, `.cmd/specs/2026-10-03-milestone-2-streaming-ui/decisions.md`
  - **Accept**: Bounded scratch diagnostics (outside the repository, sanitized output, full cleanup) with `ollama/glm-4.7-flash:latest` record:
    - **Global stream coverage.** Whether the global stream carries `text.delta`, `reasoning.delta`, `tool.input.*`, `tool.called`, `tool.success`/`.failed` and `step.*` for a session.
    - **Delta rate.** Delta count and rate per turn.
    - **Reasoning.** Whether glm emits reasoning events.
    - **Tool shapes.** The `input` and `structured` field names for `read`, `edit`, `write`, `bash`, `grep`, `glob` and `list`, plus the bash exit code and output fields.
    - **Ordering.** The order of the last stream events relative to the session leaving `active`.

    Only field names, counts and timings are kept; no model text is kept.
  - **Constraints**: No repository source changes. If deltas are missing from the global stream, record that and switch the design to per-session `session.events`.
  - **Completed evidence** (four runs; details in `decisions.md`):
    - The global stream carries every display event, and all of them arrive before the session leaves `active`.
    - Deltas are token-sized, at about 75 per second.
    - glm via `ollama` emits no reasoning events.
    - Tool calls run in parallel, so activity lines are printed on completion.
    - Tool shapes are recorded.
    - **Discovered:** a non-canonical session directory drops the first prompt on a fresh server. Group 5 canonicalizes the project root.

## Group 2: Dependencies and style foundation

- [x] Add pinned `marked` and `highlight.js`; add `src/ui/style.ts` | `package.json`, `package-lock.json`, `src/ui/`, `tests/unit/`
  - **Accept**:
    - Both dependencies are exact-pinned, with no transitive dependencies. Licences are recorded in `docs/tech.md`.
    - Colour detection honours TTY, `NO_COLOR`, `FORCE_COLOR` and `--no-color`. Without colour, every role is the identity function.
    - `quoder --no-color` is parsed.
  - **Completed evidence**:
    - `marked@18.0.14` (MIT) and `highlight.js@11.12.0` (BSD-3-Clause) are exact-pinned, with no dependencies or install scripts of their own (`npm ls` shows only those two).
    - `src/ui/style.ts`: semantic roles, `createTheme` and `colorEnabled`. A plain theme is the identity function.
    - `--no-color` is parsed. It is wired into the harness in Group 5.
    - Typecheck clean, 238 tests passing, build clean.

## Group 3: Event model and activity summaries

- [x] Add `stream-events.ts` (narrowing) and `activity.ts` (tool lines) | `src/harness/`, `tests/unit/`
  - **Accept**:
    - Malformed or unknown payloads are dropped or shown generically, never thrown.
    - Every untrusted field is sanitized and truncated.
    - Paths are shown relative to the project root when inside it.
    - Unit tests cover each verified tool shape and its fallbacks.
  - **Completed evidence**:
    - `narrowStreamEvent` maps the verified `session.next.*` payloads to a typed `StreamEvent` union. It drops non-display events, malformed payloads and payloads missing IDs, and tolerates malformed optional fields.
    - `summarizeCall`, `summarizeResult`, `renderActivity` and `runningLabel` cover `read`, `edit`, `write`, `bash` (non-zero exit is a warning), `grep`, `glob`, `list`, `webfetch`, `task` and `todowrite`, with a generic fallback.
    - Subjects and details are sanitized, collapsed to one line and truncated to 80 characters before styling.
    - 29 new unit tests; 267 tests in total.

## Group 4: Markdown and highlighting

- [x] Add the incremental block renderer and highlighter | `src/ui/markdown.ts`, `src/ui/highlight.ts`, `tests/unit/`
  - **Accept**:
    - Blocks print once complete, and a growing paragraph flushes at line boundaries after an idle interval.
    - `text.ended` finalizes a block.
    - Code fences are highlighted for the registered languages and printed plainly otherwise.
    - Highlighter output is sanitized.
    - Without colour, the renderer prints readable plain text.
  - **Completed evidence**:
    - `renderMarkdown` renders headings, paragraphs, emphasis, strikethrough, inline code, links, images, lists (nested, ordered, loose, task), blockquotes, tables (aligned columns), rules and code fences. It uses the `marked` lexer only, and source is sanitized before lexing.
    - `MarkdownStream` prints blocks as they complete: after a blank line, a closing fence, or a heading or rule line. `flushLines` prints a slow paragraph's complete lines and continues it without a gap. Fences wait for their closing fence. `end(full)` renders a missing tail and returns false when the text does not match.
    - The output is identical for delta sizes 1, 3, 7 and 64.
    - `highlightLines` uses highlight.js `lib/common` (36 languages, about 19 ms to load), the fence language only, and per-line styling. Entities are decoded and every piece is re-sanitized. A test checks that coloured output contains only SGR sequences.
    - 17 new tests; 284 tests in total.

## Group 5: Live view and harness integration

- [x] Wire the monitor, runner and live view; add status line, final status, reconciliation and cancellation display | `src/event-monitor.ts`, `src/harness/`, `src/ui/status-line.ts`, `src/cli.ts`, `tests/`
  - **Accept**:
    - The monitor forwards own-session `session.next.*` events.
    - `resolveProject` canonicalizes the project root with `realpath`, and a unit test covers a symlinked launch directory.
    - The runner exposes an `onEvent` sink, and completion logic is unchanged.
    - On a TTY, the status line animates and is erased before permanent output. Piped output has no cursor control.
    - Reconciliation guarantees the full final answer is shown.
    - Cancellation output matches FR-12.
    - The trace gains `stream.first-text` and `activity.tool` (names and counts only).
    - All Milestone 1 integration tests still pass, and new integration tests cover TTY, piped output, mid-stream cancellation and a missed delta.
  - **Completed evidence**:
    - `startEventMonitor` gains `onSessionEvent` for own-session `session.next.*` events.
    - `src/harness/live-view.ts` (`LiveView`) provides:
      - the TTY status line: spinner, phase, elapsed time, model and reasoning preview. It is redrawn at 10 Hz, truncated to `columns - 1`, and erased before permanent output;
      - streamed Markdown for each text block;
      - an idle flush after 400 ms;
      - tool lines when tools finish, with unfinished tools marked cancelled;
      - blank lines between text and tool output;
      - reconciliation of the final step's streamed text with the authoritative answer. The full answer is printed when nothing was streamed, or after a note when the stream was incomplete.
    - The runner itself is unchanged: completion and final-answer selection are as in Milestone 1. The view finds the final message from the last `step.started`, so the runner needs no `onEvent` sink.
    - `formatResult(result, theme, stats)` no longer repeats the answer. It prints notes and the reason the turn ended, then the status line: `✓ Done in Xs · N tools · Nk tokens`, `– Execution cancelled after Xs. Harness session remains active.`, `✗ Failed after`, or `! Stopped after`.
    - The banner, prompt (`QuackTrack ❯`) and notices are coloured. `--no-color`, `NO_COLOR` and `FORCE_COLOR` are wired through `colorEnabled`.
    - The trace adds `stream.first-text` and `activity.tool` (tool name only).
    - `resolveProject` uses `realpath`, with a symlink test.
    - **Found and fixed:** a closed output pipe crashed Quoder on `EPIPE` and orphaned the server (a defect from Milestone 1). The CLI now terminates cleanly with code 141 on an output error, and the launcher's process-exit hook stops a live server. Details are in `decisions.md`.
    - 303 tests pass (302 before the fix), including 5 new integration tests (stream order without a repeated answer, missed delta, unstreamed answer, mid-stream cancellation, TTY status line within width), 10 live-view unit tests and a rewritten format suite.

## Group 5a: Multi-line prompts (user request, 2026-10-03)

- [x] Shift+Return inserts a line break without submitting | `src/harness/line-keys.ts`, `src/harness/repl.ts`, `src/harness/format.ts`, `tests/`
  - **Accept**:
    - In an interactive terminal, Shift+Return (CSI u, modifyOtherKeys, or ESC Return) and Ctrl+J or pasted newlines continue the prompt on a `…` line.
    - Return sends all lines as one prompt.
    - Ctrl-C at a continuation line discards the prompt and keeps Quoder running.
    - Piped input is unchanged.
    - Raw mode is set and restored by the harness.
    - `/help` documents the key.
  - **Completed evidence**:
    - The first version added 7 tests (313 in total).
    - Revised the same day (see `decisions.md`): Quoder now requests the kitty keyboard protocol, as OpenCode and Codex do, so Shift+Return works in iTerm2 without configuration. Kitty-encoded keys are decoded back to legacy bytes for readline, the protocol is popped on every exit, and Ctrl+Z no longer suspends.
    - 325 tests pass, and a real pseudo-terminal check without a model call succeeded.
    - Manual confirmation in iTerm2 belongs to QA.

## Group 6: Live acceptance check

- [x] Extend `verify:harness` | `scripts/verify-harness.ts`
  - **Accept**:
    - New rows: streamed before completion, tool activity observed (a seeded file is read), and cancel and continue (SIGINT during a long prompt, a verified deletion, and the next prompt answers).
    - The final line becomes `Milestone 2 Exit Criterion: MET/NOT MET`.
  - **Completed evidence** (implementation only; the live run belongs to QA in Group 7 and needs the user's authorization):
    - Four prompts run in one harness process. The project is a canonical temporary directory seeded with `notes.txt`, and the trace file is kept outside the project, so the model's tools never see it.
    - The trace is split per prompt at each `session.created`.
    - New rows:
      - **Streamed before completion:** every answered prompt recorded `stream.first-text` before its `prompt.completed`.
      - **Tool activity observed:** prompt 2 recorded at least one `activity.tool`.
      - **Cancel and continue:** SIGINT is sent only while prompt 3 is provably running (created and not completed), after its first text or after a 15 s fallback. Prompt 3 must be `cancelled` and its session verified deleted, and prompt 4 must answer.
    - The expected outcomes are `answered, answered, cancelled, answered`.
    - Both exit-criterion lines are printed, and the script's exit status follows Milestone 2.
    - `tsc` passes for the live config, and `build:live` succeeds.

## Group 7: Review, security review, QA

- [ ] Run the general review (up to 3 cycles), the security review and QA (including an authorized `verify:harness` and a manual terminal check) | spec directory
  - **Accept**: The reports are persisted verbatim and all three gates pass.

## Group 8: Documentation and closure

- [ ] Update `README.md`, `docs/tech.md` and `SYSTEM_CONTEXT.md` (material facts only); add a closing decision; remove `currentspec.md`
