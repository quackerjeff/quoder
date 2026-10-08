# Security Review: Milestone 9 — Hardened Daily-Use Release

## Cycle 1 — 2026-10-07
Reviewing: Groups 1–7b after General Review Cycle 3 PASS

### Threat Model

- Untrusted inputs include project state, local Quoder state files, environment settings, terminal input, and OpenCode API responses.
- Sensitive assets include saved prompts and responses, provider configuration, and OpenCode session data.
- The authenticated local OpenCode API can create, inspect, and delete sessions; cleanup must not extend to sessions Quoder cannot establish it owns.
- The operational log is opt-in and must stay outside the target project, use restricted permissions, and contain only approved metadata.
- Terminal diagnostics and confirmation prompts must not expose raw errors or allow ambiguous input to authorize cleanup.
- Same-user processes are outside the state-file isolation guarantee; the ledger is a correlation record, not upstream proof of ownership.

### Critical

- None.

### Warning

- None.

### Suggestion

- [src/harness/operational-log.ts:99-105] **Confidence: Low** — The logger checks that an existing destination is a regular file with a single link and attempts to set mode `0600`, but does not explicitly check that the file is owned by the current user. In ordinary unprivileged runs, an inability to change permissions causes logging to fail closed. Consider checking the file owner as an additional guard for elevated or unusual shared-directory deployments.

### Review Evidence

- The ledger validates record shape, ID format, project root, file type, link count, and size; it creates intents exclusively and limits cleanup candidates to `created` records.
- Reconciliation checks exact session IDs and project locations before offering cleanup. Each candidate requires explicit `y`/`yes` confirmation; non-TTY runs skip cleanup. After confirmation, the session is checked again, and deletion is verified through Core V2 before the ledger entry is removed.
- Intent-only and ambiguous entries remain report-only. The accepted create-before-confirmed-write crash window is documented as manual recovery.
- Corrupt project memory and execution-history state are detected without silent replacement; the reviewed recovery path provides manual guidance.
- Startup validation checks the launch executable and inline launch configuration without printing their values. Failure categories use fixed sanitized messages.
- Operational JSONL uses a field allowlist, omits content-bearing trace events, creates the destination outside the project, rejects final-component symlinks, applies restrictive permissions, and disables logging on open/write failure.
- No tests were run; this was a read-only inspection.

### Verdict: PASS
