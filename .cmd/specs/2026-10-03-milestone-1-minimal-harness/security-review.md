# Security Review: Milestone 1 — Minimal Harness

## Cycle 1 — 2026-10-03
Reviewing: Groups 1–4 and Fix Groups 1–2

### Threat Model
- **Trust boundaries.**
  1. Model output, question text and options, permission `action` strings, and provider or step error messages. All of these arrive through the authenticated OpenCode server and are written to the developer's terminal.
  2. The developer's project directory. Quoder now runs `git rev-parse` there, and it is the cwd of the OpenCode server and the location of every session. Its contents, including `.git/config`, `opencode.json` and AGENTS files, may be untrusted.
  3. The global v2 SSE stream from Quoder's own child server. It is authenticated with a per-launch 32-byte random password.
  4. Developer-controlled inputs: argv (`--model`), `QUODER_TRACE_FILE`, stdin and signals.
- **Assets.**
  - The developer's terminal: its clipboard (OSC 52), its display integrity, and hyperlinks.
  - The server password and the Basic header.
  - Provider credentials in the inherited user config.
  - Milestone 1's invariant that Quoder never grants a permission.
  - Which `opencode` binary and which manifests Quoder trusts.
  - The developer's processes, which are signalled by `verify-harness`.
- **Out of Quoder's ownership, by documented design.** OpenCode loads the project configuration and enforces permissions (`SYSTEM_CONTEXT.md`, "What This Repo Does Not Own"). Running `quoder` in an untrusted checkout is therefore equivalent to running `opencode` there. Model-run shell commands can read `OPENCODE_SERVER_PASSWORD`; this is a user-accepted deferral to Milestone 3 (decisions.md, `docs/tech.md:285`). This change does not make it worse: the password is still passed only through the child's environment, never argv, and bash is already allowed under the default policy.

### Critical
None.

### Warning
None.

### Suggestion
- [src/harness/project.ts:30] **Confidence: Low**: The project root is taken verbatim from `git rev-parse --show-toplevel`. The code does not check that the root contains the launch directory. A repository-local `.git/config` can set `core.worktree` to an arbitrary path. I verified this in a scratch repo: run from `repo/`, the command printed the sibling `elsewhere/`.
  - **Attack**: An attacker could ship a project archive (a tarball or zip that contains a `.git` directory, not a `git clone`) whose `.git/config` sets `core.worktree = /Users/<dev>`. When the developer runs `quoder` inside it, Quoder starts the OpenCode server with cwd `$HOME` and binds every session's location to `$HOME`. Model file tools then work across the home directory without the `external_directory` ask the developer would expect at the project boundary. Milestone 1 gains no privilege from this, because bash is default-allowed, and the banner prints the resolved root. It becomes material once Milestone 3 relies on project-scoped permission rules.
  - **Remediation**: Accept the git top-level only when `realpath(cwd)` equals it or lies inside it. Otherwise fall back to the launch directory and print a warning. Optionally run git with `-c core.worktree=` unset or `GIT_CEILING_DIRECTORIES`, or use `--show-cdup` relative to cwd.

- [src/harness/repl.ts:127, src/harness/repl.ts:141] **Confidence: Low**: `project.name` and `project.root` are written to the terminal unsanitized, in the banner and as the readline prompt label. This is the only display path that skips `sanitizeForTerminal`.
  - **Attack**: An attacker could distribute an archive whose top-level directory name embeds an escape sequence, such as `x\e]52;c;<base64>\a`. If the developer `cd`s into it and runs `quoder`, the banner writes an OSC 52 clipboard write or title or cursor sequences to the terminal. The prompt label then re-emits them on every prompt. Plausibility is low: the developer must enter a directory with control characters in its name, and many shells' prompts already render it.
  - **Remediation**: Pass `project.name` and `project.root` through `sanitizeLine` before using them in the banner and the prompt.

- [src/opencode-adapter.ts:249] **Confidence: Low**: `replyPermission`'s default reply is `"once"`, which is a grant. This change does not introduce it: the harness passes `"reject"` explicitly (repl.ts:285), and the only other caller is the probe, which passes `"once"` explicitly. The default is a latent hazard for the Milestone 1 invariant if a future harness call site omits the argument. No current path triggers it, so this is a hardening note only.
  - **Remediation**: Remove the default and make `reply` a required parameter.

### Verification Evidence
- `npm run typecheck` passed. `npm test -- --reporter=dot` passed: 13 files, 223/223 tests. `npm run build` passed and emits to the gitignored `dist/`. `git diff --check` is clean.
- **Read in full**:
  - `src/cli.ts`, `src/package-root.ts`, `src/opencode-server.ts` and `src/event-monitor.ts`;
  - `src/harness/{terminal-text,project,format,session-runner,repl}.ts` and `scripts/verify-harness.ts`;
  - the diffs of `src/live-probe.ts`, `src/environment-preflight.ts`, `package.json`, `.gitignore` and `docs/tech.md`;
  - the error paths of `src/opencode-adapter.ts`.
