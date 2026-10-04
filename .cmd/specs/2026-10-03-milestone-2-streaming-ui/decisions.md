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

## 2026-10-03 — Implementation choices that differ from spec.md (review cycle 1, warning 4)

**Context**: Review cycle 1 found four places where the implementation differs from `spec.md` and the difference was recorded only in `tasks.md`. Each is a deliberate choice, recorded here:
- **Reconciliation.** The spec renders only the missing remainder when the streamed text is a prefix of the final answer. Instead, `MarkdownStream.end(full)` already renders a missing tail for each text block from `text.ended`. At the end of the turn, `LiveView` compares the final step's streamed text with the authoritative answer. If they differ, it prints a dim note and then the **full** answer. Rendering only a Markdown remainder after already-printed blocks can produce broken formatting, for example half a list or a code fence. Printing the full answer always yields a correct answer, at the cost of some repetition in a rare case.
- **No runner `onEvent` sink.** Events reach the view directly from the event monitor (`onSessionEvent`), not through the session runner. The view finds the final message from the last `step.started`, which is the final assistant message, as verified in Group 1. The runner stays display-agnostic and unchanged. The Group 5 acceptance line "the runner exposes an `onEvent` sink" is satisfied in intent (the runner is unaware of display), not literally.
- **No `src/ui/status-line.ts`.** The status line is about 40 lines and needs the view's phase, reasoning and output state. It lives in `src/harness/live-view.ts`; `fitColumns` is exported for tests.
- **Cancelled status wording.** `– Execution cancelled after Xs. Harness session remains active.` replaces `✗ Cancelled after Xs · session deleted`. It follows FR-12's wording ("Execution cancelled.", "Harness session remains active.") and keeps cancellation visually distinct from failure (`–` in warning colour, not `✗` in error colour). Deletion is not claimed in that line: a failed deletion prints its own warning.

## 2026-10-03 — Review cycle 1 fixes (Fix Group 1)

