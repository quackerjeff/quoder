# QA Report: OpenCode SDK Feasibility Spike

## Cycle 1 — 2026-09-30

Validating: Group 7 live OpenCode/Ollama feasibility scenario

### Environment

- Platform: macOS 26.7 (Build 25G229), arm64
- Node: `v24.18.1`
- npm: `12.0.2`
- Git: `2.54.0 (Apple Git-157)`
- Project-local OpenCode CLI: `opencode-ai@1.18.33`
- Project-local OpenCode SDK: `@opencode-ai/sdk@1.18.33`
- Ollama client: `0.34.0`
- OpenCode entry point: project-local `npm run verify:live`; the system OpenCode installation was not used
- Model/runtime: the developer's existing OpenCode/Ollama configuration was targeted and was not modified. The model identity and live runtime response were not captured before the command was interrupted.

No credentials, authorization headers, or provider secrets are included in this report.

### Coverage

- Automated:
  - `npm run typecheck` exited `0`.
  - `npm test -- --reporter=dot` exited `0`: 4 files and 63 tests passed.
  - `npm run verify:live:smoke` exited `0` after producing the expected conservative nine-row failure matrix against its unavailable-runtime fixture. This is not live capability evidence.
  - `git diff --check` exited `0` before this QA report was written.
- Live:
  - `npm run verify:live` was launched with the required permission to start the authenticated project-local OpenCode server, connect to localhost, invoke the configured Ollama model, and use disposable temporary fixtures.
  - The command did not return captured stdout or an exit code. The execution wrapper reported interruption after 1162.2 seconds. Subsequent process inspection by the orchestrating session found no active verifier, live-build verifier, or OpenCode serve process; only the pre-existing Ollama service remained.
- Not covered:
  - None of the nine capabilities has trustworthy live output from this run.
  - The verifier's cleanup behavior and final capability report cannot be confirmed from the lost output.

### Authoritative Command Record

Command:

```text
npm run verify:live
```

Captured result from the execution wrapper:

```text
aborted by user after 1162.2s
```

Exit code: unavailable because the execution was interrupted before a result was returned.

Process stdout/stderr: unavailable; no output was returned by the execution wrapper.

The absence of an exit code and capability report means the authoritative validation was not executed reliably enough to support a feasibility decision. Per the Group 7 instruction, the live scenario was not rerun after evidence was lost.

### Capability Evidence

| Capability | Status | Evidence |
| --- | --- | --- |
| Fresh session creation | FAIL | No authoritative live output or unique session identifiers were captured. |
| Project directory | FAIL | No live filesystem evidence proving activity was confined to the disposable repository was captured. |
| Local model invocation | FAIL | No final response from the configured local model was captured. |
| Streaming events | FAIL | No structured live execution event was captured. |
| Permission handling | FAIL | No live Core V2 permission request/reply evidence was captured. |
| File modification | FAIL | No live evidence that `hello.txt` was created with exact required content was captured. |
| Cancellation | FAIL | No live start, interrupt, idle, fixture-termination, or post-interrupt event evidence was captured. |
| Session deletion | FAIL | No live deletion and post-delete Core V2 404 evidence was captured. |
| Session isolation | FAIL | No live nonce/sentinel exchange across two disposable sessions was captured. |

Capability Verdict: FAIL

This is a conservative unverified result, not evidence that the installed OpenCode/Ollama environment lacks these capabilities.

### Critical

- **Authoritative validation record unavailable:** The required live command returned neither its nine-row report nor an exit code before the execution wrapper was interrupted after 1162.2 seconds. Group 7 acceptance requires both exact output and exit status. Without them, QA cannot distinguish a slow model, verifier hang, cleanup delay, runtime failure, or completed command whose output was lost.

### Warning

- None beyond the blocking validation failure above.

### Suggestion

- Diagnose the verifier's observability and finite end-to-end timeout in a separate implementation task, then authorize a fresh QA cycle that captures stdout/stderr and exit status durably. Do not treat the passing unit tests or unavailable-runtime smoke fixture as a substitute for the live scenario.

### Residual Gaps

