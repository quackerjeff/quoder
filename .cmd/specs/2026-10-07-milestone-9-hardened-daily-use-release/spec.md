# Milestone 9: Hardened Daily-Use Release

## Context

Roadmap source: `docs/requirements.md`, “Milestone 9 — Hardened Daily-Use Release”. Its goal is regular-development reliability. Its feature list is crash recovery, session cleanup, stale OpenCode session detection, corrupt-state handling, structured logging, configuration validation, graceful Ollama/OpenCode failure handling, and clear error reporting. Its exit criterion is qualitative: Quoder can be used as the normal interface for local OpenCode development without frequent manual recovery. No numeric reliability or performance target is stated.

Milestone 9 follows M8 on `milestone-9-hardened-daily-use-release`. It is the last roadmap milestone. M9 is within Quoder's harness, owned state, and OpenCode adapter boundary; it does not change OpenCode or Ollama themselves.

## Group 1 Research and current-state audit

Completed by the architect on 2026-10-07. Evidence:

- `SYSTEM_CONTEXT.md`: Quoder owns the CLI, harness state, OpenCode adapter, and child server lifecycle; it does not own OpenCode/Ollama execution. It records known in-progress history, atomic state writes, and possible orphan-resource risk.
- `docs/tech.md`: pinned SDK and server contracts; OpenCode server startup, authentication, and cleanup behavior; environment preflight; known OpenCode 1.18.33 integration limits.
- `src/harness/repl.ts`: creates a persistent authenticated server, uses fresh sessions per prompt, reacts to server exit and event-stream loss, retries undeleted sessions, and performs memoized orderly shutdown. It reports several server failures with fixed text.
- `src/opencode-server.ts`: owns a spawned child, waits for startup and authenticated health, installs an exit hook, and performs bounded SIGTERM/SIGKILL shutdown. Child diagnostics are discarded because inherited configuration can be sensitive.
- `src/harness/session-runner.ts` and `src/opencode-adapter.ts`: cancellation settles and deletes fresh sessions; adapter calls have deadlines and typed/sanitized errors.
- `src/harness/execution-history.ts`: atomic bounded records, explicit `in-progress` state, typed corruption/unavailability results, stale temporary-file cleanup, and retention. `src/harness/project-memory.ts`: atomic writes, schema/size validation, corruption reporting, and explicit clearing; malformed state is not silently overwritten.
- `src/cli.ts`: argument parsing validates the basic `--model provider/model` shape. The top-level rejection handler prints only a generic message. There is an optional `QUODER_TRACE_FILE` JSONL trace writer, but it is a harness trace hook and is not a defined general logging contract.
- Existing focused tests include `tests/unit/opencode-server.test.ts`, `tests/unit/session-runner.test.ts`, `tests/unit/opencode-adapter.test.ts`, `tests/unit/project-memory.test.ts`, `tests/unit/execution-history.test.ts`, `tests/unit/cli.test.ts`, and `tests/integration/harness.test.ts`.

The audit indicates partial existing coverage for session cleanup, process interruption labeling, state corruption, request deadlines, configuration parsing, and user-facing failures. Therefore M9 implementation should close evidenced gaps without duplicating or weakening these behaviors. “Stale OpenCode session” is not yet defined by the roadmap: the code tracks sessions Quoder attempted to delete during the current process, but there is no documented startup discovery/reconciliation contract for sessions or processes left by a hard crash.

## Source requirements versus design work

The eight bullets and qualitative exit criterion above are the only M9 roadmap requirements found. This spec treats the approved operational scenarios and diagnostics as decisions elaborating those bullets, not as new roadmap features. No numeric reliability or performance target is presumed.

## Resolved product decisions

1. **Stale resources — decided.** Detect and report stale resources and ask the developer before cleanup. Restrict cleanup to demonstrably Quoder-owned resources; do not terminate unrelated OpenCode processes or act on ambiguous sessions.
2. **Corrupt state — decided.** Preserve the corrupt source and provide manual recovery guidance only. Do not add an interactive backup/reset flow or overwrite, delete, or replace the source.
3. **Structured logging — decided.** Logging is opt-in JSONL outside the target project and contains operational metadata only: no prompts, tool output, provider payloads, or secrets. Choose the exact event fields and a safe default path during implementation without weakening these constraints.
4. **Configuration validation — decided.** At startup validate Quoder-owned settings and launch-critical dependency inputs. This does not require validating every user OpenCode setting; errors for launch-critical inputs must be clear before execution proceeds.
5. **Failure presentation — decided.** Present distinct sanitized, actionable categories for OpenCode, provider/inference, configuration, and local-state failures. Do not expose raw provider responses, credentials, or child diagnostics.

