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
