# Security Review: OpenCode SDK Feasibility Spike

## Cycle 1 — 2026-09-30
Reviewing: Groups 1–6

### Threat Model

The probe launches an OpenCode server with the developer’s privileges and existing provider/model configuration, then exposes its control API on a loopback TCP port. Trust boundaries include the OpenCode SDK/server, model-generated behavior, structured event streams, filesystem output, process IDs written by the cancellation fixture, and package/install artifacts. Sensitive assets include developer credentials inherited by the OpenCode process, repositories and files accessible to the developer account, executable shell capability, and the integrity of the feasibility verdict. The probe creates an owner-specific temporary tree and asks OpenCode to execute only inside its disposable repository, except for one deliberately created permission target. Primary attack surfaces are the loopback server, OpenCode’s shell/file tools, temporary-path and symlink handling, child-process lifecycle, error diagnostics, and npm supply-chain inputs.

### Critical

None.

### Warning

- [src/live-probe.ts:627] **Confidence: High** — The hosted OpenCode server is bound to loopback but is not explicitly authenticated. `createOpencode` returns a client with only the server URL, and this call supplies no per-run credential. Loopback restricts remote-network access, but it does not isolate the endpoint from other local users or processes. Because the API controls an agent running with the developer’s filesystem and process privileges, this is a local confused-deputy boundary rather than a harmless health endpoint.
  - **Attack**: An attacker with a process under another local account could scan loopback while the probe is running, discover the ephemeral OpenCode port, and call the unauthenticated API to create a session targeting a directory the server account can access or invoke tools with the developer’s privileges. Normal filesystem permissions that block the attacker directly would not block the server acting on the attacker’s requests.
  - **Remediation**: Generate a high-entropy credential for each probe run, configure the child OpenCode server to require it, and configure the SDK client to send it. Fail closed if authenticated server startup cannot be established. Keep the loopback bind and ephemeral port as defense in depth, and do not place the credential in command-line arguments, persisted config, or diagnostics.

### Suggestion

- [src/capabilities.ts:92] **Confidence: Medium** — Project-confinement evidence uses lexical `resolve`/`relative` checks, while [src/live-probe.ts:475] reads `hello.txt` without rejecting a symbolic link or checking its resolved target.
  - **Attack**: A compromised or unexpectedly permissive OpenCode execution could create `hello.txt` as a symlink to a file outside the disposable repository. The probe would read external content while reporting the hard-coded lexical path as confined, weakening the integrity of the security-relevant project-directory result.
  - **Remediation**: Use `lstat` to reject symlinks for evidence files, resolve existing paths with `realpath`, and compare them against the `realpath` of the disposable repository before treating them as confined.

- [src/live-probe.ts:538] **Confidence: Medium** — The cancellation fixture has bounded runtime, and normal success verifies its exit, but exceptional paths rely on session deletion and server shutdown rather than explicitly terminating the recorded fixture PID or process group.
  - **Attack**: If interruption, event observation, or session deletion fails after the fixture starts, the fixture may continue consuming resources until its 60-second timer expires; a future less-bounded fixture variant could persist longer.
  - **Remediation**: In a `finally` path, validate that the recorded PID belongs to the purpose-created fixture, terminate its process group when still alive, and verify exit before removing the temporary environment. Preserve the current session deletion and server shutdown as additional cleanup layers.

### Verification Evidence

- `npm run typecheck` — PASS
- `npm test -- --reporter=dot` — PASS, 57/57 tests
- `npm run verify:live:smoke` — PASS; produced the expected nine conservative `FAIL` rows and overall `FAIL`
- `git diff --check` — PASS
- Secret-pattern scan of repository-controlled files found no embedded credential values.
- Runtime and development dependencies are pinned exactly in `package.json`; resolved packages carry integrity hashes in `package-lock.json`.
- Process execution uses `execFile` with an argument array for Git; no application shell interpolation, `eval`, or dynamic command construction was found.
- Adapter requests and SSE streams use finite abort timeouts.
- Temporary deletion validates an OS-temporary child with the expected prefix before recursive removal.
- The authoritative OpenCode/Ollama scenario was not run.
- `npm audit --omit=dev --json` could not query the npm advisory service because registry DNS/network access was unavailable. Known-vulnerability status therefore remains unverified in this review environment.

### Variant Hunting

The same finite-timeout and stream-abort pattern is applied across session, prompt, permission, interrupt, wait, message, deletion, and event operations. Permission handling uses one-time approval only, correlates the exact Core V2 request ID, and does not accept legacy permission events. All observed subprocess invocation in repository code avoids a shell. Temporary-environment cleanup rejects the OS temp directory itself, rejects paths outside it, rejects the Quoder worktree, and checks its generated prefix. Diagnostics avoid serializing arbitrary error objects, and the CLI renderer prints capability status rather than detailed error evidence. No variants of command injection, persistent permission grants, detached promise rejection, hardcoded credentials, broad network binding, or unbounded SDK waits were found.

### Remaining Risks