Group 2 is complete. Group 3 should design only the approved flows: stale-resource reporting followed by a developer cleanup choice; manual recovery guidance that preserves corrupt state; startup diagnostics for Quoder-owned settings and launch-critical dependency inputs; and sanitized categorized failures. Do not introduce interactive state backup/reset.

## Group 4 research follow-up: stale OpenCode session ownership

**Contract sources**: Pinned local declarations at `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` (`Session3.create`, `Session3.get`, `Session3.list`) and `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` (`V2SessionCreateData`, `SessionV2Info`, `V2SessionListData`); implementation call site `src/opencode-adapter.ts`; current persistence schema `src/harness/execution-history.ts`. A verified contract note is also in `docs/tech.md` under Session Creation.

**Exact bounded command**: `node scripts/.m9-owned-session-probe.mjs` (temporary probe script, removed immediately after the run). Initial in-sandbox launches terminated with OpenCode's generic `ServeError`; after user authorization, the same command was run with fewer sandbox restrictions and passed. The script used the project-local OpenCode executable with `serve --hostname=127.0.0.1 --port=0 --pure`, no server password, and no model or provider request. It created a disposable project plus isolated temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME`, removed credential-like/inline OpenCode configuration environment variables, and generated a random `ses_` ID with a 24-character lowercase hexadecimal suffix.

**Observed result**: Core V2 `session.create` accepted the caller ID and returned it unchanged. V2 `get` and project-filtered `list` returned that exact session before restart. After the owned child server stopped and a second server started against the same temporary state, V2 `get` and project-filtered `list` still returned it. The probe deleted only that generated session using the existing legacy delete bridge, then verified Core V2 `get` returned HTTP 404. Both owned server children exited; the temporary tree was removed, and a follow-up check found no matching `quoder-m9-session-probe-*` roots. No prompt was submitted, no provider/model inference occurred, and no user project or state was used.

**What this verifies and does not verify**: The exact caller-ID shape used in this probe is accepted and durable/listable by the pinned local 1.18.33 server. The generated Core V2 request schema accepts `id?: string`, and response/list records expose the ID and project/location details. V2 create does not expose legacy `title` or `metadata`; V2 session records do not expose ownership metadata. This run does not establish arbitrary ID formats, uniqueness or conflict semantics, concurrent collision behavior, cross-version compatibility, or a cryptographic server-side ownership marker.

**Current crash window**: `#beginHistory` persists a Quoder history record before OpenCode session creation, but `ExecutionHistoryRecord` has no OpenCode session ID. `runAttempt` receives the ID only after the server has created the session; its callback updates the view and emits an in-memory trace, not durable ownership state. A hard crash after remote creation and before a durable link therefore loses the only direct identifier. Current undeleted-session retry state is also in memory. Directory, title, agent, or age matches cannot safely establish ownership.

**Approved bounded ledger protocol**: generate a random custom session ID in the tested `ses_<24 lowercase hex>` shape and atomically persist a private Quoder ownership intent before issuing V2 create. Record canonical project root, exact session ID/nonce, creation time, and lifecycle state in Quoder-owned storage outside the project. Send that exact ID in V2 create and require the response ID to match. Only a durably persisted `created-confirmed` entry—written after a successful create response whose ID exactly matches the requested ID—can be offered for cleanup. Require an exact ID and canonical project/location match, then explicit developer confirmation before deleting each such session. Intent-only, uncommitted, ambiguous, or otherwise unconfirmed entries are report-only and must never be cleanup candidates. If persisting any ownership transition fails, fail closed and do not offer cleanup. Old or unregistered sessions are never candidates. Remove/complete a confirmed ledger entry only after V2 `get` confirms 404.

Activity is a separate uncertainty. `Session3.active` reports drains owned by the current OpenCode process; a newly launched server cannot use that endpoint to prove an older orphan server is not still running the session. Until the prior server's termination can be proven, the cleanup prompt must disclose that session activity is unknown and deletion may interrupt work. Do not label a session inactive based only on absence from the new server's active list.