- All nine architecture-critical live behaviors remain unverified in the target environment for this QA cycle.
- Cleanup appears quiescent based on the orchestrating session's later process inspection, but the command's own cleanup evidence was not captured.
- The exact configured model and its response were not captured.

### Release Confidence

NOT READY

The automated implementation checks are healthy, but the environment-dependent go/no-go scenario did not yield an auditable result. Milestone 1 must remain blocked until a reliable live QA cycle completes.

### Verdict: FAIL

## Cycle 2 — 2026-09-30

Validating: Group 7 live OpenCode/Ollama feasibility scenario after Diagnostic Group 11

### Environment

- Platform: macOS 26.7 (Build 25G229), arm64
- Node: `v24.18.1`
- npm: `12.0.2`
- Git: `2.54.0 (Apple Git-157)`
- Project-local OpenCode CLI: `opencode-ai@1.18.33`
- Project-local OpenCode SDK: `@opencode-ai/sdk@1.18.33`
- Ollama client: `0.34.0`
- Ollama service state immediately before the run: unavailable; `ollama --version` reported `Warning: could not connect to a running Ollama instance`
- OpenCode entry point: project-local `npm run verify:live`; the system OpenCode installation was not used
- Live deadline: default whole-run deadline of 600,000 ms; the initial prompt also retained its 120,000 ms operation timeout
- Journal: `.live-build/verify-live.journal.jsonl`

No credentials, authorization headers, provider secrets, model content, or raw server diagnostics are included in this report or journal.

### Coverage

- Automated:
  - `npm run typecheck` exited `0`.
  - `npm test -- --reporter=dot` exited `0`: 4 files and 65 tests passed.
  - `npm run verify:live:smoke` exited `0` after producing the expected conservative nine-row failure matrix against its unavailable-runtime fixture. This is regression evidence, not live capability evidence.
  - `git diff --check` exited `0` before this report was written.
- Live:
  - `npm run verify:live` was run in the target environment with permission to start the authenticated project-local OpenCode server, connect to localhost, invoke the configured Ollama model, and use disposable temporary fixtures.
  - The authoritative run exited `1` after 120.9 seconds. It created the disposable environment, authenticated driver, and initial Core V2 session, then the initial prompt reached its finite 120-second operation timeout.
  - The command emitted exactly nine named capability rows, all `FAIL`, followed by `Capability Verdict: FAIL`.
  - The durable journal recorded session cleanup, driver close, environment removal, and `process.finish.exit-1`.
  - Post-run inspection found no residual verifier, OpenCode server, or cancellation-fixture process and no residual `open-code-sdk-spike-*` temporary directory.
- Not covered:
  - Because local model invocation did not complete, the scenario did not reach live streaming evidence, permission handling, file verification, cancellation, normal session deletion evidence, second-session creation, or isolation validation.
  - The journal deliberately records fixed stage names rather than exception details, so the timeout classification derives from the exact 120-second interval at `stage.session.initial.prompt.start`, the configured operation timeout, and the independently observed unavailable Ollama service.

### Authoritative Command Record

Command:

```text
npm run verify:live
```

Exit code: `1`

Application stderr, also persisted without the `[verify:live] ` prefix in the JSONL journal:

```text
[verify:live] {"timestamp":"2026-09-30T13:01:22.869Z","event":"process.start"}
[verify:live] {"timestamp":"2026-09-30T13:01:22.870Z","event":"stage.environment.create.start"}
[verify:live] {"timestamp":"2026-09-30T13:01:22.893Z","event":"stage.environment.create.complete"}
[verify:live] {"timestamp":"2026-09-30T13:01:22.893Z","event":"stage.driver.create.start"}
[verify:live] {"timestamp":"2026-09-30T13:01:23.540Z","event":"stage.driver.create.complete"}
[verify:live] {"timestamp":"2026-09-30T13:01:23.541Z","event":"stage.run.start"}
[verify:live] {"timestamp":"2026-09-30T13:01:23.541Z","event":"stage.session.initial.create.start"}
[verify:live] {"timestamp":"2026-09-30T13:01:23.628Z","event":"stage.session.initial.create.complete"}
[verify:live] {"timestamp":"2026-09-30T13:01:23.628Z","event":"stage.session.initial.prompt.start"}
[verify:live] {"timestamp":"2026-09-30T13:03:23.661Z","event":"stage.sessions.cleanup.start"}
[verify:live] {"timestamp":"2026-09-30T13:03:23.783Z","event":"stage.sessions.cleanup.complete"}
[verify:live] {"timestamp":"2026-09-30T13:03:23.783Z","event":"stage.driver.close.start"}
[verify:live] {"timestamp":"2026-09-30T13:03:23.783Z","event":"stage.driver.close.complete"}
[verify:live] {"timestamp":"2026-09-30T13:03:23.783Z","event":"stage.environment.remove.start"}
[verify:live] {"timestamp":"2026-09-30T13:03:23.786Z","event":"stage.environment.remove.complete"}
[verify:live] {"timestamp":"2026-09-30T13:03:23.788Z","event":"process.finish.exit-1"}
```

