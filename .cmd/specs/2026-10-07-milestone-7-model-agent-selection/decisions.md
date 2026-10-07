# Decisions: Milestone 7 — Model and Agent Selection

## 2026-10-07 — Discovery and selection contract

**Context:** FR-13 and FR-14 require interactive selection among OpenCode
models and agents, but they do not specify matching behavior, visibility
filters, or selection lifetime.

**Decision:** Query the authenticated server's project-scoped V2 model and
agent catalogs on each list or selection command. Only enabled models and
visible primary/all agents are selectable. Accept exact identifiers and
case-insensitive unique partial matches; ambiguous or unknown matches preserve
the current selection and explain how to resolve the input. Selection remains
process-local and applies to subsequent prompt sessions. The existing model and
`build` agent remain defaults.

**Rationale:** This uses the pinned SDK contracts, reflects effective project
configuration without reading configuration files, and keeps the feature
inside the current REPL and session-creation boundary. Process-local selection
meets the requirement that choices apply to the next fresh session without
introducing another persistence policy.

## 2026-10-07 — Explicit model with selected agent

**Context:** OpenCode agents may include a configured model, while Quoder also
passes an explicit model to Core V2 session creation.

**Decision:** Quoder's selected model is explicit and applies together with the
selected agent. A model configured on the agent does not silently override the
model displayed by Quoder.

**Rationale:** The REPL must be able to display and record one unambiguous
effective model/agent pair. This matches the milestone requirement that both
selections apply to the next session and preserves existing explicit model
binding.

## 2026-10-07 — Milestone completed

**Decision:** Close Milestone 7 after implementation, self-review, security
review, and automated QA passed. Selection remains process-local. No live
provider inference or manual terminal run was needed for the fake-backed
functional acceptance and neither was performed.

**Documentation:** README and `docs/tech.md` now describe runtime selection.
`docs/requirements.md` already contains the milestone behavior and remains
unchanged. `SYSTEM_CONTEXT.md` remains accurate because the repository's
ownership and dependency boundaries did not change.

**Independent review follow-up:** The general reviewer returned PASS. The
independent security reviewer initially identified unvalidated runtime catalog
shapes. The adapter now validates and bounds catalog data and emits fixed
errors; both reviewers rechecked the remediation and returned PASS. Catalogs
are limited to 500 entries, model fields to 256 characters, and agent IDs to
128 characters. These implementation bounds may reject unusually large valid
catalogs and are recorded in the review reports.
