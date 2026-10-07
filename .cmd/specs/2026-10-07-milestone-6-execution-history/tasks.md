# Tasks: Milestone 6 — Execution History

Spec: `.cmd/specs/2026-10-07-milestone-6-execution-history/spec.md`

## Group 1: Research and security prerequisites

- [x] Verify run lifecycle, activity, Git, and local persistence contracts | `docs/tech.md`, `.cmd/specs/2026-10-07-milestone-6-execution-history/decisions.md`
  - **Accept**: Record the existing run lifecycle and retry semantics, available record fields, unavailable agent details, activity/permission capture seams, Git comparison semantics, and Node persistence APIs without inventing SDK contracts.
  - **Verify**: Cross-check `src/harness/repl.ts`, `src/harness/session-runner.ts`, `src/harness/live-view.ts`, `src/harness/stream-events.ts`, `src/harness/git-state.ts`, and FR-11 in `docs/requirements.md`.
  - **Constraints**: Research only; do not inspect user OpenCode config/credentials, run a live prompt, or persist raw event payloads.

## Group 2: History interaction, privacy, and record design

- [x] Define `/history` UX, record schema, privacy disclosure, retention/deletion, bounds, run-ID allocation, and crash/concurrency behavior | `.cmd/specs/2026-10-07-milestone-6-execution-history/spec.md`, `decisions.md`
  - **Accept**: Specify list/detail/empty/error behavior, TTY and piped output, the full FR-11 field mapping, field sensitivity and redaction policy, retention controls, schema/version limits, unique-ID strategy, interrupted-run state, and concurrent writer behavior.
  - **Verify**: Review the table and examples in `spec.md` against FR-11 and available contracts recorded in Group 1.
  - **Constraints**: No implementation until sensitive-data persistence and retention policy are explicit. Do not imply same-user process isolation or claim Git authorship.
  - **Progress**: Defined complete FR-11 fields and exclusions, startup/help sensitivity disclosure, per-project state location, collision-safe random IDs, in-progress/retry semantics, a 32 MiB no-silent-truncation ceiling, default retention of 100 completed records (configurable 1–1,000), exact-run/all deletion, concurrent retention behavior, and TTY/piped `/history` list/detail/help controls. The user approved full records with retention controls.

## Group 3: History persistence layer

- [x] Implement versioned per-project history storage and unique run allocation | `src/harness/execution-history.ts`, `tests/unit/execution-history.test.ts`
  - **Accept**: Store validated records outside the project; allocate IDs without collisions; support bounded listing and retrieval; make writes atomic and expose recoverable errors without replacing existing records.
  - **Verify**: `npm test -- --run tests/unit/execution-history.test.ts`; `npm run typecheck`; `git diff --check`.
  - **Constraints**: Follow Group 2 policy, use built-in APIs unless revised, never persist credentials/raw SDK payloads, and preserve incomplete records distinctly from completed failures.
  - **Progress**: Implemented versioned per-project records outside the repository, exclusive 128-bit ID allocation, in-progress/completed lifecycle files, bounded listing/retrieval, schema and ownership checks, private permissions, atomic publication, retention pruning, deletion/clear behavior, and stale-temp cleanup. Focused suite passed (16 tests); typecheck and `git diff --check` passed.

## Group 4: Run lifecycle capture

- [x] Capture and finalize one history record per developer execution | `src/harness/repl.ts`, `src/harness/session-runner.ts`, `src/harness/live-view.ts`, `tests/integration/harness.test.ts`
  - **Accept**: Capture start metadata, prompt/context, allowed activity and permission summaries, Git comparison, final response/outcome/duration; treat retry as one run; represent interrupted/unavailable fields per Group 2; history failure does not change run outcome.
  - **Verify**: `npm test -- --run tests/integration/harness.test.ts` and focused session-runner/lifecycle tests; `npm run typecheck`.
  - **Constraints**: Preserve session creation/deletion, cancellation, retry, permission handling, and current Git reporting behavior. Do not add raw OpenCode event data to persistent records.
  - **Progress**: The REPL now begins a record before prompt submission, captures normalized tool outcomes and exact Bash commands, summarizes permission choices without resource values, and finalizes with the response/outcome/duration and observed Git path changes. Retries remain one record with an incremented attempt count; storage failures warn without changing the run result. Initial process startup occurs before prompts are accepted, so it creates no execution record. Focused suites passed (126 tests), typecheck passed, and `git diff --check` passed.

## Group 5: History commands and terminal display

