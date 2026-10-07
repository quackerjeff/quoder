# System Context

Use this file to ground AI agents in what this repository is, what it owns, and how it fits into the larger system.

Keep this file concise, factual, and current.

## Repository Identity

- Repository name: `quoder`
- Service or application name: Quoder (working product name; PRD title: OpenCode Stateless Harness)
- Primary language(s): TypeScript (Node 24, ESM)
- Primary framework(s): OpenCode SDK/API (`@opencode-ai/sdk@1.18.33`, Core V2) with project-local `opencode-ai@1.18.33`, pinned exactly
- Deployable unit: the local `quoder` command-line harness (`dist/cli.js` and its native diff reader, installed with `npm link`)

## Business Capability

This repository exists to:
- Preserve a continuous developer experience while using a fresh OpenCode session for every prompt
- Supply compact, persistent harness context to disposable OpenCode sessions
- Surface execution activity, permission requests, durable execution history, and repository changes without replacing OpenCode

Primary user or system served:
- A developer using OpenCode with local Ollama-hosted coding models under constrained VRAM

## What This Repo Owns

- The shell/TUI developer session and commands
- Harness state, context building, execution records, and project-level preferences
- The adapter boundary through which Quoder drives OpenCode sessions
- Git before/after inspection and user-facing execution summaries
- Read-only final diff viewing, including safe untracked-text inspection

## What This Repo Does Not Own

- OpenCode's agent runtime, tools, project configuration, and permission enforcement
- Ollama and local model lifecycle or inference
- The contents, behavior, and deployment of repositories operated on through Quoder

## Upstream Dependencies

Systems this repo depends on:

- OpenCode SDK/API
  - purpose: Create, drive, observe, cancel, and delete isolated OpenCode sessions
  - contract location: `docs/tech.md` (verified for 1.18.33; some generated Core V2 operations, such as `session.wait`, are server-side stubs in that version)
  - failure impact: Quoder cannot execute developer prompts
- An OpenCode-configured model provider
  - purpose: LLM inference used by OpenCode
  - current topology: provider `ollama` via `@ai-sdk/openai-compatible`, backed by a remote, authenticated HTTPS OpenAI-compatible endpoint (not localhost Ollama). The `quoder` harness binds `ollama/glm-4.7-flash:latest` by default (`--model` overrides it); feasibility runs bind `ollama/qwen3-coder:30b`
  - contract location: Developer's user-level OpenCode configuration; readiness is checked by `npm run verify:environment`
  - failure impact: OpenCode sessions cannot complete model work
- Terminal rendering libraries (Milestone 2)
  - purpose: `marked@18.0.14` (used as a Markdown lexer only) and `highlight.js@11.12.0` (code highlighting). Both are pinned exactly, have no dependencies of their own, and run in an isolated worker thread with a deadline and a memory limit
  - contract location: `docs/tech.md` ("Live Activity (Milestone 2)", "Dependency Choices")
  - failure impact: Answers are shown as sanitized plain text instead of formatted Markdown
- Git
  - purpose: Resolve project identity and capture repository state before and after executions
  - contract location: Git CLI behavior used by the implementation
  - failure impact: Project launch or change reporting is unavailable
- POSIX C compiler (`cc`) at build/test time
  - purpose: Build the directory-relative native helper used to read untracked diff files without following symlinked path components
  - supported build targets: macOS and Linux; QA validated macOS only so far
  - contract location: `native/read-untracked.c` and `scripts/build-native-reader.mjs`
  - failure impact: `npm run build` and `npm test` cannot build the safe untracked-file reader

## Downstream Consumers

Systems or teams that depend on this repo:

- Developer shell sessions
  - dependency type: Local CLI/TUI
  - compatibility concern: State recoverability, auditability, and stable command behavior

## Contracts

Source-of-truth contracts for this repo:

- Product requirements: `docs/requirements.md`
- Verified OpenCode integration patterns: `docs/tech.md`
- Persistent-state and execution-history contracts: `docs/tech.md`; implementation in `src/harness/project-memory.ts` and `src/harness/execution-history.ts`

Rules:
- do not guess contracts
- verify before implementing
- record confirmed usage patterns in `docs/tech.md`

## Data and State

Persistent state owned here:
- Per-project context memory and execution history, stored in Quoder's local user state directory outside target repositories; each feature uses a separate state subtree and its own schema/retention rules.

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
- Packaging, distribution, CI, and supported platform decisions remain open. The native untracked-diff reader is enabled for macOS/Linux builds; only macOS has been validated.

## Operational Risks

Known failure modes or sensitive areas:
- OpenCode Core V2 contracts are verified only for the pinned 1.18.33. The nine-capability feasibility passed on 2026-10-03 (Milestone 0).
- In 1.18.33, model-run shell commands inherit the OpenCode server's credentials, and the Seatbelt trampoline is not honored on the Core V2 session Bash path. Credential isolation is defense in depth, not a gate on the enabled permission prompts; the UI discloses that model-run tools are unconfined. The single-developer, local-only self-approval risk is accepted and documented in the active Milestone 3 decision record.
- OpenCode 1.18.33 intermittently drops the first prompt on a fresh server (admitted, never started). Quoder detects this within 5 s and retries once in a fresh session.
- Model and tool output is untrusted and is displayed live. Terminal-escape injection and rendering-based freezes are mitigated by post-lex sanitization, worker-isolated Markdown rendering with deadlines, and linear main-thread text handling (Milestone 2 security review).
- Session cleanup failures could retain unwanted model context or orphan resources.
- Permission forwarding errors could weaken user control or block valid work.
- A process interruption can leave a valid execution-history record in progress; Quoder labels it as possibly interrupted rather than guessing. Atomic state writes protect saved context and history records from partial publication, but same-user processes are not isolated from their contents.

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
