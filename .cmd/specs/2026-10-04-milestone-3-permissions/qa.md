# QA Report: Milestone 3 — Interactive Permission Handling

> The dated cycles below are retained as history. The current verdict is the final
> 2026-10-06 section, which evaluates the restated scope: permission prompts are enabled,
> credential isolation is defense in depth, and the UI discloses that model-run tools are
> unconfined.

## Cycle 1 — 2026-10-05
Validating: Group 8 tasks

### Coverage
- A user-authorized disposable-project probe created a private temporary copy of the OpenCode config directory and configured a project shell trampoline. The authenticated server exited with code 1 during startup, before session creation or a Bash call. The probe emitted no raw logs, config, credentials, or model output and cleaned its scratch directory. This is an inconclusive harness failure, not evidence for or against Core V2 shell selection.
- Automated:
  - `npm test`: PASS, 22 files and 444 tests.
  - `npm run typecheck`: PASS.
  - `npm run verify:permissions`: PASS. Its `build:live` TypeScript build passed, then all six no-model runtime checks passed: pending ask, exact native saved pattern, project A/B isolation, native revocation, and ask after revocation.
  - `git diff --check`: PASS.
  - Reviewed permission fake-server integration coverage: default-off gate rejects; explicit allow-once and project-save replies; configured allowed command; denial prevents outside-project read/edit operations; cancellation and EOF send no approval; stale requests and reply failures are handled.
  - Reviewed security regressions: escaped JSON `plugin` key, comment-separated key/colon, JSONC comment/string decoys, ancestor plugin config, and plugin directories are covered.
  - Reviewed root resolution coverage: canonical launch path, symlinked launch directory, normal in-repository Git root, and no-repository fallback are covered.
- Manual:
  - No model-based permission scenario or real OpenCode tool-shell invocation was run. The no-model acceptance only exercised authenticated server startup and native permission APIs.
- Not covered:
  - Actual model-run shell visibility of server credentials remains unverified. Unit tests exercise the `shell.env` transformation only; they do not prove the spawned OpenCode tool shell receives the cleared environment.
  - Actual user permission flows (allow once, deny, project save, operation result/no-result) remain unverified against a real model and OpenCode tool execution. The documented procedure is pending explicit user authorization.
  - The Group 3 root-containment acceptance specifically calls for a crafted `.git/config` `core.worktree` case. Current project tests cover ordinary Git root resolution and symlink canonicalization but do not exercise that hostile case.

### Critical
- **Runtime grant safety is not validated for release.** Without a real tool-shell invocation, QA cannot confirm that model-run commands cannot read or use the authenticated server credentials. Security Review Cycle 2 explicitly recommends keeping the permission decision gate default-off until this check passes. Enabling interactive grants without that evidence could allow a tool to bypass the intended user decision path.
- **Required interactive behavior lacks live evidence.** Fake-server tests establish the harness decision routing, and the no-model script establishes native saved-rule scope/revocation, but neither proves end-to-end behavior for a real user decision followed by a real tool operation. Those scenarios require the separately documented model-based acceptance run.

### Warning
- The claimed root-containment protection lacks the planned adversarial regression case for crafted `core.worktree` output. The implementation checks canonical containment, but this specific security acceptance is not demonstrated by the current tests.

### Suggestion
- Add the crafted `core.worktree` regression scenario during a follow-up implementation task, then include it in the regression suite before closing the milestone.

### Release Confidence
CONDITIONAL — automated behavior and no-model native persistence checks pass, but the permission grant gate must remain default-off. Do not release interactive grants as enabled until the real tool-shell credential-isolation and authorized end-to-end permission scenarios pass, and the adversarial root-containment case is covered.

### Verdict: FAIL

### Follow-up architecture check — 2026-10-05 — shell wrapper rejected
- Verified the pinned `shell` configuration contract from OpenCode 1.18.33 source: it is a string and Core V2 Bash passes it as the shell executable. This makes a wrapper selectable but does not establish it as a safe boundary.
- With a harmless dummy variable only, an owned process's environment remained visible through `ps eww` after the variable was removed and after it was added post-start. This macOS-specific check emitted only `VISIBLE`/`HIDDEN`; no real credential was inspected.
- OpenCode 1.18.34 still marks Core V2 Bash plugin-hook support TODO. Its local MCP launcher passes `...process.env` into local MCP child processes. An upgrade to 1.18.34 does not close either boundary.
- Rejected a shell-wrapper-only implementation because a model-run shell could inspect the server process environment and local MCP processes are outside the wrapper. No code-level credential-isolation fix was implemented in this follow-up.

