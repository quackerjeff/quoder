# Quoder

Quoder provides a persistent developer-facing shell while each prompt runs in a
fresh, disposable OpenCode session. Milestones 1 (the minimal `quoder` harness)
and 2 (streaming and live activity) are complete. The Milestone 0 feasibility
probe remains as regression evidence.

## Using Quoder (Milestones 1–2)

Install the pinned dependencies, build, and put `quoder` on your `PATH`:

```bash
npm ci
npm run build
npm link
```

Run it from any project directory:

```bash
cd ~/Development/QuackTrack
quoder
```

```text
Quoder · QuackTrack /Users/you/Development/QuackTrack
Model ollama/glm-4.7-flash:latest
Ready. Type /help for help.

QuackTrack ❯ Fix the empty-file check
Starting fresh OpenCode session…
⠹ Running cargo test… 12.4s · glm-4.7-flash:latest      (live status line)
Reading the import code.

✓ ● Read   src/import.rs  212 lines
✓ ✎ Edit   src/import.rs  +12 −3
! $ Run    cargo test  exit 101 · test result: FAILED. 46 passed; 1 failed

I added a guard that rejects empty files…               (streamed Markdown)

✓ Done in 41.8s · 3 tools · 1.2k tokens
```

How it behaves:

- **Project.** The project is the Git repository root, or the launch directory
  outside a repository, resolved to its real path. The prompt shows the
  project's name.
- **One server, a fresh session per prompt.** Quoder starts one authenticated,
  project-local OpenCode server and keeps it for the whole harness session. Each
  prompt runs in a fresh session bound to the model. Afterwards the session is
  deleted and its deletion verified.
- **Live activity.**
  - The answer streams as rendered Markdown, with syntax-highlighted code
    blocks.
  - Each finished tool gets one line: reads, edits with `+/−` counts, writes,
    commands with exit code and last output line, and searches.
  - On an interactive terminal, a status line shows the spinner, the current
    phase, the elapsed time and the model.
  - A closing line reports the result, duration, tools and tokens.
- **Colour.** Colour follows your terminal. `--no-color` or `NO_COLOR` turns it
  off, and `FORCE_COLOR` forces it on. Piped output is plain, with no cursor
  control.
- **Multi-line prompts.**
  - Shift+Return starts a new line, shown under `…`. It works in iTerm2,
    kitty, WezTerm and Ghostty with no setup, because Quoder requests the
    kitty keyboard protocol for the session.
  - Ctrl+J (or Option+Return set to send Esc) works in any terminal.
  - Return sends all the lines as one prompt.
  - A multi-line paste stays one prompt until you press Return.
- **Model.** The default is `ollama/glm-4.7-flash:latest`. Override it with
  `quoder --model provider/model`.
- **Commands and keys.**
  - `/help`; `/exit` or Ctrl-D to leave.
  - Ctrl-C cancels a running prompt (interrupt, settle, delete), prints
    "Execution cancelled … Harness session remains active.", and returns to
    the prompt.
  - On a `…` line, Ctrl-C discards the draft; at an empty prompt it leaves
    Quoder.
  - SIGTERM and SIGHUP cancel, clean up, and exit with 143 and 129.
  - A closed output pipe exits cleanly with 141.
- **Safety of displayed text.** Everything from the model or a tool is cleaned
  of terminal control sequences before it is shown, including Markdown
  character references such as `&#27;`. Markdown is rendered in a worker
  thread with a 200 ms deadline per block and a memory cap, so crafted output
  is shown as plain text instead of freezing or crashing Quoder.
- **A dropped first prompt.** OpenCode 1.18.33 sometimes accepts the first
  prompt on a new server and never starts it. Quoder notices within 5 s, says
  so, and sends the prompt once more in a fresh session.

Known limitations:

- **No permissions are granted.** Any OpenCode permission request is rejected
  and reported, and the model's interactive questions are rejected and shown so
  you can answer in your next prompt. Interactive permission handling arrives
  in Milestone 3.
- **Multi-line editing.** Only the line you are typing can be edited; Up and
  Down recall earlier prompts. Full multi-line editing is in `docs/backlog.md`.