Application stdout:

```text
Fresh session creation: FAIL
Project directory: FAIL
Local model invocation: FAIL
Streaming events: FAIL
Permission handling: FAIL
File modification: FAIL
Cancellation: FAIL
Session deletion: FAIL
Session isolation: FAIL
Capability Verdict: FAIL
```

The PTY also emitted npm command notices and terminal spinner control sequences; those add no capability evidence and are omitted from the application-stream transcript above.

A preliminary sandboxed launch exited `1` during driver creation because that restricted environment could not host the localhost server. It is not treated as authoritative capability evidence. The command was then run once in the explicitly authorized target environment, producing the record above.

### Capability Evidence

| Capability | Status | Evidence |
| --- | --- | --- |
| Fresh session creation | FAIL | One initial Core V2 session was created, but the timed-out prompt prevented creation of the required second unique session. |
| Project directory | FAIL | The disposable environment was created and removed, but the model did not complete file activity proving confinement to its repository. |
| Local model invocation | FAIL | The initial model prompt did not complete before its 120-second timeout; the Ollama service was unavailable immediately before execution. |
| Streaming events | FAIL | No qualifying structured execution event was observed before the initial prompt timed out. |
| Permission handling | FAIL | The scenario did not reach the live Core V2 permission request/reply stage. |
| File modification | FAIL | The scenario produced no verified `hello.txt` with exact content `Hello from OpenCode`. |
| Cancellation | FAIL | The scenario did not reach fixture start, interrupt, idle, termination, and no-late-completion validation. |
| Session deletion | FAIL | Cleanup completed, but the scenario did not record the required normal deletion evidence for both sessions and post-delete Core V2 lookups. |
| Session isolation | FAIL | The second session and exact `NO_PRIOR_SESSION` sentinel exchange were not reached. |

Capability Verdict: FAIL

This is a trustworthy negative feasibility result for the tested environment at the recorded time. It does not prove that the SDK contracts can never work when a compatible Ollama service is available.

### Critical

- **Live feasibility criteria not met:** The configured local model was unavailable and the initial prompt timed out, so none of the nine architecture-critical capabilities satisfied its complete acceptance predicate. Milestone 1 must remain blocked pending architecture/environment reassessment.

### Warning

- **Failure detail is stage-level:** The durable journal establishes the exact stalled stage and cleanup sequence but intentionally excludes raw exception diagnostics. That protects credentials and model/server data, while leaving the unavailable Ollama preflight and timing as the principal cause evidence.

### Suggestion

- In Group 8, document this capability FAIL and the need to reassess or restore the required OpenCode/Ollama environment before proposing any new feasibility cycle. Do not present passing automated tests as live capability success.

### Residual Gaps

- No successful local model response or downstream live capability evidence was obtained.
- The precise server-side/provider exception is not retained by the fixed-stage journal.
- Cleanup is supported by journal completion, absence of residual matching processes, and absence of the generated temporary directory; it does not independently prove both sessions met the normal deletion capability predicate.

### Release Confidence

NOT READY

The validation mechanism is now reliable, finite, and auditable, but the tested environment failed the Milestone 0 capability gate. Quoder must not advance to Milestone 1 on this result.

### Verdict: PASS

QA PASS means Cycle 2 executed reliably and produced an auditable negative result. It does not override the separate Capability Verdict: FAIL.
