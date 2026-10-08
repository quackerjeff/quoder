# Tasks: Milestone 8 — Context Optimization

Spec: `.cmd/specs/2026-10-07-milestone-8-context-optimization/spec.md`

Groups run in order. Groups 1–7 passed; Group 8 documentation and completion is the final gate. Do not mark a blocked task complete. Each task is assigned to an independent agent in the named role.

## Group 1: Research and current-state audit — architect

- [x] Audit M5 context pruning and M6/M7 measurements against the M8 source requirements | `src/harness/context-builder.ts`, `src/harness/repl.ts`, `src/harness/live-view.ts`, `src/harness/execution-history.ts`, `docs/tech.md`, `.cmd/specs/2026-10-07-milestone-5-persistent-context/`
  - **Accept**: Audit identifies each M8 requirement as already satisfied, partially satisfied, or open, with source paths and existing M5 QA/review evidence; no existing behavior is recast as new work.
  - **Verify**: `rg -n "Milestone 5|Milestone 8|contextCharacters|outputTokens|durationMs|step-ended" docs/requirements.md docs/tech.md src/harness tests/unit/context-builder.test.ts tests/unit/live-view.test.ts tests/unit/execution-history.test.ts`
  - **Constraints**: Read-only research; do not edit implementation or claim tests were run. No live model/provider calls. Group 1 planning evidence: existing code/spec/report inspection on 2026-10-07.

- [x] Verify the pinned usage-event contract and identify what Quoder currently retains | `docs/tech.md`, `src/harness/stream-events.ts`, `src/harness/live-view.ts`
  - **Accept**: The research record names the pinned `@opencode-ai/sdk@1.18.33` declaration/package paths, lists the exact step-event usage fields and the limits of their documented semantics, distinguishes SDK-reported values from tokenizer/cost estimates, and records that Quoder currently coerces missing/invalid fields to zero and loses availability. No API is assumed from memory.
  - **Verify**: `rg -n "tokens|step.ended|@opencode-ai/sdk@1.18.33" docs/tech.md src/harness/stream-events.ts src/harness/live-view.ts`
  - **Constraints**: Use only pinned generated declarations/package metadata for this research; semantic details not documented by those types remain unspecified. Do not change code, add dependencies, or perform provider calls. Planning research and documentation completed on 2026-10-07; implementation must preserve availability rather than treating missing usage as zero.

## Group 2: Product-scope decisions — architect records user decisions

- [x] Record user decisions for comparison, continuity, usage metrics, persistence, and pruning scope | `.cmd/specs/2026-10-07-milestone-8-context-optimization/decisions.md`, `spec.md`
  - **Accept**: User decisions are recorded: fixed 20-turn cumulative Unicode-code-point comparison with Quoder at no more than 50% of transcript total; synthetic continuity cases; preserve M5 previous-request-only injection and no live model QA; display SDK-reported per-run input/output usage when present; persist no new usage metrics; keep M5 pruning unchanged.
  - **Verify**: `rg -n "Group 2 resolved|50%|20-turn|per-run input and output|no new usage metrics|M5 context pruning unchanged" .cmd/specs/2026-10-07-milestone-8-context-optimization/decisions.md .cmd/specs/2026-10-07-milestone-8-context-optimization/spec.md`
  - **Constraints**: Do not reopen or alter the approved decisions. Do not persist new usage metrics, change M5 pruning, or make live provider calls.

## Group 3: Completion usage presentation — ui-designer

- [x] Design the completion-UI presentation for SDK-reported per-run input/output usage | `.cmd/specs/2026-10-07-milestone-8-context-optimization/spec.md`
  - **Accept**: Independent UI designer defines labels and units for SDK-reported input/output usage, behavior when either value is absent, and a representative completion line consistent with the current duration/output-token summary; the approved design is added to this spec before coding.
  - **Verify**: `rg -n "Group 3|UI designer|per-run input and output|unavailable-value" .cmd/specs/2026-10-07-milestone-8-context-optimization/spec.md`
  - **Constraints**: Keep the approved scope: per-run display only, no new usage persistence, no provider/tokenizer estimates, and no change to M5 pruning. UI designer defines presentation details only; escalate any request to broaden product behavior.

## Group 4: Implementation — coder

