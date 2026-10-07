# Decisions: Milestone 6 — Execution History

## 2026-10-07 — Scope and boundaries

**Context**: `docs/requirements.md` FR-11 requires unique execution identifiers
and records for prompt/context, project/model/agent, permission decisions,
commands, changed files, response, status, and duration. Milestone 5 explicitly
left execution history out of scope.

**Decision**: Keep records in Quoder-owned local state, queried through the
project's canonical identity. Do not persist OpenCode conversations or SDK
payloads. Use existing REPL and session-runner lifecycle as the integration
boundary; a retry is one developer run even though it may create another fresh
OpenCode session.

**Rationale**: This meets the roadmap's inspectability goal while preserving
OpenCode session disposal and the adapter boundary. A smaller purpose-built
record avoids coupling to unstable SDK event serialization.

## 2026-10-07 — Group 1 verified runtime contracts

- `Harness.#runPrompt` receives the current prompt, captures a baseline Git
  snapshot, assembles the Milestone 5 context, and owns the complete run through
  final Git comparison and user-facing reporting (`src/harness/repl.ts`).
- `runPrompt` returns a final outcome, elapsed milliseconds, deleted-session
  status, and rejected permission/question summaries. It may retry one dropped
  prompt in a fresh session (`src/harness/session-runner.ts`).
- Current trace hooks reveal prompt lifecycle, retry, session IDs/deletion,
  permission reply choice/result, and tool names, but intentionally omit prompt
  text and raw event payloads (`HarnessTraceEvent` in `src/harness/repl.ts`).
- `LiveView` consumes normalized tool-called/succeeded/failed events. The
  current completion callback exposes only tool name; capturing command
  subjects or exact activity requires an explicit, bounded callback/data
  contract, not inference from the trace stream.
- The configured model provider and ID are available from `HarnessOptions`.
  Agent selection is not currently an option, so the record must allow an
  unavailable agent value unless a later approved API supplies it.
- Milestone 4's `GitComparison` provides before/after branch/HEAD and observed
  path changes; preserve its endpoint semantics and unavailable states.
- Milestone 5 already uses Node built-in filesystem, path, and crypto APIs for
  local project state. No new external SDK or package API is required for
  history persistence. Exact allocation and concurrency policy remain for
  Group 2.

**Verification**: Findings cross-checked against `src/harness/repl.ts`,
`src/harness/session-runner.ts`, `src/harness/live-view.ts`,
`src/harness/stream-events.ts`, `src/harness/git-state.ts`, and
`docs/requirements.md` FR-11. No runtime or user OpenCode configuration was
inspected.

## 2026-10-07 — Full records with bounded retention

**User decision**: Persist full FR-11 records and provide retention controls.

**Decision**: Store exact developer prompt, injected context, complete final
response, exact Bash command strings, compact tool/permission outcome summaries,
project/model/Git metadata, changed paths, status, and duration. Do not persist
tool stdout/stderr, complete tool input/output objects, OpenCode event payloads,
credentials, or session IDs. Verbatim fields are sensitive and are not
secret-redacted. Disclose this at startup and in `/history help`.

Use per-project 128-bit random hexadecimal IDs and exclusive creation with
collision retry rather than a shared sequential counter. The initial record is
persisted as in-progress before prompt submission; a retry increments the
attempt count within the same record. A record left in progress is described as
possibly interrupted, since another Quoder process may still own it. History
uses versioned per-run JSON records under the application's user state directory
and shares Milestone 5's XDG/macOS/Linux fallback conventions, while remaining
in its own `history` tree.

Default retention is the newest 100 completed records per project. Developers
can set 1–1,000 completed records, delete an exact run, or clear all records for
the current project. In-progress records are not counted until completion;
concurrent runs can temporarily exceed the cap and each completion prunes the
oldest completed records. A 32 MiB UTF-8 serialized-record ceiling prevents a
single prompt/response from exhausting local storage; oversized records are
never silently truncated or marked complete, and history failure does not
alter the model run. History read/write failure likewise warns without
changing execution behavior.

**Rationale**: Full FR-11 data makes a run inspectable, while excluding tool
outputs and complete event payloads avoids storing a transcript and minimizes
incidental data. Per-run immutable IDs avoid cross-process counter locking.
Count-based retention provides predictable cleanup; the hard byte limit keeps
one exceptional response or prompt from defeating it. IDs appear in per-run
filenames with their lifecycle state, while file modification times preserve
start order after atomic state-file publication; list/retention read metadata
only.

**Privacy caveat**: Restrictive file modes reduce accidental exposure but do
not isolate these records from same-user processes. `/history <id>` renders
record data through terminal sanitization and labels multiline fields; storage
remains verbatim.