- OpenCode and the configured model intentionally execute with the developer’s local privileges; the spike does not sandbox that upstream runtime.
- The installed OpenCode binary is permitted to run its package lifecycle script. Exact pins and lockfile integrity reduce, but do not eliminate, package-compromise risk.
- Advisory status could not be checked against the npm registry in the restricted review environment.
- The developer configuration reportedly contains an inline authorization credential outside this repository. It was not read or reproduced, but should be rotated and moved to an appropriate secret mechanism before capturing detailed live logs.

### Verdict: FAIL

# Security Review: OpenCode SDK Feasibility Spike

## Cycle 2 — 2026-09-30

Reviewing: Group 6 and Fix Group 9

### Threat Model

The probe launches a project-local OpenCode server with the developer’s filesystem and process privileges and existing provider/model configuration. The primary trust boundaries are the authenticated loopback API, model-directed file and shell activity, SDK event streams, filesystem evidence, and fixture PIDs supplied through the disposable repository. Sensitive assets include developer-accessible repositories, credentials inherited by OpenCode, local command execution, and the integrity of the feasibility verdict. The main attack surfaces are server discovery and authentication, credential propagation, temporary-path and symlink handling, permission replies, child-process lifecycle, diagnostics, and pinned npm dependencies. A malicious local process must not be able to use the OpenCode server as an unauthenticated confused deputy, and untrusted model output must not cause arbitrary PID termination or external-file evidence to be accepted.

### Critical

None.

### Warning

None.

### Suggestion

- [src/live-probe.ts:602] **Confidence: Medium** — Fixture termination is validated and exit-checked once execution reaches the interrupt block, but the event-stream failure, missing-start-event, and missing-PID returns at lines 617–629 occur before that cleanup `try/finally`. A fixture that actually started despite incomplete event/PID evidence can therefore continue until its current 60-second timer expires.
  - **Attack**: An untrusted or malfunctioning model execution could start the fixture while the corresponding event stream ends or fails before the expected start event is processed. The probe would return from the cancellation scenario without attempting validated termination, leaving the child consuming resources for the remainder of its bounded timer.
  - **Remediation**: Enclose the complete post-prompt observation and PID-acquisition sequence in the cleanup `try/finally`. In `finally`, make a final bounded attempt to read the PID and call `terminateValidatedFixture` when a live, token-correlated process is found.

### Verification Evidence

- Per-run authentication uses `randomBytes(32)`, producing a fresh 256-bit password.
- The password and fixed username are passed only through the spawned child environment.
- The password is absent from OpenCode process arguments and persisted configuration.
- The SDK client receives the matching Basic `Authorization` header.
- Authentication verification fails closed unless anonymous health access returns `401` and authenticated access succeeds.
- Authentication/startup failure paths signal the server child, and client-construction failure closes the hosted server.
- The server command uses the project-local executable, `127.0.0.1`, and port `0`.
- Evidence-file reads use `lstat`, reject symbolic links and non-regular files, resolve both paths with `realpath`, and enforce repository confinement before reading.
- Fixture termination verifies that the PID is live and that its command contains the per-run token before sending `SIGTERM`, then verifies process exit.
- Core V2 permission handling remains request-ID correlated, requires effect `ask`, replies with `once`, and rejects legacy permission events.
- SDK requests and event streams retain finite abort timeouts.
- Session deletion, stream teardown, driver shutdown, and temporary-environment cleanup remain present.
- Runtime and development dependencies remain exactly pinned.
- No application shell interpolation, dynamic shell execution, hardcoded production credentials, or credential-bearing diagnostics were found.
- `npm run typecheck` — PASS
- `npm test -- --reporter=dot` — PASS, 63/63 tests
- `npm run verify:live:smoke` — PASS; produced the expected nine conservative `FAIL` capability rows and overall capability `FAIL`
- `git diff --check` — PASS
- The authoritative `npm run verify:live` OpenCode/Ollama scenario was not run.

### Variant Hunting

Authentication is applied consistently to startup verification and all SDK traffic through the configured client. No unauthenticated alternate server launcher remains in the production path. Credentials are not placed in arguments, reports, retained startup output, or adapter diagnostics. Permission handling still uses the correlated Core V2 event and one-time response. All repository-controlled subprocess launches avoid shell interpolation. Filesystem evidence rejects direct symlink and non-regular-file variants and checks resolved confinement. PID validation prevents arbitrary termination when the recorded PID belongs to an unrelated command. The only incomplete variant identified is cancellation cleanup before successful start-event/PID acquisition, recorded above as a bounded hardening suggestion.

### Remaining Risks

- OpenCode and the configured model intentionally execute with the developer’s local privileges; this spike does not sandbox the upstream runtime.
- Child-process environment variables can be inspected by sufficiently privileged local processes; the per-run credential primarily protects the loopback confused-deputy boundary from callers that cannot inspect that process.
- Server shutdown sends `SIGTERM` but does not wait for confirmed child exit.
- The cancellation fixture cleanup gap described above remains bounded by the fixture’s current 60-second timer.
- Package pinning and lockfile integrity reduce supply-chain risk but do not eliminate compromise of the pinned artifacts.
- The authoritative live scenario remains reserved for QA, so real-environment behavior is not established by this review.

### Verdict: PASS
