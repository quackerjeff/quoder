# Tasks: Live Probe Reliability

Spec: `.cmd/specs/2026-10-03-live-probe-reliability/spec.md`

Groups execute sequentially. No task authorizes `npm run verify:live`; that requires explicit user authorization after QA.

## Group 1: Verify contracts and tune prompts (diagnostics only)

- [x] Verify the question mitigation and measure prompt reliability | `docs/tech.md`, `.cmd/specs/2026-10-03-live-probe-reliability/decisions.md`
  - **Packages**: None.
  - **Accept**: Verify, live or in the pinned bundle, which question-tool mitigation works in disposable scope and leaves `external_directory` asking. For each model-dependent stage (initial file write plus `TOKEN_STORED`, cancellation fixture, isolation `NO_PRIOR_SESSION`), sample candidate prompts with the real model in bounded scratch diagnostics until one meets the spec target (at least 4/5 cooperating successes, no blocking behavior), or record that none does. Record selected prompts, sample counts and outcomes, and the mitigation evidence as summaries only.
  - **Verify**: `rg -n 'question|prompt|sample' .cmd/specs/2026-10-03-live-probe-reliability/decisions.md && git diff --check`
  - **Constraints**: Scratch diagnostics only, outside the repository. No user-config changes. No `verify:live`. If no prompt meets the target, stop and escalate the model decision to the user.
  - **Completed evidence**: Option (c), rejecting questions via the Core V2 question API, was verified and selected; option (b), config-content deny, was rejected because the question still blocked. Selected prompts scored: initial 5/5, cancellation 9/10, isolation 5/5. `external_directory` still asks. The residual risk is a model emitting its tool call as text (about 1 in 10 cancellation samples). See `decisions.md`.

## Group 2: Implement probe reliability fixes

- [x] Fix stream parsing, apply the question mitigation and prompts, and continue past failed stages | `src/live-probe.ts`, `src/opencode-adapter.ts` (if needed), `tests/`, `docs/tech.md`
  - **Packages**: None; retain exact pins.
  - **Accept**: The spec's Design sections are implemented, with tests using the verified runtime stream shape. No predicate is weakened. `npm run typecheck` and `npm test` pass, and `npm run verify:environment` still passes.
  - **Verify**: `npm run typecheck`, `npm test -- --reporter=dot`, `npm run verify:environment`, and `git diff --check`, run separately.
  - **Constraints**: No `verify:live`. No user-config changes.
  - **Completed evidence**:
    - **Stream parsing**: `sessionStreamEvent` accepts the verified runtime form (parsed objects) and the declared string form only when it parses to an event.
    - **Questions**: `OpenCodeAdapter.rejectQuestion` was added, and `globalEvents` accepts a `timeoutMs` and an abort `signal`. The driver's question guard subscribes for the whole run and rejects `question.v2.asked` only for its own sessions.
    - **Prompts**: the three sampled prompts are exported (`initialPrompt`, `cancellationPrompt`, `ISOLATION_PROMPT`), and `INITIAL_PROMPT_SENTINEL` is shared with the predicate.
    - **Stages**: after session creation, each stage runs through `#stage`. A failure is journaled as `<stage>.failed`, the session is settled with an interrupt and an idle wait, and later stages continue. Isolation is skipped without an admitted nonce.
    - **Project directory**: this evidence now requires the model-produced `hello.txt`, read through the confined-path check. Previously it always passed on constant paths. This tightening is recorded in `decisions.md`.
    - **Tests**: fakes use the runtime stream shape, and the question-guard subscription ends on abort. New tests cover parsing both forms, exact prompts, question rejection scoped to own sessions, and continuing past a failed initial prompt with the full nine-row report (no false PASS). The interrupt-failure scenario now asserts continuation to isolation.
    - **Mutation checks**: string-only parsing, an unscoped guard, and constant project paths each fail the tests.
    - **Results**: `npm run typecheck` passed. `npm test -- --reporter=dot` passed 121/121; the preflight timing test also passed 3/3 alone after an earlier failure under load from hanging tests. The real `npm run verify:environment` passed all eight rows. `git diff --check` passed. `docs/tech.md` was updated. No `verify:live`; no user-config change.

