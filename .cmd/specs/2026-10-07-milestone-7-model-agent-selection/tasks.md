# Tasks: Milestone 7 — Model and Agent Selection

Spec: `.cmd/specs/2026-10-07-milestone-7-model-agent-selection/spec.md`

## Group 1: Research and interaction contract

- [x] Verify model/agent discovery and session-binding contracts; define command behavior | `docs/tech.md`, `spec.md`, `decisions.md`
  - **Accept**: Confirm pinned 1.18.33 imports/signatures/response fields for model and agent catalogs and session creation; define listing, matching, visibility, error, selection lifetime, and UI states.
  - **Verify**: Inspect the local generated declarations for `client.v2.model.list`, `client.v2.agent.list`, `ModelV2Info`, `AgentV2Info`, and `V2SessionCreateData`; compare with current adapter and CLI behavior.
  - **Constraints**: Research only. Do not inspect user OpenCode configuration/credentials or submit live model prompts. Preserve the existing default model and fresh-session boundary.
  - **Progress**: Pinned SDK contracts verified in `node_modules/@opencode-ai/sdk@1.18.33`; findings recorded in `docs/tech.md`. Command behavior and selection decisions are recorded in this spec and `decisions.md`.

## Group 2: Catalog discovery adapter

- [x] Add bounded project-scoped model and agent catalog methods to the existing adapter | `src/opencode-adapter.ts`, `tests/unit/opencode-adapter.test.ts`
  - **Accept**: Use `client.v2.model.list` and `client.v2.agent.list` with the canonical project directory; return only the narrow fields needed by the UI; map API failures to sanitized adapter diagnostics; do not expose secrets or agent prompts.
  - **Verify**: `npm test -- --run tests/unit/opencode-adapter.test.ts` and `npm run typecheck`.
  - **Constraints**: No new SDK/package. Use generated 1.18.33 V2 declarations; do not substitute legacy `app.agents()` or config-file parsing.
  - **Progress**: Implemented with enabled/visible filtering and narrow return values. Focused adapter, REPL, history, session-runner, and selection suites pass; `npm run typecheck` passes.

## Group 3: REPL selection and fresh-session wiring

- [x] Implement `/model` and `/agent` list/select commands and bind selections to each new session/history record | `src/harness/repl.ts`, `src/harness/session-runner.ts`, `src/opencode-adapter.ts`, `tests/integration/harness.test.ts`, `tests/unit/session-runner.test.ts`
  - **Accept**: Show current selection and selectable catalog values; resolve exact and unique case-insensitive partial matches; leave state unchanged on invalid/ambiguous input; apply selections to subsequent prompts; store the effective model and agent in each history record.
  - **Verify**: `npm test -- --run tests/integration/harness.test.ts tests/unit/session-runner.test.ts tests/unit/execution-history.test.ts` and `npm run typecheck`.
  - **Constraints**: Catalog output is untrusted; sanitize every displayed dynamic value. No selection changes during an active prompt, no disk persistence, and no loss of current model/agent after catalog errors.
  - **Progress**: Integration coverage confirms listing, selection, ambiguous/missing-choice preservation, catalog-error handling, next-session binding, and history values. Focused suite passes with 175 tests; `npm run typecheck` passes.

## Group 4: CLI defaults and user documentation

- [x] Preserve startup model override and document selection commands and limits | `src/cli.ts`, `tests/unit/cli.test.ts`, `README.md`, `docs/requirements.md`, `docs/tech.md`
  - **Accept**: Existing `--model provider/model` parsing/default remains compatible; help and README show `/model` and `/agent` behavior, including process-local selection and errors.
  - **Verify**: `npm test -- --run tests/unit/cli.test.ts` and `git diff --check`.
  - **Constraints**: Do not imply selection persists across Quoder restarts or guarantees provider connectivity.
  - **Progress**: README and CLI usage text now describe `/model` and `/agent`; `docs/tech.md` records runtime selection behavior. Existing `--model` parser/default are unchanged. Requirements remain accurate without edits.

## Group 5: General review

- [x] Review Milestone 7 implementation and selection edge cases | `.cmd/specs/2026-10-07-milestone-7-model-agent-selection/review.md`
  - **Accept**: Latest review verdict is PASS with zero Critical and Warning findings.
  - **Verify**: Read the implementation diff and run reviewer-requested focused checks.
  - **Constraints**: Review must follow the completed implementation groups; append cycles without rewriting prior findings.
  - **Progress**: Independent reviewer agent `/root/milestone7_independent_review` returned PASS, then rechecked the catalog-validation remediation and returned PASS. No open correctness/regression findings; catalog-size/field-length caps are documented as an operational limit.

## Group 6: Security review

- [x] Review catalog data handling, command parsing, and selection wiring | `.cmd/specs/2026-10-07-milestone-7-model-agent-selection/security-review.md`
  - **Accept**: Latest security verdict is PASS with zero Critical and Warning findings.
  - **Verify**: Review sanitized rendering, API error handling, agent visibility filtering, and provider/model identifiers.
  - **Constraints**: Run after Group 5 passes; do not inspect user credentials or configuration.
  - **Progress**: Independent security reviewer agent `/root/milestone7_independent_security` initially found one Low malformed-catalog robustness issue. It was fixed and the same reviewer rechecked the delta and returned PASS with no remaining findings. No credentials/configuration were inspected.

## Group 7: QA validation

- [x] Validate model/agent list, selection, ambiguous input, and next-session behavior | `.cmd/specs/2026-10-07-milestone-7-model-agent-selection/qa.md`
  - **Accept**: QA covers command list/select/error paths, selection persistence within one harness process, new-session binding, history fields, and regression behavior; release confidence is documented.
  - **Verify**: Run repository-required automated and scenario validation from shared `steering/quality-engineering.md`; persist commands and results in `qa.md`.
  - **Constraints**: Do not contact the configured model or use user credentials unless separately authorized. Use fakes/fixtures for catalog and session behavior.
  - **Progress**: QA verdict PASS for local automated functional scope; final full suite 31 files/592 tests, build, typecheck, and diff check pass after security remediation. No live provider or manual terminal session was used.

## Group 8: Documentation and completion

- [x] Reconcile requirements, README, technical notes, and repository context; close the spec | `README.md`, `docs/requirements.md`, `docs/tech.md`, `SYSTEM_CONTEXT.md`, `.cmd/specs/2026-10-07-milestone-7-model-agent-selection/`
  - **Accept**: Docs match implementation and decisions; review, security, and QA gates pass; every task is complete; `.cmd/specs/currentspec.md` is cleared.
  - **Verify**: `git diff --check`; compare docs to the implementation and Group 1 research.
  - **Constraints**: Do not claim selections persist across process restarts or that listed models are reachable.
  - **Progress**: README and technical notes updated. Product requirements already described this milestone and remain unchanged; SYSTEM_CONTEXT ownership, boundaries, and dependencies did not materially change. QA/review/security reports are recorded; active spec pointer cleared after final checks.