- **Server password.** The OpenCode server's password necessarily stays in the
  server process's own environment: the pinned OpenCode reads it only from
  `OPENCODE_SERVER_PASSWORD` and offers no file or descriptor alternative.
  Quoder therefore makes it useless rather than hidden. Every model-run shell
  runs under a macOS Seatbelt profile that denies outbound loopback, reads of
  Quoder's private configuration, and process inspection, and that a descendant
  cannot relax. External network access still works. Check it with
  `npm run verify:sandbox`, which drives the real OpenCode Bash tool with no
  model call. macOS only; other platforms fail closed. Interactive permission
  grants stay default-off pending the remaining Milestone 3 reviews. Other
  hardening items are listed in the Milestone 1 and 2 specs' `decisions.md`
  and in `docs/backlog.md`.
- **Model nondeterminism.** The model does not always follow instructions
  exactly.

Live acceptance check (contacts the configured model):

```bash
npm run verify:harness
```

It runs the built CLI from a disposable project with four prompts: two
answers, a read of a seeded file, and a long prompt that is cancelled with
SIGINT. It checks:

- one server, and a distinct, verified-deleted session per prompt (two if
  OpenCode dropped the prompt and Quoder retried);
- text streamed before each answer, and tool activity;
- cancel-and-continue;
- a clean exit, with no residual server.

QA recorded `Milestone 1 Exit Criterion: MET` and `Milestone 2 Exit Criterion:
MET` on 2026-10-04.

## Milestone 0 status

