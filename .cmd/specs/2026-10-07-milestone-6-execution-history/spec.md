# Milestone 6 — Execution History

## Context

Milestone 5 added persistent per-project context while keeping each OpenCode
session fresh. The requirements now call for a unique run identifier and an
inspectable record of every execution. The existing REPL already has the
developer prompt, assembled harness context, starting/final Git snapshots,
model identity, streamed tool events, permission replies, final outcome, and
elapsed time at different points in the run lifecycle.

## Decision

Implement durable Quoder-owned execution records and local `/history` commands.
Keep the feature inside this repository and the existing REPL/OpenCode adapter
boundary. Do not reuse or persist OpenCode sessions. Follow FR-11 in
`docs/requirements.md`: a record covers run ID, timestamp, project, branch,
starting HEAD, model, agent when available, prompt, injected context, permission
decisions, executed commands/tool activity, observed changed files, final
response, execution status, and duration. Values unavailable from the current
contract must be represented explicitly rather than inferred.

The history store must live outside target repositories and must never persist
server credentials, raw OpenCode diagnostics, or complete SDK/event payloads.
History content includes developer and model text and may contain secrets;
private file permissions are hygiene, not isolation from same-user processes.
Group 2 defines user disclosure, retention/deletion controls, record bounds,
partial/interrupted-run behavior, and terminal interactions below.

The developer approved full FR-11 records with retention controls. “Full record”
means all FR-11 fields, including the exact developer prompt, injected context,
executed Bash command strings, final response, permission decision summaries,
and observed changed paths. It does not mean a replayable OpenCode transcript:
do not store tool stdout/stderr, full tool input/output payloads, credentials,
or SDK event objects. Persisted text is verbatim and not reliably secret-
redacted. Group 2 fixes the local storage and command contract below.

## Constraints

- Preserve a fresh OpenCode session per execution and current session cleanup,
  cancellation, retry, permission, and Git reporting behavior.
- Keep history scoped to the canonical project and outside the target repository.
- Do not record server credentials, authentication headers, raw diagnostics,
  full OpenCode event payloads, or data that the user-facing record does not
  need.
- Treat prompts, injected context, commands, permission choices, paths, and
  responses as sensitive and untrusted data. Sanitize all terminal rendering.
- Persistence failures must not change the OpenCode execution outcome and must
  be reported without printing record contents.
- Do not add a persistence dependency unless research documents a need and the
  spec records a decision.
- Do not claim that a completed record proves authorship or causality for Git
  changes; reuse Milestone 4's observed before/after semantics.

## Design

The REPL is the orchestration owner. It begins a Quoder run record when a
developer prompt starts, gathers the verified available metadata and observed
activity during execution, then finalizes the record after the prompt outcome
and Git comparison are known. A dropped-prompt retry remains one Quoder run,
although it uses a second fresh OpenCode session. If Quoder exits before
finalization, Group 2 defines how the incomplete record is represented.

The persistence component owns schema validation, per-project paths, atomic
updates, ID allocation, and history queries. The REPL owns `/history` command
dispatch and rendering. Group 1 records the current contracts in `docs/tech.md`;
Group 2 specifies interaction and storage policy; implementation groups then
build persistence, lifecycle capture, and command display in sequence.

### Group 2 record and interaction policy

History lives outside the project at `$XDG_STATE_HOME/quoder/history/<project-key>`
when `XDG_STATE_HOME` is absolute. Otherwise use
`~/Library/Application Support/Quoder/history/<project-key>` on macOS and
`~/.local/state/quoder/history/<project-key>` on other supported POSIX systems.
The project key is SHA-256 of canonical `Project.root`. Store each run as its
own versioned JSON file with private 0700 directories and 0600 files where
supported. Use exclusive creation and retry on an ID collision; use atomic
replacement when finalizing a record. Validate file type/ownership, symlink
handling, schema, and byte limits on read. The record/document ceiling is
32 MiB. Never silently truncate a record: if it exceeds the ceiling or cannot
be written, keep the execution result unchanged, report that history could not
be saved, and leave no record falsely marked complete.

Use unique same-directory temporary files for atomic updates; incomplete temp
files are not history records and are ignored during listing. Startup may remove
only abandoned temporary files older than 24 hours, so it does not interfere
with another Quoder process finalizing a run.

Run IDs are 128-bit random lowercase hexadecimal identifiers (32 characters),
scoped to the project. Exclusive file creation is the collision check against
retained and explicitly deleted IDs. Store records in filenames containing the
ID and current record state. Finalization atomically publishes the completed
state filename, then removes the in-progress filename; readers deduplicate by
ID and prefer a finalized record if a crash leaves both names. Set each record
file's modification time to its start time, including when finalization
publishes a new state filename. List and retention sort bounded file metadata
by that time without loading large prompt and response bodies. List records by
start time, not ID. A dropped-prompt retry remains one run record; store the
number of attempts, not OpenCode session IDs. The record schema is:

| Field | Content |
| --- | --- |
| `id`, `version` | Unique run ID and schema version. |
| `startedAt`, `finishedAt`, `durationMs` | UTC start/end and elapsed milliseconds; end/duration are absent while the record is in progress. |
| `project` | Project name and canonical root. |
| `branch`, `startingHead` | Values from the pre-execution Git snapshot, or explicit unavailable/null values. |
| `model`, `agent` | Provider/model ID; agent is null because the current harness does not select one. |
| `prompt`, `injectedContext` | Full developer prompt and the exact labeled background context submitted with it, stored as distinct fields. |
| `permissionDecisions` | Action, resource count, selected reply, and reply success where observed; omit raw permission payloads and resource lists. |
| `commands` | Exact Bash command strings and completion status; no stdout/stderr. |
| `toolActivity` | Tool name and success/failure/cancelled status; no complete tool inputs or outputs. |
| `filesChanged` | Milestone 4 observed path changes and change kind, preserving rename paths and endpoint/unavailable semantics. Do not claim authorship. |
| `finalResponse` | Full final assistant response for answered runs, otherwise null. |
| `status`, `attempts` | `in-progress`, `answered`, `permission-rejected`, `question-rejected`, `cancelled`, or `failed`, plus count of fresh-session attempts. A failed server launch after record creation is `failed` with a failure-stage field. An in-progress record after restart is displayed as “in progress / possibly interrupted”; do not guess that it crashed. |

Create and persist the initial in-progress record before submitting the prompt.
Finalize it after the outcome and Git comparison are available. If Quoder exits
mid-run, leave the last valid in-progress record; inspection explicitly labels
it inconclusive. If a server must be started or replaced after the run record
begins and that launch fails, finalize the run as failed with a server-start
stage. Initial harness startup occurs before Quoder accepts developer prompts;
if it fails, no execution record is created because no run was submitted.
If history storage fails at any point, prompt handling continues and a
sanitized warning names only the storage operation/error category, never record
contents. Updating or reading history must not change OpenCode session cleanup.

At startup, disclose that execution history is stored locally and may contain
verbatim prompts, context, commands, and responses. `/history help` repeats that
notice, explains that secret redaction is not provided, and documents deletion
and retention controls. The same-user access limitation must be stated plainly.
All history commands are local and never create OpenCode sessions.

| Command | Behavior |
| --- | --- |
| `/history` | Show the ten most recent records with ID, timestamp, and status; do not load or display prompt/response bodies or previews in the list. |
| `/history <id>` | Show all stored FR-11 fields for exactly that ID, clearly label unavailable/in-progress values, and sanitize terminal output without silently truncating stored data. |
| `/history help` | Show command syntax, local storage/sensitivity notice, retention defaults, and delete controls. |
| `/history retention` | Show the per-project maximum completed-record count. |
| `/history retention <count>` | Set the maximum retained completed records from 1 through 1,000; prune the oldest completed records immediately. Default is 100. |
| `/history clear <id>` | Delete one exact record ID. |
| `/history clear all` | Delete all records for the current project; keep the retention setting. |

With no records, `/history` prints “No execution history yet.” A malformed ID
prints the command syntax; a valid unknown ID prints “No history record with
that ID.” If storage is unavailable, report a fixed sanitized error and keep
prompts usable. If a stored record is malformed or unsupported, detail view
reports it unavailable without printing file contents. List view reports the
filename's status from bounded file metadata and does not pre-read record
bodies, so corruption is detected when the record is opened in detail. Invalid retention values
print the accepted 1–1,000 range and do not change settings. Reset malformed
settings with an explicit `/history retention <count>` setting operation.

Keep in-progress records outside the completed-record retention count until
they finalize. Concurrent processes may temporarily exceed the configured cap;
each finalization prunes oldest completed records. If an explicit delete races
with an active writer, the writer must not silently recreate the deleted record.
Malformed or unsupported settings/records are reported as unavailable and are
not overwritten by normal operations. `/history clear all` removes history
records and preserves a valid retention setting; if that setting is malformed,
the developer must explicitly set a valid value with `/history retention N`.
In TTY and piped modes, list/detail and delete commands use the same behavior.
Record-derived values in all output are terminal-sanitized and visibly
field-labeled; multiline text remains associated with its field and cannot
forge neighboring labels.

## Risks

- Full records can retain secrets or private source text. Clear disclosure,
  deletion/retention controls, bounded writes, and restrictive local permissions
  need an explicit policy.
- Captured stream data is untrusted. Records and terminal views must be bounded
  and safely encoded without altering the original execution outcome.
- Multiple Quoder processes may contend for per-project run IDs and history
  updates; allocation must not overwrite an existing record.
- A process crash can leave a run incomplete. The record model must distinguish
  incomplete from failed or completed execution.
- Captured Git changes describe endpoint observations only and cannot prove
  that a particular execution authored them.

## Exit Criteria

- Every submitted execution is assigned a unique, queryable run ID.
- `/history` lists recent runs and `/history <id>` shows the selected record in
  a readable, sanitized format.
- Records contain the FR-11 fields available from verified Quoder contracts,
  and clearly mark fields that are unavailable or incomplete.
- History is project-scoped, kept outside the project, recoverable after
  interrupted writes, and manageable through the approved retention controls.
- Default retention is 100 completed records per project, configurable from 1
  through 1,000; the developer can delete one or all records explicitly.
- General review, security review, and required QA pass; requirements and
  technical documentation match the shipped behavior.
