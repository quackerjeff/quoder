# Milestone 2 — Streaming and Live Activity

## Context

Milestone 1 passed and was merged on 2026-10-03 (`4bc291b`). The `quoder` shell works, but the developer tried it and found two problems:

- **The wait is silent.** Nothing is shown until the turn ends.
- **The output is monochrome.** It is plain and hard to scan.

`docs/requirements.md` defines Milestone 2 ("Streaming and Cancellation"):

- **Features.** Streaming text output, tool activity, file activity, shell command display, execution status, and Ctrl-C cancellation.
- **Exit criterion.** The developer can observe OpenCode activity in real time and safely cancel an execution without exiting the harness.

Relevant requirements:

- **FR-6** (streaming): consume structured OpenCode events, not scraped terminal output.
- **FR-12** (cancellation): cancel without terminating the harness. Milestone 1 already implements abort-and-return.
- **NFR-1** (isolation behind the adapter) and **NFR-6** (low overhead).

## Decision

User decisions (2026-10-03):

1. **A styled line shell now, a full-screen TUI possibly later.** Keep the scrolling readline shell and add colour, a live status line with a spinner, coloured tool, file and shell activity, and streamed answer text. The display logic stays separate from the event model, so a later full-screen TUI can reuse the event model.
2. **Render Markdown.** Show answers as terminal Markdown (headings, emphasis, lists, quotes, inline code), with syntax-highlighted code blocks.
3. **Reasoning: dimmed and collapsed.** While the model reasons, the status line shows a dim "Thinking…" with a short live preview of the reasoning. The reasoning text is not kept in scrollback.

## Constraints

- Keep exact `opencode-ai@1.18.33` and `@opencode-ai/sdk@1.18.33`, and keep `--pure`. Do not modify the user's OpenCode configuration.
- **All Milestone 1 guarantees still hold:**
  - a fresh session per prompt;
  - verified deletion after every prompt, including after errors and cancellation;
  - no permission is ever granted (requests are rejected and reported, questions rejected and shown);
  - one sequential input loop;
  - one memoized shutdown.

  **Streaming is display only.** Completion is still decided by `session/active` plus the final assistant message, and the authoritative answer is still the last completed assistant message.
- **Untrusted text.** Every model- or tool-originated string (text, reasoning, tool input, tool output, paths, commands) passes through `sanitizeForTerminal` or `sanitizeLine` *before* Quoder adds its own styling. Highlighter output is treated the same way.
- **Colour and spinner only on an interactive terminal.** They appear only when output is a TTY with colour support. `NO_COLOR` and `--no-color` disable colour, and `FORCE_COLOR` is respected. Piped output gets plain, line-oriented text with no cursor control, so `verify:harness` and scripts stay stable.
- **New dependencies are minimal, exact-pinned and have no dependencies of their own:**
  - `marked` (a Markdown lexer only);
  - `highlight.js` (core plus a registered set of common languages).

  Colours use Node's built-in `util.styleText`.
- No prompt text, model text or tool output in trace files or tracked artifacts. The trace gains only fixed event names and counts.

## Design

### Event source

The run-long global event monitor is already connected (via `server.connected`) before any session exists. It gains an `onSessionEvent` callback for the `session.next.*` events of Quoder's own sessions. No per-session stream is opened, so no early event can be missed and no extra subscription is needed. Group 1 verifies live that the global stream carries the text, reasoning and tool events, which are not durable.

The events consumed, with their declared payloads in `@opencode-ai/sdk` 1.18.33 (`v2/gen/types.gen.d.ts`):

| Event | Payload used | Display |
|---|---|---|
| `step.started` | `assistantMessageID`, `model` | status: "Thinking…" |
| `reasoning.delta` / `.ended` | `delta` | dim, collapsed preview in the status line |
| `text.delta` / `.ended` | `textID`, `delta`; `text` on end | streamed Markdown |
| `tool.input.started` | `callID`, `name` | status: "Preparing <tool>…" |
| `tool.called` | `callID`, `tool`, `input` | one activity line (see below) |
| `tool.success` / `.failed` | `callID`, `structured`, `content`, `error` | the line's result (✓, ✗, short summary) |
| `step.ended` | `tokens`, `finish` | accumulated for the final status |
| `step.failed`, `retried` | `error`, `attempt` | a warning line |

### Activity lines

Models issue tool calls in parallel: one step can emit every `tool.called` before any result arrives (verified in Group 1). Each tool's permanent line is therefore printed when the tool **finishes**, with its result. While tools run, the status line names them (for example, "Running cargo test", or "Running 3 tools"). Any open text is flushed before an activity line.

Each tool is summarized by a pure, unit-tested function from `{tool, input, structured}` to a short line. Untrusted fields are sanitized and truncated. Paths are shown relative to the project root when they are inside it.

