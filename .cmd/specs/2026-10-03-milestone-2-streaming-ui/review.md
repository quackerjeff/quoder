# Review: Milestone 2 — Streaming and Live Activity

## Cycle 1 — 2026-10-03
Reviewing: Groups 1–6 and 5a

### Critical
None.

### Warning
- **[src/harness/line-keys.ts:43-48, :68-75; src/harness/repl.ts:195, :226] Line endings can pair with the wrong readline `line` event, and the mismatch can last for the rest of the session.** The filter queues one ending for each `\r` it recognises, and `#receive` takes the next one off the queue for each readline `line`. The pairing breaks in three ways:
  1. **Unreported line breaks.** Kitty-encoded Ctrl+J (`CSI 106;5u`) and Ctrl+M (`CSI 109;5u`) are decoded into raw `\n` and `\r`, and no ending is reported for them. Readline still emits a `line` for each.
  2. **Reported endings with no `line`.** Readline emits no `line` for ESC followed by CR, so the reported `submit` is never used and stays in the queue.
  3. **Effect on Ctrl+J.** In a terminal that uses the kitty protocol (iTerm2, as wired), Ctrl+J therefore submits the prompt. The 5a acceptance and `decisions.md` say it continues the prompt.

  Scratch reproduction: `npm run build`, then `/private/tmp/claude-501/m2review/keys.mjs` and `keys2.mjs`. These pipe `LineEndingKeys` into `readline.createInterface({terminal:true})` with the same queue logic as the harness:
  - `one` + `CSI 106;5u` + `two\r`: `one` is submitted.
  - `a` + `CSI 109;5u` + `b` + `CSI 13;2u` + `c\r`: `a` gets `continue`, and `b` (typed before Shift+Return) gets `submit`.
  - `abc`, then Esc (`CSI 27u` or legacy `\x1b`) and Return within readline's 500 ms escape timeout, then `x` + Shift+Return + `y\r`: `abcx` is submitted early, `y` becomes a continuation line, and a stale `submit` stays in the queue. From then on every Return continues the prompt and every Shift+Return submits it, until Quoder restarts.

  **Fix:**
  - Map kitty Ctrl+J to a `continue` ending and Ctrl+M to a `submit` ending, and never forward an unreported `\r` or `\n`.
  - Stop relying on a queue that lasts across chunks. For example, push the output one ending-terminated segment at a time and set a "current ending" just before each push (readline handles each push synchronously). Alternatively, clear the queue once each chunk has been processed.
  - Add unit and integration tests for kitty Ctrl+J and for Esc followed by Return.
- **[src/harness/repl.ts:125, :230, :485, :504; src/harness/live-view.ts:264-268] Some harness messages are written while the status line is on screen, so the status line is not erased first.** This breaks the spec rule that the status line is "erased before any permanent line is printed". These messages call `#write` directly instead of going through the view, so they are appended to the current status frame and leave a stale spinner line in the scrollback:
  - "Still cleaning up the cancelled prompt…" (a second Ctrl-C during cleanup, which is common);
  - "Quoder is still running the previous prompt…" (typing while busy);
  - "Deleted N earlier OpenCode session(s)…" and "an OpenCode server did not confirm termination" (both written inside `#ensureServer`, after the `LiveView` has started drawing).

  Example output: `\r\x1b[2K⠋ Cancelling… 3.2s · glm-4.7-flash:latestStill cleaning up the cancelled prompt…\n`.

  **Fix:** while a view is active, send these messages through a `LiveView` method for permanent notes (the existing `#permanent` path). Alternatively, clear the status line before writing them. Add a TTY integration test that checks no status frame is followed by non-status text on the same row.
- **[src/ui/markdown.ts:158-160, :193-199] The block scanner misses a code fence indented by 4 or more spaces, which is valid inside a nested list item.** A blank line inside such a code block is then treated as the end of a block. The output is printed broken, and `text.ended` cannot repair text that is already printed.
  - Reproduction (`/private/tmp/claude-501/m2review/md.mjs`): stream `"1. Install:\n   - run this:\n\n     ```js\n     const a = 1;\n\n     const b = 2;\n     ```\n\n2. Done\n"`.
  - Streamed output: the raw ```` ``` ```` fences appear behind quote gutters, and the code is split in two.
  - `renderMarkdown` of the same text gives a single highlighted block.

  LLM how-to answers often put code blocks inside nested lists.

  **Fix:** while a list context is open, accept fence openers at any indentation up to the item's content indent plus 3. A simpler alternative: treat any line whose trimmed start is ```` ``` ```` or `~~~` as a candidate fence, and close it only on a matching closer. Add a streaming test for a nested-list fence that contains a blank line.
- **[src/harness/live-view.ts:186-200; spec.md:100, :147, :149, :117-118; tasks.md Group 5 Accept] Several deviations from the spec are recorded only in `tasks.md`, not in `decisions.md`:**
  - **Reconciliation.** The spec says that when the streamed text is a prefix of the final answer, only the remainder is rendered. The code prints a note and then the full answer.
  - **Runner sink.** The spec and Group 5 acceptance require an `onEvent` sink on the runner. Instead, the view finds the final message from the last `step.started`.
  - **Status-line module.** The spec lists `src/ui/status-line.ts`. The status line is implemented inside `live-view.ts` instead.
  - **Cancelled status wording.** The spec shows `✗ Cancelled after 6.2s · session deleted`. The code prints `– Execution cancelled after Xs. Harness session remains active.`

  Each choice is defensible. The checklist asks for deviations in `decisions.md`, and the Group 5 acceptance "runner exposes an `onEvent` sink" is literally unmet.

  **Fix:** add one `decisions.md` entry that records these choices and their reasons, or amend `spec.md`.

