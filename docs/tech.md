# Technical Notes

Use this file for confirmed implementation facts only.

## Verification Scope

Verified on 2026-09-29 for the active OpenCode SDK feasibility spike.

Verification index: Package, Version, Import, Signature, Source, Project directory, Session creation, Session deletion, Streaming, Permission request, Permission response, Cancellation, Final result, Node, and npm.

| Component | Exact version | Evidence |
| --- | --- | --- |
| Quoder-local OpenCode CLI package | `opencode-ai@1.18.33` | `package-lock.json`; `npx --no-install opencode --version` |
| Quoder-local OpenCode SDK package | `@opencode-ai/sdk@1.18.33` | `package-lock.json`; `node_modules/@opencode-ai/sdk/package.json` |
| Node runtime | `v24.18.1` | `node --version` |
| npm runtime | `12.0.2` | `npm --version` |
| TypeScript approved for Group 2 | `typescript@7.0.2` | `npm view typescript version` on 2026-09-29 |
| Vitest approved for Group 2 | `vitest@5.0.2` | `npm view vitest version` on 2026-09-29 |
| Node types approved for Group 2 | `@types/node@24.12.2` | Node 24 line and SDK package's declared development version |

The system OpenCode executable at `/Users/jeffrey/.local/bin/opencode` remains version `1.18.20` and is out of scope. Quoder must use the project-local package through `npx --no-install opencode` or `node_modules/.bin/opencode`.

## Stability And Selected Surface

- **Package:** `@opencode-ai/sdk@1.18.33`
- **Import:** `@opencode-ai/sdk/v2`
- **Client factory:** `createOpencodeClient`
- **Hosted server factory:** `createOpencode`
- **Core V2 API namespace:** `client.v2`
- **Stability:** The package exposes legacy endpoints and a newer Core V2 namespace from the same `/v2` import. Generated names such as `Session2`, `Session3`, and `/api/...` routes show an evolving surface. Exact dependency pinning is mandatory.

Sources:

