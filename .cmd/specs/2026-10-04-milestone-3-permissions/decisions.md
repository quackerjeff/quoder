# Decisions: Milestone 3 — Interactive Permission Handling

## 2026-10-04 — Plan around native permission enforcement

**Context**: Milestone 3 adds interactive decisions to a harness that currently rejects every OpenCode permission request. Prior security review findings become material as soon as Quoder can forward grants.

**Decision**: Treat credential isolation, project-root containment, explicit reply values, child-session ownership, and display sanitization as prerequisites to interactive grants. Keep OpenCode's permission API as the enforcement mechanism. Do not assume that an `always` response is project-scoped based only on its generated SDK type.

**Rationale**: The authenticated local server API can itself reply to permission requests, so a model-run shell with server credentials can bypass the intended human decision path. Likewise, any saved permission preference depends on a trustworthy canonical project identity and a verified OpenCode persistence scope.

## 2026-10-04 — Group 1 research status

**Context**: Static inspection of the repository's verified Milestone 1 notes, current implementation, and pinned `@opencode-ai/sdk@1.18.33` declarations.

**Decision**:
- Confirmed from prior verified research: `--pure` skips plugins; OpenCode 1.18.33's shell environment can be changed by a `shell.env` plugin hook; shell commands otherwise inherit the server environment including `OPENCODE_SERVER_PASSWORD`. Runtime isolation still needs implementation and a focused check.
- Confirmed in the pinned SDK declarations: permission replies accept `once`, `always`, or `reject`; create requests have `save?: string[]`; saved records include `projectID`, `action`, and `resource`; `SessionV2Info` has optional `parentID`.
- Confirmed by readable implementation in the exact `opencode-ai@1.18.33` executable bundle: `reject` rejects the pending request; `once` resolves the pending request without saving; `always` with nonempty `request.save` inserts each save pattern with the current project ID and request action. Native permission evaluation loads those records for that project ID as allow rules. The `always` contract is established at pinned implementation-source level; a no-model runtime integration scenario remains for later QA.
- Therefore the project option must show the exact `request.save` patterns (which can differ from current resources) and be unavailable when the save list is empty. OpenCode remains the policy store and enforcement point; Quoder does not maintain a shadow preference store.
- Confirmed current code gaps: `resolveProject` accepts any Git top-level path without checking containment; the adapter defaults an omitted reply to `once`; the monitor's own-session predicate does not yet include child sessions; prompt/banner use project labels without sanitizing them.

**Rationale**: The pinned implementation ties saved permissions to the active project ID, action, and explicit save patterns. Showing those patterns makes the scope reviewable; treating `always` as meaning the current request's resources without checking `save` would be inaccurate.

## 2026-10-04 — Group 3 implementation start

**Context**: Runtime prerequisites can be implemented independently, but the credential hook requires removing `--pure`, which changes plugin loading.

**Decision**:
- Added a Quoder `shell.env` plugin module and appended it through `OPENCODE_CONFIG_CONTENT`. The hook clears OpenCode authentication variables and inline config from model-run shell environments. The pinned bundle shows the inline config is processed after the other config layers and plugin hooks run in registered order.
- Selected the policy to reject project targets with project-sourced OpenCode plugins, while preserving project settings for plugin-free targets. The common authenticated server launch scans the target and ancestor config layers plus `.opencode/plugins` and `.opencode/plugin` paths. It fails closed on unreadable config. User-level plugins remain trusted and are outside this target-specific policy.
- Added canonical path containment for Git roots, sanitized project labels before styling, and removed the adapter's implicit `once` reply. Updated existing tests' expected call/launch arguments for these signature changes; tests have not been run.
- The plugin trust boundary remains open: configured project plugins execute in the server process before the shell hook and can read server environment variables. Disabling project config would also remove project-level OpenCode permission settings. Do not mark credential isolation complete or enable interactive grants until this tradeoff is resolved and verified.

**Rationale**: Clearing child-shell environment values addresses shell inheritance, but does not isolate server-side plugin code. Rejecting project plugin sources closes that project-controlled path while retaining project permission/settings configuration. This does not protect credentials from trusted user-level plugins.