## Group 3: General review gate

- [x] Fresh review of Groups 1–2 | `.cmd/specs/2026-10-03-live-probe-reliability/review.md`
  - **Accept**: Verdict PASS with zero critical findings and zero warnings, persisted verbatim.
  - **Constraints**: Maximum 3 cycles, then escalate. No `verify:live`.

  - **Failed cycle 1**: Zero critical findings and two warnings: cancellation failures that return `false` without throwing are never settled; and neither the settle branch nor a positive full-PASS driver path is tested. Five suggestions. See `review.md`.

## Fix Group 1: Address review Cycle 1

- [x] Settle unconditionally between stages and cover the settle and full-PASS driver paths | `src/live-probe.ts`, `src/opencode-adapter.ts`, `tests/`, `docs/tech.md`
  - **Accept**:
    - The first session is settled (interrupt and idle wait if active) after every stage, including a cancellation stage that returns without throwing. A not-passed cancellation is journaled distinctly.
    - A driver scenario leaves the session active after a non-throwing cancellation failure and asserts interrupt, then idle, before the isolation stage.
    - A driver scenario in which the fake model writes `hello.txt` asserts non-empty, confined `projectPaths` and an all-PASS nine-row report.
    - Adopted suggestions:
      - stage failures journal a credential-safe cause (the adapter operation and a timeout flag, never message text);
      - the question guard journals an unexpected end;
      - `docs/tech.md` records the run-deadline residual and single-session deletion;
      - adapter unit tests cover the `globalEvents` `timeoutMs`/`signal` options and `rejectQuestion`.
  - **Verify**: `npm run typecheck`, `npm test -- --reporter=dot`, `npm run verify:environment`, and `git diff --check`, run separately.
  - **Constraints**: No `verify:live`. No user-config change. Then a fresh Review Cycle 2.
  - **Completed evidence**:
    - **Settling**: the first session is settled after every stage (initial, permission, cancellation) regardless of outcome. `cancellation.not-passed` and `session.initial.prompt.not-completed` are journaled.
    - **Journaling**: stage failures journal the adapter operation and a timeout flag, never message text. The question guard journals `question.guard.ended` if its stream ends before it is stopped.
    - **New driver tests**: a non-throwing cancellation failure with the session left running shows interrupt, then idle, before isolation creation; a fake model writing `hello.txt` produces confined `projectPaths` and an all-PASS nine-row report.
    - **New adapter tests**: `rejectQuestion` (success and diagnostic); `globalEvents` ending on caller abort with a pending read (listener removed), an already-aborted signal, and a custom timeout overriding the adapter default.
    - **Mutation checks** (each failed the tests): removing the post-cancellation settle, forcing empty project paths, and ignoring the caller signal.
    - **Docs**: `docs/tech.md` records settling, the journal causes, single-session deletion, and the run-deadline residual.
    - **Results**: `npm run typecheck` passed. `npm test -- --reporter=dot` passed 128/128. The real `npm run verify:environment` passed. `git diff --check` passed. No `verify:live`.

  - **Failed cycle 2**: Cycle 1's warnings are resolved. Zero critical findings and one warning: adapter failure causes are lost through `settlePairedOperations`, so most real failures journal `.failed.error`, and the docs overstate the contract. One suggestion: test `question.guard.ended`. See `review.md`. Cycle 3 is the last allowed cycle.

## Fix Group 2: Address review Cycle 2