### Critical
- **No supported isolation boundary is established.** A wrapper-only fix is bypassable through same-user process inspection and leaves local MCP subprocesses exposed. Continue to keep interactive permission decisions default-off pending a runtime-level or comprehensive OS isolation design.
- **The proposed Seatbelt direction is not implemented or accepted.** Pinned Core V2 Bash reads `shell` through filesystem-backed Core V2 config entries; the current Quoder `OPENCODE_CONFIG_CONTENT` merge is not established as an override. `OPENCODE_CONFIG_DIR` is a candidate for a Quoder-owned temporary config layer, but preserving existing settings, config precedence collisions, and project shell overrides are unverified. Applying Seatbelt to the server alone would still pass inline/provider secrets to its direct Bash child. Prove the temporary config route, environment filtering, and process-tree containment before running another acceptance probe.

### Release Confidence
FAIL — no further permission acceptance should run until the server credential boundary covers environment inspection and every model-callable local process path.

### Verdict: FAIL

## Cycle 2 — 2026-10-05
Validating: bounded user-authorized live acceptance attempt

### Coverage
- Automated:
  - No automated checks were rerun in this cycle.
- Manual:
  - In a disposable Qwen run, an allowed in-project shell command returned an unpredictable runtime value: PASS.
  - The subsequent environment-isolation prompt did not invoke the Bash tool. Neither the clear marker nor the leak marker was created, so credential isolation could not be evaluated. No leak was observed, but this is not evidence that credentials are isolated.
  - The run stopped before outside-project read, outside-project edit, and project-save permission prompts. Those scenarios remain unverified.
  - The scratch runner and disposable files were cleaned. No model text or credentials were persisted.
- Not covered:
  - A real tool-shell invocation that can establish whether server credentials are absent remains required.
  - End-to-end outside-project allow/deny and saved-project permission behavior remain unverified.
  - The Group 3 adversarial containment case for a crafted `.git/config` `core.worktree` remains absent from automated coverage.

### Critical
- **Credential isolation remains unverified.** The environment-isolation prompt did not invoke Bash, so the live attempt produced no observation of the tool shell's environment. Keep the permission grant gate default-off.
- **Required permission scenarios remain unverified.** The run stopped before the outside read/edit and project-save prompts, so the live acceptance criteria are incomplete.

### Warning
- The root-containment protection still lacks the planned crafted `core.worktree` regression case.

### Suggestion
- Repeat the bounded live checks after adjusting the disposable prompt so the isolation check invokes a harmless Bash command, then cover the remaining permission scenarios under explicit authorization.

### Release Confidence
CONDITIONAL — the allowed in-project command passed, but critical acceptance remains unverified. Keep the permission grant gate default-off until tool-shell isolation and the outstanding user permission scenarios are demonstrated. The hostile `core.worktree` coverage gap also remains.

### Verdict: FAIL

## Cycle 3 — 2026-10-05
Validating: one-prompt bounded shell-isolation probe, after explicit user authorization

### Coverage
- Manual:
  - A disposable project contained a harmless local script that checked whether selected server credential environment variables were nonempty and wrote only a random clear/leak marker; it did not print or persist credential values.
  - The model did not produce the clear marker, so the actual shell environment boundary could not be established. The fixed-result probe returned `FAIL`.
  - The run stopped before any outside-project read, edit, or saved-permission scenario. No credential leak was observed; the absence of an observation is not evidence of isolation.
  - The temporary runner and disposable project were removed. No model text or credentials were persisted.
- Not covered:
  - Actual tool-shell credential isolation and end-to-end user permission scenarios remain unverified.
  - The adversarial root-containment case for crafted `.git/config` `core.worktree` output remains absent from automated coverage.

### Critical
- **Credential isolation remains unverified.** Keep the permission decision gate default-off.
- **Live permission scenarios remain incomplete.** Outside-project allow/deny and project-save behavior have not been validated against real tool execution.

### Warning
- The planned hostile `core.worktree` containment regression remains uncovered.

### Release Confidence
CONDITIONAL — the bounded probe did not establish tool-shell credential isolation. Keep interactive permission decisions default-off; do not close the QA gate or proceed to documentation closure.

