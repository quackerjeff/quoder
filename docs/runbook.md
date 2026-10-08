# Quoder Recovery and Diagnostics Runbook

This runbook covers Milestone 9 operational logging, stale OpenCode sessions, and
corrupt Quoder-owned state. Quoder does not manage unrelated OpenCode processes
or repair corrupt state automatically.

## Optional operational JSONL log

Logging is off unless `QUODER_LOG_FILE` is set. Use an absolute path in an
existing writable directory outside the target project:

```bash
QUODER_LOG_FILE="$HOME/Library/Logs/quoder.jsonl" quoder
```

The example path is for macOS; choose an equivalent user-owned log directory on
other platforms. The file is appended with restrictive permissions. Its
allowlisted records contain a timestamp and operational event metadata such as
prompt outcome/duration, server lifecycle, session deletion verification, or a
sanitized failure category. Prompts, tool output, provider payloads,
credentials, raw error objects, and child stderr are excluded.

If Quoder rejects the path or cannot open/write the log, it reports that logging
is unavailable and continues without it. Logging failure does not stop prompt
execution or cleanup. The security review noted a low-confidence suggestion to
check existing log-file ownership explicitly in elevated or unusual shared-
directory use; the current implementation does not independently verify that
ownership.

## Reviewing stale sessions

At startup, Quoder may report sessions from its private ownership ledger. In a
TTY, it asks separately before deleting each eligible session; only an explicit
affirmative answer proceeds. Blank input, `n`, Ctrl-C, or closed input declines.
Piped/noninteractive runs report eligible sessions and skip cleanup.

Cleanup candidates must have a durable `created` ledger record and must still
match the exact recorded session ID and canonical project location. Activity
may be unknown because a new OpenCode server cannot establish that an older
server is no longer using a session. Deletion could interrupt work.

Intent-only and ambiguous records are report-only and cannot be approved for
cleanup. A crash after the server creates a session but before Quoder durably
records confirmation leaves this narrow manual-recovery case. The record's ID
can help an operator locate the session in OpenCode, but Quoder will not offer
that record for deletion. Old or unregistered sessions and unrelated OpenCode
processes are left untouched.

## Corrupt or unavailable local state

Quoder reports a `Local state` failure and says the source was preserved. It
does not offer to reset, rename, overwrite, delete, or repair that file.

1. Stop Quoder before inspecting or moving any state file.
2. Make a separate copy of the affected source before any manual investigation
   or edit. Keep the original unchanged until recovery is understood.
3. Use the diagnostic to identify the subsystem: project memory, execution
   history, or OpenCode session ownership.
4. Find the per-project state using the paths below and the canonical project
   root. Paths include a SHA-256 project key, so they do not use the project
   directory name directly.
5. Consult the schema and path logic in `docs/tech.md` and the corresponding
   implementation before deciding on manual recovery. Quoder does not infer
   missing execution outcomes or ownership from incomplete records.

Default state roots (an absolute `XDG_STATE_HOME` overrides the defaults):

| State | macOS default | Other POSIX default |
| --- | --- | --- |
| Project memory | `~/Library/Application Support/Quoder/context/<project-sha256>.json` | `~/.local/state/quoder/context/<project-sha256>.json` |
| Execution history and ownership ledger | `~/Library/Application Support/Quoder/history/<project-sha256>/` | `~/.local/state/quoder/history/<project-sha256>/` |

The ownership ledger is in the `owned-sessions/` subdirectory. Do not remove a
ledger record to force cleanup: only Quoder's exact-ID/location checks and
explicit confirmation authorize deletion of an eligible session. Preserve
ledger files when reporting a local-state failure so their contents can be
reviewed manually.

## Startup validation and failure categories

Quoder validates its `--model` provider/model shape, its pinned OpenCode
executable, and the inline launch configuration needed to construct the
OpenCode child. It does not parse or validate every OpenCode user/project
setting. Correct the named Quoder input or run the suggested environment check;
diagnostics intentionally omit secret values and raw dependency errors.

Failure categories are `OpenCode`, `Provider/inference`, `Configuration`, and
`Local state`. If the category does not fit what happened, preserve the exact
diagnostic and log (if enabled) when asking for support. Do not attach prompts,
tool output, credentials, or provider payloads to public issue reports.
