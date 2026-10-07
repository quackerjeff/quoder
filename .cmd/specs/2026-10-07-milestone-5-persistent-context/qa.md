# QA Report: Milestone 5 — Persistent Harness Context

**Spec:** `.cmd/specs/2026-10-07-milestone-5-persistent-context`
**QA Task:** Group 8 — QA validation
**Date:** 2026-10-07
**QA Engineer:** CMD qa-engineer

## Cycle 1 — 2026-10-07
Validating: Group 8 tasks

### Coverage

- **Automated:** `npm test` passed: 552 tests across 29 files. This included memory command behavior in TTY and piped input, storage success/failure, project separation, corrupt/unsupported-state recovery, validation limits, fresh-session lifecycle, retry prompt equivalence, and preservation of the prior summary after rejected, failed, cancelled, and server-start-failed turns. Context tests verified the 4,096-code-point cap, current request preservation, hostile newline/control-bearing Git paths encoded on one line, and exclusion of stored assistant-response excerpts from future prompts. Persistence tests use temporary directories and exercise permissions, symlinks, atomic replacement, and recovery.
- **Additional automated checks:** `npm run typecheck`, `npm run build`, and `git diff --check` all passed.
- **Manual:** No live CLI/model run was performed. The acceptance suite uses fakes for OpenCode interactions and temporary storage for persistence; no real model prompt was submitted and no user OpenCode credentials/configuration were inspected.
- **Not covered:** Real-terminal behavior against an installed OpenCode server, cross-platform storage behavior on Linux, and provider/model behavior remain unverified. They are outside this automated QA run; the feature's memory and prompt orchestration paths are covered by fakes and unit tests.

### Critical

None.

### Warning

- **Live integration and platform coverage:** The automated suite does not exercise the assembled prompt against a running OpenCode server or verify filesystem behavior on Linux. This leaves environment-specific integration and portability risk, although the local automated checks pass and the implementation uses the existing prompt adapter seam.

### Suggestion

- When an authorized disposable environment is available, perform a no-model CLI check of `/memory` commands and a bounded integration check using harmless data. Validate Linux storage behavior before claiming cross-platform QA coverage.

### Release Confidence

**CONDITIONAL** — The implementation has strong automated coverage and all required repository checks passed. Confidence remains conditional on the unexercised real-terminal/OpenCode integration and Linux filesystem behavior; this run intentionally did not access live user configuration or submit a model prompt.

### Verdict: PASS

No critical defects were found, and the specified acceptance behaviors were exercised by automated tests. The warning describes remaining environment-specific validation, not a failure of the tested acceptance criteria.

## Cycle 2 — 2026-10-07
Validating: Follow-up for Group 8 tasks

### Coverage

- **Manual:** The developer confirmed that both follow-up checks passed: a real-terminal run using the disposable-project `/memory` workflow, and Linux filesystem validation. No ordinary model prompt was required for the terminal check.
- **Evidence detail:** The developer reported both checks passed, but did not provide terminal output, exact Linux commands, distribution, or version. This report records the confirmation without inferring those details.
- **Not covered:** Provider/model behavior remains unverified; no live model prompt was submitted.

### Critical

None.

### Warning

None. The Cycle 1 environment-coverage warning is resolved by the developer-confirmed terminal and Linux validation.

### Suggestion

None.

### Release Confidence

**READY** — Automated repository checks and the two requested follow-up validations passed. Provider/model behavior was intentionally outside this QA scope.

### Verdict: PASS