Crash handling: if create succeeds but Quoder crashes before the `created-confirmed` ledger write is durably committed, the session may be discoverable through the intent ID, but that intent remains report-only and manual recovery is required. This narrow crash window is an accepted limitation: safe cleanup takes precedence over automatically recovering every created session. If create is known to conflict or its outcome is ambiguous, preserve/report the intent; it never becomes cleanup-eligible without a durable `created-confirmed` transition. A crash during cleanup leaves the confirmed entry for another report/approval cycle, with 404 allowing safe finalization. This protocol relies on random-ID collision resistance and a pre-create uniqueness check; the probe did not verify server uniqueness/conflict semantics. The ID is a correlation marker held in the local ledger, not independent upstream ownership metadata, and same-user processes are outside the state-file isolation guarantee.

**User decisions**: The user approved the ledger and required explicit cleanup confirmation. The user also selected fail-closed handling: only durably `created-confirmed` entries with exact ID/location checks may be offered for cleanup; intent-only, uncommitted, and ambiguous entries are report-only. The user accepted the narrow crash window above and manual recovery for a created session whose confirmation was not durably recorded. The UI must clearly warn that session activity may be unknown and deletion may interrupt work if prior-server termination cannot be established. Because the old server's activity is not visible through a newly launched server, do not claim a ledger session is inactive based only on `Session3.active()` from the new process. Preserve the other protocol constraints above.

## Design boundaries and invariants

- Quoder owns lifecycle recovery only for its launched OpenCode child and sessions it created or can safely identify. Do not claim control over external OpenCode or Ollama processes.
- Preserve one fresh OpenCode session per submitted prompt and existing permission behavior.
- Preserve atomic writes, schema checks, explicit corruption results, history retention, and the existing label for interrupted records. Recovery must not infer a successful or failed model result when evidence is missing.
- Cleanup remains bounded and idempotent. Failures to confirm cleanup must remain observable to the developer.
- Keep credentials and provider configuration out of logs, terminal diagnostics, and persisted recovery metadata. Do not retain arbitrary OpenCode child stderr unless the approved redaction design establishes safety.
- Ollama is the configured OpenCode provider label in the current environment, but Quoder does not own or manage Ollama. Handle provider/inference errors at the integration boundary; do not add model/provider probes or live calls without an explicit QA decision.
- No database or persistence dependency is implied by this milestone.

## UI and error behavior

### Group 3 UI design

The harness is a terminal CLI. Keep the existing prompt and plain-text output conventions. Diagnostics are short, categorized, actionable, and safe to print in both TTY and piped use. Wrap long explanations to the current terminal width when available; in piped output, emit ordinary newline-delimited text without terminal control sequences. Sanitize all displayed identifiers and error-derived text for terminal control characters, bound their displayed length, and never print credentials, raw provider payloads, or child stderr.

#### Startup validation

- Validate Quoder-owned settings and launch-critical dependency inputs before starting the interactive prompt or accepting piped work.
- On success, continue startup without an extra confirmation screen.
- On failure, print a `Configuration` diagnostic naming the safe setting/input category, explaining what is invalid or unavailable, and giving a concrete correction or diagnostic command when known. Do not print setting values, secret values, raw dependency responses, or arbitrary OpenCode user/project configuration details.
- Use the same diagnostic in TTY and piped mode, then exit nonzero without starting a run. Do not prompt to continue with invalid launch-critical inputs.

#### Stale-resource detection and cleanup choice

- Report the number and sanitized, bounded identifiers/descriptions of stale resources Quoder can prove it owns. If discovery also encounters ambiguous or external resources, report that they were left untouched; do not offer them as cleanup targets.
- In TTY mode, after reporting the proven-owned targets, ask once whether Quoder should clean those listed resources. Use an explicit `[y/N]` choice with No as the default. Accept only an unambiguous affirmative response; blank input, any other response, Ctrl-C, or input closure means decline. On decline, state that the resources remain and that no cleanup was attempted. On acceptance, attempt only the resources just listed, with bounded operations, then report each confirmed result and any cleanup failure. A failure to confirm must never be described as successful cleanup.
- In piped/noninteractive mode, never block waiting for a choice and never clean automatically. Report the proven-owned stale resources, say cleanup was skipped because confirmation requires a terminal, and give the command/TTY invocation needed to review the choice if known.
- Do not invent resource classes, ownership signals, or cleanup actions in the UI. The implementation must supply the evidence-backed list and operation; ambiguous ownership is not actionable.

#### Corrupt local state

