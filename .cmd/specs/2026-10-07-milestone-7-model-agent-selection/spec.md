# Milestone 7 — Model and Agent Selection

## Context

Milestone 6 records the model selected for an execution but the harness always
uses its configured startup model and OpenCode's `build` agent. The product
requirements call for interactive selection of configured models and agents.
Quoder must keep its persistent REPL and fresh OpenCode session architecture.

## Source Requirements

- FR-13 requires selecting among different OpenCode-configured models.
- FR-14 requires selecting OpenCode agents.
- Milestone 7 examples include `/model`, `/model glm`, `/model qwen`, `/agent`,
  and `/agent <name>`.
- A selected model and agent apply to the next fresh OpenCode session.
- Existing startup model selection through `--model provider/model` remains
  supported.

## Decisions

- Discover selectable models and agents through the authenticated pinned
  OpenCode SDK client, scoped to the canonical project directory. Do not read
  OpenCode configuration files directly.
- List enabled models. Select a model by exact `provider/model-id` or by a
  case-insensitive unique match against provider ID, model ID, or display name.
  The examples `/model glm` and `/model qwen` therefore work when each resolves
  uniquely. On zero or multiple matches, explain the result and preserve the
  current selection; show full IDs for ambiguous results.
- Offer visible primary/all agents as harness run agents; exclude hidden agents
  and subagent-only agents from selection. Match IDs case-insensitively, with
  unique partial matches for convenience. On zero or multiple matches, preserve
  the current selection and show the available IDs.
- `/model` and `/agent` list the available options and indicate the current
  selection. Selection remains in memory for the current Quoder process and
  applies to subsequent prompt executions. It does not change an already
  running session or persist across Quoder restarts.
- Preserve the existing default model and `build` agent. A startup `--model`
  value remains the initial selected model; this milestone does not change the
  defaulting or validation behavior of the flag.
- Record the selected model and agent in the Milestone 6 history record for
  each run. Keep the selection independent: when Quoder passes an explicit
  model to OpenCode, that model is used together with the selected agent.

## Design

The adapter exposes bounded model and agent catalog calls over the existing
authenticated OpenCode client. The REPL owns the current model and agent
selection and dispatches `/model` and `/agent` as local commands. Catalog
entries and user-supplied query text are sanitized before terminal rendering.
Catalog errors produce fixed sanitized messages and do not change the current
selection or prompt availability.

Model command flow:

1. `/model` loads the project-scoped model catalog and displays selectable
   provider/model IDs and the current selection.
2. `/model <query>` resolves one enabled model. An exact provider/model ID
   takes precedence; otherwise a unique case-insensitive substring match is
   accepted.
3. Unknown or ambiguous input leaves the selection untouched and displays
   actionable results.
4. The next prompt creates a fresh session with the selected model and agent;
   its history record stores the same pair.

Agent command flow follows the same list/resolve/error behavior using visible
`primary` or `all` entries. Selection applies to the next and later prompts
until changed or Quoder exits.

## Constraints

- Preserve one fresh OpenCode session per submitted prompt and the existing
  cancellation, retry, permission, and cleanup behavior.
- Do not edit OpenCode configuration, persist selection, or create a new
  persistence dependency.
- Do not expose provider credentials, agent system prompts, permission rules,
  or raw SDK errors in catalogs or diagnostics.
- Do not allow a hidden or subagent-only agent to be selected as the main
  execution agent.
- Do not claim that configured model availability proves the remote provider is
  reachable; actual inference remains subject to existing runtime behavior.

## Risks

- OpenCode's model/agent catalogs can change while Quoder is running. Commands
  query the current server catalog when invoked and selected IDs may still
  become unavailable before the next run.
- Catalog APIs are version-specific to pinned OpenCode SDK 1.18.33; the verified
  calls and response fields are recorded in `docs/tech.md`.

## Exit Criteria

- The developer can list and select configured, enabled models and visible
  primary/all agents without restarting Quoder.
- Exact and unambiguous shorthand selection work; invalid and ambiguous
  selections do not mutate state.
- Every subsequent fresh session receives the selected model and agent, and
  execution history reports those selected values.
- Model/agent catalog and selection failures are sanitized, leave the current
  selection intact, and do not prevent later prompt execution.
- Review, security review, required QA, and documentation gates pass.
