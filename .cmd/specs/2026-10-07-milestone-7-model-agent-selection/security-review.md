# Security Review: Milestone 7 — Model and Agent Selection

## Review method

Reviewed the catalog boundary, command parsing and selection state, terminal
rendering, adapter failures, session creation, and execution-history fields.
The primary implementation agent performed this review; no separate security
reviewer agent was invoked in this run.

## Threat-focused checks

- Catalog data originates in OpenCode configuration and is treated as untrusted.
  Model references, display names, agent IDs, and user query text are sanitized
  before terminal output.
- Only enabled models and non-hidden `primary`/`all` agents are returned to the
  selector. Agent prompts, provider request details, and permission rules are
  not requested or displayed.
- Catalog requests use the existing authenticated SDK client, project root, and
  bounded request path. Failures are converted to fixed sanitized catalog
  diagnostics; raw SDK messages and error tags are not propagated.
- Unknown or ambiguous input cannot mutate selected state. Selected IDs pass
  as structured SDK fields, not shell text. Prompt-start snapshots ensure a
  selection applies to subsequent fresh sessions.
- History records only the effective model provider/ID and agent ID; no catalog
  response or credential is added to persistent records.

## Findings

No Critical or Warning findings. Existing accepted risk remains unchanged:
model-run tools are unconfined under the pinned OpenCode Core V2 path, as
documented in the Milestone 3 decision record. Milestone 7 adds no credential
handling or permission bypass path.

## Verification

- Catalog failures are tested for fixed user-facing output, unchanged selection,
  and successful later prompt execution.
- Adapter failure regression checks verify that raw diagnostic text is not
  retained in catalog errors.
- Focused suite: PASS (6 files, 175 tests); typecheck: PASS.

## Verdict

**PASS** — no Critical or Warning findings for Milestone 7. QA and final
documentation reconciliation remain.

## Independent Security Review Cycle 1 — 2026-10-07

**Reviewer:** `/root/milestone7_independent_security` (separate agent).

**Verdict:** FAIL — one Low robustness finding. The adapter trusted generated
TypeScript catalog types at runtime. Malformed IDs or names could reach
sorting, matching, or `sanitizeLine` and throw while handling a command.

**Remediation:** Validate the response array, cap its entry count, validate
bounded string and enum/boolean fields for every entry, and convert malformed
responses to fixed catalog errors. Added model-name and agent-ID malformed
entry regression tests. The selection remains unchanged when validation
fails.

## Independent Security Review Cycle 2 — remediation delta

The same separate security reviewer independently rechecked the fix.
**Verdict: PASS — no remaining findings.** Malformed catalog data cannot reach
formatters or resolvers; valid pinned-contract entries remain accepted. The
reviewer confirmed terminal sanitization, agent visibility filters, fixed
errors, authenticated project scoping, and unchanged execution capabilities.

The implementation limits catalogs to 500 entries, model fields to 256
characters, and agent IDs to 128 characters. These conservative bounds are
application limits rather than values from the SDK contract; unusually large
or long valid catalogs will be treated as unavailable.
