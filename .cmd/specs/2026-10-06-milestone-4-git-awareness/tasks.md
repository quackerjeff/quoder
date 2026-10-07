# Tasks: Milestone 4 — Git Awareness

Spec: `.cmd/specs/2026-10-06-milestone-4-git-awareness/spec.md`

## Group 1: Git snapshot and delta research

- [x] Verify Git state and diff contracts; decide baseline-delta semantics | `docs/tech.md`, `.cmd/specs/2026-10-06-milestone-4-git-awareness/decisions.md`
  - **Accept**: Record sourced behavior for branch/HEAD discovery, porcelain status, staged and unstaged diffs, untracked files, renames/deletions, binary files, and no-repository/unborn states. Decide how the summary and view distinguish pre-existing dirty state from changes observed during the prompt, without claiming unprovable authorship.
  - **Verify**: Cite primary Git documentation in `docs/tech.md`; validate the chosen commands against small disposable Git fixtures covering clean, staged, unstaged, untracked, deleted, renamed, and unborn-repository states.
  - **Constraints**: Do not mutate the user's repository or use stash/reset. Resolve only Milestone 4 contracts; do not introduce history persistence or run identifiers.
  - **Progress**: Official Git documentation and disposable fixtures on Git 2.54.0 validate the snapshot and diff contract. Fixtures covered clean/dirty, staged/unstaged, untracked, deleted/renamed, control-character paths, unborn/no-repository, binary numstat, HEAD movement, and helper execution controls. Final boundaries and command constraints are recorded in `decisions.md` and `docs/tech.md`. Arbitrary invalid UTF-8 paths and production integration remain implementation/review concerns.

## Group 2: Summary and diff interaction design

- [x] Specify completion-summary and diff-view states | `.cmd/specs/2026-10-06-milestone-4-git-awareness/spec.md`, `.cmd/specs/2026-10-06-milestone-4-git-awareness/decisions.md`
  - **Accept**: Define the summary for changes/no changes, pre-existing changes, non-Git directories, and Git inspection errors; define interactive View diff/Continue behavior, piped output, large/binary diffs, navigation, and cancellation.
  - **Verify**: The spec includes concrete terminal examples and a state table covering answered, permission-rejected, failed, and cancelled prompts.
  - **Constraints**: Do not add a dashboard, persistent history, or auto-commit affordance. Sanitize repository-controlled display text and preserve the existing REPL prompt/cancellation behavior.
  - **Progress**: Defined summary semantics for clean/changed/pre-existing/unavailable states, all four prompt outcomes, TTY View/Continue and paginated navigation, piped auto-output, binary rendering, truncation, and cancellation. Added examples and an outcome table to `spec.md`; decisions are recorded in `decisions.md`.

## Group 3: Git snapshot and comparison layer

- [x] Implement typed, read-only Git snapshots and safe change summaries | `src/harness/git-state.ts`, `tests/unit/git-state.test.ts`
  - **Accept**: Capture the Group 1 state fields with bounded Git subprocesses; derive the agreed path categories and diff metadata; report non-repository and command failures explicitly without throwing into prompt execution.
  - **Verify**: Focused unit tests exercise the Group 1 fixture matrix, limits, malformed/unusual paths, and subprocess failures.
  - **Constraints**: Use `execFile` argument arrays, never invoke a shell, and never mutate the index/worktree. Follow `docs/tech.md` and the Group 1 decision for staged, unstaged, untracked, binary, rename, and pre-existing changes.
  - **Progress**: Added bounded `execFile` capture, NUL-safe porcelain and numstat parsing, typed unavailable states, endpoint path classification, HEAD/branch movement, and committed-diff statistics. Fixtures cover clean/dirty, staged/unstaged, untracked, delete/rename, unusual path characters, binary stats, unborn/first commit, detached HEAD, helper suppression, command errors, buffer limits, and timeouts. Full suite and production build pass.

## Group 4: Prompt lifecycle integration and summary

- [x] Capture before/after state for each developer prompt and render the result | `src/harness/session-runner.ts`, `src/harness/repl.ts`, `src/harness/format.ts`, `tests/`
  - **Accept**: One prompt summary includes its observed Git delta across any dropped-prompt retry; answered, rejected, failed, and cancelled outcomes all attempt the post-state capture. Git failure does not prevent prompt execution or cleanup.
  - **Verify**: Unit/integration coverage asserts capture ordering and output for clean and dirty baselines, changes, no changes, retry, cancellation, and Git errors.
  - **Constraints**: Preserve fresh-session lifecycle, session cleanup, permission handling, and existing tool summary. Do not persist execution records or add run numbers.
  - **Progress**: Capture runs once before server/prompt work and once after `runPrompt` settles, covering its dropped-prompt retry and session cleanup. Added sanitized changed/pre-existing/resolved summaries with tracked and committed line metadata; Git capture/comparison failures remain visible without preventing prompt execution. Integration coverage exercises answered, permission-rejected, failed, cancelled, retried, changed, clean, and unavailable states.