### Verdict: FAIL

### Follow-up diagnostic — 2026-10-05
- A corrected disposable Harness run waited for the actual input prompt, then confirmed `prompt.started`, `session.created`, and a normally `answered` `prompt.completed` event.
- The model turn emitted no tool activity, no Bash call, and no permission request. Neither marker was created. Therefore this run did not reach the shell hook; it cannot confirm or refute credential isolation.
- An earlier diagnostic attempt had sent input before readline was ready. That attempt was invalid and its no-session result is discarded.
- The scratch runner and disposable project were removed. Only fixed event/tool booleans were retained; no model response or credential value was captured.

### Follow-up diagnostic — 2026-10-05 — actual Bash invocation
- The user ran the harmless probe in the disposable project through Quoder. The model invoked Bash and the script exited with code 0.
- The first fixed marker reported `NONEMPTY`. A second run recorded variable names only: `OPENCODE_CONFIG_CONTENT` and `OPENCODE_SERVER_PASSWORD` were nonempty in the model-run shell. No values were read into the report, printed, or persisted.
- This is a confirmed critical failure of runtime credential isolation, not merely a missing observation. The `shell.env` hook/config loading or merge behavior must be corrected and the live probe must pass before any interactive grant is enabled.
- Outside-project allow/deny and saved-permission flows were not run. The hostile `core.worktree` regression remains absent.
- The disposable project remains at `/private/tmp/quoder-shell-probe.eMU5Ca` for this user-guided investigation; its script and marker contain no credential values.

### Critical
- **The model-run Bash environment contains `OPENCODE_SERVER_PASSWORD` and `OPENCODE_CONFIG_CONTENT`.** Treat the current credential-isolation implementation as failed. Keep the permission decision gate default-off and fix the runtime hook boundary before continuing live permission acceptance.

### Follow-up fix and verification — 2026-10-05
- The pinned OpenCode 1.18.33 bundle confirms that `OPENCODE_PURE` skips all external plugins. Quoder now removes this flag from the owned OpenCode server environment so its mandatory `shell.env` hook cannot be disabled by the parent environment.
- Added a regression assertion with `OPENCODE_PURE=1`; `npm test` passed (22 files, 444 tests), `npm run typecheck`, `npm run build`, `npm run build:live`, and `git diff --check` passed.
- A bounded direct Harness attempt with `OPENCODE_PURE=1` completed without a Bash tool call, so it produced no fresh marker and did not verify the fix. The prior marker was removed to prevent reuse of stale evidence.
- Group 8 remains FAIL pending a Bash invocation through the rebuilt Quoder CLI and a `CLEAR` result. The outside-project permission scenarios and hostile `core.worktree` test also remain outstanding.

### Follow-up diagnosis — 2026-10-05 — Core V2 shell hook is not called
- The latest shell probe result listed `OPENCODE_CONFIG_CONTENT` and `OPENCODE_SERVER_PASSWORD` as nonempty; it did not contain the temporary diagnostic marker.
- The user clarified that the preceding CLI launch command had been submitted inside an existing Quoder session. The model replied with a natural-language interpretation of the command, so the rebuilt CLI was not launched; this run cannot compare the new CLI's behavior. The credential names still confirm that the shell used by that session inherited both variables.
- Inspection of exact OpenCode `v1.18.33` source (`packages/core/src/tool/bash.ts`) found an explicit TODO to add plugin `shell.env` augmentation. The Core V2 Bash path creates the child process directly without invoking the hook. Therefore, the plugin-based clearing mechanism cannot isolate Quoder's Core V2 Bash tool even when plugin loading succeeds.
- No outside-project permission scenario was run. The crafted `.git/config` `core.worktree` regression remains absent.
- Removed the temporary diagnostic marker branch. Interactive permission decisions remain default-off. A different isolation mechanism must be implemented and security reviewed before further live acceptance.

### Critical
- **Credential isolation is failed.** Core V2 Bash inherits `OPENCODE_SERVER_PASSWORD` and `OPENCODE_CONFIG_CONTENT`; the `shell.env` plugin is not invoked by the pinned V2 Bash implementation. The attempted rebuilt-CLI launch was invalid because it became model input.

### Release Confidence
FAIL — do not enable or release interactive grants until an alternate credential-isolation mechanism passes live shell verification, outside-project permission scenarios pass, and the hostile `core.worktree` regression is covered.

