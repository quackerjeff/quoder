# Tasks: Milestone 5 — Persistent Harness Context

Spec: `.cmd/specs/2026-10-07-milestone-5-persistent-context/spec.md`

## Group 1: Research and security prerequisites

- [x] Map existing prompt lifecycle, project identity, Git context, and Node persistence APIs | `docs/tech.md`, `.cmd/specs/2026-10-07-milestone-5-persistent-context/decisions.md`
  - **Accept**: Record the current `repl.ts` → `runPrompt` → adapter prompt seam, canonical project identity source, existing Git summary ownership, exact Node built-in API references, external storage/privacy constraints, corruption behavior, atomic-write approach, and concurrency assumptions. Confirm there is no existing memory store and no new dependency is needed.
  - **Verify**: `rg -n "Persistent Harness Context|Current integration seam|Persistence and privacy contract" docs/tech.md`; code findings are cross-checked against `src/harness/project.ts`, `src/harness/repl.ts`, and `src/harness/session-runner.ts`.
  - **Constraints**: Research only; do not implement storage or alter runtime behavior. Do not inspect user OpenCode configuration or credentials. Do not claim private file permissions isolate memory from same-user model tools.

## Group 2: Memory controls and context UX design

- [x] Specify how developers create, inspect, edit, and clear project memory, and how each prompt updates the previous execution summary | `.cmd/specs/2026-10-07-milestone-5-persistent-context/spec.md`, `.cmd/specs/2026-10-07-milestone-5-persistent-context/decisions.md`
  - **Accept**: Define user-visible commands/interaction, first-run and missing/corrupt-state behavior, automatic versus explicit memory updates, summary provenance, stale-memory handling, size limits, clear/reset behavior, pre-execution context-size visibility, and concrete terminal/context examples.
  - **Verify**: `rg -n "Memory interaction and context policy|State/event|Example injected context|concurrent Quoder processes" .cmd/specs/2026-10-07-milestone-5-persistent-context/spec.md`; confirm it covers first-run, valid/corrupt/unavailable state, all turn outcomes, clear/reset, exact bounds, and the “what we just implemented” follow-up.
  - **Constraints**: Keep execution-history commands out of scope. Never silently derive durable decisions or constraints from model text. Keep stored memory distinct from current developer instructions.
  - **Progress**: Defined local `/memory` management commands, startup disclosure, default-on automatic one-turn request/response excerpts with opt-out, manual-only durable objective/task/decision/constraint/issue fields, bounded storage/context, explicit corruption recovery, storage-error behavior, prompt-outcome behavior, a state matrix, terminal examples, prompt-context labeling, and exact character-count visibility before execution. Concurrent instances are documented as atomic last-writer-wins without locking.

## Group 3: Project memory persistence layer

- [x] Implement validated, versioned per-project state with bounded atomic persistence | `src/harness/project-memory.ts`, `tests/unit/project-memory.test.ts`
  - **Accept**: State is keyed by canonical `Project.root`, stored outside the project, validates schema/version and size, uses private directory/file permissions and same-directory atomic replacement, and returns explicit load/write error states without destructive fallback.
  - **Verify**: Focused tests cover first creation, round trip, project separation, malformed/unknown versions, size limits, interrupted writes, permissions where supported, and concurrent writes leaving a complete last-writer-wins document rather than partial JSON.
  - **Constraints**: Built-in Node APIs only unless Group 1 decisions are revised. Never store full transcripts, credentials, permission events, or OpenCode diagnostics. Do not mutate project Git state.
  - **Progress**: Added schema version 1 and validation for exact fields, per-field/list/code-point limits, and the 32 KiB UTF-8 document ceiling. Project files use SHA-256 of the canonical project root under absolute XDG state or the macOS/Linux defaults. Storage directories/files are restricted to 0700/0600; reads use no-follow file handles, verify ownership/type, cap bytes, and reject invalid UTF-8. Saves validate existing state and use an exclusive 0600 same-directory temp file, fsync, and atomic rename. Corrupt/future files are not overwritten by normal saves; explicit clear resets them. Concurrent replacements are complete last-writer-wins. Focused coverage: 14 tests pass; typecheck and production build pass.

## Group 4: Memory management interaction

