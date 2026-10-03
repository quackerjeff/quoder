# Security Review: OpenCode/Ollama Environment and Architecture Reassessment

## Cycle 1 — 2026-10-02
Reviewing: Groups 1–4 and Fix Groups 1–6

### Threat Model
- **Assets:** the provider credential header in the user's OpenCode config (`provider.ollama.options.headers`); the per-run generated server password and its derived `Authorization: Basic …` header; the developer's account (filesystem, other processes); integrity of the readiness and capability verdicts.
- **Trust boundaries:**
  1. User-level config file (`$XDG_CONFIG_HOME|~/.config/opencode/opencode.json[c]`). The user trusts this file; it is the only source of the endpoint URL and the header.
  2. The remote HTTPS OpenAI-compatible endpoint on the user's LAN. It receives the credential header and returns model output.
  3. The project-local `opencode` child bound to `127.0.0.1:0`, protected by Basic auth. It inherits `process.env` plus `OPENCODE_SERVER_USERNAME/PASSWORD`.
  4. Model-driven tool execution inside OpenCode. Model output is untrusted and can run `bash` in the disposable repository, which it can write to.
  5. Local multi-user exposure of the loopback port, the process list, and temporary directories.
- **Data flows that need redaction:** preflight rows on stdout; the live-probe capability report on stdout; the `.live-build` journal and its stderr mirror; child stdout/stderr; and errors from `fetch`, `execFile`, `spawn` and the SDK.
- **Attack surfaces:**
  - Outbound authenticated HTTPS, including redirect behaviour.
  - The spawned executables, resolved relative to `process.cwd()`.
  - The generated fixture script, its PID file and the PID signalling.
  - `mkdtemp` roots and recursive removal.
  - Termination of the child after a timeout or cancellation.

### Critical
None.

### Warning
None.

### Suggestion
- [src/live-probe.ts:835] **Confidence: Medium** — Model-run shell commands can read the server password. The authenticated server gets `OPENCODE_SERVER_PASSWORD` through its environment, which is correct: it is not in argv, and on macOS only the same user or root can read another process's environment. However, the pinned 1.18.33 bundle's `ShellTool.shellEnv` returns `{...process.env, ...<plugin env>}` with `extendEnv: true`, so every model-run `bash` command inherits the password, and the 127.0.0.1 port is easy to find.
  - **Attack:** A prompt-injected or malicious model could run `curl -u quoder:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:<port>/…` to reply to its own pending permission requests or drive the server API. In this spec the model already has `bash` execution as the user, and the probe creates and answers its own permission request, so there is no privilege gain today. That is why this is a Suggestion. It does undercut the product invariant "Quoder does not bypass OpenCode's permission enforcement" once Milestone 1 forwards real permission decisions.
  - **Remediation:** Record this as a known limitation for Milestone 1 design. Options are a `shell.env` plugin hook that overrides `OPENCODE_SERVER_PASSWORD`/`USERNAME` with empty values for tool processes, or an upstream request to strip server credentials from tool environments. Do not move the password into argv, because that would expose it to all local users through `ps`.

- [src/environment-preflight.ts:465, :482] **Confidence: Low** — The HTTPS requirement (`parseProviderConfiguration`, line 398) applies only to the configured base URL. Both `fetch` calls use the default `redirect: "follow"`. Node 24's fetch drops `Authorization` on a cross-origin redirect, including an https→http downgrade. The parser accepts any header name, though, and a non-`Authorization` credential header (for example `X-API-Key`) would be resent to a redirect target, including a plaintext `http:` target.
  - **Attack:** If the endpoint or a fronting reverse proxy were misconfigured or compromised so that it returned a 30x to another origin or to `http://`, a custom credential header would be sent there. That leaks it to a third party or over cleartext on the LAN. Someone already in control of the endpoint receives the header anyway, so the gain is limited to the redirect and downgrade cases.
  - **Remediation:** Pass `redirect: "error"` to both preflight `fetch` calls. Optionally, allow only `Authorization` as the credential header name.

- [src/environment-preflight.ts:504, src/live-probe.ts:830] **Confidence: Low** — The `opencode` executable, `package.json`, and the pinned-manifest checks all resolve against `process.cwd()`. `npm run verify:environment` always sets cwd to the package root, so the documented invocation is safe.
  - **Attack:** If a developer ran `node /path/to/quoder/.live-build/scripts/verify-environment.js` from inside an untrusted checkout, Quoder would read that directory's forged `package.json` and `node_modules` manifests, which pass the pin check. It would then execute that directory's `node_modules/.bin/opencode` with the developer's environment and the generated server password.
  - **Remediation:** Resolve the package root from `import.meta.url` instead of `process.cwd()`, or assert that cwd equals the module's package root before running anything.

