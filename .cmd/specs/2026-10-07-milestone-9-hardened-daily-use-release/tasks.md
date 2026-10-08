# Tasks: Milestone 9 — Hardened Daily-Use Release

Spec: `.cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/spec.md`

## Group 1: Research and current-state audit

- [x] Audit roadmap requirements, existing lifecycle/state/config/error behavior, tests, SDK contracts, and risks | `docs/requirements.md`, `SYSTEM_CONTEXT.md`, `docs/tech.md`, `src/`, `tests/`, spec Group 1
  - **Accept**: Group 1 evidence and uncovered decisions are recorded in `spec.md`; existing features are distinguished from actual gaps; no unsupported acceptance threshold is added.
  - **Verify**: `git status --short --branch && rg -n "Milestone 9|Crash recovery|stale|corrupt|QUODER_TRACE_FILE|SERVER_STARTUP_TIMEOUT|SERVER_TERMINATION" docs/requirements.md SYSTEM_CONTEXT.md docs/tech.md src tests`
  - **Constraints**: Research only; do not implement, perform live model calls, or assume Quoder owns external OpenCode/Ollama processes.

## Group 2: Product and operational decision gate

- [x] Resolve stale-resource, corrupt-state, logging, configuration-validation, and failure-reporting decisions | `spec.md`, `decisions.md`
  - **Accept**: User-approved decisions are recorded; startup validation covers Quoder-owned settings and launch-critical dependency inputs; corrupt-state handling preserves source and offers manual guidance without interactive backup/reset.
  - **Verify**: `rg -n "Resolved product decisions|stale resources|Corrupt state|Structured logging|Configuration validation|Failure presentation|Group 2 is complete" .cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/spec.md .cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/decisions.md`
  - **Constraints**: Do not broaden validation into arbitrary OpenCode settings or introduce automatic/interactive state reset. No implementation is part of this task.

## Group 3: UI/error/recovery design

- [x] Define terminal behavior for approved recovery and error flows, or record that no new flow is required | `.cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/spec.md`
  - **Accept**: A role-specific UI design documents TTY and piped behavior, actionable diagnostic text, cancellation/decline behavior where relevant, and safe handling of long or untrusted error content; otherwise the group is marked complete with rationale after Group 2.
  - **Verify**: Check every approved user-facing behavior against the design and confirm it introduces no behavior absent from `decisions.md`.
  - **Constraints**: Do not expose credentials, raw provider payloads, or unsanitized terminal control characters. Do not design prompts for actions the user has not approved.

## Group 4: Lifecycle and stale-resource recovery

- [x] Implement owned-session intent ledger, stale-resource reporting, and explicit cleanup confirmation under the approved protocol | `src/harness/repl.ts`, `src/harness/session-runner.ts`, `src/opencode-adapter.ts`, `src/harness/owned-session-ledger.ts`, relevant unit/integration tests
  - **Accept**: Lifecycle behavior is deterministic and bounded. Atomically persist each random custom session ID and canonical project root before create; require create to return that ID and durably record `created-confirmed` before making it cleanup-eligible. Only durable `created-confirmed` entries with exact ID and canonical project/location match may be offered, and each requires explicit confirmation. Intent-only, uncommitted, ambiguous, or otherwise unconfirmed entries are report-only and never cleanup candidates, including when a ledger transition write fails. Preserve confirmed ledger entries until deletion is verified; report unknown activity and warn cleanup may interrupt; never touch old/unregistered sessions. Cover normal shutdown, cancellation, server loss, interruption, and stale-resource scenarios; document that a create-before-confirmed-write crash remains report-only for manual recovery.
  - **Verify**: `npm test -- --run tests/unit/opencode-sandboxed-launch.test.ts tests/unit/session-runner.test.ts tests/unit/opencode-adapter.test.ts tests/unit/execution-history.test.ts tests/unit/owned-session-ledger.test.ts tests/integration/harness.test.ts && npm run typecheck`
  - **Constraints**: Preserve fresh-session-per-prompt, permission behavior, atomic/private state, and existing retention semantics. Never kill unrelated OpenCode processes or delete sessions without explicit confirmation and exact ledger-ID/project match. Treat ID conflict/ambiguous create outcome as unowned; do not rely on current-process `Session3.active()` to prove an old server has stopped. No unbounded retries or live model calls.
  - **Research evidence**: The pinned 1.18.33 no-model probe verified the tested custom ID shape is accepted and visible through Core V2 get/list after server restart; see Group 4 research follow-up in `spec.md` and the contract note in `docs/tech.md`. The probe did not establish ID uniqueness/conflict semantics; the intent-before-create ledger and collision handling remain required.

## Group 5: State recovery and configuration validation

- [x] Implement user-approved corrupt-state handling and configuration validation | `src/harness/project-memory.ts`, `src/harness/execution-history.ts`, `src/cli.ts`, `src/opencode-server.ts`, relevant tests
  - **Accept**: Approved malformed, unsupported, unsafe, and unavailable-state scenarios produce the selected safe behavior; invalid supported configuration is detected at the selected boundary; no state is silently overwritten or discarded; focused tests assert both outcome and preserved data.
  - **Verify**: `npm test -- --run tests/unit/project-memory.test.ts tests/unit/execution-history.test.ts tests/unit/cli.test.ts tests/unit/opencode-sandboxed-launch.test.ts tests/integration/harness.test.ts && npm run typecheck`
  - **Constraints**: Keep atomic publication, schema/version checks, current retention controls, and state outside target projects. Validate only configuration in approved scope; do not dump config values in errors.

