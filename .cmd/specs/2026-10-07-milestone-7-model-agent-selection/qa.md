# QA Report: Milestone 7 — Model and Agent Selection

## Scope

Validate model/agent catalog filtering, list and selection commands, ambiguous
and invalid input, sanitized catalog errors, process-local state, next-session
binding, history values, and regression behavior. Tests use a fake OpenCode
client; no configured model, provider, user credential, or user configuration
was accessed.

## Automated validation

- Focused suite:
  `npm test -- --run tests/unit/opencode-adapter.test.ts tests/integration/harness.test.ts tests/unit/session-runner.test.ts tests/unit/execution-history.test.ts tests/unit/selection.test.ts tests/unit/cli.test.ts`
  — PASS (6 files, 175 tests).
- Full suite: `npm test` — PASS (31 files, 589 tests).
- Build: `npm run build` — PASS.
- Typecheck: `npm run typecheck` — PASS.
- Whitespace check: `git diff --check` — PASS.

The integration scenarios confirm that:

- `/model` and `/agent` list available choices and indicate the current choice.
- Unique shorthand selects the intended model/agent; an ambiguous model query
  prints full IDs and does not replace the current selection.
- Missing model/agent queries preserve state.
- Catalog API failures show fixed messages, hide raw error details, preserve
  defaults, and do not block a later prompt.
- The next fresh session receives the selected model and agent, and its history
  record contains that same pair.
- Existing session lifecycle and `--model` parsing/default behavior continue
  to pass regression tests.

## Manual validation

No manual terminal session or live-provider prompt was run. TTY presentation
and provider reachability remain unverified. The SDK catalog, REPL command
flow, and session payload were validated with local fakes and pinned-contract
tests. A listed model may still fail when OpenCode attempts inference.

## Findings

No open Critical, Warning, or QA findings.

## Release confidence and verdict

**PASS for Milestone 7 functional acceptance in the local automated scope.**
Process-local persistence is intentional; no persistence across Quoder restarts
is promised. Live provider connectivity and a manual terminal run were outside
this QA scope.

## Final security-remediation revalidation — 2026-10-07

After runtime catalog validation and malformed-entry tests were added:

- `npm run build` — PASS.
- `npm test` — PASS (31 files, 592 tests).
- `npm run typecheck` — PASS.
- `git diff --check` — PASS.

No live provider or manual terminal session was used. The functional QA verdict
remains PASS; only the final automated test count changed from 589 to 592.