- [x] Add `/history` list/detail commands and safe record formatting | `src/harness/repl.ts`, `src/harness/format.ts`, `tests/unit/format.test.ts`, `tests/integration/harness.test.ts`
  - **Accept**: Developers can inspect recent run IDs and one run's record; empty, malformed ID, unavailable store, truncation, and non-TTY states follow Group 2 design; untrusted text cannot inject terminal controls.
  - **Verify**: Focused formatting and REPL tests; `npm run typecheck`; `git diff --check`.
  - **Constraints**: History commands are local and do not create OpenCode sessions. Display only the fields approved in the spec and sanitize all record-derived text.
  - **Progress**: Added startup and help privacy disclosures; implemented list/detail/help, retention query/update, exact-run deletion, and clear-all commands for TTY and piped input. Detail output preserves full stored text while sanitizing terminal controls and indenting multiline values. Focused formatter/REPL tests passed (102 tests); typecheck and `git diff --check` passed. The list stays filename-metadata-only, so record corruption is reported when detail is opened.

## Group 6: General review

- [x] Review Milestone 6 implementation | `.cmd/specs/2026-10-07-milestone-6-execution-history/review.md`
  - **Accept**: Review report ends in PASS with zero critical findings and zero warnings.
  - **Verify**: `rg -i 'verdict.*pass' .cmd/specs/2026-10-07-milestone-6-execution-history/review.md`.
  - **Constraints**: Run after Groups 3–5; do not proceed to security review until PASS; maximum three cycles.
  - **Progress**: Cycle 1 identified a delete/finalize race that could leave a tombstoned record body on disk. Deletion now re-scans after creating the tombstone, and a deterministic test covers the interleaving. The shared CMD reviewer returned Cycle 2 PASS with zero critical findings and zero warnings.

## Group 7: Security review

- [x] Review stored data, terminal rendering, path/ID handling, and failure behavior | `.cmd/specs/2026-10-07-milestone-6-execution-history/security-review.md`
  - **Accept**: Security report ends in PASS with zero critical findings and zero warnings.
  - **Verify**: `rg -i 'verdict.*pass' .cmd/specs/2026-10-07-milestone-6-execution-history/security-review.md`.
  - **Constraints**: Run only after Group 6 passes; inspect sensitive-field exposure, malicious text, symlink/path safety, record corruption, resource exhaustion, and concurrent ID allocation; maximum three cycles.
  - **Progress**: The shared CMD security-reviewer role, run by `/root/milestone6_security_reviewer`, completed the threat model and targeted/variant review. Cycle 1 returned PASS with no Critical or Warning findings; documented plaintext and same-user access risks were confirmed as disclosed.

## Group 8: QA validation

- [x] Validate record capture, retrieval, recovery, and regressions | `.cmd/specs/2026-10-07-milestone-6-execution-history/qa.md`
  - **Accept**: QA covers accepted executions, cancellation/failure/rejection, retry, crash/incomplete records, persistence errors, multi-run ordering, and TTY/piped commands; residual risk and release confidence are documented.
  - **Verify**: Run repository-required validation from shared `steering/quality-engineering.md`; persist commands and coverage in `qa.md`.
  - **Constraints**: Do not submit live model prompts or inspect user credentials without explicit authorization. Use disposable projects and harmless fixtures.
  - **Progress**: Cycle 1 failed because question-rejection history and TTY history commands were not directly validated. After adding focused coverage, Cycle 2 passed: full suite (580 tests), typecheck, focused history/lifecycle suites (145 tests), and `git diff --check`. A user-run manual process termination/relaunch check then confirmed the same in-progress record remained visible as `in progress / possibly interrupted`; see the manual verification addendum in `qa.md`. Group 8 confidence is HIGH for its validation scope.

## Group 9: Documentation and completion

- [x] Update user, requirements, technical, and repository-state documentation; close the active spec | `README.md`, `docs/requirements.md`, `docs/tech.md`, `SYSTEM_CONTEXT.md`, `.cmd/specs/2026-10-07-milestone-6-execution-history/`
  - **Accept**: Docs match shipped history fields, storage/privacy policy, commands, retention/recovery, and lifecycle. Review, security, and required QA pass; all tasks are complete; `.cmd/specs/currentspec.md` is cleared.
  - **Verify**: `git diff --check`; compare final docs to implementation and Group 2 design.
  - **Constraints**: Final group follows all review and QA gates; do not claim records prove authorship or same-user isolation.
  - **Progress**: Updated the README, FR-11 and Milestone 6 requirements, implementation notes, and repository state context. Added `completion.md` with review/security/QA outcomes and the user-run crash/restart evidence. Requirements were cross-checked against `src/harness/execution-history.ts`, `src/harness/repl.ts`, `src/harness/format.ts`, and Group 2 policy. Final documentation check passed; active spec pointer cleared.
