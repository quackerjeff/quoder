# QA Report: Milestone 6 — Execution History

## Cycle 1 — 2026-10-07
Validating: Group 8 tasks

### Coverage

- **Automated:** `npm test` — PASS, 30 files / 579 tests. `npm run typecheck` — PASS. Focused run `npm test -- --run tests/integration/harness.test.ts tests/unit/execution-history.test.ts tests/unit/session-runner.test.ts tests/unit/format.test.ts` — PASS, 4 files / 144 tests. `git diff --check` — PASS.
- **Automated scenario mapping:**
  - Accepted execution, full record fields, normalized activity, and observed Git paths: `captures one full run record with normalized activity and observed Git changes`.
  - Cancellation, ordinary failure, and permission rejection record outcomes: `captures post-prompt Git state after a %s outcome` (`answered`, `permission-rejected`, `failed`, `cancelled`); permission summary fields: `captures denied permission summaries without storing resource values`.
  - Dropped-prompt retry: `keeps dropped-prompt retries in one history record and counts both attempts`.
  - In-progress/interrupted representation and valid finalization: `leaves interrupted records in progress and permits only valid terminal outcomes`; detail/list formatting: `shows an empty list and labels in-progress rows without reading their bodies`.
  - Initial server startup, begin failure, and finalize failure behavior: `keeps initial server startup behavior unchanged and history write failures from changing prompt results`.
  - List failure and continued REPL use: `reports unavailable history with a fixed sanitized message and keeps the REPL usable`.
  - Ordering, retention, malformed-setting recovery, deletion, and finalization race: persistence tests `lists by start time without reading record bodies`, `uses default retention and prunes oldest completed records when the limit changes`, `rejects invalid retention and allows explicit settings recovery`, and `deletes exact IDs, preserves tombstones against concurrent finalization, and clears project history`.
  - Piped `/history` help, empty/list/detail, retention, exact deletion, clear-all, malformed/unknown IDs, and unavailable-store behavior are covered by the named integration tests above.
- **Manual:** None. No live model prompts were submitted and no user credentials or OpenCode user configuration were inspected.
- **Not covered:** No history-specific integration assertion verifies the stored `question-rejected` outcome. Existing question-rejection coverage validates the session-runner result and general REPL display, but does not assert the corresponding persisted history record. History command behavior is exercised in piped mode only; no test invokes `/history` commands through the TTY interaction path. No process-kill/crash test was run; interrupted-record behavior is tested at the store and formatter level instead.

### Critical

- **Question-rejection history capture:** The Group 8 matrix requires validating question rejection, but automated tests do not assert that a rejected question is finalized with the correct history status and summary. The persisted audit record could be incorrect without the existing adjacent session-runner/REPL tests detecting it.
- **TTY `/history` command path:** The spec requires the same list/detail and delete behavior in TTY and piped modes. The history integration tests all use piped input, leaving the TTY command path unvalidated.

### Warning

- Crash recovery is represented by loading and displaying an in-progress record; abrupt process termination and restart were not exercised as an end-to-end scenario.

### Suggestion

- Add focused integration coverage for a rejected question's persisted record and exercise `/history` commands with the TTY input path before rerunning Group 8.

### Release Confidence

NOT READY — automated suites pass, but two explicitly required user-visible history paths remain unvalidated.

### Verdict: FAIL

## Cycle 2 — 2026-10-07
Validating: Group 8 tasks after coverage additions

### Coverage

- **Automated:** `npm test` — PASS, 30 files / 580 tests. `npm run typecheck` — PASS. Focused run `npm test -- --run tests/integration/harness.test.ts tests/unit/execution-history.test.ts tests/unit/session-runner.test.ts tests/unit/format.test.ts` — PASS, 4 files / 145 tests. `git diff --check` — PASS.
- **Automated scenario mapping:** All Cycle 1 scenarios remain covered. The newly added integration assertion `shows a rejected question so the developer can answer it next` verifies the persisted `question-rejected` status, null final response, and attempt count. `routes history list, detail, and deletion commands through the interactive TTY input path` exercises TTY list/detail/exact-delete and confirms commands do not create extra sessions. `leaves interrupted records in progress and permits only valid terminal outcomes` now opens the same state directory through a new store instance and verifies the unfinished record remains in progress before it is finalized.
- **Manual:** None. No live model prompts were submitted and no credentials or user OpenCode configuration were inspected.
- **Not covered:** No OS-level forced termination/relaunch of the Quoder process was performed. Persistence recovery is validated by creating a new store instance against the same on-disk state; end-to-end process crash behavior is not independently exercised.

### Critical

- None.

### Warning

- Crash recovery is covered through store reinitialization and in-progress retrieval, but not by forcibly terminating and relaunching the CLI process. This leaves a narrow integration-level validation gap; the persistent record/reopen path itself passes.

### Suggestion

- Consider a disposable process-level crash/restart smoke check in a future validation pass if the harness gains a safe no-model way to suspend an active run.

### Release Confidence

CONDITIONAL — the required automated history, outcome, retry, persistence, error, retention, piped, and TTY scenarios pass. The remaining process-level crash simulation gap is documented and does not invalidate the in-progress persistence/reopen evidence.

### Verdict: PASS

## Manual process-restart verification — 2026-10-07

- **Project:** Disposable directory `/tmp/quoder-m6-crash.89S45O`.
- **Procedure:** After building the current CLI, a harmless `sleep 60` prompt was started and Quoder was forcibly terminated while the run was active. Quoder was restarted from the same project directory and `/history` was queried without submitting another prompt.
- **Observed result:** Record `58a789c203b0837b422d3d39174a2040`, started at `2026-10-07T21:29:01.674Z`, remained `in progress / possibly interrupted` after restart.
- **Evidence source:** User-run manual check, reported in the development conversation; no prompt contents or credentials were inspected.
- **Verdict:** PASS. This closes Cycle 2's process-level termination/relaunch coverage gap. The persisted incomplete record is visible after a fresh CLI process starts.
- **Release confidence:** HIGH for the Group 8 validation scope; all previously required automated paths passed in Cycle 2, and the sole documented process-restart gap now has manual evidence.