- [x] Preserve adapter failure causes through paired operations and test the journal contract | `src/live-probe.ts`, `tests/`, `docs/tech.md`
  - **Accept**:
    - `settlePairedOperations` keeps its message and attaches the rejection reasons as the error's `cause`.
    - `#stage` journals the operation and timeout flag of the first `OpenCodeAdapterError` it finds directly or through `cause` or `errors` (bounded depth), never message text, and `error` otherwise.
    - Driver tests assert a direct adapter cause with a timeout (`session.initial.prompt.failed.wait-for-session.timeout`) and a paired cause (`session.initial.prompt.failed.submit-prompt`).
    - `question.guard.ended` is asserted when the guard stream ends early, and its absence is asserted in the normal full-PASS scenario.
    - `docs/tech.md` states the corrected contract.
  - **Verify**: `npm run typecheck`, `npm test -- --reporter=dot`, `npm run verify:environment`, and `git diff --check`, run separately.
  - **Constraints**: No `verify:live`. Then fresh Review Cycle 3 (final); if it fails, stop and escalate.
  - **Completed evidence**:
    - **Cause preservation**: `settlePairedOperations` keeps its message and attaches `cause: AggregateError(reasons)`.
    - **Classification**: the exported `findAdapterError` searches the error, its `cause`, and aggregated `errors` to depth 4. `#stage` journals that error's operation and timeout flag, or `error`, never message text.
    - **Test hook**: `OpenCodeLiveDriver` accepts an optional `operationTimeoutMs` so tests can exercise real timeouts; the default stays `LIVE_PROBE_TIMEOUT_MS`.
    - **New driver tests**:
      - a paired cause (`session.initial.prompt.failed.submit-prompt`, with no generic `.failed.error`);
      - a direct timeout (`session.initial.prompt.failed.wait-for-session.timeout`);
      - `question.guard.ended` on an early guard end;
      - the full-PASS scenario, which now asserts no failure or not-passed markers and no `question.guard.ended`.
    - **New unit tests**: `findAdapterError` directly, through a cause, through paired aggregation, for non-adapter errors, and at the depth bound.
    - **Mutation checks**: dropping the cause, ignoring the timeout flag, and inverting the guard-ended condition each failed the tests.
    - **Results**: `npm test -- --reporter=dot` passed 133/133 in three consecutive runs. `npm run typecheck` passed. The real `npm run verify:environment` passed. `git diff --check` passed. `docs/tech.md` has the corrected journal contract. No `verify:live`.

  - **Passed cycle 3**: PASS with zero critical findings and zero warnings. One optional suggestion: a self-referential cause case for `findAdapterError`. See `review.md`.

## Group 4: Security review gate

- [x] Fresh security review | `.cmd/specs/2026-10-03-live-probe-reliability/security-review.md`
  - **Accept**: Verdict PASS with zero critical findings and zero warnings, persisted verbatim.
  - **Constraints**: Only after Group 3 passes. No `verify:live`.

  - **Passed cycle 1**: PASS with zero critical findings, zero warnings, and no suggestions. See `security-review.md`.

## Group 5: QA and run recommendation

- [x] Independent QA of the preflight and probe reliability evidence | `.cmd/specs/2026-10-03-live-probe-reliability/qa.md`
  - **Accept**: QA validates the automated suite and the real preflight, reviews the Group 1 sampling evidence, and issues exactly one recommendation: `Authoritative Run: GO` or `Authoritative Run: NO-GO`.
  - **Constraints**: No `verify:live`. GO is a recommendation only.

## Group 6: Documentation and closure

- [x] Document results and the next authorized action | `README.md`, `docs/tech.md`, `.cmd/specs/2026-10-03-live-probe-reliability/decisions.md`
  - **Accept**: The docs reflect the implemented changes and the recommendation. `currentspec.md` is removed only after all gates pass.
  - **Constraints**: Do not claim Milestone 0 without an authoritative nine-predicate PASS.
  - **Completed evidence**: `README.md` reports the unchanged capability verdict (FAIL), the reliability fixes, the conditional GO with an estimated 0.7 per-run cooperation rate, and the next action. `docs/tech.md` records QA's re-sampling and the HTTP 502 caveat. `decisions.md` records the final state and what carries forward. Sixteen leftover test temp directories from earlier interrupted test runs were inspected and removed.
