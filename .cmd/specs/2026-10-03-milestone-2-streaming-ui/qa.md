# QA: Milestone 2 — Streaming and Live Activity

## Automated acceptance — 2026-10-04

### Run 1 (authorized `npm run verify:harness`): NOT MET

| Row | Result |
|---|---|
| Harness launch and exit | PASS: exit code 0 |
| Single OpenCode server | PASS: 1 started, 0 lost |
| Fresh session per prompt | PASS: 4 sessions, 4 distinct |
| Prompts completed | **FAIL**: outcomes were failed, answered, cancelled, answered |
| Session deletion | PASS: 4 of 4 verified deleted |
| Server cleanup | PASS: stopped 1, 0 left running |
| Streamed before completion | PASS: 2 of 2 answered prompts |
| Tool activity observed | PASS: `read` |
| Cancel and continue | PASS |

### Diagnostic (authorized)

The built CLI ran prompt 1 three times, each on a fresh server, and printed only Quoder's own status lines:
- **Run 1:** "The prompt did not complete: OpenCode did not start a response", then "✗ Failed after 30.9s".
- **Runs 2 and 3:** answered, in 8.7 s and 7.3 s.

**Finding:** OpenCode 1.18.33 intermittently drops the first prompt on a fresh server. It is not a Milestone 2 regression. **Fix:** QA Fix Group 1 detects a dropped prompt within 5 s and retries it once in a fresh session; reviewed in cycles 5 and 6 (PASS). See `decisions.md`.

### Run 2 (after QA Fix Group 1): MET

| Row | Result |
|---|---|
| Harness launch and exit | PASS: exit code 0 |
| Single OpenCode server | PASS: 1 started, 0 lost |
| Fresh session per prompt | PASS: 4 prompts, 5 sessions, 5 distinct, **1 retried after OpenCode dropped the prompt** |
| Prompts completed | PASS: answered, answered, cancelled, answered |
| Session deletion | PASS: 5 of 5 verified deleted |
| Server cleanup | PASS: stopped 1, 1 tracked, 0 left running |
| Streamed before completion | PASS: 3 of 3 answered prompts streamed text before completing |
| Tool activity observed | PASS: prompt 2 tools: `read` |
| Cancel and continue | PASS: SIGINT sent; prompt 3 cancelled, its session verified deleted; the next prompt answered |

- **Model replies (informational):** 3 of 3 exact.
- **Milestone 1 Exit Criterion: MET.**
- **Milestone 2 Exit Criterion: MET.**

The dropped-first-prompt behaviour happened again in this run, and the retry handled it live.

Tests: 417 pass. Typecheck and build are clean.

## Manual terminal check (iTerm2) — pending the developer

To be run by the developer in iTerm2 with the current build (`npm run build`, then restart `quoder`):
1. Colour banner and the `❯` prompt; the spinner status line while a prompt runs.
2. Streamed Markdown answer (headings, bold, lists, a highlighted code block) and tool lines (✓ Read, $ Run).
3. Shift+Return makes a multi-line prompt; Return sends it. A multi-line paste stays one prompt until Return.
4. Ctrl-C during a prompt: "Cancelling…", "– Execution cancelled … Harness session remains active."; the next prompt works.
5. Ctrl-C at a continuation (`…`) line discards the draft; Ctrl-D at an empty prompt exits, and the shell behaves normally afterwards (no stray keyboard modes).