- [x] Add the Group 2 memory inspect/edit/clear interactions to the persistent REPL | `src/harness/repl.ts`, `src/harness/format.ts`, `tests/integration/harness.test.ts`
  - **Accept**: Each designed interaction is available from the REPL, accurately reports persistence errors, sanitizes displayed memory, and leaves ordinary prompt and shutdown behavior intact.
  - **Verify**: Unit/integration tests cover every command path, invalid input, TTY/non-TTY behavior, cancellation, and storage errors from Group 3.
  - **Constraints**: Follow the Group 2 interaction spec exactly. Do not create `/history`, run IDs, or persistent execution records.
  - **Progress**: The REPL now loads memory before startup, discloses local persistence and automatic-summary status, and handles show/help/set/add/remove/auto/partial-clear/full-clear commands without creating OpenCode sessions. Displayed fields and paths are terminal-sanitized. Corrupt state is read-only until explicit reset; failed writes do not update displayed memory, and prompts continue through storage failures. Integration tests cover every command family, invalid values, saved text sanitization, TTY and piped input, cancellation, corruption reset, and I/O failures. 86 focused tests, typecheck, build, and `git diff --check` pass.

## Group 5: Context builder and prompt lifecycle integration

- [ ] Build bounded labeled context from current memory and live Git state and submit it with each fresh prompt | `src/harness/`, `src/harness/repl.ts`, `src/harness/session-runner.ts`, `tests/`
  - **Accept**: Each new OpenCode session receives current prompt plus correctly labeled, bounded continuity memory and current Git context; a follow-up can unambiguously refer to immediately preceding work; exact context/prompt character counts are displayed before execution; retry uses equivalent context; session creation/deletion semantics remain unchanged.
  - **Verify**: Focused tests cover empty and populated memory, prior summary/update policy, changed Git state, context truncation, prompt labeling, dropped-prompt retry, and fresh-session lifecycle.
  - **Constraints**: Do not reuse OpenCode sessions or feed the complete developer conversation. Treat persisted memory as untrusted data, keep it separate from current user instructions, and omit duplicated Git details.

## Group 6: General review

- [ ] Review Milestone 5 implementation | `.cmd/specs/2026-10-07-milestone-5-persistent-context/review.md`
  - **Accept**: Reviewer report is persisted verbatim with PASS, zero critical findings, and zero warnings.
  - **Verify**: `rg -i 'verdict.*pass' .cmd/specs/2026-10-07-milestone-5-persistent-context/review.md`
  - **Constraints**: Run after Groups 3–5; maximum three cycles. Do not proceed to security review until general review passes.

## Group 7: Security review

- [ ] Review persistence, prompt-context trust boundaries, and sensitive-data handling | `.cmd/specs/2026-10-07-milestone-5-persistent-context/security-review.md`
  - **Accept**: Security report is persisted verbatim with PASS, zero critical findings, and zero warnings.
  - **Verify**: `rg -i 'verdict.*pass' .cmd/specs/2026-10-07-milestone-5-persistent-context/security-review.md`
  - **Constraints**: Run only after Group 6 passes; inspect path/key construction, permissions, symlink behavior, atomic writes, corruption and concurrency handling, prompt injection through memory, and leakage to traces/output. Maximum three cycles.

## Group 8: QA validation

- [ ] Validate persistent-context acceptance and regressions | `.cmd/specs/2026-10-07-milestone-5-persistent-context/qa.md`
  - **Accept**: QA confirms the milestone exit criteria with focused automated coverage and the approved no-model or bounded runtime scenarios; all critical/warning findings are resolved.
  - **Verify**: Run the repository's required validation from `steering/quality-engineering.md`; record exact commands and coverage in `qa.md`.
  - **Constraints**: Do not send a real model prompt or run live verification without explicit authorization. Keep all runtime data in disposable projects and use harmless content.

## Group 9: Documentation and completion

- [ ] Document Milestone 5 behavior and close the active spec | `docs/requirements.md`, `docs/tech.md`, `.cmd/specs/2026-10-07-milestone-5-persistent-context/`
  - **Accept**: Requirements and technical docs match shipped behavior, including data location, privacy, memory controls, bounds, and recovery. Review/security/QA reports are present and pass; all tasks are complete; `.cmd/specs/currentspec.md` is cleared.
  - **Verify**: `git diff --check`; inspect the final docs against implementation and the Group 2 interaction design.
  - **Constraints**: Documentation is the final group and follows passed review, security review, and required QA. Do not claim isolation from same-user processes.
