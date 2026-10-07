# Decisions: Milestone 5 — Persistent Harness Context

## 2026-10-07 — Scope and architecture

**Context**: The Milestone 5 roadmap calls for persistent objective/task, decisions, constraints, previous execution summary, unresolved issues, and a context builder, while OpenCode sessions remain fresh per prompt.

**Decision**: Scope this milestone to compact harness memory plus prompt-context assembly. Preserve fresh OpenCode sessions. Keep execution records and `/history` in Milestone 6. Use the existing canonical `Project.root`, combine memory with live Git state, and do not duplicate Git facts in memory.

**Rationale**: Repository state can be rediscovered; developer intent and prior conclusions cannot. A separate bounded context document preserves continuity without carrying OpenCode conversation history.

## 2026-10-07 — Persistence research boundaries

**Context**: The current repository has no memory store and submits the raw REPL line to `runPrompt`. Milestone 4 already owns Git snapshots and final diffs.

**Decision**: Use built-in Node filesystem/path/hash APIs; key a versioned state document by a hash of canonical project root; persist outside the target repository in `$XDG_STATE_HOME/quoder/context`, falling back to `~/Library/Application Support/Quoder/context` on macOS and `~/.local/state/quoder/context` on other supported POSIX platforms. Create private directories/files (0700/0600 where POSIX modes apply) and use same-directory atomic rename. Treat memory as sensitive data, not a same-user security boundary. Surface corrupt/unknown-version state without overwriting it. Group 2 has defined authoring/edit/clear behavior, summary provenance, bounds, and best-effort last-writer-wins semantics for simultaneous processes.

**Research**: `docs/tech.md` records the current prompt seam, project root source, Git context ownership, and Node v24 API sources. `package.json` contains no `engines` declaration; no new persistence package is proposed.

## 2026-10-07 — Memory controls and previous-result summary

**Context**: Persistent objective/task and prior-result context needs a visible authoring, review, opt-out, and deletion path. The existing REPL handles local slash commands before creating an OpenCode session and accepts line input in TTY and pipe modes.

**Decision**: Add `/memory` local commands for show/help, setting objective/task, adding/removing decisions/constraints/issues, toggling automatic summaries, and clearing selected or all memory. Manual durable facts are only developer-authored. Automatic summaries are on by default with a startup disclosure; after an answered prompt only, store one bounded pair of excerpts from the developer prompt and final assistant response. Do not extract decisions from assistant text. Failed, rejected, cancelled, startup-failed, or otherwise unanswered turns preserve the last successful summary. Explicit `/memory clear` is the confirmation and clears content immediately; automatic summary behavior returns to default-on.

**Bounds and behavior**: Objective/task are limited to 500 Unicode code points each; each manual list holds at most 20 entries of 500 code points. The automatic summary retains at most 512 code points from the request and 1,536 from the final response. The versioned document cap is 32 KiB; the injected memory plus live Git context cap is 4,096 Unicode code points, with current developer input always preserved verbatim. On malformed/unsupported state, prompts continue without memory, writes are blocked, and explicit clear is required before reset. On storage failures, show a sanitized warning and do not fail the prompt.

**Rationale**: Explicit commands keep long-lived intent under developer control, while the single replace-on-success summary supports natural immediate follow-ups without retaining a transcript or adding a model call. Startup disclosure and a direct opt-out make the automatic local persistence visible. The current Git snapshot supplies repository facts and is not duplicated in durable memory.

**Sensitive-data disclosure**: Automatic excerpts are retained verbatim up to their limits and are not reliably secret-redacted. `/memory help` must state this plainly and describe how to disable automatic summaries and clear the stored summary. The same-user tools limitation from Group 1 remains in force.

**Staleness and context priority**: Developer-authored objective/task/list entries remain until explicitly replaced, removed, or cleared; Quoder does not infer that a decision or constraint has expired. The replace-on-success summary is the only automatically refreshed memory. Within the context cap, retain objective and task first, then the latest request/response summary, then newest manual list entries, and trim oldest list entries before clipping summary excerpts. Live Git facts are added separately and are never persisted in the summary.

## 2026-10-07 — Versioned project memory store

**Implementation**: Added `src/harness/project-memory.ts` with a strict version-1 JSON schema, exact-key validation, code-point/list bounds, and the 32 KiB UTF-8 ceiling. State is keyed by SHA-256 of `Project.root` and stored outside the project in the selected XDG/macOS/Linux state directory. The Quoder and context directories use mode 0700; files use mode 0600. Reads use `O_NOFOLLOW` where available, verify a regular file and same-user ownership, cap the read buffer, and reject invalid UTF-8. The store resolves existing ancestors to reject paths that end up inside the project.

**Write/recovery behavior**: Normal save refuses malformed, oversized, invalid-schema, and unsupported-version existing files. It writes a unique same-directory temporary file with exclusive creation, syncs it, and renames it atomically. Temporary files from interrupted writes do not affect the last committed state. Explicit `clear()` is the reset path and writes an empty default document. Concurrent writes are atomic but intentionally last-writer-wins; there is no cross-process lock.

**Verification**: `./node_modules/.bin/vitest run tests/unit/project-memory.test.ts` passes 14 tests. `npm run typecheck` and `npm run build` pass.

## 2026-10-07 — Persistent REPL memory commands

**Implementation**: `Harness` creates and loads one project memory store before startup, reports whether memory is available and whether automatic summaries are enabled, and handles `/memory` locally before any OpenCode session is created. Added formatted, terminal-sanitized show/help output and all Group 2 edit/remove/toggle/clear operations. A memory store factory can be injected for embedders and tests.

**Failure behavior**: Load errors leave memory unavailable but do not prevent server startup or developer prompts. Only whole-memory clear is allowed while corrupt/unsupported state is unavailable. All edits report success only after store persistence succeeds; failures keep the displayed in-memory state unchanged. No memory command writes prompt text or saved values to traces.

**Verification**: `./node_modules/.bin/vitest run tests/integration/harness.test.ts tests/unit/project-memory.test.ts` passes 86 tests. `npm run typecheck`, `npm run build`, and `git diff --check` pass.
