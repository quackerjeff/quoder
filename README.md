# Quoder

Quoder is intended to provide a persistent developer-facing shell/TUI while each
prompt runs in a fresh, disposable OpenCode session. The repository currently
contains the Milestone 0 feasibility probe, not the production CLI/TUI.

## Milestone 0 status

**Capability verdict: FAIL (last authoritative run, 2026-09-30). Milestone 1
remains blocked.**

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
