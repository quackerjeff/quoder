# QA Report: Milestone 4 — Git Awareness

## Cycle 1 — 2026-10-06
Validating: Groups 1–7

### Coverage
- **Automated:** `npm run typecheck`; `npm test` (27 test files, 514 tests); `npm run build`; `git diff --check`. Snapshot fixtures cover clean and dirty repositories, staged and unstaged changes, untracked paths, deletions, renames, unusual paths, binary stats, unborn and detached HEAD, Git failures, timeouts, and output limits. Diff fixtures cover tracked and untracked text, binary omission, terminal-control sanitization, the 1 MiB cap, symlink leaves and parents, and safe native-reader execution. Harness integration covers TTY View/Continue, 40-line pagination, previous/next and return-to-choice, clean-state behavior, deterministic piped output, truncation notices, and Ctrl+C/Ctrl+D handling.
- **Manual:** Ran a disposable runtime probe against a committed-tree change and an unborn-to-first-commit transition. Both rendered their committed diffs. `git status --porcelain` remained empty after each capture, confirming the read-only path did not dirty either fixture.
- **Not covered:** No physical terminal/PTY session or live OpenCode model was used; interactive behavior is exercised with the test harness's terminal-mode input stream. The native helper was built and run on macOS only; Linux build/runtime remains unverified. No end-to-end test covers a missing or damaged compiled helper binary.

### Critical
- None.

### Warning
- The native reader is documented for macOS and Linux, but only macOS has been exercised in this environment. Validate Linux in CI before relying on the helper there.
- Interactive flows are covered by simulated terminal-mode integration tests; a manual PTY smoke check remains useful before a broad release.

### Suggestion
- Add Linux native-helper build and symlink traversal coverage to CI, and retain a PTY smoke case for the View/Continue flow.

### Release Confidence
- CONDITIONAL — The specified behavior passes on macOS, with residual cross-platform and physical-terminal validation gaps documented above.

### Verdict: PASS