```text
● Read   src/import.rs
✎ Edit   src/import.rs
+ Write  tests/import_test.rs
$ Run    cargo test
  └ exit 0 · 47 tests passed            (last non-empty output line, dim)
⌕ Search "fn import" in src/
◆ Task   Investigate failing test
✗ Read   /etc/hosts  — permission rejected
```

Unknown tools are shown generically (`· <tool>`). The verified shapes are recorded in `decisions.md`:
- `read`, `write` and `edit` use `input.path`; edit counts come from `structured.files[].additions` and `.deletions`.
- `bash` uses `input.command` and `structured.exit`; its output is `content[].text`.
- `grep` and `glob` use `input.pattern`, with a count of `structured.value.length`.

Fields that are missing fall back to the generic line. A bash command with a non-zero exit is a tool *success* and is shown with a warning colour and its exit code.

### Streamed text and Markdown

Text deltas are buffered per `textID`. A block-level renderer, built on the `marked` lexer, prints each Markdown block once it is complete: a paragraph after a blank line, or a fenced code block after its closing fence. The unfinished tail stays buffered. A paragraph that keeps growing without a blank line is flushed at a line boundary after a short idle interval, so slow text never looks stalled.

On `text.ended`, the block is finalized from the event's full `text`. Code blocks are highlighted with `highlight.js` using a fixed language set. The language is taken from the fence info string, with no automatic detection beyond that set.

**Reconciliation.** When the turn ends, the final answer (from messages, as in Milestone 1) is compared with what was streamed for that message:

- If the streamed text is a prefix of the final answer, only the remainder is rendered.
- Otherwise a dim note is printed and the full final answer is rendered.

This keeps the answer complete even if a delta was missed.

### Status line (TTY only)

A single ephemeral line shows:

- a spinner;
- the phase: Thinking, Writing, Running `<tool>`, Waiting for model;
- the elapsed time;
- the model.

During reasoning, it also shows a dim preview of up to the terminal width. It is redrawn at 10 Hz with `\r` and clear-line, and is erased before any permanent line is printed. When the turn ends it is replaced by a final status line:

```text
✓ Done in 41.8s · 4 tools · 12.3k tokens
✗ Cancelled after 6.2s · session deleted
```

The Milestone 1 notes (rejected permission or question, deletion warning) keep their wording, with colour added.

### Colour theme

`src/ui/style.ts` holds:

- semantic roles: prompt, accent, dim, success, warning, error, tool, path, command;
- colour detection;
- a no-colour fallback in which every role is the identity function.

The prompt label is coloured (`QuackTrack ❯`), and the banner is condensed and coloured.

### Cancellation (FR-12)

The Milestone 1 behaviour is unchanged: interrupt, settle, delete, return. The display now:

- erases the status line;
- prints "Cancelling OpenCode execution…";
- marks unfinished tool lines as cancelled;
- prints the final status line;
- ends with "Harness session remains active." as in FR-12.

### Module structure

- `src/harness/stream-events.ts`: narrows untrusted `session.next.*` payloads into a typed `StreamEvent` union. This is the event model a future TUI would reuse.
- `src/harness/activity.ts`: tool-line summaries.
- `src/ui/style.ts`, `src/ui/markdown.ts`, `src/ui/highlight.ts`, `src/ui/status-line.ts`: presentation.
- `src/harness/live-view.ts`: consumes `StreamEvent`s and the runner's lifecycle, and writes to the output stream.
- The session runner gains an optional `onEvent` sink. It stays display-agnostic.

### Verification

- **Unit tests:**
  - event narrowing (including malformed payloads);
  - tool summaries;
  - Markdown blocks, including incremental flushing;
  - highlight-to-ANSI conversion and sanitizing;
  - style detection;
  - status-line rendering;
  - reconciliation.
- **Integration tests:** the fake OpenCode stream emits deltas and tool events. Cover TTY and piped output, cancellation mid-stream, and a missed-delta reconciliation.
- **`npm run verify:harness`** gains rows:
  - **Streamed before completion:** the trace records `stream.first-text` before `prompt.completed`.
  - **Tool activity observed:** a prompt that reads a seeded file records `activity.tool`.
  - **Cancel and continue:** SIGINT during a long prompt yields a cancelled outcome and a verified deletion, and the next prompt still answers.
- **Manual QA in a real terminal:** colour, spinner, Markdown and Ctrl-C.

## Risks

- **Event coverage on the global stream.** If deltas are missing there, fall back to the per-session `session.events` stream opened before the prompt. Group 1 decides this.
- **Terminal rendering differences.** Wide characters and narrow terminals affect the status line. It is truncated to `columns - 1` and never wraps; piped mode avoids cursor control.
- **Highlighting cost.** Only a fixed set of languages is registered, keeping startup fast (NFR-6).
- **Partial Markdown.** Unfinished constructs can look wrong until their block completes. Mitigation: block-level flushing and finalization from `text.ended`.
- **Model output volume.** Very long tool outputs are never printed in full; only a one-line summary.