## Group 6: Structured diagnostics and graceful dependency failures

- [x] Implement approved structured logging and actionable sanitized OpenCode/provider failure reporting | `src/cli.ts`, `src/harness/repl.ts`, `src/opencode-adapter.ts`, `src/opencode-server.ts`, tests
  - **Accept**: Approved events use the selected structured format and destination; diagnostics distinguish approved failure categories and next steps; tests prove secrets and disallowed content are absent and logging failure does not corrupt session cleanup.
  - **Verify**: `npm test -- --run tests/unit/cli.test.ts tests/unit/opencode-adapter.test.ts tests/unit/opencode-sandboxed-launch.test.ts tests/integration/harness.test.ts && npm run typecheck`
  - **Constraints**: Follow the Group 2 content policy. Do not log prompts, tool output, provider payloads, credentials, or child stderr unless the approved design explicitly establishes safe handling. Logging must not block or change core execution outcomes.

## Group 7: General code review

- [x] Independent reviewer inspects all implementation groups and writes the report | `.cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/review.md`
  - **Accept**: Reviewer report is persisted verbatim and has PASS with zero critical findings and zero warnings.
  - **Verify**: `rg -n -i "verdict.*pass|critical|warning" .cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/review.md`
  - **Constraints**: Do not begin security review until general review passes. Maximum three review cycles before escalating unresolved findings.

## Group 7a: Review cycle 1 fix — local-state failure classification

- [x] Classify ownership-ledger prepare/update failures as Local state and cover both paths | `src/harness/session-runner.ts`, `tests/unit/session-runner.test.ts`
  - **Accept**: Failures from ledger `prepare()` and `markCreated()` are distinguished from OpenCode request failures, produce the approved `Local state` category, stop/settle the run safely, and have focused regression coverage for both operations. No unrelated behavior changes.
  - **Verify**: `npm test -- --run tests/unit/session-runner.test.ts tests/unit/format.test.ts tests/integration/harness.test.ts && npm run typecheck`
  - **Constraints**: Do not expose raw ledger errors or corrupt-state data. Do not reclassify generic OpenCode transport failures as local state or provider failures. Preserve ownership-ledger entries on uncertain outcomes.

## Group 7b: Review cycle 2 fix — fail-closed uncommitted ledger handling

- [x] Make intent-only and ambiguous ledger entries report-only after any failed transition write; add regression coverage | `src/harness/session-runner.ts`, `src/harness/owned-session-ledger.ts`, `src/harness/repl.ts`, `tests/unit/session-runner.test.ts`, `tests/unit/owned-session-ledger.test.ts`, `tests/integration/harness.test.ts`
  - **Accept**: Only a durably `created-confirmed` entry can become a cleanup candidate after exact ID/location checks and explicit confirmation. If `markCreated()` or `markAmbiguous()` persistence fails, and for every intent-only/uncommitted/ambiguous entry, later reconciliation never offers deletion. Preserve the documented create-before-confirmed-write crash window as report-only/manual recovery. Existing collision, old/unregistered-session, and unrelated-process restrictions remain enforced.
  - **Verify**: `npm test -- --run tests/unit/session-runner.test.ts tests/unit/owned-session-ledger.test.ts tests/integration/harness.test.ts && npm run typecheck`
  - **Constraints**: Fail closed on ledger persistence errors; do not infer ownership from ID format, project/title/age alone, or absence of an ID. Do not delete or offer deletion of report-only entries, even with explicit confirmation. Do not widen cleanup scope or add live model calls.

## Group 8: Security review

- [x] Independent security reviewer inspects the implementation after Group 7 PASS | `.cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/security-review.md`
  - **Accept**: Reviewer report is persisted verbatim and has PASS with zero critical findings and zero warnings, including review of log content, state recovery, process/session ownership, and error sanitization.
  - **Verify**: `rg -n -i "verdict.*pass|critical|warning" .cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/security-review.md`
  - **Constraints**: Run only after general review PASS; do not suppress or reinterpret findings.

## Group 9: QA validation

- [x] Validate crash/lifecycle recovery, stale-resource handling, corrupt state, configuration failures, structured diagnostics, and graceful provider/OpenCode failures | `.cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/qa.md`
  - **Accept**: QA report records automated/manual coverage, the selected recovery/error scenarios, residual risks, release confidence, and PASS/FAIL; any required manual process/TTY check is completed or explicitly remains a release limitation.
  - **Verify**: `npm test && npm run typecheck && npm run build`
  - **Constraints**: No live model/provider call without explicit user authorization. Do not mark PASS if an approved critical scenario lacks evidence.

## Group 10: Documentation and completion

- [x] Update user and technical documentation for approved behavior; record final scope and limitations; close the spec | `README.md`, `SYSTEM_CONTEXT.md`, `docs/tech.md`, `docs/runbook.md` (if created/needed), `.cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release/`
  - **Accept**: Documentation matches reviewed behavior, recovery instructions and logging/config contracts are accurate, limitations are explicit, completion evidence is recorded, and `.cmd/specs/currentspec.md` is removed only after all gates pass.
  - **Verify**: `git diff --check && rg -n "TODO|FIXME|PLACEHOLDER" README.md SYSTEM_CONTEXT.md docs .cmd/specs/2026-10-07-milestone-9-hardened-daily-use-release`
  - **Constraints**: Documentation is the final group and runs after review, security, and required QA. Do not document deferred or failed behavior as shipped.