## Group 5: Read-only diff inspection flow

- [x] Add sanitized interactive and non-interactive diff viewing | `src/harness/git-diff.ts`, `src/harness/repl.ts`, `src/harness/line-keys.ts`, `src/harness/format.ts`, `tests/`
  - **Accept**: The developer can inspect the complete supported diff after a prompt and return to the REPL. Non-TTY behavior is deterministic. Large diffs are navigable without unbounded terminal output; hostile diff text cannot inject terminal control sequences.
  - **Verify**: Tests cover View/Continue choices, no-change behavior, pagination/limits, path/text sanitization, pipe output, and cancellation/shutdown.
  - **Constraints**: Diff viewing is read-only, does not enter the next model prompt, and does not alter Git state.
  - **Progress**: Added bounded final tracked/committed and untracked-text diff capture, terminal sanitization, binary/symlink handling, 1 MiB output and untracked-read caps, a directory-relative POSIX reader, a 40-line TTY pager with View/Continue choice, and deterministic pipe output. Coverage checks real disposable Git fixtures plus TTY paging, no-change behavior, pipe sanitization/truncation notice, symlinked-parent omission, and Ctrl-C/Ctrl-D shutdown. Full typecheck, test suite, build, and diff check pass.

## Group 6: General review

- [x] Review Milestone 4 implementation | `.cmd/specs/2026-10-06-milestone-4-git-awareness/review.md`
  - **Accept**: Reviewer report is persisted verbatim with PASS, zero critical findings, and zero warnings.
  - **Verify**: `rg -i 'verdict.*pass' .cmd/specs/2026-10-06-milestone-4-git-awareness/review.md`
  - **Constraints**: Review after Groups 3–5; maximum three cycles.
  - **Progress**: Cycle 1 returned PASS with zero critical findings and zero warnings. Recorded one low-priority suggestion about coalesced navigation-key chunks. Automated checks passed: typecheck, all 513 tests, build, and `git diff --check`.

## Group 7: Security review

- [x] Review Git subprocess, repository input, diff rendering, and state boundaries | `.cmd/specs/2026-10-06-milestone-4-git-awareness/security-review.md`
  - **Accept**: Security report is persisted verbatim with PASS, zero critical findings, and zero warnings.
  - **Verify**: `rg -i 'verdict.*pass' .cmd/specs/2026-10-06-milestone-4-git-awareness/security-review.md`
  - **Constraints**: Run after general review. Inspect command construction, hostile paths/diff content, output bounds, temporary data cleanup, and read-only behavior; maximum three cycles.
  - **Progress**: Cycles 1–2 identified a path-based symlink-swap race; the intermediate post-open identity check was insufficient and both FAIL reports remain recorded. Replaced it with an `openat`/`O_NOFOLLOW` native helper rooted at an inherited project directory descriptor. Cycle 3 returned PASS with zero critical findings and zero warnings. The helper rejects symlinked path components, reads regular files only, and is bounded by per-file and aggregate time/byte limits. `npm run typecheck`, all 514 tests, `npm run build`, and `git diff --check` pass.

## Group 8: QA gate

- [x] Validate Git summaries and diff inspection | `.cmd/specs/2026-10-06-milestone-4-git-awareness/qa.md`
  - **Accept**: QA records automated/manual coverage, repository fixture matrix, failure behavior, residual gaps, release confidence, and PASS/FAIL.
  - **Verify**: `rg -i 'verdict.*pass|verdict.*fail' .cmd/specs/2026-10-06-milestone-4-git-awareness/qa.md`
  - **Constraints**: Do not claim the milestone exit criterion while status transitions or full diff inspection are unverified.
  - **Progress**: QA Cycle 1 returned PASS with conditional release confidence. All 514 tests, typecheck, build, and diff checks passed. A disposable runtime check validated regular and unborn committed-tree diff rendering without changing fixture repository status. Linux runtime and physical-PTY/live-model checks remain documented gaps.

## Group 9: Documentation and closure

- [x] Update user and technical documentation; close the spec | `README.md`, `docs/tech.md`, `SYSTEM_CONTEXT.md`, `.cmd/specs/currentspec.md`
  - **Accept**: User docs explain per-prompt Git summaries and diff inspection; technical docs record verified Git behavior and limitations; all review and QA gates pass; clear `currentspec.md`.
  - **Verify**: `git diff --check` and documentation review against the implementation and QA report.
  - **Constraints**: Do not describe persistent history, auto-commit, or attribution guarantees outside the verified scope.
  - **Progress**: Updated README behavior/setup guidance, technical Git and native-reader details, and system ownership/build dependencies. Docs reflect conditional QA confidence and the macOS-validated/Linux-unverified boundary. Cleared the active-spec pointer after the documentation and consistency checks.