**Decision and changes**:
- **Line endings (warning 1).** The ending queue is gone. `LineEndingKeys` forwards a continuation as `CONTINUE_MARK` (Ctrl+G, which readline ignores) followed by `\r`. The harness listens to keypresses (registered before readline's own listener): a `return` directly after the mark continues the prompt, and any other `return` submits it. Each decision is taken at the very keypress readline turns into a `line`, so no stale state can last.
  - Kitty Ctrl+J continues and Ctrl+M submits.
  - Kitty Esc is dropped, so under the kitty protocol Esc followed by Return still submits. In a legacy terminal, readline itself reads Esc and then Return or Ctrl+J as Meta+key: the Return is ignored and Ctrl+J submits. No state is left behind in either case.
  - A typed Ctrl+G (legacy or kitty) is dropped, so it cannot fake the mark.
  - Keypad Enter submits.
  - Input is decoded with `StringDecoder`, and a CSI sequence cut off at a chunk boundary is held for the next chunk; a lone ESC is not held.
- **Bracketed paste.** The earlier claim that pasted newlines arrive as `\n` was wrong: iTerm2 and xterm paste `\r`. The harness now also enables bracketed paste (`CSI ? 2004 h`/`l`, written and restored with the keyboard protocol). Every line break inside a paste continues the prompt, so a pasted block becomes one prompt and the developer submits it with Return.
- **Status line (warning 2).** Messages that can appear while a prompt runs now go through `LiveView.note`, which erases the status line first: "still running", "Still cleaning up", "Deleted N earlier sessions" and "server did not confirm termination". The test was checked to fail without the fix.
- **Markdown (warning 3).** Fences are recognized at any indentation. Inside a list, a blank line becomes a block boundary only once the next line is neither indented nor another item, so code blocks and paragraphs inside nested list items stream intact.
- **Suggestions adopted:**
  - The idle flush skips a table, and a line that could still become a setext heading.
  - A heading or rule after a flushed paragraph keeps its blank line.
  - Only the 10 Hz ticker advances the spinner. Events redraw only when the phase changes or the line was erased.
  - Truncation counts display columns, with wide and emoji characters taking 2.
  - Tests check that the harness's process-exit hook is removed at shutdown.
- **Not adopted:** a note for a non-final step whose `text.ended` disagrees with its stream. The final answer is reconciled, and intermediate step text is informational.

**Verification**: 345 tests pass (20 new). A real pseudo-terminal check without a model call covered Shift+Return, a bracketed paste of two lines that stayed one prompt, a kitty Ctrl+D exit, and both modes being restored.

## 2026-10-03 — Review cycle 2 fixes (Fix Group 2)

**Decision and changes**:
- **Stuck paste (warning 1).** The carry is decided after translation, once the paste state is known. Inside a paste, any trailing prefix of the end marker is held, a lone ESC included. Outside one, a started CSI sequence is held, but a lone ESC (the Esc key) is not. A held fragment is released after 50 ms if the rest never arrives. (Correction from review cycle 3: this did **not** end a paste whose end marker was late or lost. Fix Group 3 adds a paste timeout for that.)
- **Echo while busy (warning 2).** While a prompt runs, `LineEndingKeys` (`isBusy`) passes only Ctrl+C and Ctrl+D to readline, so typing is neither echoed over the status line nor queued. A Return while busy shows "Quoder is still running…" through the live view. The integration test now asserts that no status frame is ever followed by a newline, and was checked to fail without the fix.
- **Lists (warning 3).** Inside a list, a blank line ends the block when the next line is not indented past the list's markers: a new item at the list's level, or less indented text. The first visible character of that line is enough to decide. Only indented content (an item's paragraph, fence or nested item) keeps the block open. A loose list therefore prints item by item.
- **Suggestions adopted:**
  - An idle flush in a list never cuts into the item still being written, so a nested fence survives a flush.
  - Deeply indented fences are recognized only inside lists; outside a list such a line is an indented code block, as CommonMark says.
  - A stream that stalls right after a line break flushes everything except its last line.
  - Blank lines inside list items carry no trailing spaces.

**Known limitation (accepted)**: Printing a list item by item means the renderer cannot know that later items make the whole list "loose", or renumber it. Compared with rendering the full answer at once, a nested list may lack one blank line, and a source list numbered `3, 4, … 10` keeps the author's `10` instead of being renumbered. A comparison of streamed and one-shot output over 14 varied inputs and delta sizes 1, 2, 3, 7 and 1000 found only these two cosmetic differences.

**Verification**: 352 tests pass (7 new). A pseudo-terminal check without a model call covered Shift+Return, a paste whose end marker was split after its ESC, and a kitty Ctrl+D exit.

## 2026-10-04 — Review cycle 3 fixes (Fix Group 3) and a fourth review round

**Context**: Review cycle 3, the workflow's last, returned FAIL with two warnings. The developer chose to fix them and authorized one extra, focused review round beyond the three-cycle limit.

**Decision and changes**:
- **Late or lost paste end marker (warning 1).** While a paste is open, every chunk re-arms a 500 ms paste timeout (`pasteTimeoutMs`). When it expires, the paste ends: `#pasting` becomes false and any held part of the end marker is dropped. If the rest of that marker (for example `[201~`) arrives afterwards, it is removed rather than typed. A paste that is merely slow stays open as long as its chunks keep arriving.
- **A list after an intro line (warning 2).** `scan()` enters list mode on any list-item line in the block, not only on the block's first line. "Steps:\n1. …" therefore gets the same protection for nested fences and loose items.
- **Suggestions adopted:**
  - The idle-flush limit is the outermost open item (at the list's own indentation), so a flush never separates nested items from their parent.
  - A trailing `===` underline stays with the line it underlines.
  - A lone trailing ESC is now held too, outside a paste, for at most 50 ms. A paste start marker split right after its ESC is therefore recognized, and the Esc key is passed on after the hold.
- **Not adopted:** limiting the "still running" notice to once per run. It is harmless, and paste chunks during a run are rare.

**Verification**:
- 359 tests pass (7 new or changed): a late end marker, a lost end marker, a slow but complete paste, a split start marker, intro-line lists with nested fences, nested items across a flush, and a setext underline at a stall.
- The streamed-versus-one-shot comparison, extended with the reviewer's intro-line inputs (18 inputs, delta sizes 1, 2, 3, 7 and 1000), shows only the two accepted cosmetic differences.
- A pseudo-terminal check without a model call: an end marker arriving 700 ms late ended the paste, the stray remainder was dropped, Return submitted normally and Ctrl+D exited.

## 2026-10-04 — General review passed at cycle 4; suggestions carried forward

**Context**: Review cycle 4, an extra round the developer authorized, returned PASS with zero critical findings and zero warnings.

**Decision**: Do not change code after the passing review, because any change would need another review cycle. These suggestions are carried forward, all with low likelihood or cosmetic effect:
- **Paste timeout length.** Raise it from 500 ms to about 1.5–2 s. A paste with a gap of more than 500 ms between chunks (tmux over SSH, a paced paste) ends early. Recovering from a lost marker is never urgent.
- **Late end-marker remainder.** Drop it even when it arrives split across chunks. Today it is dropped only when it arrives in one piece.
- **Intro line before a list.** After an idle flush that stops at a list's first item, keep the blank line between an intro line and the list.
- **List mode in a paragraph.** Enter list mode mid-block only for bullets and `1.`/`1)`, as CommonMark allows. A line like `2024. was` inside a paragraph is otherwise rendered as a list item after a flush.
- **Quotes.** Blank quote lines are dropped when an idle flush falls inside a quote.

## 2026-10-04 — Security review cycle 1 fixes (Security Fix Group 1)

**Context**: Security review cycle 1 returned FAIL, with one Critical finding and one Warning. Both were confirmed.

**Decision and changes**:
- **Critical: character references decoded into control characters.** `marked`'s lexer decodes numeric character references in text (`&#27;` becomes ESC, `&#155;` becomes C1 CSI, `&#x202E;` a bidi override). That happens *after* Quoder's pre-lex sanitization. `renderMarkdown` now runs `sanitizeTokens` over the whole lexed token tree: every string field of every token is cleaned in place, recursively. This single choke point covers every block and inline type, present or future. Both the streamed (`MarkdownStream`) and reconciled (`LiveView` → `renderMarkdown`) paths go through it, and the pre-lex sanitization stays as a second layer. The misleading module comment is corrected.
  - **Tests:** 9 reference spellings (`&#27;`, `&#x1b;`, `&#x1B;`, `&#0027;`, `&#155;`, `&#x9b;`, `&#7;`, `&#x202E;`, `&#8238;`) across 13 contexts. The contexts cover paragraphs, ATX and setext headings, both list kinds, quotes, emphasis, tables, links and images, inline and block HTML, code spans, escapes and fences. Each is checked in plain and colour themes, and on the streamed path with 1-, 2- and 5-character deltas and periodic flushes. The output may contain no C0, C1 or bidi controls apart from Quoder's own SGR sequences. With `sanitizeTokens` disabled, 10 of these tests fail.
- **Warning: highlight.js CPU time on crafted input.** Highlighting runs on the event loop and blocked Ctrl-C (about 13 s for 80 KB of repeated C# tokens). A block is now shown plain when it exceeds `HIGHLIGHT_MAX_CHARACTERS` (8,000) or has a line longer than `HIGHLIGHT_MAX_LINE` (1,000). Measured worst case at the budget, in 80-column lines: C# 127 ms, SCSS 14 ms, YAML 9 ms, INI 6 ms. Reconciliation can highlight a block a second time, so the bound for that path is about 0.25 s.
  - **Tests:** a 60 KB pathological C# block renders plain in under 250 ms, ordinary blocks under the budget are still highlighted, and a block with a very long line is shown plain.

**Verification**: 372 tests pass; the typecheck is clean.

## 2026-10-04 — Security review cycle 2 fixes (Security Fix Group 2)

**Context**: Security review cycle 2 confirmed that both cycle 1 findings are resolved: 3,200 injection cases produced 0 escapes, and the highlighting worst case at the budget is 220 ms across all 36 languages. It found one new Warning in the same class as the highlighter one, plus one Suggestion.

**Decision and changes**:
- **Warning: nested emphasis cost quadratic CPU in colour.** Each inline level wrapped its content in another `styleText` call, which rescans the whole inner string. 2,000 `*` around a word (about 1,000 levels) took 1.1 s, and 6 KB took 3.7 s, all blocking Ctrl-C. Inline rendering now stops styling at `MAX_INLINE_DEPTH` (8): deeper content is shown as its sanitized source text, so output and time stay linear. Measured: 2,000 markers in 14 ms, 3,000 in 31 ms. Block rendering likewise stops at `MAX_BLOCK_DEPTH` (16) nested lists or quotes.
- **Suggestion adopted: stack overflow on deep nesting.** `renderMarkdown` catches any rendering failure, for example the lexer's own recursion overflowing on about 4 KB of `- ` nesting, and falls back to the sanitized plain text. Model text can no longer be dropped from the display, or end the harness through `LiveView.finish`.
- **Tests.**
  - Emphasis with `*` and `_`, in a heading and in a link label, at 2,000 markers: under 300 ms in colour, and output under 4× the input. The size is chosen so the uncapped renderer is slow, not overflowing; with the cap removed these 4 tests fail at about 1.1 s each.
  - 6,000 markers, which overflow the stack.
  - Deeply nested bullets, numbers, quoted lists and quotes: on both the one-shot and streamed paths, rendering never throws and never drops the text.

**Verification**: 382 tests pass; the typecheck and build are clean.

## 2026-10-04 — Security review cycle 3 fixes (Security Fix Group 3) and a fourth security round

**Context**: Security review cycle 3, the workflow's last, returned FAIL with three Warnings. Each is a way for crafted model output, steered by a prompt-injected file, to overload the synchronous renderer:
1. A huge GFM table (4,000 × 4,000, about 32 KB) exhausts the V8 heap and aborts the process, skipping every exit hook.
2. A small source can produce enormous output: a reference link used thousands of times, or one long table cell padding every row, written synchronously to the blocking TTY.
3. `marked`'s emphasis tokenizer is quadratic in `*`/`_`/`~` delimiters: 40 KB took about 7 s.

The developer chose one systemic rendering budget, plus one extra security round beyond the three-cycle limit.

**Decision and changes** (`RENDER_BUDGET` in `src/ui/markdown.ts`):
- **Budget before lexing (Warnings 1 and 3).** `renderMarkdown` shows a chunk as sanitized plain text, without lexing, when:
  - it is larger than 128 KB;
  - it has more than 1,000 emphasis delimiters outside code fences (measured: 1,000 cost at most 44 ms; 2,000 cost 170 ms; fences and plain text lex in about 1 ms even at 64 KB, so `snake_case` code does not count);
  - a table line has more than 64 columns, or the table would have more than 10,000 cells.
- **Bounded output (Warning 2).**
  - Displayed link URLs are cut to 200 characters, and table columns to 120. A wider cell is shown truncated and unstyled.
  - As a backstop, rendered output larger than 10 times its source plus 4 KB is replaced by the sanitized plain text.
- **Per-block rendering.** `MarkdownStream.push` now renders each completed block on its own, rather than everything completed by one push in a single chunk. `LiveView`'s reconciliation renders the authoritative answer through a `MarkdownStream` instead of one `renderMarkdown` call, so the budget applies block by block and a long answer keeps its formatting.
- **Failure fallback.** Any over-budget or failed render shows the sanitized source as plain text. Nothing is dropped, and the harness never ends because of it.

**Tests**:
- A 4,000 × 4,000 table renders in under 200 ms, one-shot and streamed, with output under 2 times the source.
- A reference link used 10,000 times, and a table with one 10 KB cell over 10,000 rows, both stay within the expansion bound.
- `*a ` × 13,000, `*` × 40,000 and `__` × 20,000 render in under 200 ms, one-shot and per push.
- Long URLs are shortened.
- Ordinary content still formats normally, including a code block with 800 underscores.
- An over-budget chunk with an embedded OSC 52 is shown plain, sanitized and complete.
- A 300-paragraph unstreamed answer is reconciled with its formatting.

**Verification**: 392 tests pass. The streamed-versus-one-shot comparison is unchanged: only the two accepted cosmetic differences remain.

## 2026-10-04 — Security review cycle 4: Markdown rendering isolated in a worker (Security Fix Group 4) and a fifth security round

**Context**: Security review cycle 4, an extra round, returned FAIL with four Warnings. All four bypassed the rule-based rendering budget:
- a fence the budget recognized but `marked` did not;
- `marked`'s quadratic link and image opener path;
- O(uses × href) work for reference links;
- pipe-less GFM table rows.

Each let crafted output block the event loop for 3–8 s, or crash Quoder on a low-heap machine. Two rounds had shown that rules placed in front of the lexer leak. The developer chose to isolate rendering in a worker thread and authorized a fifth round.

**Decision and changes**:
- **`src/ui/isolated-render.ts` (`IsolatedMarkdownRenderer`).** Each Markdown chunk is rendered in a worker thread (`src/ui/render-worker.ts`, using the protocol in `src/ui/render-protocol.ts`):
  - **Hard deadline.** The main thread posts the chunk, then waits for the reply with `Atomics.wait` for at most `RENDER_DEADLINE_MS` (200 ms) and reads it with `receiveMessageOnPort`. The API stays synchronous, so output order with tool lines is unchanged.
  - **Failure handling.** On a timeout, a worker death or a render error, the chunk is shown with `plainMarkdown` (sanitized plain text). A stuck or dead worker is terminated and a new one started in the background; chunks are shown plain until it reports ready. The main thread never waits for a worker to start.
  - **Memory isolation.** The worker runs with `resourceLimits` (256 MB old generation), so running out of memory kills only the worker. Quoder survives, and its exit hooks still restore the terminal and stop the server.
  - **Startup and shutdown.** The CLI starts the worker at launch, so it is ready before the first answer. The worker is `unref`'d and never keeps Quoder alive.
- **Per-stream budget.** `MarkdownStream` accepts a renderer and a `STREAM_RENDER_BUDGET_MS` (1 s) total budget per stream: per text block, and for the reconciled answer. After the budget is spent, the stream's remaining chunks are shown plain, so many slow chunks cannot add up to a long freeze. A renderer that throws also falls back to plain text.
- **Unchanged layers.** The rule-based `RENDER_BUDGET`, the depth caps and token sanitization remain inside `renderMarkdown`, which now runs in the worker, as cheap first filters. `truncate` is now O(max). Tests and the harness use in-process `renderMarkdown` unless the CLI injects the isolated renderer (`HarnessOptions.renderMarkdown` → `LiveViewOptions.render`).

**Verification**:
- **Against the built CLI modules** (scratch, no model calls), every round 3 and round 4 shape returned within about 206 ms as plain text: the fence bypass with 40 KB of `*a `, 125 KB of `![](`, a 60 KB href used 16,000 times, and 64,000 pipe-less table rows. A timer queued during a slow chunk was delayed by only about 206 ms, the Ctrl-C response bound. Normal Markdown is still formatted in about 11–15 ms, including right after a respawn.
- **Out of memory.** With a 48 MB limit, the worker died of out-of-memory; the main process survived, showed the chunk plain and recovered with a new worker.
- **Tests** (401 pass), using a protocol-compatible test worker (`tests/fixtures/render-worker-fixture.mjs`):
  - rendering and colour pass-through;
  - a spinning worker and a dying worker, each abandoned within the deadline and then recovered;
  - an out-of-memory worker, survived;
  - real `marked` on `![](` × 31,000, bounded by the deadline;
  - a failed render, a not-yet-ready worker and a closed renderer, each giving sanitized plain text;
  - the per-stream budget and a throwing renderer in `MarkdownStream`;
  - `LiveView` routing both text blocks and reconciliation through the injected renderer.

## 2026-10-04 — Security review cycle 5 fix (Security Fix Group 5) and a short sixth round

**Context**: Security review cycle 5 confirmed the worker isolation on the real production wiring:
- every earlier freeze shape now returns in about 200 ms;
- a worker out-of-memory crash is contained;
- kill-and-respawn churn leaks nothing;
- output ordering matches in-process rendering;
- nothing bypasses the isolated renderer.

It found one Warning: the plain-text fallback that the isolation relies on runs on the main thread, and trimmed trailing newlines with `/\n+$/u`. V8 runs that pattern in quadratic time on a long run of newlines (or `\r`, which sanitization turns into `\n`) that is not at the end of the string, so 200 KB took 14 s. The developer chose to fix it and run a short sixth round.

**Decision and changes**:
- `trimTrailingNewlines` is a linear loop. It replaces all four `\n+$` uses in `src/ui/markdown.ts`: `plainMarkdown`, `plainSource`, HTML block text and the default raw-token case.
- An audit of the other end-anchored patterns that run on chunk text on the main thread (`FENCE_CLOSE`, `RETROACTIVE_LINE`, `STANDALONE_BLOCK`) found that each is anchored at the line start and runs on a single line, so none can backtrack quadratically. `sanitizeForTerminal` was measured linear in cycle 5.
- **Suggestions recorded, not adopted:**
  - `scan()` rescans the pending block on every delta, which costs O(n²/delta) in total. No single call takes more than about 43 ms, and the cost is paced by the model's output rate.
  - A dead worker is noticed only when the deadline expires. That is harmless at the fixed 200 ms.

  Both are recorded in `docs/backlog.md`.

**Verification**: 405 tests pass. With the old regex restored, the new time-bounded tests take about 14 s and fail; with the loop they pass in under 50 ms.

## 2026-10-04 — Security review cycle 6 fix (Security Fix Group 6) and a main-thread regex audit

**Context**: Security review cycle 6 confirmed the cycle 5 fix: every newline and `\r` case now takes under 5 ms on every path. It found one Warning of the same class. `FENCE_OPEN`/`FENCE_OPEN_IN_LIST` (`/^…(`{3,}|~{3,})([^`]*)$/u`) runs in `scan()` on the main thread for every line on every delta. Because both `~{3,}` and `[^`]*` match `~`, a long tilde run ending in a backtick backtracks quadratically: 100 KB took 3.6 s, repeated on every later delta.

**Decision and changes**:
- `fenceOpening()` replaces both regexes. It matches the leading run with `/^([ \t]*)(`{3,}|~{3,})/u`, which has no end anchor and is linear. It then checks the indentation (at most 3 spaces outside a list) and, for a backtick fence only, uses `line.includes("`")` for the info string. The CommonMark semantics are unchanged: a tilde fence may have backticks in its info string, and a backtick fence may not.
- `LineEndingKeys`' partial-sequence check now inspects only the text after the last ESC. That input is the developer's own keyboard and paste, outside the model trust boundary, but the change makes it linear at no cost.
- **Audit and fuzz (in place of reasoning about each regex alone).** Every main-thread path over model text was fuzzed: `MarkdownStream` push, flush and end with a plain renderer, `plainMarkdown`, `sanitizeForTerminal`, `sanitizeLine`, and the bash activity summary.
  - **Inputs:** 1,793 shapes, each a run of one to three significant characters (`` ` ~ space tab - * _ = | # > 1 . ) \n \r ESC [ ; ] a BEL \ + 0 ``) about 60 KB long, followed by every breaker character. Each shape was tried in 7 contexts: plain, list item, ordered item, quote, indented, inside a fence, and inside a table.
  - **Result:** the slowest single call was 25 ms. The remaining patterns (`FENCE_CLOSE`, `RETROACTIVE_LINE`, `STANDALONE_BLOCK`, `LIST_ITEM`, `indentOf`, the setext and gap checks, and the `terminal-text.ts` patterns) have disjoint classes or start anchors, which agrees with the cycle 6 reviewer's own audit.

**Verification**: 409 tests pass. The new time-bounded tests cover a 200 KB tilde run ending in a backtick (plain and in a list) and a backtick run with a later backtick. With the old regex restored they take about 28 s each and fail; with the fix they finish in under 100 ms. The streamed-versus-one-shot comparison is unchanged.

## 2026-10-04 — Security review passed at cycle 7

**Context**: Security review cycle 7, a short round authorized by the developer, returned PASS with zero critical findings and zero warnings. It verified:
- the cycle 6 fix on production wiring (a tilde run that took 14.3 s per delta now takes under 8 ms);
- `fenceOpening()`'s agreement with `marked`, and that no text is lost or duplicated (20,000 random sources);
- an independent fuzz of 103,257 shapes over every main-thread text path (worst 37 ms at 200 KB);
- the cycle 1 injection fix (2,200 outputs, 0 escapes).

**Decision**: The security gate is closed. Its only open item is the incremental `scan()` suggestion, recorded in `docs/backlog.md`.

**Summary of the security gate**:
- Seven cycles found and fixed one Critical and nine Warnings:
  - **Escape injection:** character references were decoded after sanitization.
  - **Event-loop freezes and an out-of-memory crash** from crafted model text: `highlight.js` cost, nested `styleText`, `marked` quadratics, table and link amplification, and quadratic main-thread regexes.
- The structural outcomes are:
  - token-tree sanitization after lexing;
  - Markdown rendering isolated in a worker with a hard 200 ms deadline per chunk, a 1 s budget per stream and a 256 MB memory limit;
  - linear main-thread code, checked by fuzzing.