- Use a `Local state` diagnostic that identifies the affected Quoder-owned state area and says its source was preserved unchanged. Give manual recovery guidance: stop Quoder before inspecting or moving the file, make a copy before any manual edits, and consult the documented state location/schema or support instructions when available.
- Do not offer a reset, backup, rename, delete, overwrite, or repair button/command. Guidance is informational only; Quoder does not modify the corrupt source.
- Keep TTY and piped behavior identical apart from wrapping. End the affected operation safely and return a nonzero result when required state prevents startup or the requested operation; do not silently substitute empty state.

#### Categorized operational failures

Use stable category labels and fixed, sanitized summaries with one next step, based only on verified failure evidence:

| Category | User-facing intent | Example next step |
| --- | --- | --- |
| `OpenCode` | Server startup, connection, or session lifecycle failed | Restart Quoder; if the problem persists, run `npm run verify:environment` from Quoder |
| `Provider/inference` | OpenCode reported that a model request could not complete | Check the selected provider/model availability and its configuration in OpenCode |
| `Configuration` | A Quoder-owned setting or launch-critical input is invalid/unavailable | Correct the named setting/input or run the relevant environment check |
| `Local state` | Quoder-owned state could not be read or safely interpreted | Preserve the source and follow manual recovery guidance |

Do not infer a provider failure from a generic transport error. If evidence cannot distinguish categories, use the narrowest truthful category (`OpenCode` for server/transport failures; `Local state` only for owned-state operations). Keep the message and next step bounded; sanitize any safe identifier included, and omit untrusted raw details. In TTY and piped modes use the same wording and exit/status semantics.

#### Opt-in JSONL operational log

- Logging is disabled by default. Enabling it is explicit through the documented opt-in setting or option; show the resolved destination in a sanitized startup notice only when logging is enabled.
- The JSONL destination must be outside the target project. If the destination cannot be safely resolved or opened, show a bounded `Configuration`/logging diagnostic and continue the core session without logging; logging failure must not change prompt, cleanup, or recovery outcomes.
- TTY and piped runs use the same event schema and content policy. Log operational metadata only. Never log prompts, tool output, provider payloads, credentials, raw error objects, or child stderr. Do not echo serialized log records to the terminal.
- Keep line-oriented output valid for piping; no color or terminal controls in JSONL or piped diagnostics.

#### Accessibility and handoff

- All cleanup decisions are keyboard-readable text prompts, with the default shown and a visible explanation of what is in scope. No color-only meaning or raw-key-only action is required.
- Errors must retain their category when color is disabled, and long text must wrap without hiding the action or preservation statement.
- Group 4–6 consume this design. They may choose exact stable message wording and log metadata fields, but must preserve the approved actions, defaults, category boundaries, sanitization, and TTY/piped equivalence above.

## Verification boundary

Automated unit and integration tests should cover deterministic crash/lifecycle, stale-resource, corrupt-state, invalid-configuration, and categorized-failure cases using fakes or disposable local fixtures. Do not make live model inference a default test. Group 7 must state whether a manual run is needed to validate OS process behavior or terminal recovery UX; any live provider/model run requires explicit user authorization.

## Risks and open architecture questions

- A hard process kill may bypass orderly cleanup. An exit hook can help only while the process receives an exit path; it is not proof that an orphan cannot remain.
- OpenCode's own durable session state and Quoder's session records have different owners and cleanup contracts. Startup deletion based only on an ID or project name risks deleting user-owned state.
- State corruption can be loss-prone if “recovery” means reset. Preserve source data until the user-approved behavior is explicit.
- Existing trace events may contain content-bearing fields; blindly turning the trace writer into general-purpose structured logging could leak prompts, commands, or model output.
- OpenCode 1.18.33 and the configured provider may fail with different typed and untyped response shapes. Map only verified error evidence; do not infer provider-specific guarantees.
- The exit criterion “without frequent manual recovery” has no count, interval, or reliability target. Do not invent one; report concrete scenario coverage and remaining limits.

## Non-scope

- Changes to OpenCode or Ollama, their process management, configuration formats, or service availability.
- Changing permission policy, credential-isolation claims, fresh-session architecture, M5 context-pruning behavior, M6 retention policy, or M8 usage persistence/display decisions.
- New telemetry service, analytics, crash upload, or cloud dependency.
- Automatic deletion/reset of ambiguous or corrupt user data.
- Live model benchmark or quality tuning.