- Official SDK source: [anomalyco/opencode JavaScript SDK](https://github.com/anomalyco/opencode/tree/dev/packages/sdk/js)
- Official Core V2 permissions: [OpenCode V2 permissions](https://opencode.ai/v2/docs/permissions)
- Official server API: [OpenCode server](https://dev.opencode.ai/docs/server/)
- Local package manifest: `node_modules/@opencode-ai/sdk/package.json` (`1.18.33`)
- Local generated client declarations: `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` (`1.18.33`)
- Local generated wire types: `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` (`1.18.33`)

## Framework Patterns

### Hosting And Client Connection

Import and signatures:

```ts
import {
  createOpencode,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2";

createOpencode(options?: ServerOptions): Promise<{
  client: OpencodeClient;
  server: { url: string; close(): void };
}>;

createOpencodeClient(config?: Config & {
  directory?: string;
  experimental_workspaceID?: string;
}): OpencodeClient;
```

Sources: local `dist/v2/index.d.ts`, `client.d.ts`, and `server.d.ts`. `ServerOptions` accepts `hostname`, `port`, `signal`, `timeout`, and `config`. The official server documentation confirms an OpenAPI server and SSE transport.

The pinned SDK helper does not expose a child-environment or authentication option. OpenCode `1.18.33` protects `serve` with HTTP Basic Auth when `OPENCODE_SERVER_PASSWORD` is set; `OPENCODE_SERVER_USERNAME` overrides the default username. An authenticated embedded launch must therefore start the project-local CLI with those variables only in the child environment and construct the SDK client with the matching `Authorization: Basic ...` header. Credentials must not be placed in command arguments, persisted configuration, or diagnostics. Sources: official OpenCode server authentication documentation and local inspection of `@opencode-ai/sdk@1.18.33` `dist/v2/server.js`, `dist/v2/client.js`, and `dist/v2/gen/client/types.gen.d.ts`.

Local server command:

```bash
npx --no-install opencode serve --hostname 127.0.0.1 --port <port>
```

### Model and Agent Discovery (Milestone 7 research, 2026-10-07)

The pinned `@opencode-ai/sdk@1.18.33` V2 client exposes project-scoped
catalogs: `client.v2.model.list({ location: { directory } })` returns
`{ location, data: ModelV2Info[] }`, and
`client.v2.agent.list({ location: { directory } })` returns
`{ location, data: AgentV2Info[] }`. The generated declarations are in
`node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` and
`types.gen.d.ts`; both methods accept an optional `signal` through their
second request-options argument.

`ModelV2Info` includes `id`, `providerID`, `name`, `enabled`, and status.
`AgentV2Info` includes `id`, `mode`, and `hidden`; mode is `primary`,
`subagent`, or `all`. These fields are sufficient to build selectable labels
without showing agent system prompts, provider request details, or permission
rules. Core V2 session creation accepts both `agent?: string` and
`model?: ModelRef`, where `ModelRef` contains `providerID`, `id`, and optional
`variant`. This is the same session-creation contract Quoder already uses;
Milestone 7 does not require a new endpoint or dependency.

**Milestone 7 implementation:** `OpenCodeAdapter.listModels(directory)` and
`listAgents(directory)` call those V2 endpoints with the canonical project
root and a per-call deadline. Models are reduced to provider ID, model ID, and
display name after filtering disabled entries. Agents are reduced to IDs after
filtering hidden and subagent-only entries. The REPL sanitizes catalog values
before display, resolves exact or unique case-insensitive partial matches, and
keeps the selected model/agent in process memory. Each prompt snapshots both
values before it starts, passes them to the fresh session, and records them in
execution history. `/model` and `/agent` catalog errors use fixed messages and
do not alter the current selection. This selection state is not persisted.

The Quoder launcher omits `--pure` and registers a `shell.env` plugin from a final `OPENCODE_CONFIG_CONTENT` merge. This does not isolate credentials for the Core V2 Bash tool in `opencode-ai@1.18.33`: pinned `packages/core/src/tool/bash.ts` marks plugin `shell.env` support as TODO and creates the child process directly. A bounded user-guided tool-shell probe confirmed that `OPENCODE_CONFIG_CONTENT` and `OPENCODE_SERVER_PASSWORD` were nonempty. Same-user processes can inspect an owned server's environment using `ps eww`, and local MCP child processes also inherit `process.env`. The Seatbelt trampoline is not honored on the Core V2 session path used by the harness. These isolation gaps are defense-in-depth follow-up, not a gate on the enabled permission prompts; the CLI discloses that model-run tools are unconfined. Since project plugins execute in the server process and can access its environment, Quoder rejects project plugin configuration and plugin directories while preserving plugin-free project settings. User-level plugins remain trusted.

Group 3 verification: unit coverage confirms project settings without plugin sources are accepted, root/nested/ancestor plugin sources are rejected, and the `shell.env` hook function blanks the server credentials and inherited inline config when called. This does not establish invocation by Core V2 Bash; pinned 1.18.33 source explicitly records that hook integration as TODO, and runtime probing confirmed the two credential/config variables remain nonempty. Authenticated server startup and native save scope/revocation passed no-model runtime checks. Credential isolation remains unverified on the harness path and is not a release blocker under the 2026-10-06 requirement restatement.

### Git State Capture (Milestone 4 research, 2026-10-06)

The local environment provides Git `2.54.0 (Apple Git-157)`. Milestone 4 proposes using argument-array subprocess calls from Quoder with the canonical `Project.root`; no Git package dependency is introduced.

- `git status --porcelain=v2 --branch --untracked-files=all -z` is a machine-oriented candidate for branch, HEAD, index/worktree status, and individual non-ignored untracked paths. Porcelain v2 adds extensible headers; parsers must ignore unknown headers. With `-z`, paths are NUL-delimited and are not quoted, so parsing must be byte-safe. The branch headers distinguish an unborn branch (`branch.oid (initial)`) and detached HEAD (`branch.head (detached)`). See the official [git-status documentation](https://git-scm.com/docs/git-status).
- `git --no-optional-locks status ...` avoids Git's optional background index refresh write. Git documents that ordinary `status` may update cached stat data in the index. Group 1 fixtures confirmed that this alone does not prevent a configured fsmonitor helper; add `-c core.fsmonitor=false`. Untracked scanning remains enabled and can be slow in large worktrees.
- `git diff` compares working tree to index; `git diff --cached` compares index to HEAD; `git diff HEAD` compares the current working tree to HEAD. Ordinary diff output does not include untracked file contents. `git diff --no-index` can compare two filesystem paths, but implies diff-style exit codes. See the official [git-diff documentation](https://git-scm.com/docs/git-diff).
- `git ls-files --others --exclude-standard -z` is the documented candidate for enumerating individual untracked paths while applying repository, info, and global ignore rules. See the official [git-ls-files documentation](https://git-scm.com/docs/git-ls-files).
- For machine counts and path parsing, `git diff --numstat -z` emits added/deleted line counts and NUL-delimited path fields; binary files use `-` counts. Rename/copy records contain both preimage and postimage paths. Diff commands should explicitly use `--no-ext-diff --no-textconv` so configured external diff helpers and text conversion filters are not run. These details are described in [git-diff](https://git-scm.com/docs/git-diff).

**Validated disposable-fixture behavior (Git 2.54.0, 2026-10-06)**: Group 1 exercised clean and dirty worktrees, staged plus unstaged changes, untracked files with spaces, deletion, staged rename, control/tab/newline paths, unborn and non-Git repositories, HEAD movement, committed-tree comparison, binary numstat, and helper execution. Status v2 with `-z` preserved unusual path boundaries. `git diff HEAD` included both staged and unstaged tracked edits, while untracked contents required separate enumeration and reading. A changed `old..new` commit range exposed committed changes after HEAD movement. Binary `--numstat -z` used `-\t-\t<path>\0`.

**Read-only invocation constraints**: In fixtures, `--no-optional-locks` alone still invoked a repository-configured `core.fsmonitor` helper; `-c core.fsmonitor=false` suppressed it. Diff commands with `--no-ext-diff --no-textconv` did not invoke configured external diff helpers. `git diff --no-index` returned 1 for differing files, which is its difference indicator rather than an operational failure. Milestone 4 implementation must use these overrides, NUL-safe parsing, bounded untracked reads, and explicit unavailable states for non-repositories and Git failures. Endpoint snapshots describe observed state only and cannot establish authorship or detect an intermediate HEAD change that returns to the original value. See the decision log for the reporting contract and fixture limitations.

**Quoder snapshot API (Group 3, 2026-10-06)**: `src/harness/git-state.ts` exposes `captureGitSnapshot(root)` and `compareGitSnapshots(before, after)`. Each subprocess uses `execFile` argument arrays, a 5 s deadline, a 4 MiB output ceiling, `-c core.fsmonitor=false`, and `--no-optional-locks`. Git directory/index/object redirection, command-line config injection, and trace environment variables are removed from the child environment so the requested root remains authoritative and Git does not write inherited trace logs. Porcelain v2 status uses NUL-delimited byte output and supplies individual untracked paths in the same scan; rename records consume both path fields. Tracked line statistics use `git diff --numstat -z --no-ext-diff --no-textconv HEAD`; binary files make aggregate line totals unavailable and are counted separately. When HEAD moves, comparison captures the old-to-new tree statistics separately; an unborn-to-first-commit transition uses `git diff-tree --root --numstat --no-commit-id -r -z`. Failed, timed-out, and over-limit Git calls yield a typed unavailable state rather than a clean snapshot. Dirty-at-both-endpoints paths remain explicitly pre-existing, with a status-transition flag that does not claim authorship.

**Prompt lifecycle integration (Group 4, 2026-10-06)**: The REPL captures one baseline before server/prompt work and one final snapshot after `runPrompt` settles, so an automatic retry and session deletion remain within one comparison interval. The post-snapshot is attempted for answered, rejected, failed, and cancelled outcomes. `formatGitSummary` sanitizes repository-controlled paths, limits each path list to 100 entries, distinguishes observed paths from baseline-dirty/resolved paths, and labels line counts as final tracked/committed diffs rather than prompt attribution. Capture and comparison failures become unavailable summaries and do not replace the prompt outcome.

**Read-only diff viewing (Group 5, 2026-10-06; reader hardened in Group 7)**: `captureGitDiff(comparison)` reads the final tracked tree diff against HEAD, includes the old-to-new committed tree delta when HEAD moved, and reads untracked regular text files separately. Untracked reads use `native/read-untracked.c`, a small POSIX helper built into `dist/native/read-untracked` by `scripts/build-native-reader.mjs`. Quoder passes the project directory as an open descriptor; the helper walks each repository-relative path component with `openat`, `O_DIRECTORY` for parents, and `O_NOFOLLOW` for every component, then reads only a regular file through its descriptor. The helper enforces the per-file byte limit; the TypeScript caller enforces an aggregate 1 MiB read limit, 1 MiB rendered diff limit, 2 s per-file deadline, and 10 s aggregate untracked-read deadline. Binary and non-UTF-8 data and all symlink paths are omitted. The helper uses POSIX APIs and the build script enables macOS/Linux; it requires a C compiler (`cc`) for `npm run build` and `npm test`. QA built and exercised it on macOS only; Linux remains unverified. All diff content is terminal-sanitized; interactive TTY output pages at 40 lines and supports next, previous, and return to the View/Continue choice. Piped output prints the bounded sanitized diff automatically. Clean snapshots produce no empty choice. Diff content is transient and is not added to the next model prompt or persisted.

### Persistent Harness Context (Milestone 5, 2026-10-07)

`src/harness/project-memory.ts` implements version-1 per-project JSON memory using only Node built-ins. It keys a file by SHA-256 of the canonical `Project.root` supplied by `resolveProject`, and stores it outside the target project under absolute `$XDG_STATE_HOME/quoder/context`, falling back to `~/Library/Application Support/Quoder/context` on macOS and `~/.local/state/quoder/context` on other supported POSIX platforms. Native paths use `node:path`. The implementation relies on Node filesystem and crypto APIs documented in the [Node.js v24 File System API](https://nodejs.org/docs/latest-v24.x/api/fs.html) and [Crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html); no persistence dependency was added.

The state schema has exact keys and bounded values: objective/task are each limited to 500 Unicode code points; decisions, constraints, and issues allow up to 20 entries of 500 code points each; automatic request and response excerpts are limited to 512 and 1,536 code points; and the UTF-8 document limit is 32 KiB. Directories are created with mode 0700 and files with mode 0600 where supported. Reads reject symlinks where `O_NOFOLLOW` is available, non-regular files, wrong ownership, oversized content, invalid UTF-8, malformed data, and unsupported versions. Existing ancestors are resolved to keep storage outside the project. Saves validate the current document, write and sync a unique exclusive temporary file in the same directory, then atomically rename it. Normal saves refuse corrupt or future-version state; explicit clear is the recovery/reset operation. Simultaneous processes produce complete atomic files with last-writer-wins semantics; there is no cross-process lock.

These permissions and path checks protect against accidental exposure and corruption, not other processes running as the same user. Memory is sensitive local data; it is not a credential store. Automatic excerpts are verbatim and are not reliably secret-redacted. Startup discloses whether automatic summaries are enabled; `/memory help` explains their limits and controls. `/memory` supports show/help, objective/task editing, adding/removing decisions/constraints/issues, automatic-summary on/off, and selected or complete clearing. Corrupt or unsupported state leaves prompts available without memory, reports the condition, and blocks edits until explicit reset. Persistence warnings do not fail prompts, and failed edits do not alter the displayed state.

`src/harness/context-builder.ts` assembles at most 4,096 Unicode code points of labeled background context from objective/task, manually authored lists, the immediately preceding developer-request excerpt, and bounded live Git branch/path state. Entries and repository paths are single-line JSON data; paths are limited to 12 entries of 120 code points each. The prior assistant-response excerpt is retained for `/memory show` only and is excluded from future model prompts. Git diffs and line counts are not duplicated. The current developer request follows in its own section verbatim. The REPL displays exact context/request code-point counts before execution; dropped-prompt retry reuses the same assembled prompt and the existing runner still creates and deletes a fresh OpenCode session per prompt. After final Git capture, only an answered turn replaces the stored request/response excerpts. Other outcomes preserve the previous excerpts; a failed summary write warns without changing the prompt result.

Verification recorded for this milestone: 552 tests across 29 files pass, as do `npm run typecheck`, `npm run build`, and `git diff --check`. The developer confirmed the disposable-project terminal check and Linux filesystem validation passed; exact manual output and Linux distribution/version were not recorded. This Linux storage validation does not change the separate Milestone 4 native-reader QA status above.

### Execution History (Milestone 6, implemented 2026-10-07)

`src/harness/repl.ts` begins one history record after the baseline Git snapshot and context assembly, before submitting a prompt. Initial Quoder/OpenCode startup occurs before the developer can submit a prompt, so startup failure creates no execution record. If a server must be started or replaced after the record begins and that startup fails, the run finalizes as `failed` with `failureStage: "server-start"`. A dropped admitted prompt retried in a fresh OpenCode session remains one Quoder record and increments `attempts`. Normal cancellation, permission rejection, question rejection, failure, and answered outcomes finalize the same record after the final Git comparison. A process interruption before finalization leaves its last valid `in-progress` record; list and detail label this “in progress / possibly interrupted” because another Quoder process may still own it.

The version-1 record in `src/harness/execution-history.ts` contains a 32-character lowercase random ID, timestamps and duration, project name/canonical root, starting branch and HEAD, model provider/ID, nullable agent, exact developer prompt and injected context, compact permission decisions (action, resource count, selected reply and reply success), exact Bash command strings/statuses, tool names/statuses, observed file changes, final response, outcome, retry-attempt count, and optional server-start failure stage. It omits credentials, OpenCode session IDs, tool stdout/stderr, full tool inputs/outputs, and SDK/event payloads. Milestone 6 left agent nullable because selection was not yet supported; Milestone 7 records the selected agent for new runs. Git changes retain Milestone 4 endpoint-observation semantics and do not establish authorship.

The store uses Node filesystem/path/crypto APIs; no persistence dependency was added. It stores each project's records outside the target repository under `$XDG_STATE_HOME/quoder/history/<sha256-project-root>` when `XDG_STATE_HOME` is absolute. Otherwise it uses `~/Library/Application Support/Quoder/history/<sha256-project-root>` on macOS and `~/.local/state/quoder/history/<sha256-project-root>` on other supported POSIX systems. The default maximum is 100 completed records per project, configurable from 1 through 1,000; the list shows ten newest metadata-only summaries. In-progress records do not count toward retention. Concurrent completions may temporarily exceed the selected cap; finalization prunes oldest completed records.

Directories use mode 0700 and records/settings use mode 0600 where supported. Reads validate ownership, regular-file type, symlink/path safety, exact schema/version, UTF-8, and a 32 MiB serialized-record limit. New IDs use exclusive creation with collision retry. Finalization writes and syncs a unique same-directory temporary file before publishing the terminal record; start-time ordering is preserved. Explicit deletion uses tombstones to prevent concurrent finalization from restoring a record. Temporary files older than 24 hours may be removed. These controls protect against accidental exposure and cross-user access; they do not isolate history from same-user processes. Prompts, context, commands, responses, and paths are verbatim and are not reliably secret-redacted. Startup and `/history help` disclose that sensitivity.

`/history`, `/history <id>`, `/history help`, `/history retention`, `/history retention <count>`, `/history clear <id>`, and `/history clear all` are local commands in both TTY and piped input modes and never create OpenCode sessions. Lists do not read prompt/response bodies; detail sanitizes terminal output and labels multiline fields. A valid retention-setting command is the recovery path for malformed retention settings. Storage failures produce sanitized operation/reason warnings and do not change prompt outcomes.

Group 8 automated verification passed on 2026-10-07: 30 test files / 580 tests, typecheck, and the focused history/lifecycle suite (4 files / 145 tests). A user-run disposable-project process-termination/relaunch check then confirmed that the same run remained visible as `in progress / possibly interrupted`; see `.cmd/specs/2026-10-07-milestone-6-execution-history/qa.md`. No live prompt output or credentials were used as fixtures.

### Project Directory / Location

Core V2 session creation uses a location, not the legacy client's directory query:

```ts
client.v2.session.create({
  id?: string,
  agent?: string,
  model?: ModelRef,
  location?: LocationRef,
});
```

Source: `Session3.create` and `V2SessionCreateData` in the local generated 1.18.33 declarations. Group 2 must compile the precise `LocationRef` construction. Do not substitute `client.session.create({ directory })` and claim Core V2 behavior.

### Session Creation

`client.v2.session.create(...)` uses `POST /api/session` and returns `{ data: SessionV2Info }`.

Sources: `Session3.create` and `V2SessionCreateData`/`V2SessionCreateResponses` in the local generated 1.18.33 declarations.

### Prompt Submission

```ts
client.v2.session.prompt({
  sessionID: string,
  id?: string,
  prompt?: PromptInput,
  delivery?: "steer" | "queue",
  resume?: boolean,
});
```

Wire contract: `POST /api/session/{sessionID}/prompt` returns `{ data: SessionInputAdmitted }`. This admits input and schedules execution; it is not a final response.

Sources: `Session3.prompt` and `V2SessionPromptData`/responses in the local declarations.

### Streaming

```ts
client.v2.session.events({
  sessionID: string,
  after?: string,
}): Promise<ServerSentEventsResult<V2SessionEventsResponses>>;
```

Wire contract: `GET /api/session/{sessionID}/event`. It replays durable events after the aggregate sequence and continues with new events.

Source: `Session3.events` and `V2SessionEventsData` in the local declarations. The broader generated event union includes permission, session, message, and tool lifecycle events, but implementation must narrow against the actual V2 per-session response union rather than assume all global/legacy events appear there.

**Runtime item shape (verified live 2026-10-02/03).** The generated type declares each item as `{ id, event, data: string }`, but at runtime the 1.18.33 SDK yields parsed events `{ id, type, durable, data }`, with `data` as the payload object. Treat the parsed form as authoritative (`sessionStreamEvent`), and accept the declared string form only when it parses to an event. A consumer that `JSON.parse`s `data` never matches; this caused the 2026-10-02 authoritative run's first 120 s stall.

**Live display events on the global stream (verified 2026-10-03, `glm-4.7-flash:latest`).** The run-long global subscription (`client.v2.event.subscribe`) delivers every `session.next.*` display event for a session. Items have the parsed shape `{type, data}`, with `data.sessionID`. The events are:
- `step.started` and `step.ended` (with `tokens` and `finish`);
- `text.started`, `text.delta` (`textID`, `delta`, about 5 characters each, about 75 per second) and `text.ended` (full `text`);
- `tool.input.started`, `.delta` and `.ended`;
- `tool.called` (`callID`, `tool`, `input`);
- `tool.success` (`structured`, `content`, `outputPaths`) and `tool.failed` (`error: {type, message}`).

Every display event arrived before the session left `active`. glm via `ollama` emits no `reasoning.*` events.

One step may issue several tool calls in parallel: every `tool.called` comes before any result, and the step's `text.ended` can follow the calls. Verified tool shapes (`input` → `structured`):
- `read` `{path}` → `{uri, name, content, encoding, mime}`
- `grep` `{pattern, path?}` → `{value: [...]}`
- `glob` `{pattern}` → `{value: [{path, type}]}`
- `bash` `{command, timeout?, description?}` → `{exit, truncated}`, with output in `content[].text`. A non-zero exit is still `tool.success`.
- `edit` `{path, oldString, newString, replaceAll?}` → `{files: [{file, patch, additions, deletions, status}], replacements}`
- `write` `{path, content}` → `{operation, target, resource, existed}`

**Session directory must be canonical.** If a session's `directory` differs textually from the server's resolved cwd (for example, `/var/folders/…` versus `/private/var/folders/…` on macOS), the first prompt on a fresh server is admitted and then silently dropped: the session goes idle with no assistant message and no error (reproduced 3 of 3). Pass the `realpath` of the project root both as the server cwd and as the session directory.

### Permission Request

Core V2 uses ordered `permissions` rules with `action`, `resource`, and `effect`. Official V2 documentation states that an unmatched permission defaults to `ask`; the base policy also asks for external-directory and `.env` access.

Deterministic, model-independent trigger:

```ts
client.v2.session.permission.create({
  sessionID,
  action: "external_directory",
  resources: [canonicalHarmlessPathOutsideDisposableRepository],
  save: [],
  agent,
});
```

Source: `Permission2.create` and route `POST /api/session/{sessionID}/permission` in the local declarations, plus the official V2 permissions defaults. The path must be purpose-created under the spike's temporary root. The probe must observe the real OpenCode pending request/event; a test double is not live evidence.

Verified live against 1.18.33 on 2026-10-02, with no model call. `create` returned HTTP 200 with `{ id, effect: "ask" }` in about 0.8 s and **does not block** until a reply arrives. The global event stream (`client.v2.event.subscribe`) delivered `permission.v2.asked` with the same `id`, `action`, and `resources`. Permission events carry **no durable sequence** and cannot be replayed, and the SDK's SSE subscription connects on its first read. A consumer must therefore already be connected before the event is published. The original probe subscribed per stage and read only after dispatching `create`. That race, first accepted as a residual risk, occurred in the 2026-10-03 authoritative run and failed Permission handling. The live probe now observes `permission.v2.asked` through its **run-long event monitor**: one global subscription opened at run start and connected for the whole run. It records asked permissions for the probe's own sessions, even when they arrive before `create` returns. The permission stage waits, within the operation bound, for the recorded event with exactly the created request's ID, then replies `once`. Before any session exists, the monitor waits up to 10 s for the server's `server.connected` frame. That frame is verified live as the first frame of every v2 global subscription, arriving within milliseconds. If it does not arrive, the monitor journals `event.monitor.unconfirmed` and the run continues.

QA (2026-10-03, real server, no model calls, every request answered `reject`) compared the two designs over 27 permission creates:

| Design | Events observed |
| --- | --- |
| Pre-connected monitor (current) | 27/27 |
| Late first read after `create` (former) | 0/27 |

On a warm server, `create` returns in about 2.5 ms and the event follows about 0.1 ms later. A late reader connects 1–8 ms after `create`, by which time the event is gone.

### Interactive Questions

The 1.18.33 `build` agent allows the model's `question` tool. A call raises `question.v2.asked` on the global stream (it is not a permission request) and stays `running` until answered, so an unattended session never goes idle. This caused the 2026-10-02 run's second 120 s stall.

- `OPENCODE_CONFIG_CONTENT={"permission":{"question":"deny"}}` in the server process does **not** prevent the block (verified live 2026-10-03).
- `client.v2.session.question.reject({ sessionID, requestID })` returns 204, followed by `question.v2.rejected`. The question tool call fails and the turn ends with the session idle. The live probe's run-long event monitor rejects questions raised by its own sessions only. Rejecting a question is not a permission decision; `external_directory` still asks.

### Rejected Requests And Interrupted Turns (verified 2026-10-03, `glm-4.7-flash:latest`)

| Situation | Events | Final assistant message |
| --- | --- | --- |
| `permission.v2.asked` replied `reject` (here `external_directory`; event keys `{id, sessionID, action, resources, save, source}`) | `tool.called` → `tool.failed`; idle about 0.2 s later; no `step.ended` | Incomplete: no `finish`, no `time.completed`, a `tool:error` part |
| `question.v2.asked` (`{id, sessionID, questions: [{question, header, options: [{label, description}]}], tool}`) rejected | `tool.called(question)` → `tool.failed`; idle | Incomplete, with a `tool:error` part |
| `interrupt` during plain text generation | `step.failed`; idle within about 11 ms | `finish: "error"`, `time.completed` set, `error: { message: "Provider turn interrupted" }` |

In every case the session becomes idle with an assistant message in the turn, but there is no successful final response. A client must report why the turn ended instead of treating the empty result as an answer.

### Permission Response

```ts
client.v2.session.permission.reply({
  sessionID: string,
  requestID: string,
  reply?: PermissionV2Reply,
  message?: string,
});
```

Wire contract: `POST /api/session/{sessionID}/permission/{requestID}/reply`, returning HTTP 204.

Sources: `Permission2.reply` and `V2SessionPermissionReplyData`/responses in the local declarations. The Milestone 0/1 probe uses one-time approval. Verified live on 2026-10-02: `reply: "once"` returned HTTP 204, followed by a `permission.v2.replied` event (`reply=once`). Milestone 3 must separately verify before offering persistent approval.

### Milestone 3 Security Prerequisites (research, 2026-10-04)

These are verified findings from the pinned SDK declarations, current harness code, and the Milestone 1 research record. They document the implementation starting point; they do not mean Milestone 3 security hardening is complete.

- The pinned `PermissionV2Reply` declaration is `"once" | "always" | "reject"`. `Permission2.reply` takes `sessionID`, `requestID`, optional `reply`, and optional `message`; the wire route is `POST /api/session/{sessionID}/permission/{requestID}/reply`. The declaration also gives `Permission2.create` a `save?: string[]` field. Source: `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` and `sdk.gen.d.ts` in SDK 1.18.33.
- The pinned executable bundle implements `PermissionV2.reply`: `reject` fails the pending request; `once` resolves only that request; `always` with a nonempty `request.save` inserts one saved permission per save pattern using the current OpenCode project ID and the request action, then resolves the request. The permission evaluator loads saved permissions for that same project ID and merges them as allow rules. Evidence: readable bundled source in `node_modules/opencode-ai/bin/opencode.exe` for `opencode-ai@1.18.33` (`PermissionSaved.add/list` and `PermissionV2.configured/ask/assert/reply`); generated types alone do not show this behavior.
- Therefore, “Allow for project” can only accurately mean “send `always` for this request, saving OpenCode's `request.save` patterns for this action and project.” The UI must show those patterns and must not offer this choice when `save` is empty. It must not imply that persistence is limited to the request's `resources` unless those sets are equal. The sibling-request auto-allow logic is also native OpenCode behavior when saved rules cover their resources.
- `PermissionSavedInfo` declares `id`, `projectID`, `action`, and `resource`; the generated list accepts a `projectID` query, and the generated remove endpoint deletes by saved-record ID. The runtime source stores saved rows in OpenCode's permission table, keyed by project ID, action, and resource. Project scoping and persistence are confirmed at pinned-bundle source level and by the no-model runtime checks in `npm run verify:permissions`, which exercise saved-pattern creation, project A/B isolation, and revocation.
- Legacy shell hook behavior does not apply to the Core V2 Bash path used by Quoder. The pinned `packages/core/src/tool/bash.ts` implementation explicitly has a TODO to add plugin `shell.env` augmentation and invokes its child process without that hook. The runtime probe confirmed `OPENCODE_SERVER_PASSWORD` and `OPENCODE_CONFIG_CONTENT` remain nonempty. The function-level hook test proves only the hook's transformation if invoked; it is not isolation evidence. `OPENCODE_PURE` is removed from Quoder's owned server environment, but this does not fix the Core V2 gap. As restated on 2026-10-06, this remains defense-in-depth hardening and does not gate interactive permission prompts; the accepted risk and user-facing disclosure are recorded in the active Milestone 3 decision.
- `SessionV2Info` declares optional `parentID`; generated global session-created/updated events carry session information. The harness now registers child sessions with their owning execution before routing permission/question events. The event-ordering and ownership tests cover the implemented strategy; see `tests/unit/event-monitor.test.ts` and `tests/unit/session-runner.test.ts`.
- `src/harness/project.ts` canonicalizes the launch directory and Git root, accepting the Git root only when it contains the canonical launch directory and otherwise using a safe launch-directory fallback. Ordinary repository and symlink cases are covered. The specifically adversarial `.git/config` `core.worktree` regression remains an optional QA follow-up.
- `OpenCodeAdapter.replyPermission` requires an explicit reply value; it does not supply an implicit `"once"` or `"always"`. Project labels and root paths displayed by the REPL are sanitized before styling.

### Cancellation

Core V2 calls cancellation `interrupt`:

```ts
client.v2.session.interrupt({ sessionID: string });
```

Wire contract: `POST /api/session/{sessionID}/interrupt`. It interrupts execution owned by the current OpenCode process; idle interruption is a no-op.

Version-specific ordering and pass predicate, verified live against 1.18.33 on 2026-10-02:

1. Observe the durable `session.next.tool.called` event whose `tool` is `bash` and whose `input.command` contains the fixture's random token; record its `callID`. The fixture's PID file confirms the process started. OpenCode 1.18.33 emits no `session.next.shell.started` event for model-run commands, and the bash call did not raise a permission request under the default policy.
2. Call `client.v2.session.interrupt({ sessionID })` and require success.
3. Observe the durable `session.next.tool.failed` event for the same `callID` after the interrupt (live error: `Tool execution interrupted`). `session.next.step.ended` was observed next, but it is not required. Durable sequences are dense per session, and the interrupt request is not an event, so it is placed strictly between the last durable event read before it and the next one. A `tool.failed` at N+1 directly after the fixture's `tool.called` at N is therefore post-interrupt. Its `timestamp` must not precede the local interrupt request, because events queued before the interrupt can be read after it. Then confirm idle by polling `GET /api/session/active` until the session is no longer listed. No `session.idle` event is emitted. Read the start and terminal events from one global stream with explicit `next()` calls: leaving a `for await` loop early closes the stream.
4. Confirm the fixture process is gone (OpenCode terminated it), that no `session.next.tool.success` exists for that `callID`, and that no fixture-completion marker exists.

Sources: `Session3.interrupt`, `Session3.active`, the corresponding generated wire types, and the 2026-10-02 bounded live diagnostic recorded in the reassessment spec's `decisions.md`. The declarations do not promise a distinct terminal `cancelled` event, so tests must not invent one.

### Final Result

Core V2 separates admission from completion:

- `client.v2.session.prompt(...)` returns `SessionInputAdmitted`.
- `client.v2.session.active()` (`GET /api/session/active`) returns a map keyed by the IDs of running sessions (`{ type: "running" }`).
- `client.v2.session.messages({ sessionID, order: "asc" })` retrieves projected messages oldest-first. **The default order is newest-first**, so correlation must request `asc`.
- `client.v2.session.message(...)` retrieves one projected message.
- `client.v2.session.history(...)` and `.events(...)` provide durable evidence. Streaming `session.next.text.delta` events carry no durable sequence.

**`client.v2.session.wait(...)` is not implemented in 1.18.33.** It is generated in the SDK, but the bundled server handler looks up the session and then always fails with `Session.OperationUnavailableError({ operation: "wait" })`, returned as HTTP 503 `ServiceUnavailableError` "Session wait is not available yet". `compact`, `shell`, and `skill` are stubbed the same way. Do not call `wait`.

Verified completion contract (live, 2026-10-02): after admission the session appears in `active` at once and emits durable `session.next.prompted`, `session.next.step.started`, `session.next.text.started`, `session.next.text.ended`, and `session.next.step.ended`, with tool events between steps. The session stays listed between steps and leaves `active` when the run finishes. `OpenCodeAdapter.waitUntilIdle` polls `active` within its finite deadline. For a prompt it also requires an assistant message after the admitted input in the ascending list, so a run that has not yet been scheduled cannot be mistaken for completion. In the 1.18.33 bundle, admission synchronously registers the run before the HTTP response, and the session stays registered until every step drains.

OpenCode 1.18.33 appends **one assistant message per model step**. When a step starts, the projector completes the previous assistant message and appends a new one. A turn that uses tools therefore holds several assistant messages, for example a tool-call step followed by a final text step. The final result is the turn's **last** assistant message: after the admitted input and before the next user input in the ascending list, with `time.completed` set (`finalAssistantResponseText`). Earlier step messages are intermediate and never the result. Prompt admission alone is not success.

Sources: the corresponding `Session3` signatures and V2 wire types in the local declarations, inspection of the 1.18.33 server bundle, and the bounded live diagnostics recorded in the reassessment spec's `decisions.md`. Re-verify on every OpenCode upgrade, and switch to a native `wait` when one is implemented.

### Session Deletion — Verified Compatibility Bridge

Core V2 1.18.33 has no native generated session-deletion method, but the bundled legacy deletion endpoint is verified against a Core V2-created session for this exact version pair.

`client.v2.session` exposes list, create, active, get, switch, prompt, compact, wait, context, history, events, interrupt, messages, revert, permission, and question operations. It exposes no `delete` method, and generated Core V2 types contain no `DELETE /api/session/{sessionID}` operation.

The same package exposes:

```ts
client.session.delete({ sessionID, directory?, workspace? });
```

on `DELETE /session/{sessionID}`.

Live compatibility evidence on 2026-09-29, using an isolated temporary XDG data/config/state root and the project-local CLI/SDK pair:

1. `client.v2.session.create({ agent: "build" })` created `ses_f119a3330ffe2zY5QMJPk5V7Af`.
2. `client.v2.session.get(...)` returned HTTP 200.
3. `client.session.delete(...)` returned HTTP 200 and `true`.
4. A second `client.v2.session.get(...)` returned HTTP 404 with `SessionNotFoundError`.

Sources: the live check above; manual inspection of `Session3`, every Core V2 `/api/session/{sessionID}` route, legacy `Session2.delete`, and `SessionDeleteData` in the local declarations. Official legacy server documentation also lists the deletion endpoint.

For `1.18.33`, the adapter may use this compatibility bridge, but it must keep deletion behind one adapter method and assert the post-delete Core V2 lookup returns 404. Re-verify on every OpenCode upgrade and replace it with a native Core V2 delete method when one becomes available.

### Session Creation Payload Caveat

Although `Session3.create(parameters?)` is generated with an optional parameter, live calls with no argument or `{}` produced `InvalidRequestError: Expected object, got undefined` because the empty body was omitted. Supplying `{ agent: "build" }` succeeded. Group 2 must always send a non-empty creation payload and cover this 1.18.33 behavior in tests.

## Quoder Harness (Milestone 1)

Implemented in spec `2026-10-03-milestone-1-minimal-harness`; QA recorded `Milestone 1 Exit Criterion: MET` on 2026-10-03.

**Shared OpenCode modules (NFR-1).**
- `src/package-root.ts` resolves Quoder's own package root from the module's location (the nearest `package.json` named `quoder`), so the pinned `node_modules/.bin/opencode` and manifests never depend on `process.cwd()`.
- `src/opencode-server.ts` is the authenticated launcher. It takes an optional `cwd` and exposes an optional `exited` promise.
- `src/event-monitor.ts` is the run-long global-event monitor, with an own-session predicate, question, permission and end callbacks, and `confirmed`. The Milestone 0 probe and the preflight use these same modules.

**Harness modules.**
- `src/harness/project.ts`: the Git root, or the launch directory.
- `src/harness/session-runner.ts`: one prompt, one session.
- `src/harness/repl.ts`: the lifecycle.
- `src/harness/format.ts` and `src/harness/terminal-text.ts`: output and sanitizing.
- `src/cli.ts`: the `quoder` entry point. `npm run build` builds it to `dist/cli.js`.

**Lifecycle contracts.**
- **Server.** One server is launched per harness session, with the project root as its working directory, and is confirmed through `server.connected` before use. An unconfirmed monitor fails the start. A server is replaced before the next prompt after an unexpected exit, monitor loss, or a failed reject reply.
- **Prompt.** Create a session bound to the model and project root, submit, and wait with **no fixed execution timeout**. Every API call is bounded at 30 s. An idle session with no assistant message for 5 s counts as **dropped** (Milestone 2 QA: OpenCode 1.18.33 intermittently drops the first prompt on a fresh server). The session is deleted and verified, and the prompt is sent once more in a fresh session. There is no retry after a cancel, or when the deletion was unverified. A second drop fails. Classify the turn as answered, permission rejected, question rejected, cancelled, or failed. Interrupt and settle whenever the turn did not end idle, then delete and verify (404). Session IDs whose deletion is unverified are retried on the next server and at shutdown.
- **Input.** One sequential loop consumes lines in order. EOF, `/exit`, and signals reach one memoized shutdown. An exit request during startup aborts the in-progress launch only; a server that is already up is never killed before session cleanup.
- **Policy.** Milestone 1 never grants a permission: every `permission.v2.asked` for a Quoder session is replied `reject` and reported, and questions are rejected and shown. Requests raised by subagent (`task`) child sessions are not intercepted. Nothing is granted, but the turn may wait until Ctrl-C (recorded for Milestone 3).
- **Trace.** `QUODER_TRACE_FILE` appends JSON lines containing fixed event names, session IDs, verified flags, outcome kinds and tool names only, never prompt or model text. Milestone 2 added `prompt.started`, `prompt.retried`, `stream.first-text` and `activity.tool`. `npm run verify:harness` relies on it.

## Live Activity (Milestone 2)

Implemented in spec `2026-10-03-milestone-2-streaming-ui`. The general review passed at cycle 4 and the security review at cycle 7. QA recorded `Milestone 2 Exit Criterion: MET` on 2026-10-04, and the developer accepted the manual terminal check. The streaming event contract (global stream coverage and tool shapes) is recorded under **Streaming** above.

**Modules.**
- `src/harness/stream-events.ts` narrows untrusted `session.next.*` payloads into a typed `StreamEvent` union. It has no presentation, so a future full-screen TUI can reuse it.
- `src/harness/activity.ts` holds the one-line tool summaries: sanitized, truncated, and paths relative to the project.
- `src/harness/live-view.ts` (`LiveView`) contains:
  - the TTY status line, redrawn by a 10 Hz ticker, truncated by display columns and erased before permanent output;
  - Markdown streaming per text block;
  - the idle flush;
  - a line per tool when it finishes;
  - reconciliation of the final step's streamed text with the authoritative answer, which is printed in full if it was missed.
- `src/harness/format.ts` writes the closing status line.
- `src/harness/line-keys.ts` (`LineEndingKeys`) handles keyboard input.
- `src/ui/style.ts` provides theme roles and colour detection.
- `src/ui/markdown.ts`, `src/ui/highlight.ts` and `src/ui/isolated-render.ts` (with `render-worker.ts` and `render-protocol.ts`) handle rendering.

**Event source.** The run-long global monitor forwards own-session `session.next.*` events (`onSessionEvent`). Streaming is display-only: completion and final-answer selection remain the session runner's job.

**Rendering untrusted Markdown.**
- `marked` is used only as a lexer. Model text is sanitized before lexing, and every string in the token tree is sanitized again after it, because the lexer decodes references such as `&#27;`.
- Blocks are printed as they complete, using a line-based scan:
  - a blank line, a closing fence, or a heading or rule line ends a block;
  - list items with indented content stay together;
  - an idle flush never splits a table, a setext heading or the open list item.
- Each chunk is rendered in a worker thread (`IsolatedMarkdownRenderer`). It has:
  - a 200 ms `Atomics.wait` deadline per chunk;
  - a 1 s budget per stream;
  - a 256 MB heap limit.

  On a timeout, worker death or error, the chunk is shown as sanitized plain text and the worker is replaced. Inside the worker, `RENDER_BUDGET`, nesting caps and a highlighting budget are cheaper first filters.
- Main-thread text handling is linear, and was checked by fuzzing.

**Keyboard and terminal modes.** In interactive mode Quoder writes `CSI > 1 u` (the kitty keyboard protocol's disambiguate flag) and `CSI ? 2004 h` (bracketed paste) at startup. It reverses both at shutdown and from a process-exit hook. `LineEndingKeys`:
- decodes kitty-encoded keys back to legacy bytes for readline;
- marks continuations (Shift/Alt/Ctrl+Return, Ctrl+J, and line breaks inside a paste) with a Ctrl+G mark that the harness classifies per keypress;
- holds split escape sequences;
- ends a paste whose end marker is late or lost after 500 ms;
- passes only Ctrl+C and Ctrl+D while a prompt runs.

Raw mode is owned by the harness, and Ctrl+Z does not suspend.

**Process safety.** Output errors (EPIPE) end Quoder through the orderly shutdown with exit code 141. The launcher's process-exit hook sends SIGTERM to a live server child.

## Dependency Choices

Group 3 verification commands:

```bash
npm run typecheck
npm test
```

Approved exact Group 2 development dependencies:

```bash
npm install --save-dev --save-exact \
  typescript@7.0.2 \
  vitest@5.0.2 \
  @types/node@24.12.2
```

Runtime dependencies are pinned exactly in `package.json`: `@opencode-ai/sdk@1.18.33` and `opencode-ai@1.18.33`. Do not use a global CLI or the transitive SDK under `~/.config/opencode`.

Milestone 2 presentation dependencies (spec `2026-10-03-milestone-2-streaming-ui`). Both are exact-pinned and have no dependencies or install scripts of their own:

```bash
npm install --save-exact marked@18.0.14 highlight.js@11.12.0
```

- `marked` 18.0.14 (MIT) is used only as a Markdown lexer. Quoder renders tokens itself.
- `highlight.js` 11.12.0 (BSD-3-Clause) highlights code blocks for a fixed set of registered languages.
- Colour uses Node's built-in `util.styleText` with `validateStream: false`. `src/ui/style.ts` decides colour once, from TTY, `TERM`, `NO_COLOR`, `FORCE_COLOR` and `--no-color`.
- `marked-terminal` and `shiki` were rejected: they pull in many transitive packages or WebAssembly.

## Contracts And Integrations

- OpenCode remains the permission-enforcement and execution engine.
- Use Core V2 methods only for Core V2 capability claims.
- Use the project-local CLI/SDK pair at `1.18.33`.
- Use a purpose-created disposable repository and harmless temporary path.
- Never emit authorization headers or provider credentials into reports, logs, tests, or fixtures.

## Environment Notes

- Local CLI invocation: `npx --no-install opencode`.
- The user-level OpenCode config has no explicit permission policy. Under it, the `external_directory` trigger returned `effect: "ask"` live on 2026-10-02. A model-run `bash` command and the `glob` tool executed without a permission request.
- **Milestone 3 verification scope:** OpenCode 1.18.33 Core V2 Bash launches child processes without calling plugin `shell.env` hooks (pinned source TODO at `packages/core/src/tool/bash.ts`). The disposable tool-shell probe confirmed `OPENCODE_SERVER_PASSWORD` and `OPENCODE_CONFIG_CONTENT` were nonempty. The shell hook's unit test does not validate this runtime boundary. Credential isolation is not established on the harness path; per the 2026-10-06 requirement restatement, this is defense-in-depth follow-up rather than a gate on interactive permission prompts. The CLI prompts are enabled and disclose that model-run tools are unconfined.
- The provider configuration contains an inline authorization credential. It is not reproduced here. Rotate it and move it to an environment/secret mechanism before capturing live probe logs.
- A sandbox may require localhost-bind permission and writable XDG data/state directories; that is an execution-environment concern, not an OpenCode API limitation.

## Live Verification Diagnostics

`npm run verify:live` records timestamped lifecycle and scenario-stage transitions in
`.live-build/verify-live.journal.jsonl` and mirrors the same entries to stderr. The journal is
rewritten for each invocation, is gitignored with the rest of `.live-build`, and deliberately
contains only fixed stage names—never authorization headers, credentials, model content, or raw
server diagnostics.

The complete live run has a default 600,000 ms deadline. Override it only when diagnosing a
specific environment:

```bash
QUODER_LIVE_TIMEOUT_MS=300000 \
QUODER_LIVE_JOURNAL_PATH=/tmp/quoder-live.journal.jsonl \
npm run verify:live
```

On deadline expiry, the verifier records `stage.run.timeout`, closes any available driver,
attempts normal disposable-environment cleanup, prints a conservative nine-capability FAIL
report, and exits nonzero.

## Milestone 0 Live Result

QA Cycle 2 ran the authoritative `npm run verify:live` command on 2026-09-30
with the following environment:

| Component | Tested value |
| --- | --- |
| Platform | macOS 26.7 (Build 25G229), arm64 |
| Node | `v24.18.1` |
| npm | `12.0.2` |
| OpenCode CLI | project-local `opencode-ai@1.18.33` |
| OpenCode SDK | project-local `@opencode-ai/sdk@1.18.33` |
| Ollama service | Unavailable immediately before the run |

The command exited `1` after 120.9 seconds. It created the disposable
environment, launched and authenticated the project-local OpenCode server, and
created the first Core V2 session. The initial prompt did not complete before
its 120-second operation timeout. The journal then recorded session cleanup,
driver close, environment removal, and the nonzero process exit. Post-run
inspection found no residual verifier, OpenCode server, cancellation fixture,
or generated temporary repository.

Authoritative command:

```bash
npm run verify:live
```

Observed capability matrix:

| Capability | Result | Evidence limitation |
| --- | --- | --- |
| Fresh session creation | FAIL | One Core V2 session was created; the second unique session was not reached. |
| Project directory | FAIL | No completed model file activity proved repository confinement. |
| Local model invocation | FAIL | The initial prompt timed out while the Ollama service was unavailable. |
| Streaming events | FAIL | No qualifying structured execution event was observed before timeout. |
| Permission handling | FAIL | The Core V2 permission request/reply stage was not reached. |
| File modification | FAIL | No verified `hello.txt` containing `Hello from OpenCode` was produced. |
| Cancellation | FAIL | Fixture start, interrupt, idle, termination, and no-late-completion validation were not reached. |
| Session deletion | FAIL | Cleanup completed, but normal deletion of both required sessions plus Core V2 404 checks was not proven. |
| Session isolation | FAIL | The second session and exact `NO_PRIOR_SESSION` exchange were not reached. |

**Capability Verdict: FAIL.** The nine predicates are conjunctive and remain
failed when their complete live evidence is absent. Most predicates were not
reached; this result must not be interpreted as proof that their underlying SDK
operations inherently fail.

**QA Verdict: PASS.** The validation mechanism ran reliably, terminated in
finite time, retained an auditable stage record, emitted the complete matrix,
and cleaned up. This validates the quality of the negative result, not the
feasibility of Quoder's disposable-session architecture.

Milestone 0 did not pass and Milestone 1 remains blocked. Before another live
feasibility attempt, restore and preflight the required Ollama/model service or
reassess the architecture and its environment dependency in a separate spec.
Passing unit tests and `npm run verify:live:smoke` do not substitute for this
live evidence.

## Milestone 0 Live Result — 2026-10-03 authoritative PASS

After the `2026-10-03-permission-event-race` fix and `Authoritative Run: GO`,
the user authorized a fresh preflight and the authoritative run.

- `npm run verify:environment`: all eight rows PASS, exit 0.
- `npm run verify:live` (journal times UTC): exit 0, with the scenario itself
  completing in about 5 s.

| Capability | Result |
| --- | --- |
| Fresh session creation | PASS |
| Project directory | PASS |
| Local model invocation | PASS |
| Streaming events | PASS |
| Permission handling | PASS |
| File modification | PASS |
| Cancellation | PASS |
| Session deletion | PASS |
| Session isolation | PASS |

**Capability Verdict: PASS. Milestone 0 is passed.**

- Stage timings: initial prompt 3.2 s; permission 13 ms (the run-long monitor
  had already recorded the event); cancellation 0.7 s; isolation 0.5 s.
- The journal contains no `.failed`, `not-passed`, `not-observed`,
  `not-completed`, `unconfirmed`, `skipped`, or `question.*` markers.
- Cleanup was complete: no residual OpenCode server, fixture, or temporary
  repository.

Tested environment: macOS 26.7 (arm64), Node `v24.18.1`, npm `12.0.2`,
project-local `opencode-ai@1.18.33` and `@opencode-ai/sdk@1.18.33`, model
`ollama/qwen3-coder:30b` via the remote authenticated OpenAI-compatible
endpoint, run from inside the user's LAN.

Historical Milestone 0 limitations carried into Milestone 1 (the credential-gating statement
below was superseded by the 2026-10-06 Milestone 3 requirement restatement):

- **Server credentials.** Model-run shell commands inherit the OpenCode
  server's credentials. At that time, this was treated as a prerequisite for
  forwarding permission decisions; the active Milestone 3 decision later
  changed that requirement to defense-in-depth hardening.
- **Model nondeterminism.** QA estimated about 0.7 joint cooperation per run
  for the scenario prompts.
- **Version-specific contracts.** The `wait` stub, the stream shape, and the
  question tool are specific to OpenCode 1.18.33 and must be re-verified on
  every upgrade.

## Milestone 0 Live Result — 2026-10-03 run (8 of 9)

After the `2026-10-03-live-probe-reliability` fixes and a conditional
`Authoritative Run: GO`, the user authorized a fresh preflight and the
authoritative run.

- `npm run verify:environment`: all eight rows PASS, exit 0.
- `npm run verify:live`: exit 1 after 126 s.
  - **8 of 9 predicates PASS**: Fresh session creation, Project directory, Local
    model invocation, Streaming events, File modification, Cancellation, Session
    deletion, and Session isolation.
  - **Permission handling: FAIL.** Capability Verdict: FAIL. Milestone 0 is not
    passed, and Milestone 1 remains blocked.
  - Cleanup was complete, with no residual server, fixture, or temporary
    repository.
- Timeline: the initial prompt stage completed in 2.5 s. The `permission` stage
  ran from 10:44:34.264Z to 10:46:34.271Z, exactly the 120 s stream bound, and
  journaled `complete` with no `.failed` entry. `permission.create` therefore
  succeeded, but the stage's global subscription never observed
  `permission.v2.asked`. Cancellation and isolation then passed.
- Classification: this is the previously **accepted permission-event
  subscription race**, now observed. `permission.v2.asked` is not durable and
  cannot be replayed. The SDK's SSE subscription connects lazily on its first
  read, which happens only after `create` is dispatched. With a warm server, the
  event was evidently published before that subscription connected.

## Milestone 0 Live Result — 2026-10-02 run

After `Future Capability QA: GO`, the user authorized a fresh preflight and the
authoritative run.

- `npm run verify:environment`: all eight rows PASS, exit 0, about 5 s.
- `npm run verify:live`: exit 1 after 241 s.
  - All nine predicates FAIL. **Capability Verdict: FAIL.**
  - Milestone 0 is not passed, and Milestone 1 remains blocked.
  - The journal shows `session.initial.prompt.start` at 17:18:58.758Z and then
    nothing until `sessions.cleanup.start` at 17:22:58.766Z. That is exactly
    two 120 s operation timeouts in the initial-prompt stage. The run then
    raised an error, so every predicate failed conservatively.
  - Cleanup, driver close, and environment removal completed. No OpenCode
    server, fixture, or temporary repository remained.

Diagnosis so far:

- **First 120 s (identified).** The live probe parses each session-stream item
  with `JSON.parse(item.data)`, as the generated SDK type says
  (`{ id, event, data: string }`). At runtime the 1.18.33 SDK yields
  already-parsed event objects instead: `item.type`, `item.durable.seq`, and
  `item.data` as the payload object (observed in the 2026-10-02 completion
  diagnostic). The structured-event observation therefore never matched and
  ran until the 120 s stream timeout. The driver test's fake stream followed
  the generated type, so it did not catch this.
- **Second 120 s (identified by sampling).** Four bounded scratch diagnostics
  of the exact first prompt were run against the same model, outside the
  repository and without `verify:live`. In one of the four, the model called
  OpenCode's interactive **`question` tool**. The 1.18.33 `build` agent allows
  this tool, it raises no permission event, and it stays `running` until
  someone answers. The session therefore never becomes idle, and
  `waitUntilIdle` exhausts its 120 s, which matches the live run.
- **Model instruction-following (new risk).** In none of the four samples did
  the model create `hello.txt`. In three, it answered in plain text that was
  not the `TOKEN_STORED` sentinel (134–230 characters) and finished in about
  2 s. The fourth is the `question` case above. In the earlier cancellation
  diagnostic the same model did call `glob` and `bash`, so tool calling works,
  but this prompt does not reliably cause a file write. Local model invocation
  and File modification are therefore at risk even after the probe defects are
  fixed.
- The 1.18.33 default `build` policy, inspected in the bundle, is
  `"*": "allow"`, with exceptions: `external_directory` asks, `.env` reads ask,
  `doom_loop` asks, and plan transitions are denied. `question` is allowed for
  `build`. Writing a file inside the repository does not ask.

### Probe Prompts And Stage Isolation (spec 2026-10-03)

The scenario prompts were selected by sampling against `ollama/qwen3-coder:30b`, with question rejection active:

| Stage | Prompt | Samples |
| --- | --- | --- |
| Initial | Use the write tool to create `hello.txt` with exact content, remember the nonce, ask no questions, then reply exactly `TOKEN_STORED` | 5/5 |
| Cancellation | Run `` `node fixture.mjs <token>` `` and wait for it to finish; do not run it in the background; ask no questions | 9/10 |
| Isolation | Reply exactly `NO_PRIOR_SESSION` unless a prior nonce is known (then only the nonce); no tools; no questions | 5/5 |

The residual cancellation failure is the model emitting its tool call as plain text (`<function=bash> … </tool_call>`), so no command runs. A more directive "Use the bash tool to run exactly…" wording made this happen 5/5 times. The failure is conservative: Cancellation FAIL, finitely bounded.

QA (2026-10-03) independently re-sampled the prompts as implemented, importing them from the compiled module:

| Stage | QA samples |
| --- | --- |
| Initial | 9/11 |
| Cancellation | 13/15 |
| Isolation | 6/6 valid |

- The plain-text tool-call failure also appeared once in the initial stage.
- One cancellation turn ended with no tool call and no text.
- One initial sample called only `todowrite`.
- A short upstream outage returned HTTP 502 on inference while `/v1/models` still answered. The affected isolation samples were excluded. This is why the full preflight, which checks inference, must run immediately before an authoritative run.
- The estimated chance that all three model-dependent stages cooperate in a single run is about 0.7.

The live driver now runs each stage after session creation (initial prompt, permission, cancellation, isolation) in isolation:

- **Failures are journaled with a credential-safe cause.** A failed stage is journaled as `<stage>.failed.<adapter-operation>[.timeout]`, taken from the first adapter error found directly or through the `cause`/aggregated reasons of a paired-operation failure (for example `session.initial.prompt.failed.submit-prompt`). When no adapter error is involved (for example a permission-correlation mismatch), it is `<stage>.failed.error`. Error text is never journaled.
- **Not-passed outcomes are journaled too.** A stage that completes without its evidence journals a distinct marker: `session.initial.prompt.not-completed`, `permission.not-observed.timeout`, `permission.not-observed.monitor-ended`, or `cancellation.not-passed`.
- **The session is settled after every stage**, whether or not the stage threw: if it is still active, it is interrupted and waited to idle. Settling an idle session costs one status read.
- **Later independent stages still run**, so a single run reports evidence for every predicate.
- **Isolation needs the nonce.** It is skipped (`isolation.skipped`) when the first session never received the nonce.
- **A dropped event monitor is visible.** If the monitor's global stream ends before the run stops it, `event.monitor.ended` is journaled. Later questions would then block their stage until its timeout, and later asked permissions would go unobserved, so Permission handling FAILs within its bound.

No failure becomes a PASS:

- Project directory evidence now requires the model-produced `hello.txt`, read through the confined-path check, so it no longer passes on constant paths.
- Session deletion can PASS with a single session created and deleted (isolation skipped), because every created session is still verified by the delete-plus-404 check (PRD requirement 11). Fresh session creation and Session isolation then FAIL.

Residual risk: a run with several stalled stages can sum per-operation 120 s bounds past the 600 s whole-run deadline. The deadline still closes the server, cleans up, and fails all nine predicates conservatively, but per-predicate evidence for that run is lost.

## Remaining Live Verification Items

The environment reassessment (2026-10-02) verified each underlying mechanism
live against the pinned 1.18.33 server, in bounded scratch diagnostics:

- model completion through `session/active`, and ascending final-response
  correlation;
- the permission create/asked/reply round-trip;
- the interrupted-tool cancellation sequence;
- session deletion during cleanup.

None of these is capability evidence. All nine predicates above still have to
pass together in one explicitly authorized `npm run verify:live` run against
the configured model. That run additionally depends on the model following
instructions exactly:

- writing `hello.txt` and replying `TOKEN_STORED`;
- running the fixture once, in the foreground;
- replying `NO_PRIOR_SESSION` in the isolation session.

Run `npm run verify:environment` immediately beforehand. If Permission handling
fails, read the journal:

- `permission.failed.<operation>` means the create or reply request failed.
- `permission.not-observed.timeout` means the run-long monitor saw no matching
  `permission.v2.asked` within the bound.
- `permission.not-observed.monitor-ended` or `event.monitor.ended` means the
  monitor's subscription dropped.
- `event.monitor.unconfirmed` means the server never confirmed the monitor's
  subscription.

Re-verify the legacy-delete/Core-V2 compatibility bridge and the
`wait`/`active` contracts whenever OpenCode is upgraded.

## Environment Reassessment — Group 1 Diagnosis

Collected on 2026-09-30 (completed at `2026-09-30T23:10:43Z`) without changing
the service, models, user configuration, or pinned packages.

The active OpenCode configuration defines provider `ollama` through
`@ai-sdk/openai-compatible`, using a remote HTTPS OpenAI-compatible endpoint at
`llm.quackerjack.com/v1`. Authorization is supplied by an inline header; its
value was neither printed nor persisted. The provider declares six models,
including `qwen3-coder:30b`. Historical OpenCode state also identifies
`ollama/qwen3-coder:30b` as a previously selected model. Endpoint ownership and
the product's eventual default model remain decisions for Group 2; this group
tested the currently configured provider and model without treating localhost
Ollama availability as authoritative.

| Layer | Bound | Exit | Result | Evidence |
| --- | --- | --- | --- | --- |
| Versions | Command completion | 0 | PASS | Node `v24.18.1`, npm `12.0.2`, Ollama client `0.34.0`, `opencode-ai@1.18.33`, and `@opencode-ai/sdk@1.18.33`. The local Ollama client reported no localhost service, but localhost is not the configured provider endpoint. |
| Remote endpoint and model discovery | 10 seconds | 0 | PASS | Authenticated `GET /v1/models` returned HTTP 200 in 295 ms, reported seven models, and included `qwen3-coder:30b`. |
| Direct inference | 45 seconds | 0 | PASS | Authenticated `POST /v1/chat/completions` using `qwen3-coder:30b` returned HTTP 200 and exact `ENVIRONMENT_READY` in 16,370 ms. An earlier attempt was excluded as inconclusive because its command wrapper stopped capturing before the request's own deadline. |
| Project-local OpenCode discovery | Command completion | 0 | PASS | `npx --no-install opencode models ollama --pure` listed the configured models, including `ollama/qwen3-coder:30b`. |
| Project-local OpenCode inference | 45 seconds per adapter operation | 1 | FAIL | An authenticated disposable OpenCode server created a Core V2 session explicitly targeting `ollama/qwen3-coder:30b` and admitted the sentinel prompt, but `session.wait` returned HTTP 503 `ServiceUnavailableError`; total time was 1,548 ms. |
| Cleanup | Bounded adapter deletion and synchronous server close | 0 | PASS | The diagnostic deleted the session through the verified compatibility bridge, closed the server, removed the disposable repository, and completed cleanup in 1,679 ms. A post-run process check found no matching OpenCode server or diagnostic process. |

The first explicit-model attempt used the invalid field name `modelID` instead
of the verified Core V2 `ModelRef.id`; it failed session validation in 670 ms,
cleaned up in 676 ms, and is excluded from provider compatibility evidence.

Group 1/2 taxonomy classification (**superseded on 2026-10-02**, see "Reassessment
Outcome" below): **Integration incompatibility**. Equivalent
direct inference succeeds while the pinned project-local OpenCode integration
fails. This classification does not yet distinguish an OpenCode/provider
configuration mismatch from a defect or version incompatibility inside the
pinned integration boundary; Group 2 must make that architectural distinction.
The result is `Future Capability QA: NO-GO` until a reviewed correction and
deterministic preflight pass. No Milestone 0 capability changed to PASS.

Group 2 repeated the explicit-model OpenCode check in the unrestricted target
environment, ruling out sandbox networking as the cause: `session.wait` again
returned HTTP 503 in 1,775 ms and cleanup completed in 1,884 ms. A one-second
runner-registration delay produced the same 503 in 2,396 ms. A separate
30-second correlated-message poll observed no assistant response and cleaned up
in 31,864 ms. Explicit model binding is therefore necessary to eliminate the
prior ambient-default mismatch but is not sufficient to make the pinned
integration ready.

The approved smallest reversible correction is to bind model-executing sessions
to `{ providerID: "ollama", id: "qwen3-coder:30b" }` and add the layered
`npm run verify:environment` preflight. User provider configuration and exact
package pins remain unchanged because direct inference passes and no alternate
package version has verified compatibility evidence. Security review applies.

### Environment Preflight Implementation

Group 3 added `npm run verify:environment`. It reads only the approved provider
shape, validates both declared and installed OpenCode `1.18.33` pins, performs
bounded discovery and sentinel inference, launches an authenticated disposable
OpenCode server, and always emits these eight credential-safe rows in order:

1. `Pinned dependencies`
2. `Provider configuration`
3. `Endpoint reachability`
4. `Model discovery`
5. `Direct inference`
6. `OpenCode model discovery`
7. `OpenCode inference`
8. `Cleanup`

The command uses 10-second discovery deadlines, 60-second inference deadlines,
and a 180-second whole-run deadline. It exits zero only when all rows pass and
prints exactly one `Environment Readiness: PASS|FAIL` verdict. Diagnostics use
fixed evidence text; raw configuration, authorization values, model content,
and server diagnostics are not rendered.

The target-environment verification on 2026-09-30 produced PASS for every row
except `OpenCode inference`, so the command exited 1 with
`Environment Readiness: FAIL`.

### Reassessment Outcome

On 2026-10-02 the `OpenCode inference` failure was traced to Quoder's use of
Core V2, not to the provider, the model, or OpenCode's execution:

- `session.wait` is an unconditional 503 stub in 1.18.33. See "Final Result"
  for the bundle evidence and the replacement completion contract.
- The earlier 30-second poll most likely missed the reply because messages
  default to newest-first.
- Model execution itself completed in about 2 s.

After the corrections, the authenticated disposable OpenCode run returns the
exact sentinel. The real preflight passed all eight rows with exit 0 on every
run on 2026-10-02: QA Cycle 1 recorded 5 of 5 runs at about 5 s each, with no
residue. Seven synthetic failure-path runs used temporary configurations, each
exited 1 with the correct failing row, and all output was structurally free of
credentials.

The general review (Cycle 7), the security review (Cycle 1), and QA (Cycle 1)
all passed. The recommendation is **`Future Capability QA: GO`**. This does not
pass Milestone 0, does not authorize Milestone 1, and does not authorize
`npm run verify:live`, which requires explicit user authorization. The
capability verdict above remains FAIL until that run.

## Group 1 Verification Checklist

- [x] Package and runtime versions recorded with local evidence.
- [x] Import paths and hosting/client signatures recorded with 1.18.33 declaration paths.
- [x] Location, creation, prompt, streaming, permission, cancellation, and final-result contracts recorded with exact methods and sources.
- [x] Deterministic `ask` action identified from official V2 defaults and the real permission-create API.
- [x] Cancellation ordering documented without inventing a terminal event.
- [x] Native Core V2 deletion is absent, but the bundled legacy delete endpoint was verified to remove a Core V2-created session under 1.18.33; post-delete Core V2 lookup returned 404.

## Model-run tool sandbox (OpenCode 1.18.33, macOS)

Confirmed by running the pinned binary; the probe is `npm run verify:sandbox`.

- **The server password cannot be kept out of the server process.** Core V2 reads it only from the
  environment (`ServerAuth.Config` declares `password: Config.string("OPENCODE_SERVER_PASSWORD")`),
  and `opencode serve --help` exposes only `--port`, `--hostname`, `--mdns`, `--mdns-domain`,
  `--cors`, `--pure`, and logging flags. There is no file, descriptor, or socket delivery path, so
  hiding the credential is not achievable and the boundary must remove the capability to use it.
- **One debug-agent Bash invocation honours a configured `shell`.** A marker file confirmed the
  configured shell is executed in `opencode debug agent --tool bash`, both when supplied through
  `OPENCODE_CONFIG_CONTENT` and project config. This does not establish behavior for the Core V2
  session prompt path used by the harness; see the scope correction below. Project config has
  later precedence, so Quoder rejects a project `shell` before launch.
- **`opencode debug agent <name> --tool bash --params '{...}'` runs the Bash tool with no model.**
  This is the basis of the deterministic sandbox probe and replaces the earlier model prompt.
- **`opencode serve` performs no startup configuration validation.** Malformed
  `OPENCODE_CONFIG_CONTENT`, unknown keys, a wrong-typed `shell`, and a malformed project
  `opencode.jsonc` all start normally. A config that never took effect fails silently, so Quoder
  asserts the resolved configuration after startup by reading `GET /config`, which returns the
  resolved document including `shell` and `mcp`.
- **`--port=0` is not purely ephemeral.** It prefers 4096 and falls back to an ephemeral port when
  4096 is held. Concurrent servers on the same and on different projects start without conflict.

### Seatbelt rules that behave unexpectedly

Each of these caused a silent or fatal failure during implementation:

- **Paths must be realpath-resolved.** `(deny file-read* (subpath "/var/..."))` does not match the
  kernel's `/private/var/...`; the denial is lost with no error and the file is readable.
- **`env -i` is fatal under `(deny process-info*)`** — SIGTRAP, exit 133, during loader startup.
  Use `env -u NAME` per variable instead.
- **`(deny network-inbound ...)` breaks DNS**, because the resolver binds a local socket
  (`bind: Operation not permitted`). Deny only outbound loopback.
- **`(deny process-info*)` alone breaks HTTPS.** It must be followed by
  `(allow process-info* (target self))`.
- **A sandboxed process cannot relax its profile**: a nested `sandbox-exec` with `(allow default)`
  fails with `sandbox_apply: Operation not permitted`.
- **Seatbelt refuses to exec setuid binaries under any profile**, so `/bin/ps` reports
  `Operation not permitted` inside the sandbox regardless of the rules.

### Process-environment exposure

`ps -axeww` does expose same-user process environments on this host. An unprivileged
`KERN_PROCARGS2` read does not, so the exposure depends on `/bin/ps` being setuid root. These facts
motivated the Seatbelt work, but the configured trampoline is not honored by the harness's Core V2
session Bash path. Do not treat the sandbox checks below as proof that harness model-run tools
cannot inspect or use server credentials; the accepted residual risk and user-facing disclosure
are recorded in the 2026-10-06 decision below.

## Permission grants enabled; sandbox scope correction (2026-10-06)

- **Grants are enabled.** `src/cli.ts` supplies `permissionDecisionsEnabled: true`. The
  `HarnessDependencies` flag still defaults to off so embedders and non-interactive paths keep
  deny-by-default behaviour, and tests cover both configurations.
- **Credential isolation is defence in depth, not a precondition.** The permission prompt is a
  review affordance, not a containment boundary: an approved Bash command carries full host-user
  authority by OpenCode's own advisory. Rationale and accepted residual risk are in
  `.cmd/specs/2026-10-04-milestone-3-permissions/decisions.md`.
- **OpenCode 1.18.33 has two Bash spawn paths with different shell resolution.** One passes the
  configured `shell` through verbatim; the other calls `Shell.preferred(config.shell)`, which
  accepts only recognised shell names from a built-in table (`bash`, `dash`, `fish`, `ksh`, …) and
  otherwise silently falls back to the default shell. Quoder's trampoline is named
  `quoder-model-shell`, so it is discarded on that second path, which is the one a Core V2 session
  prompt uses. `npm run verify:sandbox` passes because it drives
  `opencode debug agent --tool bash`, which takes the first path. It is regression evidence for
  that path only, not for the harness.
- **`/config` reports the V1 resolved document.** It reported Quoder's trampoline even when the
  Core V2 tool path ignored it, while `/global/config` never reports `shell` at all. A runtime
  assertion that reads `/config` therefore cannot prove the V2 tool path is sandboxed.