- **Sanitizer.** I ran a scratch harness outside the repository against a copy of `terminal-text.ts`, with no network. All of these vectors came out free of C0, C1, DEL and bidi characters:
  - OSC 52, BEL- and ST-terminated;
  - OSC 8 hyperlinks;
  - unterminated OSC;
  - 8-bit OSC (0x9D) and CSI (0x9B);
  - DCS, APC, PM and SOS;
  - SGR 8 (concealed text), CSI 2K with CR (line overwrite), and bare CR or BS overwrite;
  - a doubled ESC, VT/FF and NUL;
  - U+202E, U+2067 and U+061C.

  The final `CONTROL_CHARACTERS` pass removes every ESC and C1 byte regardless of how the escape regex matched, so sequences cannot be reassembled. CR is converted to LF, so no in-line overwrite is possible. I checked the bidi class by byte dump: it covers U+061C, U+200E/F, U+202A–202E and U+2066–2069, the complete set of bidi formatting controls. Payloads of DCS, APC, PM and SOS lose their introducer and print as inert text. Unterminated OSC swallows the rest of the text, which is over-removal, not injection.
- **Display paths.**
  - Answers use `sanitizeForTerminal`.
  - These use `sanitizeLine`: question text (format.ts:44), options, the permission action (format.ts:7), failure reasons including adapter and server messages and the step `error.message` (format.ts:56), and the notes (format.ts:17, 22).
  - Notices, help text and status lines are fixed literals. Only `project.name` and `project.root` (above) and the developer's own `--model` value are unsanitized.
- **Permission policy.**
  - The only harness reply is `replyPermission(..., "reject")` (repl.ts:285).
  - Events are acted on only when `isOwnSession` holds: the tracker is registered right after `createSession`, before the prompt is submitted, and unregistered after deletion.
  - Events with no string `sessionID` or `id` are dropped.
  - Events come only from Quoder's own authenticated child server, so no spoofing channel exists apart from the deferred password exposure.
  - A failed rejection marks the server unhealthy, stops the prompt, and settles and deletes the session, so failures fail closed: nothing is ever granted.
- **Binary and manifests.**
  - `findPackageRoot` walks up from `import.meta.url` (which Node resolves to the real path through the `npm link` symlink) to the first `package.json` named `quoder`, so `process.cwd()` is never consulted.
  - `node_modules/.bin/opencode` points to `opencode-ai/bin/opencode.exe`, a native Mach-O arm64 binary. There is no `#!/usr/bin/env node` wrapper whose `node` lookup a project could steer.
  - The preflight now reads its manifests through `packagePath`, which closes the earlier cwd-relative suggestion.
  - `--pure` is retained (opencode-server.ts args).
- **Secrets.**
  - The password comes from `randomBytes(32)` and goes only into the child's environment (opencode-server.ts:79), never argv.
  - The Basic header lives only inside the SDK client.
  - Launch failures print a fixed message, and server stdout and stderr are discarded.
  - `verify-harness` prints only fixed rows and counts; child stdout is used only to count sentinels.
  - Trace events are a closed union (repl.ts:23–31): fixed names, session IDs, verified flags, outcome kinds and elapsed ms. They contain no prompt or model text and no credentials.
- **Trace file.** It is written with `appendFileSync` at a path the developer chooses, with the default mode (0666 & umask). It follows symlinks, but the path is chosen by the developer and the content is non-sensitive. `verify-harness` places it inside a `mkdtemp` directory (0700).
- **verify-harness signalling.**
  - PIDs are collected only where `ppid` equals the spawned CLI's PID and the command contains the exact server command line.
  - Each PID is re-validated with `ps -p` immediately before both SIGTERM and SIGKILL.
  - The unguarded `process.kill` race is the carried-forward cosmetic item, not a safety issue.
- **Resource use.**
  - There is no per-turn timeout, by design (Ctrl-C).
  - Every adapter call is bounded at 30 s. The no-response idle is bounded at 30 s. Server startup is bounded at 15 s and termination at 2+2 s.
  - Undeleted-session retries run once per server launch, over a bounded list.
  - The line queue grows only from developer input, and TTY input is refused while busy.
  - Per-session permission and question arrays are cleared on unregister.

### Variant Hunting
- **Sanitization consistency.** Every display path that carries model or server text is sanitized. The single gap is the project label and path, reported above.
- **Event-driven actions.** Only two exist, `rejectQuestion` and `replyPermission("reject")`. Both are scoped to owned sessions, and neither can grant.
- **Subagent (`task`) child sessions.** They have their own session IDs and are not registered, so their permission or question asks are ignored rather than rejected. The effect is fail-closed: nothing is granted, and the turn may block until Ctrl-C, which interrupts and deletes the parent. This is a usability or completeness concern for a later milestone, not a security finding.
- **Comments vs code.**
  - "Milestone 1 never grants a permission" (repl.ts:283) matches the code.
  - "Fixed event names … never prompt or model text" (repl.ts:22) matches the type.
  - The `package-root.ts` claim that Quoder never resolves from cwd matches the code.
- **Error text.** Only `.message` is displayed, never `cause`, `responseHeaders`, `metadata` or request objects. That matches the prior review's redaction analysis. The step `error.message` is now shown to the developer's terminal, which is new, but it is the provider's message string only, and it is sanitized.
- **Environment inheritance.** The server inherits the full `process.env`, unchanged from Milestone 0 and by design. `QUODER_TRACE_FILE` also reaches the server and model-run shells. A model could therefore append forged lines to a diagnostic trace, but it already has same-user bash, so nothing is gained, and the acceptance run uses fixed, non-injectable prompts in a disposable directory.
- **Project configuration and `--pure`.** `--pure` disables only plugins. The project's `opencode.json` (permissions, MCP and agents) is still loaded by OpenCode, by design and owned by OpenCode. It is not a Quoder finding.

### Verdict: PASS