## 2026-10-04 — Permission prompt interaction design

**Context**: The harness runs the model while the live status line is active. `LineEndingKeys` currently routes only Ctrl-C and Ctrl-D to readline while a prompt is busy, and the milestone needs explicit, safe user decisions during that interval.

**Decision**:
- Use a temporary, keyboard-only panel rendered through `LiveView.note`; show action and requested resources, plus a separate list of exact `save` patterns when present. Do not promise to show a command without a verified correlation to the permission source.
- Bind case-insensitive `A` to allow once, `P` to allow for project only when `save` is nonempty, and `D` or Escape to deny. Return and unknown keys do nothing. The prompt explains that project approval covers the displayed save patterns.
- Queue simultaneous requests in event-arrival order and allow only one reply in flight. Reconcile the queue against native reply events because OpenCode's `reject` rejects all pending requests for the same session, and `always` can resolve other requests whose resources are covered by the saved patterns.
- On TTY loss, EOF, Ctrl-C, monitor loss, stale request, or API failure, no allow reply is sent. Preserve existing interruption and cleanup behavior; do not retry a reply whose result is uncertain.
- In non-TTY mode, show a sanitized plain-text notice and reject through OpenCode, since Quoder cannot collect a human decision.

**Rationale**: This interaction preserves the existing busy-input protections and status display, makes the scope of persistent approval visible, and ensures ambiguous states cannot grant access.

## 2026-10-04 — Group 4 implementation

**Context**: Group 3 prerequisites passed focused automated checks. The active spec still requires a security-review gate before real permission forwarding is enabled by default.

**Decision**:
- The event monitor reports `session.created` / `session.updated` metadata before subsequent request events. `SessionTracker` associates a child (and its descendants) only when its `parentID` is already owned by the current execution; unrelated sessions remain ignored. Root cleanup removes the whole execution tree.
- Permission events now retain the verified action, resources, and save patterns for the decision panel. Interactive TTY input routes A/P/D/Escape to the active request without entering readline; pasted text and unknown keys do not trigger decisions. P is disabled without save patterns. Native reply events reconcile requests that OpenCode resolved independently or as siblings.
- Non-TTY requests, TTY sessions before security review, cancellation, EOF, monitor loss, and reply failures send no approval. Reply failure stops the turn; cancellation and EOF clear the panel queue. The internal `permissionDecisionsEnabled` dependency defaults off and exists for controlled testing until the Group 7 security gate passes.
- Added focused monitor, tracker, keyboard, and harness integration coverage for each reply, disabled project approval, simultaneous requests, native sibling replies, stale requests, cancellation, EOF, and uncertain API replies. `npm run typecheck` passes and the focused 5-file suite passes (150 tests). No live model session was run.

**Rationale**: Event arrival order plus parent ownership prevents unrelated sessions from being treated as Quoder's work. Keeping the grant path off by default honors the spec's review prerequisite while allowing the exact interaction and native reply path to be tested deterministically.

## 2026-10-04 — Group 5 automated acceptance

**Context**: Permission routing and UI behavior are implemented behind a default-off decision gate. Group 5 requires repeatable behavior coverage and runtime evidence for native saved-permission scope, without running a model prompt.

**Decision**:
- Added deterministic fake-server integration coverage for allowed execution, ask prompting, deny blocking, outside-project read/edit denial, project-save choices, parallel asks, cancellation/EOF, stale requests, native sibling replies, and reply failures. Security prerequisite regressions remain covered by focused unit/integration tests.
- Added `npm run verify:permissions`, a separate no-model runtime acceptance command. It uses two disposable Git projects and a process-local `external_directory: ask` policy to confirm the exact native saved pattern is scoped to project A and that removing the saved record makes the request ask again. It cleans up temporary records and sessions and emits only fixed result rows.
- Documented model-based acceptance separately in `permission-acceptance.md`; it must wait for the Group 7 security review and explicit enabling of the default-off permission gate. No model prompt was run for Group 5.
- Verification passed: `npm test` (22 files, 441 tests), `npm run typecheck`, `npm run build:live`, `git diff --check`, and `npm run verify:permissions` (all six no-model runtime checks PASS).