### Suggestion
- **[src/ui/markdown.ts:236-242] The idle `flushLines` can split constructs that span several lines, and the split is permanent.** Reproduced in `md.mjs`:
  - A table flushed after its header line is printed as raw `| a | b |` / `|---|---|` text.
  - `intro line\n# Heading` loses the blank line before the heading when a flush happens after `intro line`.
  - A setext underline (`===`) after a flush becomes a paragraph.

  Consider not flushing when the pending text starts like a table (`|`) or when the next line could be a setext underline. Also consider resetting `#continuing` when the next chunk starts with a heading or rule.
- **[src/harness/line-keys.ts:67] `chunk.toString("utf8")` is called on each chunk separately.** A multi-byte character split across two chunks becomes U+FFFD. Reproduced: `héllo` split after byte 2 gives `h��llo`. Before this change, readline decoded the input itself, so this is a regression for large non-ASCII pastes.

  Use `StringDecoder`. Also keep an incomplete trailing `ESC[`… sequence for the next chunk: a split `CSI 13;2u` is currently lost, and `one`+`two` are joined.
- **[src/harness/line-keys.ts:50-55] Keypad Enter is dropped.** The kitty spec reports non-text keypad keys under the "disambiguate" flag. Keypad Enter (`CSI 57414 u`) falls in the private-use range and is dropped, so it does nothing. Consider mapping it to `submit`.
- **[decisions.md "Multi-line prompts"] The decision says pasted multi-line text becomes one prompt because the newlines arrive as `\n`.** Most terminals, iTerm2 and xterm included, paste newlines as `\r`, so each pasted line would be submitted on its own. Consider enabling bracketed paste (`CSI ?2004h`/`l`, which pairs with the existing push/pop) or correcting the claim.
- **[src/harness/live-view.ts:156, :274] The status line is redrawn and the spinner advanced on every event, not only on the 10 Hz ticker.** At about 75 deltas per second the spinner spins about 7 times faster while text streams, and each delta also writes a status frame. Consider advancing the frame only on ticks, or rate-limiting redraws triggered by events.
- **[src/harness/live-view.ts:276-280] Truncation counts code points, not display columns.** Wide (CJK or emoji) characters in a reasoning preview or model label can make the line wrap. `\r\x1b[2K` then clears only the last row, leaving fragments behind. glm emits no reasoning, so this is latent. Consider a simple East-Asian-width estimate, or reserve a margin.
- **[src/harness/live-view.ts:129-136] The return value of `stream.end(event.text)` is ignored.** If a non-final step's text block disagrees with its `text.ended`, the mismatch is silent, because reconciliation covers only the final message. Consider a dim note in that case.
- **[tests] Missing tests:**
  - the `process.on("exit")` hooks that pop the keyboard protocol (repl.ts:250) and stop the server (the launcher has one test; the harness hook has none);
  - idle flush combined with lists or tables;
  - the cases above (kitty Ctrl+J, Esc then Return, nested fences, status-line erasure for harness notices).

### Tests
- [x] All tests passing: `npx vitest run` gives 19 files and 325 tests passed. `npx tsc --noEmit -p .`, `npx tsc --noEmit -p tsconfig.live.json` and `npm run build` are clean.
- [ ] Test coverage adequate for changes: the input-pairing edge cases, the status-line erasure for messages written by the harness itself, and nested-fence streaming are untested (see the Warnings).

**Invariants checked and holding:**
- A fresh session per prompt; streaming is display only, and the runner still decides completion and the final answer.
- `LiveView.finish` always runs in `finally`, so its timers are cleared.
- No permission is granted, the shutdown is memoized, and the server process-exit hook is in place.
- Piped output has no cursor control and no colour, unless `FORCE_COLOR` is set (an integration test asserts this).
- The keyboard protocol is popped and raw mode restored at shutdown.
- `verify-harness` splits the trace per prompt at each `session.created`, and only sends SIGINT while prompt 3 is running.

### Verdict: FAIL

## Cycle 2 — 2026-10-03
Reviewing: Fix Group 1 (and Groups 1–6, 5a regression check)

**How the cycle 1 warnings now stand:**
- **Warning 1 (line-ending pairing): resolved for the reported cases.** I piped `LineEndingKeys` into Node 24.18.1 `readline.createInterface({terminal:true})` and reproduced the harness's keypress logic (`/private/tmp/claude-501/m2review2/keys.mjs`). The harness listener is registered first. These cases now give the right result, and no state is left behind:
  - Shift+Return;
  - kitty Ctrl+J (continues) and Ctrl+M (submits);
  - kitty Esc then Return (submits, and later lines stay in step);
  - typed Ctrl+G, legacy and kitty (dropped);
  - a CSI sequence split across chunks;
  - a paste-marker split inside the CSI;
  - mixed endings in a single chunk;
  - a UTF-8 character split across chunks;
  - keypad Enter, Alt+Return and legacy Ctrl+J.

  Readline does not echo or insert Ctrl+G (no BEL in the output, and line contents are clean). One new problem with paste-state carry is listed below.
- **Warning 2 (harness messages during a run): partly resolved.** The messages now go through `LiveView.note`. However, readline's own echo still commits the status frame to the scrollback (see below).
- **Warning 3 (nested-list fences): resolved when there is no idle flush.** The new list deferral causes a progressive-display regression (see below).
- **Warning 4 (undocumented deviations): resolved.** The `decisions.md` entry "Implementation choices that differ from spec.md" covers all four deviations, with reasons.

### Critical
None.