- [src/live-probe.ts:693] **Confidence: Low** — The cancellation fixture is written with `writeFile(scriptPath, …)`, which follows symbolic links, into a repository that earlier model-driven stages can write to. This code predates this spec. The script content is safe: the token and paths are embedded with `JSON.stringify`, and the token is a fresh UUID.
  - **Attack:** A malicious model in an earlier stage could create `repository/fixture.mjs` as a symlink to a file outside the repository, such as `~/.zshrc`. Quoder would then overwrite that file with fixed fixture text. The model's `bash` access could already do this directly, so there is no privilege gain.
  - **Remediation:** Write with `{ flag: "wx" }` (O_EXCL, which refuses existing paths or symlinks), or `lstat` and refuse a pre-existing path.

### Verification Evidence
- `npm run typecheck`: passed with no errors.
- `npm test -- --reporter=dot`: 5 files, 117/117 tests passed in 1.82 s. The tests use typed fakes and fake children. A grep found no real hosts in `tests/`, and none of them call the default launcher dependencies against a real CLI.
- `git diff HEAD --stat -- src scripts tests package.json`: 10 files reviewed in full or in their changed regions: `environment-preflight.ts`, `verify-environment.ts`, `live-probe.ts`, `opencode-adapter.ts`, `capabilities.ts`, the tests, and `package.json`.
- Read-only inspection of `node_modules/opencode-darwin-arm64/bin/opencode` (1.18.33):
  - `serve` reads `OPENCODE_SERVER_PASSWORD`/`USERNAME` from the environment.
  - The startup line is `opencode server listening on http://<hostname>:<port>`.
  - `ShellTool.shellEnv` returns `{...process.env, ...b.env}`; this is the basis of the first Suggestion.
- No live command was run, no network endpoint was contacted, and the user's OpenCode configuration was not read. The config shape comes from `parseProviderConfiguration` and its tests.
- Controls confirmed:
  - **Preflight output:** it prints only the fixed `safeEvidence` strings. Every error, including stage errors, cleanup errors, `execFile` stderr, `fetch` errors and late rejections, is discarded. Tests assert that sentinel secrets never appear.
  - **Config and model content:** the `ProviderConfiguration` object, its headers and the model responses are never printed.
  - **Server credentials:**
    - The password is 32 bytes from `randomBytes`.
    - It is not placed in argv.
    - The Basic header is sent only to the URL parsed from the owned child's stdout.
    - `verifyServerAuthentication` requires an unauthenticated 401 before it sends credentials, which defeats a look-alike local listener.
  - **Child output:** server stdout/stderr are drained and never retained.
  - **Spawn errors:**
    - In the live probe, `error.message` from a spawn error is only "spawn <path> ENOENT", with no environment or arguments, and only that text reaches the capability report.
    - In the preflight it is suppressed.
  - **Command execution:** every command uses `spawn`/`execFile` with argument arrays and no shell. The arguments are fixed constants or a decimal PID.
  - **Signalling:**
    - `terminateOwnedChild` signals only the directly spawned `ChildProcess` handle, so PID reuse is impossible after the exit is reaped.
    - The fixture is signalled only after `ps -p <pid>` shows the per-run UUID in its command line. The PID must be greater than 1, so process-group and broadcast signals are excluded. Liveness probes use signal 0.
  - **Temporary files:**
    - `mkdtemp` creates the root with mode 0700 under `os.tmpdir()`.
    - `validateTemporaryRoot` confines the root to the temporary directory and keeps it outside the worktree.
    - The root is removed with a `quoder-live-probe-` basename check.
    - `rm -r` does not follow symlinks inside the tree.
    - Partial roots are removed on failure or when ownership is rejected.
  - **Cleanup on timeout:** an ownership gate rejects late resources so their producer releases them, settlement is bounded, cleanup runs on every path, and incomplete handoff forces `Cleanup: FAIL`.

### Variant Hunting
- **Redaction consistency:** the preflight is uniformly redacted. The live probe intentionally puts `OpenCodeAdapterError` messages into its stdout report; these are adapter operation names plus the server's error `message` field. Nothing reaching that path carries the provider header or the Basic header. Provider failures surface in message `error` fields, which are never printed, and the SDK error objects are never serialized; only `.message` is used. In `verify-live.ts`, the rethrow that would print a full error, including its cause, is unreachable in practice because `runLiveProbe` catches internally. This is not a finding.
- **Process environment:**
  - The `opencode models` child does not receive server credentials.
  - The server child's inherited `process.env` matches what a directly launched OpenCode would get.
  - The provider credential is never placed in any child's environment; OpenCode reads it from its own config.
- **SSRF:** the only outbound target comes from the user's own config file; no untrusted input selects URLs. Paths are fixed relative segments (`models`, `chat/completions`) under the base URL. A URL with embedded credentials is rejected by `fetch`, and the rejection is suppressed.
- **Accepted risk:** the permission-event subscription race in `decisions.md` fails conservatively (Permission handling FAIL) and has no security impact.
- **Other checks:**
  - No pattern of unbounded child output was found; `maxBuffer` is 1 MiB and server output is drained.
  - No new dependencies were added, and the pins remain exactly 1.18.33.
  - No tracked artifact contains secrets. The endpoint hostname appears in `docs/tech.md` as an accepted, redacted host identity, not a credential.

### Verdict: PASS