**Capability verdict: PASS. Milestone 0 is passed (authoritative
`npm run verify:live`, 2026-10-03: all nine predicates PASS; see "Milestone 0
Live Result — 2026-10-03 authoritative PASS" in `docs/tech.md`).** Milestone 1 is
complete (see above). Before Quoder forwards real permission decisions
(Milestone 3), keep the OpenCode server's credentials out of model-run tool
environments.

Earlier authoritative run, 2026-10-03, 8 of 9 PASS: Permission handling failed
because of the permission-event subscription race, which has since been fixed.

Earlier run, 2026-10-02: The 2026-10-02 run followed a passing preflight but stalled
in its first prompt stage. See "Milestone 0 Live Result — 2026-10-02 run" in
`docs/tech.md`.

**Permission-event race: fixed. Authoritative Run: GO (2026-10-03).** The
`2026-10-03-permission-event-race` spec replaced the permission stage's late,
per-stage subscription with the run-long event monitor. That subscription is
confirmed connected (`server.connected`) before any session exists, and it
records `permission.v2.asked` for the probe's own sessions. Against the real
server, with no model calls, QA observed 27/27 events with the new design and
0/27 with the old late-reader design, which explains the 2026-10-03 Permission
handling FAIL. The general, security, and QA gates passed.

**Probe reliability fixes: done (2026-10-03).** The `2026-10-03-live-probe-reliability` spec made these changes:

- **Stream parsing.** Session-stream events are parsed in the runtime shape the
  SDK actually yields.
- **Questions.** The model's interactive `question` tool no longer blocks
  unattended sessions: the probe rejects questions raised by its own sessions.
- **Prompts.** The scenario prompts were tuned by sampling the configured model.
- **Stage isolation.** Each stage after session creation now runs in
  isolation, so one run reports evidence for all nine predicates. A failed stage
  is journaled with a credential-safe cause, and absent evidence is never
  reported as a PASS.

The general, security, and QA gates passed. Model nondeterminism remains: the
model occasionally writes a tool call as plain text instead of calling the tool.
QA estimates about a 0.7 chance that all three model-dependent stages cooperate
in a single run, so a failure caused only by that may justify a rerun. Run
`npm run verify:environment` immediately before any authorized
`npm run verify:live`.

**Environment Readiness: PASS. Future Capability QA: GO (2026-10-02).** The
environment and architecture reassessment
(`.cmd/specs/2026-09-30-environment-architecture-reassessment/`) found that the
earlier failure was not the model service and not an inherent OpenCode
limitation. The cause was three Quoder-side contract errors against the pinned
OpenCode `1.18.33`:

- Core V2 `session.wait` is an unconditional 503 stub in this version.
  Completion is now detected by polling `GET /api/session/active`.
- Session messages default to newest-first, and every model step adds its own
  assistant message. The final response is now the turn's last completed
  assistant message, read in ascending order.
- Model-run commands appear as `session.next.tool.called` (`bash`), and an
  interrupt produces `session.next.tool.failed`. No `session.idle` event is
  emitted. The cancellation evidence now uses these verified events.

The configured model is `ollama/qwen3-coder:30b`, served by a remote HTTPS
OpenAI-compatible endpoint rather than localhost Ollama. Sessions bind it
explicitly. The general, security, and QA gates all passed.

GO does **not** pass Milestone 0. The next step is a fresh
`npm run verify:environment` followed by an explicitly user-authorized
`npm run verify:live`. Milestone 0 passes only if that run reports PASS for all
nine predicates below.

The previous authoritative run, QA Cycle 2 on 2026-09-30, completed reliably but
proved none of the nine capabilities. Its first model prompt timed out, which
was later traced to the contract errors above. Tested environment:

- macOS 26.7, arm64
- Node `v24.18.1`
- npm `12.0.2`
- project-local `opencode-ai@1.18.33`
- project-local `@opencode-ai/sdk@1.18.33`

The nine required capability predicates all reported `FAIL`:

| Capability | Result | Limitation in QA Cycle 2 |
| --- | --- | --- |
| Fresh session creation | FAIL | The first Core V2 session was created, but the second required session was not reached. |
| Project directory | FAIL | No completed model file activity proved confinement to the disposable repository. |
| Local model invocation | FAIL | The initial prompt timed out while Ollama was unavailable. |
| Streaming events | FAIL | No qualifying structured execution event was observed before timeout. |
| Permission handling | FAIL | The Core V2 permission request/reply stage was not reached. |
| File modification | FAIL | The required `hello.txt` output was not produced and verified. |
| Cancellation | FAIL | The cancellation fixture and interrupt validation were not reached. |
| Session deletion | FAIL | Cleanup succeeded, but the complete normal deletion predicate was not proven. |
| Session isolation | FAIL | The second session and isolation sentinel exchange were not reached. |

The QA verdict was `PASS` because the command completed in finite time, emitted
all nine results, recorded an auditable stage journal, and verified cleanup. That
QA verdict does not override the separate capability verdict.

## Reproduce the probe

Install the pinned project dependencies and run deterministic checks:

```bash
npm ci
npm run typecheck
npm test -- --reporter=dot
npm run verify:live:smoke
```

Check environment readiness first. The preflight validates the pinned
dependencies, the provider configuration (which must use HTTPS and declare the
model), endpoint reachability, model discovery, bounded direct inference, and
bounded inference through a disposable authenticated project-local OpenCode
server, and then cleans up. It prints exactly eight rows and one
`Environment Readiness: PASS|FAIL` verdict, using fixed, credential-free
evidence text. It exits zero only when every row passes. Deadlines are 10 s
for discovery, 60 s for inference, and 180 s for the whole run.

```bash
npm run verify:environment
```

Readiness is a prerequisite only; it satisfies none of the nine capability
predicates. Run the authoritative environment-dependent scenario only after a
passing preflight, and only with explicit authorization:

```bash
npm run verify:live
```

The command writes a credential-safe stage journal to
`.live-build/verify-live.journal.jsonl`, prints one row for each capability, and
exits nonzero if any predicate fails. Its default whole-run deadline is 600,000
ms; the initial prompt retains a 120,000 ms operation timeout. Diagnostic
overrides are available:

```bash
QUODER_LIVE_TIMEOUT_MS=300000 \
QUODER_LIVE_JOURNAL_PATH=/tmp/quoder-live.journal.jsonl \
npm run verify:live
```

The live command starts a local authenticated server, invokes the developer's
configured model, and creates disposable temporary fixtures. It does not use the
system OpenCode installation. A passing smoke test is regression evidence only;
it is not live capability evidence.

## Workflow

Start your AI coding agent in this repository and ask it to read `AGENTS.md` first.

Example:

```text
Read AGENTS.md and SYSTEM_CONTEXT.md, then use prompts/scope.md to open the first spec for ...
```

## Local Setup

Repository workflow setup:

1. Read `AGENTS.md` and `SYSTEM_CONTEXT.md` before non-trivial work.
2. Keep confirmed framework, SDK, and contract notes in `docs/tech.md`.
3. Create or resume a spec under `.cmd/specs/` for non-trivial work.
4. Make the guardrail scripts executable if you plan to run them locally:

```bash
chmod +x scripts/guardrails/*.sh
```

## Canonical CMD Source

This repository was bootstrapped from:

- `/Users/jeffrey/Development/AI/collaborative-multi-agent-development`