### Warning
- **[src/harness/line-keys.ts:97-99, :112-121] A bracketed-paste end marker split right after its ESC leaves `#pasting` stuck on. After that, Return never submits, and kitty-encoded Ctrl+C and Ctrl+D stop working.**
  - **Cause:** a lone trailing ESC is deliberately never held. If a chunk ends with `\x1b` and the next chunk starts with `[201~`, `indexOf(PASTE_END)` never matches. Every later chunk then goes through `translatePaste`, which:
    - turns each `\r` into `CONTINUE`;
    - forwards kitty keys such as `CSI 99;5u` and `CSI 100;5u` undecoded, so readline ignores them.
  - **Recovery:** only another paste or killing the terminal gets out of this state.
  - **Likelihood:** this needs a large paste whose chunk boundary falls exactly after that ESC. iTerm2 sends pastes in roughly 1 KB pieces, and the macOS pty splits large writes. That makes it rare, but the effect is permanent for the session.
  - **Reproduction** (`/private/tmp/claude-501/m2review2/stuck.mjs`, `keys.mjs`): send the chunks `"\x1b[200~l1\rl2\x1b"`, then `"[201~"`, then `"typed\r"`, then kitty Ctrl+C, then kitty Ctrl+D, then `"\r"`. Readline reports `"l1"` continue, `"l2typed"` continue, `""` continue. No `SIGINT` and no `close` follow.
  - **Fix:** while `#pasting` is true (more generally, whenever the tail of the text is a prefix of the marker being looked for), hold the trailing prefix, a lone ESC included. The carry has to be decided after `#translate` knows the paste state at the end of the chunk. Add a unit test that splits `\x1b` | `[201~`. Optionally, add a safety valve: if no data arrives for about 1 s while pasting, end the paste.
- **[src/harness/repl.ts:212-217, :240-244; src/harness/live-view.ts:194-196] Typing while a prompt runs still leaves a stale status frame in the scrollback, so cycle 1's "still running" case is not fixed in a real terminal.**
  - **Cause:** readline stays active in terminal mode during a run. It echoes each typed character onto the status row. On Return, its `clearLine()` writes `\r\n` before it emits `line`. That newline commits `⠋ Thinking… 0.3s · glm-4.7-flash:latesttyped while busy` to the scrollback. `#notice` then calls `view.note`, whose `CLEAR_LINE` erases the new, empty row instead.
  - **Reproduction:** I copied the integration suite to `/private/tmp/claude-501/m2review2/echo.test.ts` and added one scratch test: run "slow work", then write `"typed while busy\r"`. The output after typing is `"typed while busy\r\n\r\x1b[2KQuoder is still running the previous prompt; …"`.
  - **Why the new test passes:** the test "erases the status line before Quoder's own messages" only flags frames that contain the message text itself, so it misses this case.
  - **Fix:** while `#running` is set, keep readline from echoing. Options:
    - give readline an output wrapper that drops writes while busy, and redraw the prompt and line afterwards;
    - have `LineEndingKeys` or the keypress layer discard input other than Ctrl+C and Ctrl+D while busy, and raise the notice from the keypress listener.

    Then tighten the test to assert that no status frame is followed by `\n` without an erase in between.
- **[src/ui/markdown.ts:216-223, :232-233] Deferring list boundaries holds back a whole list until the first line after it. For list-shaped answers, nothing streams.**
  - **Cause:** once a block starts with a list item, a blank line becomes a boundary only when the next line is neither indented nor another item. A loose list, with blank lines between items or with item paragraphs, is therefore one block until the list ends. LLM how-to answers are usually numbered steps with explanation paragraphs.
  - **Effect:** only the 400 ms idle flush can show it earlier, and that timer is reset on every delta (`live-view.ts:278-285`). A model that streams steadily therefore shows nothing but the status line until the list is over. Before this fix, each item printed as soon as it completed, and the numbering was correct (`2.` stays `2.`).
  - **Spec:** spec.md:94 says each Markdown block is printed "once it is complete".
  - **Reproduction** (`/private/tmp/claude-501/m2review2/md.test.ts`, run with `npx vitest run --root /private/tmp/claude-501/m2review2`):
    - a 6-step loose numbered list followed by `That's all.` (474 chars): first output at char 473 now, against char 14 at HEAD;
    - the nested-fence example: char 94 of 94, against 27.
  - **Fix:** defer only while the content after a blank line belongs to the current item. That is, at a blank line inside a list, end the block when the next non-blank line is a new item at the list's own marker indentation, as well as when it is a non-list line. Keep deferring only through indented continuation lines and fences. This limits the delay to one item. Add a test that a loose list's first item is written before the list ends.

### Suggestion
- **[src/ui/markdown.ts:277-286] An idle flush (or the flush in `#finishTool`) inside a list still breaks a nested fence.** The list lines are emitted, and the indented ```` ``` ```` that follows is rendered on its own as an indented code block with raw fences behind a gutter. This is cycle 1 warning 3 again, but it now needs a pause of at least 400 ms inside the list. Reproduced in `md.test.ts` (nestedFence, flush every 5 deltas). Consider not flushing past the last list-item line while `inList` holds, or flushing only the lines before the item that is still open.
- **[src/ui/markdown.ts:159-160] Fences are now recognized at any indentation, outside lists too.** Outside a list, a line indented by 4 or more spaces that starts with ```` ``` ```` belongs to an indented code block, not a fence.
  - Text like that with no matching closer keeps the scanner "in a fence", and everything after it waits until the end.
  - With a matching closer, the streamed output gets an extra empty `│` line compared with `renderMarkdown` (input `fenceInParagraphIndented` in `md.test.ts`).

  Consider allowing deep indentation only when `inList` is set.
- **[src/harness/line-keys.ts:97-99] In a legacy (non-kitty) terminal, Esc and then Ctrl+J or Return as separate keypresses becomes Meta+key.**
  - Esc then Ctrl+J submits instead of continuing.
  - Esc then Return is swallowed: neither submit nor continue. Nothing stale remains afterwards.

  `decisions.md` says "Esc followed by Return still submits", which is true only under the kitty protocol. Consider qualifying that sentence.
