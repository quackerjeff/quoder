# Handoff: OpenCode server credentials and the permission gate

**Date:** 2026-10-06
**Branch:** `milestone-3-seatbelt-tool-sandbox` (from `main` @ `81e311b`)
**Spec:** `.cmd/specs/2026-10-04-milestone-3-permissions/`
**Supersedes:** `handoff-credentials-issue.md` (untracked, kept on disk for history)

## Outcome in one paragraph

Interactive permission grants are **enabled**. The credential-isolation requirement that blocked
them was **rewritten, not waived**: it is now defence in depth rather than a precondition. A macOS
Seatbelt sandbox for model-run tools was built and does work, but **not on the Bash path the
harness uses**, so it is not load-bearing and the UI does not claim it is. The residual risk —
self-approval under prompt injection — is accepted and recorded for this single-developer,
local-only tool.

## Why the original requirement was dropped

The requirement said: prove model-callable processes cannot recover or use the server password,
*then* enable the permission prompt. The reasoning was that a process holding the password could
call OpenCode's permission API and approve its own request.

That treats the prompt as a security control. It isn't one. An approved Bash command already
carries full host-user authority — OpenCode's own advisory string says so:

> Bash runs with host-user filesystem, process, and network authority

The prompt shows you what is about to run and lets you refuse. It does not constrain what an
approved command can do. So gating the prompt on perfect credential isolation left strictly *less*
safety than enabling it: every request was auto-denied and nothing was reviewable.

Full rationale and the conditions that would warrant revisiting: `decisions.md`, entry
*2026-10-06 — Credential isolation is defence in depth*.

## Why hiding the credential is impossible on the pinned version

Worth knowing before anyone retries this. In OpenCode 1.18.33:

- `ServerAuth.Config` declares `password: Config.string("OPENCODE_SERVER_PASSWORD")`. The
  environment is the only source.
- `opencode serve --help` exposes `--port`, `--hostname`, `--mdns`, `--mdns-domain`, `--cors`,
  `--pure` and logging flags. There is no credential flag, file, or descriptor option.

So the password is necessarily in the server process's environment, and `ps -axeww` can read
same-user environments on macOS 26 (confirmed: four sentinel occurrences). Any fix must make the
credential **inert**, not hidden. That is why the work pivoted to an OS capability boundary.

One nuance: an unprivileged `KERN_PROCARGS2` read does *not* return another process's environment.
The exposure depends on `/bin/ps` being setuid root. Seatbelt refuses to exec setuid binaries under
any profile, so `ps` fails inside any sandbox regardless of the rules.

## What was built, and what it actually covers

| File | Purpose |
| --- | --- |
| `src/opencode-tool-sandbox.ts` | Seatbelt profile, shell trampoline, private mirror of the user's global config selected with `OPENCODE_CONFIG_DIR`. Fail-closed on non-macOS, missing `sandbox-exec`, rejected profile, global `shell` collision, unparsable global config. |
| `src/opencode-sandbox-assertion.ts` | Post-startup assertion: refuses to continue unless the resolved `shell` is the trampoline and no local MCP server is configured. |
| `src/opencode-server.ts` | `launchSandboxedOpenCodeServer` — prepare, launch, assert, clean up as one unit. |
| `src/opencode-project-policy.ts` | Rejects project `plugin` *and* `shell` keys before launch, including escaped JSON spellings. |
| `scripts/verify-core-v2-shell-config.ts` | Model-free probe: `npm run verify:sandbox` and `npm run verify:sandbox:negative`. |

The user's real configuration is read and mirrored, never modified.

**Scope limit, important.** `verify:sandbox` reports PASS for ten predicates and the negative
control correctly fails three of them. It is nonetheless **not evidence about the harness**, because
it drives `opencode debug agent --tool bash`. See the next section.

## The failure that matters

A real `quoder` session ran `ps -axeww | head -3` and it **succeeded**, printing live process data,
while the startup assertion had passed and the resolved `shell` was the trampoline.

Confirmed empirically:

| Invocation path | Trampoline honoured? |
| --- | --- |
| `opencode debug agent --tool bash` | yes |
| `session.shell` (V1 API) | yes |
| real harness session prompt | **no** |

Also confirmed: the two config views disagree. `/config` reports `shell` as the trampoline;
`/global/config` never reports `shell` at all. An assertion that reads `/config` therefore cannot
prove anything about the path Core V2 Bash uses.

**Mechanism — leading hypothesis, not settled.** The pinned binary contains two distinct command
spawn sites:

- one reads `Object.assign({}, ...Config.entries().filter(type === "document")).shell ?? default`
  and passes the value straight to the child process;
- one reads `Shell.preferred(config.shell)` and builds argv with `Shell.args(...)`.

The bundled `Shell` module exposes `preferred`, `acceptable`, `name`, `login`, `args` over a table
keyed by shell *name* (`bash`, `dash`, `fish`, `ksh`, …). A configured shell whose filename is not a
recognised name is most likely discarded, with a silent fallback to the default shell. Quoder's
trampoline is named `quoder-model-shell`.