### Verdict: FAIL

## 2026-10-05 — Group 3.1 re-verification after the Seatbelt tool sandbox

**Scope**: Credential isolation for model-run tools only. This does not re-open Group 8, and interactive permission grants remain default-off.

**Deterministic evidence**

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS (25 files, 485 tests) |
| `npm run build` | PASS |
| `npm run build:live` | PASS |
| `git diff --check` | PASS |
| `npm run verify:sandbox` | PASS (10/10 predicates) |

**Model-free sandbox predicates** (`npm run verify:sandbox`, via `opencode debug agent --tool bash`, which runs the pinned Core V2 Bash with no model call):

| Predicate | Result |
| --- | --- |
| Tool sandbox prepared | PASS |
| Core V2 selected the sandbox shell | PASS |
| Loopback denied to model-run shell | PASS |
| Private config unreadable by model-run shell | PASS |
| Process inspection denied to model-run shell | PASS |
| Credential variables absent from model-run shell | PASS |
| Nested sandbox cannot relax the profile | PASS |
| External network preserved | PASS |
| Project shell override rejected | PASS |
| Runtime config assertion fails closed | PASS |

**Negative control**: `npm run verify:sandbox:negative` replaces the generated Seatbelt profile with a permissive one and inverts the verdict, passing only when the loopback, private-config, and nested-escape predicates report FAIL. Observed: all three flip, so the suite is not vacuously passing. This is a repeatable script rather than a manual patch of the built artifact. The process-inspection predicate still passes under the control because Seatbelt refuses to exec setuid `/bin/ps` under any profile; it therefore detects an unsandboxed shell rather than the specific rule. This is recorded rather than claimed as rule coverage.

**End-to-end against a real authenticated server**: `launchSandboxedOpenCodeServer` started the server, the post-startup assertion passed, `GET /config` confirmed the resolved `shell` is Quoder's trampoline with zero local MCP servers, unauthenticated `/global/health` still returned 401, and the private sandbox directory was removed on close with no leftover scratch directories.

**Earlier inconclusive result resolved**: The previous `server exited during startup (code 1)` was not caused by the sandbox configuration. Fourteen launch variants including an exact reconstruction all started successfully, and `opencode serve` was shown to perform no startup configuration validation. That is also why the post-startup runtime assertion is required rather than optional.

**Residual gaps**
- LSP and formatter subprocesses are outside `shell` and are not yet asserted against; only local MCP servers are rejected.
- `OPENCODE_SERVER_PASSWORD` remains in the server's own environment by design; the sandbox makes it inert rather than hidden.
- `sandbox-exec` is deprecated in its man page, though present and working on macOS 26.
- Linux has no verified backend and fails closed.
- Outside-project permission flows and adversarial `core.worktree` coverage remain outstanding from the earlier QA cycle.

**Verdict**: Group 3.1 credential isolation PASS. Group 8 remains FAIL pending the outstanding permission scenarios; interactive grants stay default-off until Group 7 security review and Group 8 QA are re-run against this change.

## 2026-10-06 — Requirement restated; grants enabled

**Change**: Interactive permission grants are enabled in the CLI. Credential isolation is reclassified as defence in depth, so Group 3/3.1 and the prior Group 7 suggestion no longer gate this milestone. See `decisions.md` for the rationale and the accepted residual risk.

**Deterministic evidence after the change**

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS (25 files, 485 tests) |
| `npm run build` | PASS |
| `npm run build:live` | PASS |
| `git diff --check` | PASS |

Coverage retained for both configurations: the enabled path asserts an explicit Allow once key before a request resolves, and the disabled path asserts deny-by-default with the auto-deny notice.

**Known-false claim removed**: The startup line no longer states that model-run tools are sandboxed. `npm run verify:sandbox` still passes, but it exercises `opencode debug agent --tool bash` rather than a Core V2 session prompt, so it is regression evidence for that path only and is no longer an acceptance gate.

**Outstanding follow-ups, none blocking**: trampoline naming so `Shell.preferred` accepts it; a runtime assertion against a config source the V2 tool path consults; LSP and formatter subprocess coverage; outside-project permission flows; adversarial `core.worktree` coverage.

**Verdict**: PASS for the restated scope. Interactive permission handling is enabled and covered; model-run tool containment is explicitly out of scope and is disclosed in the UI and the README.