- **[src/ui/markdown.ts:277-280] `flushLines` now returns whenever the pending text ends exactly at a newline (`tail === ""`).** A model that stalls right after a line break, which is common because newline is often its own token, never gets an idle flush. Consider flushing everything except the last complete line in that case, since only that line could still become a setext heading.

### Tests
- [x] All tests passing: `npx vitest run` gives 19 files and 345 tests passed. `npx tsc --noEmit -p .`, `npx tsc --noEmit -p tsconfig.live.json` and `npm run build` are clean.
- [ ] Test coverage adequate for changes: these cases have no tests:
  - a paste end marker split after its ESC;
  - readline's echo while busy (the status-line test's filter cannot detect it);
  - progressive output of a loose list;
  - an idle flush inside a list that contains a fence.

**Checked and holding:**
- Keypress listener ordering: the harness listener runs before readline's.
- Ctrl+G is neither echoed nor inserted on Node 24.18.1.
- `StringDecoder` handles split UTF-8.
- The CSI carry works when the split comes after `[`.
- Kitty Ctrl+J and Ctrl+M are mapped correctly.
- Kitty Esc then Return now submits and leaves no queue behind.
- Bracketed paste is enabled and restored together with the keyboard protocol, and the exit hook is removed.
- Raw mode is restored at shutdown.
- The spinner advances only on the ticker; events redraw only when the phase changes or the line was erased.
- `fitColumns` truncates by display columns and leaves a one-column margin.
- The table and setext guards in `flushLines` hold.
- A heading after a flushed paragraph keeps its blank line.
- In `md.test.ts` (16 inputs: lists, headings, fences, tables, setext, quotes; delta sizes 1, 3, 7 and whole), streamed output with no idle flush matches `renderMarkdown` for every input except the indented-fence case above.

Scratch files are under `/private/tmp/claude-501/m2review2/`. The repository was not modified.

### Verdict: FAIL

## Cycle 3 — 2026-10-03
Reviewing: Fix Group 2 (and full Milestone 2 regression check)

**Status of the cycle 2 warnings**

- **(a) Paste end marker split after its ESC: resolved for back-to-back chunks, but not when the rest of the marker arrives late (see Warning 1).**
  - I piped the built `LineEndingKeys` into Node 24 `readline` (`/private/tmp/claude-501/m2review3/keys.mjs`) and sent `"\x1b[200~l1\rl2\x1b"`, `"[201~"`, `"typed\r"`, kitty Ctrl+C, `"\r"`. The result is `"l1"` continue, `"l2typed"` submit, `SIGINT`, `""` submit. That is correct.
  - Also still correct:
    - a CSI split and completed within 50 ms;
    - kitty Esc followed by Return;
    - arrow keys;
    - legacy Esc followed by Return (no stale state).
  - The timer is cleared in `_transform`, `_flush` and `_destroy`, and it is `unref`'d. I found no leak and no push after the stream ends.
- **(b) Typing while busy: resolved.**
  - While busy, only `\x03` and `\x04` reach readline. Kitty Ctrl+C and Ctrl+D are decoded before the filter applies, so they still work. Paste state is tracked before the filter runs.
  - A run starts only after a submitted, empty readline line, so there is never a half-typed line to lose. There are no interactive permission prompts that would need typed input during a run.
  - I checked that the tightened integration test catches the old bug. In a scratch copy of the repo I set `isBusy: () => false`, and "erases the status line before Quoder's own messages" fails on `committedFrames`.
- **(c) Lists: resolved for lists that start a block.**
  - A loose list now streams item by item: writes at characters 43, 86, 129, 172 and 184 of 184.
  - Nested fences in such lists stay intact with and without flushes. I tested delta sizes 1, 2, 3, 5, 7, 13 and 1000, with `flushLines()` after every 1, 2, 3, 5 or 11 deltas, over 30 inputs (`/private/tmp/claude-501/m2review3/md.mjs`).
  - The streamed output matched `renderMarkdown` except in these cases:
    - the two accepted cosmetic limitations (the missing blank line in a nested list, and the `8.`–`11.` marker width);
    - the flush-only cases listed under Suggestions, which mostly predate Fix Group 2 (HEAD fails more of those configurations, checked in `repo/tests/scratch-md.test.ts`);
    - a list that does not start its block (Warning 2).

### Critical
None.