This explains every observation, but the mapping of which spawn site serves which API path was
**not** fully pinned down. Confusingly, the site that honours the raw value is also the one
carrying the permission assertion, which would naively suggest it is the V2 path. Anyone resuming
this should confirm the mapping directly rather than trusting the inference above.

## Hard-won Seatbelt details

Each of these cost real debugging time and each would ship as a silent or fatal failure:

1. **Rules must name realpath-resolved paths.** A `(deny file-read* (subpath "/var/..."))` rule does
   not match the kernel's `/private/var/...`. The denial is lost with no error and the file stays
   readable. This silently voided the file-read control in the first implementation.
2. **`env -i` is fatal under `(deny process-info*)`** — SIGTRAP, exit 133, during loader startup.
   Use `env -u NAME` per variable instead.
3. **`(deny network-inbound ...)` breaks DNS**, because the system resolver binds a local socket
   (`bind: Operation not permitted`). Deny only outbound loopback.
4. **`(deny process-info*)` alone breaks HTTPS.** It must be followed by
   `(allow process-info* (target self))`; order matters, Seatbelt applies the last match.
5. A sandboxed process **cannot relax its own profile**: a nested `sandbox-exec` with
   `(allow default)` fails with `sandbox_apply: Operation not permitted`.

## Diagnosing the previous handoff's `exit code 1`

The prior attempt reported `server exited during startup (code 1)` and could not diagnose it. It was
**not** caused by the sandbox design. Fourteen launch variants, including an exact reconstruction of
the failing configuration, all started normally. Supporting facts:

- `opencode serve` performs **no startup configuration validation**. Malformed
  `OPENCODE_CONFIG_CONTENT`, unknown keys, a wrong-typed `shell`, and a malformed project
  `opencode.jsonc` all start fine. This is why a post-startup runtime assertion is necessary at all.
- `--port=0` prefers 4096 and falls back to an ephemeral port when 4096 is held; concurrent servers
  on the same and different projects start without conflict. Port contention is excluded.

The exit was environmental and transient. The deeper defect was the probe: it discarded stderr and
staked its claim on a nondeterministic model prompt.

## Verification lesson

Every predicate in `verify:sandbox` ran through **one** invocation path. A negative control proves a
suite is sensitive to the variable it perturbs; it cannot reveal that the whole suite addresses the
wrong code path. The suite passed, the negative control behaved correctly, and the boundary still
did not hold where it mattered.

Two predicates were also outright non-discriminating until the negative control exposed them: a raw
TCP listener made `curl` fail whether or not the sandbox blocked it, and the process-harvest check
accepted a zero count with no proof the sentinel was findable. Both are fixed.

If this is resumed, the acceptance criterion must include **at least one check driven through a real
harness session prompt**, accepting the model nondeterminism that implies.

## Current state

Commits on this branch, oldest first:

| Commit | Summary |
| --- | --- |
| `9f33481` | Seatbelt tool sandbox, runtime assertion, project policy, model-free probe |
| `920c63e` | Negative control as a repeatable script (`verify:sandbox:negative`) |
| `db6164f` | Startup line reporting the sandbox — **superseded**, claim was false |
| `c79c471` | Reopened Group 3.1 after the harness-path failure; banner corrected |
| `d865a2a` | Grants enabled; credential isolation descoped to defence in depth |

Behaviour now:

- Permission prompts are live. `src/cli.ts` supplies `permissionDecisionsEnabled: true`; the
  harness dependency still defaults to off so embedders and non-interactive paths keep
  deny-by-default.
- Startup states the posture without claiming containment:
  `Permission prompts on · approved commands run with your full user authority; model-run tools are unconfined`
- Retained because they are cheap and affect correctness: root containment within the launch
  directory, explicit replies with no implicit default, child-session registration, label
  sanitization, and the fail-closed project policy.

Gates at `d865a2a`: `npm run typecheck` clean; `npm test` 485 tests across 25 files;
`npm run build` and `npm run build:live` clean; `git diff --check` clean.

## Optional follow-up, unscheduled and not blocking

1. Name the trampoline so `Shell.preferred` accepts it — for example `<private dir>/bin/bash` — and
   handle the argv `Shell.args`/`Shell.login` produce for that name, including a possible `-l`
   before `-c`. Confirm the spawn-site mapping first.
2. Point the runtime assertion at a config source the V2 tool path genuinely consults. `/config` is
   the V1 view and reported the trampoline even when it was unused.
3. Add a harness-path predicate driven through a real session prompt.
4. Cover LSP and formatter subprocesses; only local MCP servers are asserted against today.
5. Outstanding from earlier QA: outside-project permission flows, adversarial `core.worktree`
   coverage.

## Rules for anyone resuming

- Do not restore a "sandboxed" claim in the UI without evidence from a real session prompt. A false
  assurance is worse than none.
- Do not treat `verify:sandbox` as proof about the harness. It covers one invocation path.
- Do not read, print, copy, or persist `~/.config/opencode`, provider configuration, or real
  credentials. Use harmless sentinels and disposable projects, as the existing probes do.
- If Quoder becomes multi-user, runs unattended, or targets untrusted repositories by default, the
  accepted risk in `decisions.md` must be revisited before anything else.