**Rationale**: Deterministic tests cover decision behavior without provider variability. The native persistence check exercises the pinned server's actual project scope and revocation behavior while avoiding model execution. Real model acceptance remains a separate QA activity behind the security gate.

## 2026-10-05 — Prevent pure mode from disabling the credential hook

**Context**: The authorized disposable model-run shell probe found `OPENCODE_CONFIG_CONTENT` and `OPENCODE_SERVER_PASSWORD` nonempty in Bash. OpenCode 1.18.33's bundled runtime skips all external plugins when `OPENCODE_PURE` is enabled, while the authenticated launcher inherited that parent environment variable.

**Decision**: Remove `OPENCODE_PURE` from the owned OpenCode server's child environment. Quoder requires its external `shell.env` credential-clearing hook, so a parent pure-mode setting must not disable plugin loading for that server.

**Verification**: Unit coverage sets `OPENCODE_PURE=1` and confirms it is absent from the server launch environment. A later follow-up did not launch the rebuilt CLI: the launch command was submitted as a Quoder model prompt, which returned a natural-language answer. Separately, exact 1.18.33 Core V2 source (`packages/core/src/tool/bash.ts`) shows Bash creates its child process directly and explicitly leaves plugin `shell.env` augmentation as TODO. The disposable Bash observation still found both variables nonempty. The hook cannot protect this Core V2 path, so the runtime isolation implementation is failed.

**Rationale**: Removing `OPENCODE_PURE` allows plugin loading but does not cause Core V2 Bash to invoke the shell hook. A different isolation mechanism is required; keep permission decisions default-off until it is implemented and verified.

## 2026-10-05 — Core V2 Bash bypasses the shell environment hook

**Context**: The latest guided probe still reported the server password and inline config as nonempty. The user clarified that the attempted CLI relaunch produced an assistant reply interpreting the command, so it was entered into an existing Quoder session rather than at the operating-system shell prompt.

**Decision**: Treat the credential leak as confirmed and the rebuilt-launch comparison as invalid. Keep Group 8 failed and interactive grants default-off. Do not spend further QA runs on the plugin hook as a proposed fix: pinned Core V2 Bash source explicitly says plugin `shell.env` augmentation is TODO and starts the shell process without invoking the hook. A new isolation design is required before repeating the live probe.

**Evidence**: OpenCode `v1.18.33` source, `packages/core/src/tool/bash.ts`, lines 62 and 142–152; disposable shell probe result lists only `OPENCODE_CONFIG_CONTENT` and `OPENCODE_SERVER_PASSWORD` (names only). The attempted relaunch is not evidence for the rebuilt CLI because Quoder answered it as model input.

**Rationale**: The plugin hook's unit test exercises only its callback. It cannot establish a security boundary when the pinned V2 Bash implementation never calls that callback.

## 2026-10-05 — Reject a shell wrapper as a complete credential boundary

**Context**: The configured OpenCode `shell` field is a string and Core V2 Bash uses it for child process launch, so a wrapper initially appeared to be a local workaround. A same-user process can inspect another owned process's environment on this macOS host with `ps eww`; a harmless dummy-variable check returned `VISIBLE`. Clearing or changing a variable after process startup did not remove it from that output either.

**Decision**: Do not implement a shell wrapper as the credential-isolation fix. It can clear environment variables inherited by the shell, but cannot stop Bash from reading the authenticated server's environment through process inspection. It also does not cover local MCP subprocesses. OpenCode 1.18.34, the latest package reported by `npm view opencode-ai version`, still has the Core V2 `shell.env` TODO and its local MCP launcher merges `process.env` into the child environment (pinned tag source, `packages/opencode/src/mcp/index.ts`, lines 323–332).

**Required direction**: Keep permission decisions default-off. A passing design must cover both process-environment inheritance and same-user process inspection, and all model-callable local process launch paths. That likely requires an OpenCode runtime change that keeps server credentials out of process-visible environment and filters them from child environments, or an OS isolation boundary that is applied consistently to every model-callable process. Validate the full boundary before selecting or implementing one.

