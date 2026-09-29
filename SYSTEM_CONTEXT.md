# System Context

Use this file to ground AI agents in what this repository is, what it owns, and how it fits into the larger system.

Keep this file concise, factual, and current.

## Repository Identity

- Repository name: `quoder`
- Service or application name: Quoder (working product name; PRD title: OpenCode Stateless Harness)
- Primary language(s): TypeScript (proposed by the PRD's feasibility milestone)
- Primary framework(s): OpenCode SDK/API; exact package and version require verification
- Deployable unit: Local command-line/TUI application

## Business Capability

This repository exists to:
- Preserve a continuous developer experience while using a fresh OpenCode session for every prompt
- Supply compact, persistent harness context to disposable OpenCode sessions
- Surface execution activity, permission requests, history, and repository changes without replacing OpenCode

Primary user or system served:
- A developer using OpenCode with local Ollama-hosted coding models under constrained VRAM

## What This Repo Owns

- The shell/TUI developer session and commands
- Harness state, context building, execution records, and project-level preferences
- The adapter boundary through which Quoder drives OpenCode sessions
- Git before/after inspection and user-facing execution summaries

## What This Repo Does Not Own

- OpenCode's agent runtime, tools, project configuration, and permission enforcement
- Ollama and local model lifecycle or inference
- The contents, behavior, and deployment of repositories operated on through Quoder

## Upstream Dependencies

Systems this repo depends on:

- OpenCode SDK/API
  - purpose: Create, drive, observe, cancel, and delete isolated OpenCode sessions
  - contract location: To be verified and recorded in `docs/tech.md`
  - failure impact: Quoder cannot execute developer prompts
- Ollama and an OpenCode-configured local model
  - purpose: Local LLM inference used by OpenCode
  - contract location: Developer's local OpenCode/Ollama configuration
  - failure impact: OpenCode sessions cannot complete model work
- Git
  - purpose: Resolve project identity and capture repository state before and after executions
  - contract location: Git CLI behavior used by the implementation
  - failure impact: Project launch or change reporting is unavailable

## Downstream Consumers

Systems or teams that depend on this repo:

- Developer shell sessions
  - dependency type: Local CLI/TUI
  - compatibility concern: State recoverability, auditability, and stable command behavior

## Contracts

Source-of-truth contracts for this repo:

- Product requirements: `docs/requirements.md`
- Verified OpenCode integration patterns: `docs/tech.md` (not yet researched)
- Harness state and execution-record schemas: not yet designed

Rules:
- do not guess contracts
- verify before implementing
- record confirmed usage patterns in `docs/tech.md`

## Data and State

Persistent state owned here:
- Local harness state and execution-history files; exact location and schema remain open

Important invariants:
- Each submitted prompt uses a new OpenCode session.
- Completed or cancelled OpenCode sessions are disposed and must not leak conversation history into later runs.
- Quoder does not bypass OpenCode's permission enforcement.
- Repository state is authoritative for facts recoverable from Git or project files.

## Environments and Deployment

Deployment environments:
- Local developer workstation and local AI server environment

Deployment notes:
- The initial product is local-first and has no cloud deployment requirement.
- Packaging, distribution, CI, and supported platform decisions remain open.

## Operational Risks

Known failure modes or sensitive areas:
- Required OpenCode SDK capabilities and version-specific contracts are not yet verified.
- Session cleanup failures could retain unwanted model context or orphan resources.
- Permission forwarding errors could weaken user control or block valid work.
- Crashes or non-atomic state writes could corrupt harness history or preferences.

Observability references:
- Structured local logging is planned for a later milestone; no current observability artifacts exist.

## Adjacent Repositories

Related repositories the agent may need to know about:

- Collaborative Multi-Agent Development (`/Users/jeffrey/Development/AI/collaborative-multi-agent-development`)
  - relationship: Shared development workflow source
  - why it matters: Supplies the role, steering, prompt, and guardrail conventions used in this repository

## Working Rules For AI Agents

- Prefer local repo facts over assumptions.
- Keep active implementation specs in `.cmd/specs/` within this repo.
- For cross-repo work, document dependencies and rollout order in the active spec.
- If this file is stale or incomplete, call that out explicitly rather than inventing missing architecture facts.

## Maintenance

Update this file when:
- ownership changes
- contracts move
- major dependencies change
- deployment topology changes
- the repo boundary changes
