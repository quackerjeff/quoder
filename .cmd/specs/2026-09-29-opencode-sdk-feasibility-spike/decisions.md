# Decisions: OpenCode SDK Feasibility Spike

## 2026-09-29 — Start with PRD Milestone 0

**Context**: The PRD makes OpenCode SDK capability validation a prerequisite to production implementation.

**Decision**: The first executable spec is limited to an OpenCode SDK feasibility probe covering all nine PRD exit criteria.

**Rationale**: Quoder's architecture depends on lifecycle, streaming, permission, cancellation, project-scoping, and isolation contracts that must be proven against the installed OpenCode environment.

## 2026-09-29 — Defer product naming resolution

**Context**: The repository is named Quoder, while the PRD title and examples use OpenCode Stateless Harness, `quackharness`, and `QuackTrack`.

**Decision**: Use Quoder for repository-level context, but do not select the final executable name in this spike.

**Rationale**: The feasibility probe does not expose the production CLI, so naming does not affect its result. Resolve naming before Milestone 1 user-facing design.

## 2026-09-29 — Require live evidence in addition to unit tests

**Context**: Test doubles can validate Quoder-owned control flow but cannot prove the installed OpenCode/Ollama environment exposes the required behavior.

**Decision**: Keep live verification opt-in and isolated from default unit tests, but require it for the QA verdict.

**Rationale**: This separates fast deterministic tests from the environment-dependent go/no-go evidence the spike exists to produce.

## 2026-09-29 — Standardize the spike verification entry point

**Context**: The task plan needs one reproducible command that QA can run and automation can interpret.

**Decision**: The feasibility spike exposes `npm run verify:live`, with exact Node, npm, OpenCode, and test-tool versions verified and recorded during Group 1.

**Rationale**: The PRD requires a TypeScript program, and a stable npm script makes the environment-dependent probe repeatable without deciding the eventual production packaging or binary name.

## 2026-09-29 — Use a version-scoped deletion compatibility bridge

**Context**: `@opencode-ai/sdk@1.18.33` exposes no native delete method under `client.v2.session`, while the same package retains legacy `client.session.delete`.

**Decision**: For exactly CLI/SDK version 1.18.33, the adapter may delete a Core V2-created session through `client.session.delete`, then must prove deletion by requiring a Core V2 get to return 404. Keep this behavior behind one adapter method and re-verify it on every OpenCode upgrade.

**Rationale**: An isolated live check created a Core V2 session, observed it through Core V2, deleted it through the legacy endpoint with HTTP 200/`true`, and then received `404 SessionNotFoundError` through Core V2. This supplies direct compatibility evidence without pretending Core V2 has a native delete operation.

## 2026-09-29 — Authorize one exceptional fourth review cycle

**Context**: The third general review cycle resolved the Cycle 2 findings but identified two bounded correctness defects: the initial prompt/event operations are not guaranteed to settle together, and permission evidence is not correlated to the request created by the probe. The shared CMD workflow requires escalation after three failed review cycles.

**Decision**: By explicit user authorization, add one implementation fix group for exactly these Cycle 3 findings and one fresh general review as Cycle 4. Do not begin security review unless Cycle 4 passes. If Cycle 4 fails, stop and escalate without adding another review cycle.

**Rationale**: Both findings are localized control-flow and evidence-integrity defects with measurable regression tests. One bounded exception is preferable to abandoning the feasibility spike, while the hard stop after Cycle 4 preserves the purpose of the review-cycle limit.

## 2026-09-30 — Authorize a narrowly scoped fifth review cycle

**Context**: Cycle 4 correctly escalated a single Core V2 permission-event mismatch. The user then directed a correction that changed the production observer and classifier from legacy `permission.asked` to typed `permission.v2.asked`, added a driver-level typed-fake regression test, and passed all requested automated verification. That correction was intentionally made without creating another review cycle.

**Decision**: By explicit user authorization, run one narrowly scoped Review Cycle 5 covering only the user-directed Cycle 4 correction. If the fresh reviewer returns PASS with zero critical findings and zero warnings in that scope, mark the general review gate complete. Do not begin security review or QA as part of this authorization.

**Rationale**: A focused independent check can close the escalated finding without reopening unrelated implementation scope. This authorization supersedes only the prior prohibition on creating Cycle 5; all other gate ordering remains unchanged.