**Rationale**: A Bash-only wrapper would reduce accidental inheritance while leaving a working route to recover the same credentials and would miss local MCP processes. It would produce a false security claim.

## 2026-10-05 — Select a Seatbelt boundary around the OpenCode server

**Context**: The shell-wrapper rejection established that per-shell env clearing cannot stop same-user process inspection and cannot contain server-launched MCP processes. The user approved a macOS Seatbelt approach after a local probe showed that `sandbox-exec` can deny outbound access to loopback while preserving external HTTPS and prevents descendants from relaxing their inherited profile.

**Proposed boundary**: A Seatbelt profile around the authenticated OpenCode server can cover Core V2 Bash and server-launched descendants at exec time. The initial policy would deny loopback outbound access entirely; local-service exceptions are deferred until rule precedence and exclusion of the Quoder endpoint are proven. Seatbelt is macOS-only; unsupported systems or missing/invalid profiles must fail closed.

**Pinned-version integration finding**: Core V2 Bash `packages/core/src/tool/bash.ts` (v1.18.33, lines 142–152) reads the shell from Core V2 `Config.entries()` and passes it to `ChildProcess.make`. Core V2 `packages/core/src/config.ts` (v1.18.33, lines 128–205) builds these entries from filesystem-backed global and project config documents. Core `Global.make` selects the global config directory from `OPENCODE_CONFIG_DIR` when set. This provides a candidate path: point the server at a Quoder-owned temporary config directory containing a shell override, while mirroring the existing global config inputs without changing their source files. Project config is later in Core V2 precedence and must not override the wrapper. The current inline `OPENCODE_CONFIG_CONTENT` alone is not a verified Core V2 shell override. A whole-server Seatbelt profile also does not remove environment variables from the server's direct Bash child; inherited inline/provider credentials would remain readable and usable by that child. Applying the initial profile alone would give a misleading pass.

**Verification still required**: The user-provided experiment proves only that a standalone process cannot connect to one loopback target and that nested relaxation failed. It does not prove that OpenCode can bind and serve under a profile, that all IPv4/IPv6 routes to the authenticated listener are blocked, or that all process/file operations remain healthy. The temporary config directory must preserve user settings and plugin resources. A global `opencode.jsonc` collision and any project shell override need safe, fail-closed handling. No Core V2 runtime hook is exposed through Quoder's current remote SDK/plugin arrangement; a runtime hook would require an OpenCode host/runtime change or a separately verified replacement tool path. Do not enable permission decisions until the config overlay, complete boundary, independent review, and bounded runtime acceptance pass.

**Rationale**: Applying a process policy before OpenCode starts may contain local subprocess paths, but current source evidence does not provide Quoder with a reliable Core V2 shell override for stripping environment credentials. The password may remain in the server environment, but containment cannot be treated as complete while direct Bash children also inherit provider configuration secrets. Keep the gate closed while resolving the config/runtime boundary.

## 2026-10-05 — Implement the Seatbelt tool sandbox; diagnose the earlier startup failure

**Context**: The previous Group 3.1 attempt reported `server exited during startup (code 1)` and could not diagnose it, because the launcher discards server stderr and the probe coupled its security claim to a model prompt.

**Startup failure: not caused by the sandbox design.** Fourteen launch variants were replayed, including an exact reconstruction of the failing probe's configuration (private config mirror selected with `OPENCODE_CONFIG_DIR`, Quoder's plugin registration, the project `shell` override, and the trampoline). All fourteen started and printed a listening URL. Further variants confirm `opencode serve` performs no configuration validation at startup: malformed `OPENCODE_CONFIG_CONTENT`, unknown keys, a wrong-typed `shell`, and a malformed project `opencode.jsonc` all start normally. Port contention is also excluded: `--port=0` prefers 4096 and falls back to an ephemeral port when 4096 is held, and three concurrent servers on the same and different projects all started. The exit was environmental and transient; no configuration input reproduces it.

**Decision**: Implement the boundary as a Seatbelt profile applied to every model-run shell, delivered through a Quoder-owned private global config directory, and verify it with a model-free probe.