- [x] Implement only the user-approved M8 gaps in measurements and context optimization | `src/harness/context-builder.ts`, `src/harness/stream-events.ts`, `src/harness/live-view.ts`, `src/harness/repl.ts`, `src/harness/execution-history.ts`, related tests, `docs/tech.md`
  - **Accept**: Each approved source requirement has a testable implementation; already-satisfied M5/M6/M7 behavior is reused; tests cover reported/absent input/output usage, exact context and request sizing, the fixed 20-turn comparison, synthetic continuity scenarios, and preservation of fresh-session/retry semantics. No usage metrics are persisted and M5 pruning remains unchanged.
  - **Verify**: `npm test -- --run tests/unit/context-builder.test.ts tests/unit/stream-events.test.ts tests/unit/live-view.test.ts tests/unit/execution-history.test.ts tests/integration/harness.test.ts && npm run typecheck && npm run build`
  - **Constraints**: Follow Group 2 decisions and Group 3 design. Do not add usage persistence or change M5 pruning. Preserve current request verbatim, untrusted-data labels/escaping, and exclusion of prior assistant responses/full conversation transcripts. No provider calls. Do not introduce unresearched dependencies.

## Group 5: General review gate — reviewer

- [x] Independently review all implementation groups | `.cmd/specs/2026-10-07-milestone-8-context-optimization/review.md`
  - **Accept**: Independent reviewer returns PASS with zero critical findings and zero warnings; orchestrator stores the report verbatim.
  - **Verify**: `rg -ni "verdict: pass" .cmd/specs/2026-10-07-milestone-8-context-optimization/review.md`
  - **Constraints**: Read-only review. Do not proceed to security review until general review passes; maximum three review cycles before escalating unresolved findings.

## Group 6: Security review gate — security-reviewer

- [x] Independently review context handling, telemetry, persistence, and output safety | `.cmd/specs/2026-10-07-milestone-8-context-optimization/security-review.md`
  - **Accept**: After Group 5 PASS, security reviewer returns PASS with zero critical findings and zero warnings; report is stored verbatim. Review includes data minimization, prompt/context retention, untrusted context encoding, token/cost exposure, and malformed/missing usage data.
  - **Verify**: `rg -ni "verdict: pass" .cmd/specs/2026-10-07-milestone-8-context-optimization/security-review.md`
  - **Constraints**: Read-only security review, sequential after general review. Do not expand collection or persistence beyond approved decisions.

## Group 7: QA validation — qa-engineer

- [x] Validate approved context-optimization scenarios and release confidence | `.cmd/specs/2026-10-07-milestone-8-context-optimization/qa.md`
  - **Accept**: QA report separates automated/manual coverage, validates the fixed 20-turn cumulative Unicode-code-point comparison against the 50% threshold and the synthetic follow-up/saved decision/constraint/live-Git continuity scenarios, includes context and usage availability cases, identifies residual gaps, and records a release-confidence level and PASS/FAIL verdict. No live model/provider QA run is required.
  - **Verify**: `rg -ni "verdict: pass|verdict: fail|release confidence" .cmd/specs/2026-10-07-milestone-8-context-optimization/qa.md`
  - **Constraints**: QA is separate from code review. Do not alter the approved threshold/scenarios or make live provider calls; prior assistant-response content remains excluded from prompts.

## Group 8: Documentation and completion — docs

- [x] Update user/technical documentation and close Milestone 8 records | `README.md`, `docs/requirements.md`, `docs/tech.md`, `.cmd/specs/2026-10-07-milestone-8-context-optimization/`
  - **Accept**: Docs match reviewed and QA-validated behavior, accurately describe units and unavailable/estimated metrics, include no descoped promises, completion record summarizes evidence/limitations, all tasks are `[x]`, and active spec pointer is cleared only after all gates pass.
  - **Verify**: `npm run typecheck && npm run build && git diff --check && rg -ni "verdict: pass" .cmd/specs/2026-10-07-milestone-8-context-optimization/review.md .cmd/specs/2026-10-07-milestone-8-context-optimization/security-review.md .cmd/specs/2026-10-07-milestone-8-context-optimization/qa.md`
  - **Constraints**: Documentation is the final group and runs after review, security, and required QA. Do not clear `currentspec.md` or claim completion while a gate is missing or failed.
