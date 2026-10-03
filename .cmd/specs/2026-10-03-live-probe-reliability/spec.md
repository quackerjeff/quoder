# Live Probe Reliability

## Context

The environment reassessment (`2026-09-30-environment-architecture-reassessment`) closed with `Environment Readiness: PASS` and `Future Capability QA: GO`. The user-authorized authoritative `npm run verify:live` on 2026-10-02 then failed all nine predicates. It stalled for two consecutive 120 s timeouts in the initial-prompt stage and then raised an error, so no later stage ran. Bounded diagnostics (recorded in `docs/tech.md`, "Milestone 0 Live Result — 2026-10-02 run") identified:

1. **Session-stream parsing defect.** At runtime, the 1.18.33 SDK yields session-stream items as parsed objects (`{ id, type, durable, data }`, with `data` as the payload object). The generated type says `data: string`. The probe's `JSON.parse(item.data)` never matches, so Streaming events cannot pass and the stage waits out its stream timeout.
2. **Interactive `question` tool stall.** The 1.18.33 `build` agent allows the `question` tool. When the model calls it, the tool stays running until someone answers. It raises no permission event, so the session never becomes idle.
3. **Instruction-following.** In four sampled runs of the exact first prompt, `qwen3-coder:30b` never created `hello.txt`. Three runs replied with text other than the `TOKEN_STORED` sentinel; one called `question`.
4. **Fail-fast scenario.** `run()` stops at the first error, so a single stall hides every later predicate.

Milestone 0 remains unpassed and Milestone 1 remains blocked.

## Decision

Make the live probe a faithful, informative test of the nine predicates without weakening them:

- Fix the session-stream parsing against the verified runtime shape, with test fakes that use that shape.
- Prevent interactive questions from blocking unattended disposable sessions, using a verified, disposable-scope mechanism. Quoder must never modify the user's configuration. The mechanism must also not weaken any capability predicate, permission enforcement, or the permission-handling predicate.
- Make the scenario prompts explicit enough that a cooperating model reliably performs the required actions. Measure reliability by sampling the prompts in bounded scratch diagnostics before spending an authoritative run.
- Let the scenario continue past a failed stage where later stages remain meaningful, so one run reports evidence for every predicate. Each predicate stays conjunctive and evidence-based; a failure is never converted into a pass.

### Smallest viable outcome

The next authorized `npm run verify:live` either passes all nine predicates or yields specific, per-predicate evidence of what failed.

### Alternatives considered

- **Re-run `verify:live` unchanged.** Rejected: the parsing defect alone guarantees Streaming events FAIL.
- **Loosen predicates, for example accepting near-sentinel text.** Rejected: the PRD requires exact, verifiable behavior.
- **Change the model or provider.** Deferred: the configured model has demonstrated tool calling (`glob`, `bash`). Prompt clarity is the cheaper, reversible first step. If sampling shows the model cannot follow explicit instructions, record that as a product finding and escalate the model decision to the user.
- **Edit the user's OpenCode configuration to deny `question`.** Rejected: it is outside Quoder's ownership. Any mitigation must be scoped to the disposable environment or the probe's own server process.

## Constraints

- Do not modify the user's OpenCode configuration, provider credentials, services, or models. Retain exact `opencode-ai@1.18.33` and `@opencode-ai/sdk@1.18.33`.
- Do not run `npm run verify:live` without explicit user authorization.
- Scratch diagnostics stay outside the repository and are bounded. They may print model replies to aid prompt tuning. Tracked artifacts record only summaries, never raw model replies, credentials, or configuration.
- Preserve authentication, permission correlation, path confinement, deletion verification, cancellation strictness, the explicit model binding, redaction, the preflight contract, and readiness-versus-capability separation.
- Verify every new OpenCode contract live or in the pinned bundle before relying on it, and record it in `docs/tech.md`.

## Design

### Stream parsing

The session stream is consumed as typed runtime objects. A narrow runtime guard accepts objects with a string `type` and an optional numeric `durable.seq`. It tolerates the generated string form only if the guard proves the string to be a JSON event, so evidence never depends on a type the runtime does not produce.

### Question-tool mitigation

Candidates, verified in Group 1 before selection:

- (a) a project-level OpenCode config inside the disposable repository that sets `permission.question: "deny"`;
- (b) configuration passed only to the probe's own server process, for example via an environment variable the pinned CLI documents;
- (c) observing the question and declining it through the Core V2 question API.

Select the option that is verified, disposable-scoped, and leaves the permission-handling predicate intact. That predicate uses `external_directory` and must still `ask`.

### Prompts

Each model-dependent stage gets a directive prompt:

- name the tool action;
- state exact content, with no clarification needed;
- forbid questions;
- require a reply consisting of exactly the sentinel.

Acceptance is measured by sampling each prompt with the real model in scratch diagnostics. The target is a cooperating success in at least 4 of 5 samples per prompt, with no blocking behavior. The predicates themselves are unchanged.

### Continue past failed stages

The scenario records a stage failure as missing evidence and proceeds wherever later stages are independent. Permission handling is independent of the first prompt's file write. Cancellation needs a live first session. Deletion and isolation need the session lifecycle. Every created resource is still cleaned up, and the whole-run 600 s deadline stays.

### Tests

- Fakes use the verified runtime stream shape.
- Unit and driver tests cover the question mitigation, the continue-past-failure behavior (a failed stage does not suppress later independent evidence and never produces a false PASS), and the new prompts' exact sentinels.

Security review applies: configuration is placed in disposable scope, and a child process's environment or arguments may change.

## Source-to-Spec Audit

- **Source requirement:** `docs/requirements.md` requires all nine Milestone 0 predicates in one authoritative run.
- **Evidence:** the 2026-10-02 authoritative FAIL and its diagnostics.
- **User direction:** the user deferred to the recommendation to open this spec, and to show model replies only in scratch diagnostics.