**Design**: `src/opencode-tool-sandbox.ts` mirrors the user's global configuration into a private `0700` directory, adds only `shell`, and writes a `0600` profile plus a `0700` trampoline. `src/opencode-server.ts` selects the mirror with `OPENCODE_CONFIG_DIR`. `launchSandboxedOpenCodeServer` prepares, launches, asserts, and removes the sandbox as one unit. `src/opencode-sandbox-assertion.ts` reads `GET /config` from the live server and refuses to continue unless the resolved `shell` is Quoder's trampoline and no local MCP server is configured. `src/opencode-project-policy.ts` now rejects a project `shell` as well as `plugin`, because project config outranks the private global layer in Core V2 precedence.

**Verified behaviour (model-free, via `opencode debug agent <name> --tool bash --params`)**: This executes the pinned Core V2 Bash implementation with no model call, which removes the previous nondeterminism. `npm run verify:sandbox` reports PASS for all ten predicates: sandbox prepared; Core V2 selected the trampoline; loopback denied; private config unreadable; process inspection denied; credential variables absent; nested sandbox cannot relax the profile; external network preserved; project `shell` override rejected; runtime assertion fails closed.

**Core V2 `shell` is honoured from both layers.** Contrary to the earlier note that an inline merge is not a V2 shell override, a marker file confirmed Core V2 Bash executes the configured `shell` when it is supplied through `OPENCODE_CONFIG_CONTENT` *and* when supplied through project config. The implementation still uses the filesystem-backed private global directory, as the spec requires.

**Four Seatbelt constraints found empirically; each would have produced a silent or fatal failure:**

1. **Rules must name realpath-resolved paths.** A `(deny file-read* (subpath "/var/..."))` rule does not match the kernel's `/private/var/...` and the denial is lost with no error. The first implementation read a sentinel successfully (`rc=0`) because of this. With the resolved path the read is refused, including through the `/var` alias and through `cp`.
2. **`env -i` is fatal under `(deny process-info*)`.** The sandboxed process dies with SIGTRAP (exit 133) during loader startup. The trampoline therefore uses `env -u` for each credential variable, which keeps the inherited environment otherwise intact.
3. **`(deny network-inbound ...)` breaks DNS**, because the system resolver binds a local socket (`bind: Operation not permitted`, with curl dying under SIGTRAP). Only outbound loopback is denied; reaching the server requires an outbound connection.
4. **`(deny process-info*)` alone breaks HTTPS.** It must be followed by `(allow process-info* (target self))`, after which external HTTPS returns 200 while inspection of other processes stays denied.

**Process-environment exposure confirmed, and its scope corrected.** `ps -axeww` does expose same-user process environments on this host (four sentinel occurrences), so the earlier finding stands. An unprivileged `KERN_PROCARGS2` read does not, so the exposure depends on `/bin/ps` being setuid root. Seatbelt refuses to exec setuid binaries under any profile, so `ps` reports `Operation not permitted` inside the sandbox; the explicit `process-info*` denial is defence in depth. This matters because `webfetch` runs inside the unsandboxed server process and can still reach loopback, so the password must stay unharvestable, not merely unusable from the shell.

**Probe honesty: two false passes found and fixed.** A negative control that neuters the profile in the built artifact initially reported PASS for every predicate. Two were not discriminating: the loopback stage used a raw TCP listener, against which `curl` fails whether or not the sandbox blocked it, and the harvest stage accepted a zero count with no proof the sentinel was discoverable. The listener is now a real HTTP server and the harvest stage first proves the sentinel is visible without the sandbox. With the negative control the loopback, private-config, and nested-escape predicates now correctly FAIL.

**Residual gaps, unchanged by this work**: `OPENCODE_SERVER_PASSWORD` remains in the server's own environment, by design, and is now inert rather than hidden. LSP and formatter subprocesses are not covered by `shell` and are not yet asserted against; only local MCP servers are. Linux has no backend and fails closed. `sandbox-exec` is deprecated in its man page though present and working on macOS 26.

**Gate status**: Interactive permission grants remain **default-off**. This change satisfies the Group 3.1 implementation and its model-free verification; Group 7 security review and Group 8 QA have not been re-run against it.