### Warning
- **[src/harness/line-keys.ts:130-140, :185-191; decisions.md:141] A paste end marker whose remainder arrives more than 50 ms after its ESC still leaves the filter stuck in a paste for the rest of the session. A paste whose end marker is lost entirely is never ended either. `decisions.md` says the hold timer "also ends a paste whose end marker was lost", which is false.**
  - **Cause:** when the timer fires, `#translate(held, false)` passes the held fragment through `translatePaste`, and `#pasting` stays true.
  - **Reproduction** (`keys.mjs`, two cases):
    - Send `"\x1b[200~l1\rl2\x1b"`, wait 80 ms, then send `"[201~"`, `"typed\r"`, kitty Ctrl+C, `"\r"` and kitty Ctrl+D. The result is `"l1"` continue, `"l2typed"` continue, `""` continue. There is no SIGINT and no close.
    - Send `"\x1b[200~l1\rl2"`, wait 200 ms, then send `"typed\r"` and kitty Ctrl+C and Ctrl+D. The filter stays stuck.
  - **Effect:** Return never submits again, and kitty Ctrl+C and Ctrl+D are dead. The only way out is to kill the terminal.
  - **Likelihood:** this needs a delay at that exact byte. Paced pastes can cause it (for example iTerm2's "Paste Slowly", which I could not verify offline), and so can a heavily loaded machine.
  - **Acceptance:** this still breaches the Fix Group 2 acceptance line "A split paste end marker cannot leave the filter stuck in a paste" (tasks.md:147).
  - **Fix:**
    - Inside a paste, hold a marker prefix longer (about 500 ms to 1 s).
    - When the hold expires, or when there is no input for that long while `#pasting`, end the paste: set `#pasting = false` and drop the held marker prefix. Optionally, strip a late `[201~` remainder that follows.
    - Add a unit test with a small `holdMs`: write `"\x1b[200~a\x1b"`, wait longer than the hold, write `"typed\r"`, and expect a submit.
    - Correct `decisions.md` to match the behaviour.
- **[src/ui/markdown.ts:239-245] List handling switches on only when a block begins with a list item. A list that follows an intro line with no blank line in between ("Steps:\n1. …") gets none of the Fix Group 1 and 2 protection, so cycle 1's nested-fence breakage comes back.**
  - **Cause:** `inList` and `listIndent` are set only on the block's first non-blank line. The intro line is not a list item, so the deep-indent fence pattern is not used and blank lines are not deferred. Small local models often write an intro line directly followed by a list.
  - **Reproduction** (`/private/tmp/claude-501/m2review3/md2.mjs`, `md3.mjs`, delta size 1, no flush):
    - `"Do:\n- step\n  - sub:\n    \`\`\`py\n    a = 1\n\n    b = 2\n    \`\`\`\n- next\n"` streams as an intact first half of the code block. After it come raw `│ b = 2` and `│ \`\`\`` lines, rendered as an indented code block.
    - `"Steps:\n1. Install:\n   - run this:\n\n     \`\`\`js …"` breaks the same way.
    - `"Options:\n- a\n\n  - a1\n\n  - a2\n\n- b\n"` loses its nesting.
    - A fence at item indentation (3 spaces) loses its indentation and gains a stray blank line before the next item.
  - **Not a Fix Group 2 regression:** HEAD had no list logic at all. However, it means the "nested-list fences stream intact" acceptance (Fix Group 1) holds only for lists that start their block.
  - **Fix:** in `scan()`, enter list mode on any list-item line in the current block, not only the first: `if (!inList && !standalone && LIST_ITEM.test(line)) { inList = true; listIndent = indentOf(line); }`. Add tests for intro line + nested fence with a blank line inside, and for intro line + loose nested list.

### Suggestion
- **[src/ui/markdown.ts:307-308] The new "stalled after a line break" flush can split a setext `=====` underline from its text.** If the stream pauses for 400 ms right after `"Title\n=====\n"`, `Title` is printed as a paragraph and `=====` later appears as literal text. The `---` underline is unaffected because it already ends a block. Reproduction: `/private/tmp/claude-501/m2review3/setext.mjs`. Fix: when the last complete line is itself a setext underline, flush only up to the start of the line before it.
- **[src/ui/markdown.ts:244, :310] An idle flush inside a nested list still flattens the nesting.** `openItemStart` is the latest item line at any depth, so `"- a\n  - a1\n"` can be flushed as `- a` alone. Later items then render as a top-level list (`• a1` at column 0). The same happens to the parent item before a nested fence: the fence stays intact but loses its indentation. A pause inside a quote (`> p1\n>\n> p2`) likewise drops the blank quote line. This happens only with flushes, and HEAD was worse. Fix: use the start of the outermost open item, at `listIndent`.
- **[src/harness/line-keys.ts:187] A paste start marker split right after its ESC is not held.** The lines of that paste are then submitted one at a time, so the first line runs as a prompt. This is very unlikely, because the marker begins the terminal's write. Since the 50 ms timer now exists, holding a lone trailing ESC outside a paste would cost only a 50 ms delay on the Esc key.
- **[src/harness/line-keys.ts:163] While busy, `onReturnWhileBusy` fires once per chunk that contains `\r`.** A multi-chunk paste during a run therefore prints the "still running" notice several times. Consider limiting it to once per run.

### Tests
- [x] All tests passing:
  - `npx vitest run`: 19 files, 352 tests passed.
  - `npx tsc --noEmit -p .` and `npx tsc --noEmit -p tsconfig.live.json`: clean.
  - `npm run build`: succeeds.
- [ ] Test coverage adequate for changes: these cases have no tests:
  - a paste end marker that is delayed or lost (Warning 1);
  - a list preceded by an intro line in the same block (Warning 2).

  The other cycle 2 gaps are now covered:
  - the split ESC marker;
  - the busy echo, a test checked to fail without the fix;
  - loose list progression;
  - a flush inside a list with a fence.

Scratch files are in `/private/tmp/claude-501/m2review3/`. They include a repo copy in `repo/`, with a HEAD-versus-current Markdown comparison in `repo/tests/scratch-md.test.ts`. The repository was not modified.

### Verdict: FAIL

## Cycle 4 — 2026-10-04 (authorized extra round)
Reviewing: Fix Group 3 (and Milestone 2 regression check)

**Status of the cycle 3 warnings**

- **Warning 1 (late or lost paste end marker): resolved.**
  - I reran cycle 3's reproductions. The built `LineEndingKeys` was piped into Node 24 `readline` with `terminal: true`, using the same keypress classification as `src/harness/repl.ts:205-212` (script: `/private/tmp/claude-501/m2review4/keys.mjs`).
  - Results:
    - **ESC, then `[201~` after 80 ms or 700 ms:** gives `"l1"` continue, `"l2typed"` submit, SIGINT, `""` submit, then close.
    - **End marker lost entirely (600 ms):** gives `"l1"` continue, `"l2typed"` submit, SIGINT, close.
    - **Split at `\x1b[20` with a 700 ms gap:** the late `1~` is dropped.
    - **Ctrl+C after a paste timeout:** gives SIGINT.
  - Regression checks that held:
    - A slow but complete paste with 400 ms gaps stays one prompt (`a`, `b`, `c` continue, `d` submits).
    - Kitty Esc then Return submits.
    - A legacy lone Esc is released after the hold, and readline's own 500 ms escape handling then applies as before. Esc then `x` 600 ms later inserts `x`. Alt+b still moves back a word. Arrow keys work.
    - A paste start marker split after its ESC (within the hold) is recognized.
    - While busy, typing and Esc are filtered out, legacy and kitty Ctrl+C both reach readline, kitty Ctrl+D closes, and `onReturnWhileBusy` fires once.
    - The timer is cleared in `_transform`, `_flush` and `_destroy` and is `unref`'d. After `destroy()` nothing is pushed. After `end()` the held ESC is flushed once, synchronously. The paste-timeout callback never pushes data.
- **Warning 2 (a list after an intro line): resolved.**
  - With no idle flush, every cycle 3 intro-line input now streams the same as `renderMarkdown`, apart from the accepted nested-list blank line: `Do:\n- step\n  - sub:` with a fence, `Steps:\n1. Install:` with a nested fence, `Options:` with a loose nested list, and a fence at item indentation.
  - I tested 51 inputs at delta sizes 1, 2, 3, 5, 7, 13 and 1000, each with `flushLines()` after every 1, 2, 3, 5 or 11 deltas and with none (`/private/tmp/claude-501/m2review4/md.mjs`, `md3.mjs`). With no flush, the only differences are:
    - the two accepted limitations (`nestedFence`/`introNoBlankNested` and `numberedTen`);
    - `listCodeIndented`, where `renderMarkdown` itself prints a trailing empty `│ ` line; this predates Fix Group 3 and the streamed output is the cleaner of the two.
  - Entering list mode mid-block does not break other constructs. These inputs match with no flush: a paragraph containing `- dash line`, `2024. was a good year` followed by indented code or a fence, `+ b` and `+1 to that`, hyphenated words, `*emph*` after a `*` list, a heading or setext block or table after an intro-line list, and a quote with an intro line. `LIST_ITEM` requires the marker to be followed by whitespace, so hyphenated text and `+1` are not affected.

### Critical
None.

### Warning
None.

### Suggestion
- **[src/harness/line-keys.ts:146] The 500 ms paste timeout trades a permanent hang for a truncated prompt.** If a genuine paste has a gap of more than 500 ms between chunks, the paste is ended early. This could happen under tmux over SSH, with a paced paste, or if the event loop is blocked; Node runs expired timers before polling for I/O.
  - Reproduction: `"\x1b[200~a\r"`, then 600 ms, then `"b\r"` and `"c\x1b[201~"`. The result is `"a"` continue, then `"b"` submit, so the prompt `a\nb` runs. The rest of the paste is then dropped by the busy filter.
  - Recovering from a lost marker is never urgent, so a longer timeout (about 1.5–2 s) costs almost nothing and makes this much less likely.
- **[src/harness/line-keys.ts:136] The late remainder of the end marker is removed only if it arrives in one piece at the start of a chunk.** In the case "ESC, then 700 ms, then `[20`, then `1~`", the text `[201~` is inserted into the prompt as literal text (`"l2[201~typed"`). This needs two unlucky delays, so it is very unlikely. Possible fix: keep a partial match of `#lateMarkerRest` across chunks, or drop it only once.
- **[src/ui/markdown.ts:318, :339-345] After an idle flush, an intro line and the list that follows it are not separated by a blank line.** `flushLines` stops at `openItemStart` and emits `"Steps:\n"` with `#continuing = true`, so the list is written directly below it. `renderMarkdown` puts a blank line there.
  - This happens only with a flush inside the block. It was reproduced in `introNoBlankNested`, `doNested`, `optionsLoose`, `introListSetext` and `paraThenHeadingInList` with a flush after every delta.
  - The same thing could already happen before Fix Group 3 when a stall fell inside the first item line.
  - Possible fix: when the flush limit is the list's first item and lines come before it, set `#continuing = false` so the list keeps its gap.
- **[src/ui/markdown.ts:244-249] A non-1 number that starts a line inside a paragraph (`2024. was a good year`) turns on list mode.** CommonMark says such a line cannot interrupt a paragraph. With no flush the output is identical. With a flush, the line is emitted on its own and rendered as an ordered list item, so the paragraph's next line gets a hanging indent (`yearPara`). The text itself is unchanged. Possible fix: when the list would start mid-block, enter list mode only for bullets and `1.`/`1)`.
- The earlier cosmetic differences that appear only with flushes are still there and are not new: blank quote lines dropped when a pause falls inside a quote (`quoteIntro`, `quoteBlank`, `listInQuoteLoose`).

### Tests
- [x] All tests passing:
  - `npx vitest run`: 19 files, 359 tests passed.
  - `npx tsc --noEmit -p .` and `npx tsc --noEmit -p tsconfig.live.json`: clean.
  - `npm run build`: succeeds.
- [x] Test coverage adequate for changes. New tests cover:
  - a late end marker with its remainder dropped;
  - a lost end marker;
  - a slow but complete paste;
  - a split start marker;
  - Esc released after the hold;
  - intro-line lists with nested fences;
  - nested items across a flush;
  - a setext underline at a stall.

**Checked and holding:** the `decisions.md` correction in "Review cycle 2 fixes" and the Fix Group 3 entry match the code's behaviour. The tasks.md acceptance lines for Fix Group 3 are met. Nothing in `live-view.ts` or `repl.ts` regressed.

Scratch files are in `/private/tmp/claude-501/m2review4/` (`keys.mjs`, `md.mjs`, `md3.mjs`). The repository was not modified.

### Verdict: PASS

## Cycle 5 — 2026-10-04 (QA addendum: dropped-prompt retry)
Reviewing: QA Fix Group 1 (uncommitted diff against 0ee4bdd: `src/harness/session-runner.ts`, `src/harness/repl.ts`, `scripts/verify-harness.ts`, `tests/unit/session-runner.test.ts`, `tests/integration/harness.test.ts`, spec `tasks.md`/`decisions.md`)

### Invariants checked (no defects found)
- **Fresh session per prompt and cleanup.** Each `runAttempt` creates its own session, registers it with the tracker, settles it (interrupt and wait for idle, since a dropped turn has `endedIdle: false`), deletes and verifies it, reports `onSessionDeleted`, and unregisters it. All of that happens before `onRetry` and before the second session is created. I confirmed the order in the unit test and in a scratch run against the built `dist/` (outside the repo).
- **Unverified first-session deletion is never lost.** The runner retries only when `attempt.sessionDeleted` is true (`session-runner.ts:201`). If the first deletion is unverified, the result keeps `sessionID: ses_1, sessionDeleted: false`, and `repl.ts:368` pushes it to `#undeletedSessions`. After a retry, `sessionID`/`sessionDeleted` describe the second session, and the first is known to be verified deleted. Permissions and questions from the first session are dropped from the result, which is acceptable: the session has no assistant message, so no tool ran.
- **No permission is ever granted.** Unchanged. A late event from the first session after `unregister` fails `isOwnSession`, so the monitor ignores it. It is never answered, and in particular never granted.
- **Cancel and stop requests during the retry.** The scratch experiment (`/private/tmp/claude-501/quoder-review-c5/exp.mjs`) covered three cases:
  - Ctrl-C during the second attempt gives `cancelled`, and `ses_2` is interrupted, idled, deleted and unregistered.
  - A `StopRequest` abort during the retry gives `failed: "Server lost."`, with the same cleanup.
  - An abort while `createSession` #2 is in flight gives `cancelled`, and `ses_2` is still settled and deleted.

  Cancelling during the 5 s detection window returns `cancelled` without a retry (covered by an existing test).
- **Could the 5 s check misfire on a legitimate turn?** No window found. `docs/tech.md:237` records that admission synchronously registers the run before the HTTP response, and that the session stays in `active` until every step drains. `docs/tech.md:176` says a pending question keeps the session running. A legitimate turn is therefore never "inactive with no assistant message", and `idleWithoutResponseSince` resets whenever the session is active. The worst case is a run that fails before creating any assistant message. That would now fail after one retry (about 10 s plus cleanup) instead of after 30 s, which is harmless.
- **LiveView across the session switch.** `setSession(ses_2)` resets the phase. `handle` drops any event whose `sessionID` is not the current session (`live-view.ts:129`), and the monitor also filters out the unregistered `ses_1`. No late `ses_1` output can reach the view. The retry note goes through `view.note`, which erases the status line first.
- **verify-harness logic.** Segmenting by `prompt.started` is correct: it is traced once per `#runPrompt`, before `#ensureServer`, so a server-start failure still opens a segment. Other row logic:
  - The "Fresh session per prompt" row requires one session per prompt, or two only when the prompt was retried, and every session ID distinct.
  - "Session deletion" still covers every created session.
  - `cancelledDeleted` requires at least one session and every session verified deleted.
  - `streamedBeforeCompletion` and the tool list are per prompt, as before.

### Critical
None.

### Warning
- **[tests/unit/session-runner.test.ts:312 (and session-runner.ts:201)] The cancel guard before the retry and cancellation during the retry are untested.**
  - **What the test actually covers.** "does not retry after the developer cancelled" aborts at clock 1200, inside the detection window (idle since 800, timeout 1000). `runTurn` therefore returns `cancelled` with `dropped: false`, and the runner never reaches the `!options.cancel.aborted` check at line 201. That check could be deleted and the test would still pass.
  - **Failure scenario this leaves open.** A future change that removes or reorders the guard would let a Ctrl-C pressed while the dropped session is being settled or deleted be ignored: the runner would start a fresh session and send the prompt again after the developer cancelled. No test would fail.
  - **Also untested.** Cancel and `StopRequest` during the second attempt, and an abort during the second `createSession`. These are the session-cleanup paths the change adds. I confirmed they work today only by the scratch experiment above.
  - **Fix.** Add unit tests for:
    - an abort fired from `deleteSession("ses_1")` (or from `onRetry`): expect one `create:` call and `onRetry` not called (or no second session);
    - an abort, then a `{ stopped }` abort, during `ses_2`'s polling: expect `cancelled` or `failed: <stop message>`, `sessionID: "ses_2"`, the calls `interrupt:ses_2`, `idle:ses_2` and `delete:ses_2`, and the tracker no longer owning either session.
  - **Also.** Rename the existing test to say "cancelled while waiting for a response".

### Suggestion
- **[src/harness/session-runner.ts:201] Ctrl-C during cleanup is reported as a failure.** If Ctrl-C arrives while the dropped session is being settled or deleted, the retry is correctly skipped, but the outcome stays `failed: "OpenCode did not start a response"`, not `cancelled` (seen in the scratch run). The developer pressed Ctrl-C and sees a failure. Consider returning `abortedOutcome(options.cancel)` when `attempt.dropped && options.cancel.aborted`.
- **[src/harness/session-runner.ts:174] Inaccurate `Attempt.dropped` doc comment.** It says "and the session is gone", but `dropped` is also true when the deletion was unverified. Reword it to "admitted but OpenCode never started a response".
- **[scripts/verify-harness.ts:165-176] Stale comment and fallback clock start.** The comment says SIGINT is sent only while the third prompt is "provably running (created, not completed)". The trigger is now `prompt.started`, which comes before `session.created`, and the 15 s fallback clock starts there. The practical risk is small, because the server is already up for prompt 3. One edge case: if the fallback fires between a dropped first attempt and the retry, the prompt ends `failed` and the row fails spuriously. Consider requiring `target.sessionIDs.length > 0` before arming the fallback, and updating the comment.
- **[docs/tech.md:290] Stale timeout figure.** It still says an idle session with no assistant message "fails after 30 s" and does not mention the retry. This is due in Group 8, but it should not be missed.

### Tests
- [x] All tests passing: `npx vitest run` gives 20 files and 413 tests passed. `npx tsc --noEmit -p .` and `npx tsc --noEmit -p tsconfig.live.json` are both clean. `npm run build` succeeded.
- [ ] Test coverage adequate for changes: the cancel guard before the retry and cancel/stop during the retry are untested (see Warning).

### Verdict: FAIL
The implementation behaves correctly in every scenario I checked. The FAIL comes only from the Warning: the retry's cancellation and stop paths, including the guard at `session-runner.ts:201`, have no tests. Adding the tests listed above should be enough to pass.

## Cycle 6 — 2026-10-04 (QA addendum follow-up)
Reviewing: QA Fix Group 1 review fixes

**Process incident, needs your attention:** During mutation testing, one setup `cp` failed. Because the command was chained with `&&`, the shell stayed in the repository, so three mutations were applied to the real `src/harness/session-runner.ts` instead of the scratch copy:
- the guard branch was removed
- the post-create `cancel.aborted` check was replaced with a bare block
- the `if (!endedIdle) await settle(...)` line was removed

I found this straight away and restored all three spots from the exact original text I had read earlier in this cycle. After the restore:
- `git diff 0ee4bdd --stat` again shows `session-runner.ts | 62` (the same as before the incident).
- The restored region was re-read and matches the original.
- `git status` shows the same 8 modified files and no untracked files.
- `npx vitest run` in the repo passes 417/417.

No other repo file was touched. Please run a quick `git diff -- src/harness/session-runner.ts` yourself to confirm. The mutation runs were then redone in a scratch copy, since deleted.

### Critical
- None.

### Warning
- None. The cycle 5 Warning is resolved:
  - **New tests exist and pass.** They are in `tests/unit/session-runner.test.ts`, describe block "cancelling around a retry (review cycle 5)":
    - Ctrl-C during cleanup of the dropped session.
    - Ctrl-C and a harness stop during the retried turn (`it.each`).
    - Cancel while the second session is being created.
  - **Mutation testing in the scratch copy** (`session-runner.test.ts` plus `harness.test.ts`):
    - Removing the guard branch (`if (attempt.dropped && options.cancel.aborted)` → `if (false)`) fails only "reports a Ctrl-C pressed while the dropped session is cleaned up, and does not retry". So the test does reach the guard, and catches its removal.
    - Removing only the `outcome: abortedOutcome(...)` override (keeping the no-retry) also fails that test. So it checks both "no retry" and "reported as `cancelled`".
    - Making the retry ignore cancel (`runAttempt({...options, cancel: new AbortController().signal})`) fails both retried-turn stop tests and the cancel-while-creating test.
    - Removing the post-create `cancel.aborted` check fails "still settles and deletes the second session when cancelled while it is being created", plus an existing harness test.
    - Removing `tracker.unregister` fails the two retried-turn stop tests, which assert neither session is still registered.
    - Removing `settle` fails 13 tests, including all the new retry-cancel tests.
- **Adopted suggestions are correct:**
  - **Cancel during cleanup of a dropped session** (`src/harness/session-runner.ts:200-206`): now reports `abortedOutcome(...)`, i.e. `cancelled`, or `failed` with the stop reason for a harness stop. No retry, and the result keeps `ses_1` and its real `sessionDeleted` value. Precedence over the retry branch is correct even when deletion was not verified.
  - **verify-harness cancel fallback** (`scripts/verify-harness.ts:166-188`): armed only when all of these hold:
    - exactly three prompts have started (`prompt.started` count === 3), so a 4th has not;
    - the target has no outcome;
    - the target has at least one session.

    The clock restarts whenever the target's session count changes, so a retry restarts it.
  - **Can SIGINT be sent while Quoder is idle?** In practice, no:
    - `prompt.started` is traced inside `#runPrompt` after `#running` is set, and `prompt.completed` is traced before `#running` is cleared in `finally`. So "started, not completed" lies within the running window.
    - Server-start failure leaves no session, so the fallback never arms.
    - If the fallback fires between deleting the dropped session and creating the retry session, Quoder is still inside `runPrompt` (`#running` set). The new guard turns that into `cancelled`, and the dropped session ID is in `deleted`, so "Cancel and continue" passes.
    - The only remaining path is the race in the suggestion below; it is pre-existing and fails safe.
  - **"Fresh session per prompt" and "Cancel and continue"** now key on `prompt.started` and allow exactly two sessions when `prompt.retried` was traced. A retry whose second session failed to create is correctly reported as a failure.

### Suggestion
- [scripts/verify-harness.ts:184] `cancelTargetSeenAt ??= Date.now();` is now dead code. The preceding block always assigns it the first time a session appears, because `cancelTargetSessions` starts at 0 and the length is already ≥ 1. Remove it, and optionally make `cancelTargetSeenAt` a plain `number`.
- [scripts/verify-harness.ts:174-188] **Narrow, pre-existing race:** the target prompt can complete between the async trace read and `child.kill("SIGINT")`. An idle SIGINT makes Quoder exit (`interrupt()` → `#requestExit(0)`), so the 4th prompt never runs. The script then reports FAIL rather than passing wrongly, so it is a possible flaky false negative only. Worth one sentence in the comment, which currently says "never when idle".
- [tests/unit/session-runner.test.ts:390] Minor tidy: the empty line before the closing `});` of the first describe block.

### Tests
- [x] All tests passing: `npx vitest run` gives 20 files, 417/417. `npx tsc --noEmit -p .` is clean, and so is `npx tsc --noEmit -p tsconfig.live.json`.
- [x] Test coverage adequate for changes. The retry's cancel and stop paths, the post-cancel guard, cleanup of the second session, and tracker unregistration are all covered, and each is shown by mutation to catch its removal.

### Verdict: PASS
