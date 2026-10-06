# Tasks: Milestone 3 — Interactive Permission Handling

Spec: `.cmd/specs/2026-10-04-milestone-3-permissions/spec.md`

## Group 1: Research and security prerequisites

- [x] Verify the pinned OpenCode permission and persistence contract | `docs/tech.md`, `.cmd/specs/2026-10-04-milestone-3-permissions/decisions.md`
  - **Accept**: Record the exact 1.18.33 request/reply shapes, meaning of `once`/`always`/`reject`, `save` behavior, and whether persistent approval is confined to the current project and saved patterns. Distinguish generated declarations, bundled implementation evidence, and runtime-confirmed behavior. No persistent grant is approved on declaration evidence alone.
  - **Verify**: `rg -n 'PermissionV2Reply|V2SessionPermission|PermissionSavedInfo|Project scoping and persistence' docs/tech.md`
  - **Constraints**: Do not run a model prompt or inspect user OpenCode configuration. A no-model runtime acceptance scenario remains required in Group 5/QA.
- [x] Verify and record existing credential-isolation, event-monitor, root-containment, and child-session evidence | `docs/tech.md`, `.cmd/specs/2026-10-04-milestone-3-permissions/decisions.md`
  - **Accept**: Record what is confirmed, its evidence source, and remaining implementation/proof gaps for `shell.env` and `--pure`, project root validation, child-session parent IDs, explicit reply values, and sanitized project labels.
  - **Verify**: `rg -n 'Milestone 3 Security Prerequisites|shell\.env|parentID|core\.worktree|replyPermission' docs/tech.md`
  - **Constraints**: Treat prior spec findings and the pinned SDK declarations as evidence with their stated limits; do not represent static type declarations as live behavior.

## Group 2: Permission interaction design

- [x] Define terminal permission prompt states and input behavior | `.cmd/specs/2026-10-04-milestone-3-permissions/spec.md`, `.cmd/specs/2026-10-04-milestone-3-permissions/decisions.md`
  - **Accept**: Specify display fields, Allow once / Allow for project / Deny affordances, exact display of `request.save` patterns and disabled state when empty, simultaneous and stale requests, no-input and EOF behavior, Ctrl-C, status-line interaction, sanitization, and the project-persistence behavior from Group 1.
  - **Verify**: `rg -n 'Permission prompt interaction|Non-TTY|Ctrl-C|stale|request\.save|Keyboard guidance' .cmd/specs/2026-10-04-milestone-3-permissions/spec.md`
  - **Constraints**: Use the shared CMD UI design role sequentially if delegation is unavailable. Do not promise command details absent from verified event data.

## Group 3: Security prerequisites

- [!] Isolate server credentials from model-run shell environments | `src/opencode-server.ts`, `src/opencode-project-policy.ts`, OpenCode plugin/config loading, `tests/`
  - **Accept**: The server remains authenticated, model-run shell environments cannot read or use the server credentials, project plugin sources are rejected before launch while plugin-free project settings remain enabled, and user-level plugins are documented as trusted.
  - **Verify**: `npx vitest run tests/unit tests/integration` plus focused environment-isolation coverage.
  - **Constraints**: Re-verify exact pinned-version `shell.env` and `--pure` semantics against Group 1 evidence. Never put credentials in arguments, project files, traces, or fixtures.
- **Status**: FAIL. The plugin hook function is unit-covered but Core V2 Bash 1.18.33 does not call it. A configurable shell wrapper is not sufficient: same-user `ps eww` can read the server environment, and local MCP subprocesses inherit it. Design and verify a comprehensive process isolation boundary before marking complete; see `qa.md` and `decisions.md`.

## Group 3.1: macOS Seatbelt isolation implementation

- [x] Install a temporary Core V2 shell override and complete the Seatbelt boundary | `src/opencode-server.ts`, `src/opencode-project-policy.ts`, `tests/`
  - **Accept**: Quoder supplies a model-shell trampoline through a private temporary global config directory selected with `OPENCODE_CONFIG_DIR`, without editing the existing user config or target project. It clears inherited credentials and applies a non-relaxable child profile. The authenticated server and all server-launched descendants are also contained so leaked server credentials cannot be used. Any unsupported config collision, missing tool, invalid profile, unsupported platform, or uncertain launch/config behavior fails closed and keeps grants disabled.
  - **Verify**: Cover the pinned Core V2 filesystem config load and actual shell invocation; preserve existing user config through a private mirror; reject project shell overrides; verify server authentication, denied loopback and process inspection, credential-free shell environment, private-file denial, nested sandbox behavior and server-launched child paths. Only then run bounded model acceptance from a real OS terminal.
  - **Constraints**: Core V2 Bash 1.18.33 reads `shell` from filesystem-backed `Config.entries()` and passes it to `ChildProcess.make`; Quoder's `OPENCODE_CONFIG_CONTENT` merge alone is not a V2 shell override. `OPENCODE_CONFIG_DIR` redirects Core V2's global config directory, so the temporary tree must preserve the user's existing config and plugin resources without altering their originals. Project config has later precedence; reject project shell overrides. Server-wide Seatbelt alone is insufficient while shell children inherit inline/provider credential variables. Keep interactive grants default-off. Initially deny all loopback destinations; do not add local-service exceptions until Seatbelt rule precedence and server-port exclusion are proven. Linux remains unsupported for grants until it has an independent verified backend.
  - **Evidence**: Implemented in `src/opencode-tool-sandbox.ts`, `src/opencode-sandbox-assertion.ts`, `launchSandboxedOpenCodeServer` in `src/opencode-server.ts`, wired through `src/cli.ts`, with project `shell` rejection in `src/opencode-project-policy.ts`. `npm run typecheck`, `npm test` (25 files, 485 tests), `npm run build`, `npm run build:live`, and `git diff --check` all passed. `npm run verify:sandbox` reports PASS for all ten predicates with no model call, driving real Core V2 Bash through `opencode debug agent --tool bash`. End-to-end against a real server: the resolved `shell` is Quoder's trampoline, zero local MCP servers, unauthenticated `/global/health` still returns 401, and the sandbox directory is removed on close. A negative control that neuters the profile correctly fails the loopback, private-config, and nested-escape predicates.
  - **Startup diagnosis**: The earlier exit-code-1 failure was not caused by any configuration the probe wrote. Fourteen launch variants, including an exact reconstruction, all started; `opencode serve` performs no startup configuration validation, and port contention is excluded. See `decisions.md`.
  - **Residual**: LSP and formatter subprocess paths are not yet asserted against (only local MCP is). `OPENCODE_SERVER_PASSWORD` stays in the server's own environment by design and is now inert. Linux fails closed. Group 7 security review and Group 8 QA have not been re-run against this change, so interactive grants remain default-off.
- [x] Contain Git project roots and sanitize project labels | `src/harness/project.ts`, `src/harness/repl.ts`, `tests/`
  - **Accept**: A canonical Git root is accepted only when it contains the canonical launch directory; otherwise use a safe launch-directory fallback. Banner and prompt labels sanitize both project name and root.
  - **Verify**: `npx vitest run tests/unit/project.test.ts tests/unit/repl.test.ts`
  - **Constraints**: Cover crafted `core.worktree` and symlink/canonical-path cases without trusting Git output as a containment proof.
- [x] Require explicit permission replies | `src/opencode-adapter.ts`, `tests/`
  - **Accept**: The adapter cannot grant permission when a caller omits the reply value.
  - **Verify**: `npx tsc --noEmit -p .` and focused adapter coverage.
  - **Constraints**: No implicit `once` or `always` default.

## Group 4: Permission routing and terminal interaction

- [x] Register session-tree ownership for permission and question events | `src/event-monitor.ts`, `src/harness/session-runner.ts`, `tests/`
  - **Accept**: Child sessions are associated with the owning harness execution before their permission/question requests can be ignored; unrelated sessions remain untouched.
  - **Verify**: Focused monitor and runner tests cover child event ordering and ownership boundaries.
  - **Constraints**: Preserve the run-long preconnected monitor; permission events are not replayable.
- [x] Implement interactive permission decisions and native replies | `src/harness/repl.ts`, `src/harness/line-keys.ts`, `src/harness/live-view.ts`, `src/opencode-adapter.ts`, `tests/`
  - **Accept**: Valid user choices are forwarded to the matching session/request through Core V2; no other path can approve. Questions remain separate. Requests and decisions are sanitized and shown through `LiveView.note` while busy.
  - **Verify**: Focused REPL, line-key, event-monitor and adapter tests cover each choice, cancellation, EOF, stale request and reply failure.
  - **Constraints**: Project-scoped approval is implemented only if Group 1 confirms its exact native scope. Keep Ctrl-C cancellation and multiline prompt behavior intact.
  - **Evidence**: `npm run typecheck`; focused `vitest` run of `line-keys`, `event-monitor`, `session-runner`, `opencode-adapter`, and `integration/harness` passed (150 tests). Permission forwarding remains default-off pending Group 7.

## Group 5: Automated acceptance coverage

- [x] Cover required permission scenarios and security regressions | `tests/`, `scripts/verify-harness.ts`, `scripts/verify-permissions.ts`
  - **Accept**: Deterministic coverage verifies allowed command execution, ask prompting, denied command blocking, outside-project read policy, outside-project edit policy, saved-pattern project scoping and revocation, and the prerequisite security cases. The live acceptance procedure is documented and does not run automatically.
  - **Verify**: `npx vitest run` and `npx tsc --noEmit -p .`.
  - **Constraints**: Live model acceptance requires explicit developer authorization for that run. Do not record model replies in tracked files.
  - **Evidence**: `npm test` passed (22 files, 441 tests); `npm run typecheck`, `npm run build:live`, and `git diff --check` passed. `npm run verify:permissions` passed the no-model runtime checks for pending ask, exact native saved pattern, project A/B isolation, revocation, and ask-after-revocation. Model-based scenarios remain for Group 8 after Group 7 review and enabling the default-off gate.

## Group 6: General review

- [x] Review implementation for correctness and maintainability | `.cmd/specs/2026-10-04-milestone-3-permissions/review.md`
  - **Accept**: Reviewer report is persisted verbatim with PASS, zero critical findings, and zero warnings.
  - **Verify**: `rg -i 'verdict.*pass' .cmd/specs/2026-10-04-milestone-3-permissions/review.md`
  - **Constraints**: Maximum three cycles; do not proceed until PASS.
  - **Evidence**: Cycle 1 returned PASS with no findings; the reviewer independently ran `npm test` (441 tests) and `npm run typecheck`.

## Group 7: Security review

- [x] Review permission, credential, project-scope, and terminal-input boundaries | `.cmd/specs/2026-10-04-milestone-3-permissions/security-review.md`
  - **Accept**: Security report is persisted verbatim with PASS, zero critical findings, and zero warnings.
  - **Verify**: `rg -i 'verdict.*pass' .cmd/specs/2026-10-04-milestone-3-permissions/security-review.md`
  - **Constraints**: Run after general review passes. Maximum three cycles.
  - **Cycle 1**: FAIL. The project plugin scanner can be bypassed with a valid escaped JSON property name. See `security-review.md`; interactive decisions remain default-off.
  - **Cycle 2**: PASS with no critical findings or warnings. One suggestion says to keep permission decisions default-off until QA verifies runtime tool-shell isolation.

## Fix Group 7.1: Close escaped plugin-key scanner bypass

- [x] Parse project OpenCode JSON/JSONC configuration and reject decoded `plugin` properties | `src/opencode-project-policy.ts`, `tests/unit/opencode-project-policy.test.ts`
  - **Accept**: Valid JSON and JSONC property spellings that decode to `plugin` are rejected before server launch; unrelated strings/comments containing the word do not cause a false rejection. Existing scanner boundaries remain covered.
  - **Verify**: `npm test` and `npm run typecheck`.
  - **Constraints**: Do not weaken fail-closed behavior on malformed or unreadable config. Do not enable permission decisions by default; rerun Group 7 security review after the fix.
  - **Evidence**: Added escaped-key rejection plus decoy-string/comment and comment-separated-colon tests. `npm test` passed (22 files, 444 tests), `npm run typecheck`, and `git diff --check` passed. Permission decisions remain default-off.

## Group 8: QA gate

- [!] Validate regression, permission scenarios, and release confidence | `.cmd/specs/2026-10-04-milestone-3-permissions/qa.md`
  - **Accept**: QA report records automated and manual coverage, residual gaps, release confidence, and PASS/FAIL. Any live scenarios remain pending until explicitly authorized and performed.
  - **Verify**: `rg -i 'verdict.*pass|verdict.*fail' .cmd/specs/2026-10-04-milestone-3-permissions/qa.md`
  - **Constraints**: Do not claim the exit criterion is met while a required scenario lacks evidence.
  - **Blocked**: The user-authorized disposable Bash probe confirmed `OPENCODE_SERVER_PASSWORD` and `OPENCODE_CONFIG_CONTENT` remain nonempty in the model-run shell. Core V2 Bash does not call the `shell.env` hook. Implement and verify the new macOS Seatbelt boundary and pre-launch disabling of server-launched subprocesses before further live permission scenarios. Keep permission decisions default-off. Outside-project permission flows and adversarial `core.worktree` coverage also remain outstanding. See `qa.md`.

## Group 9: Documentation and closure

- [ ] Update user and technical documentation; close the spec | `README.md`, `docs/tech.md`, `.cmd/specs/currentspec.md`
  - **Accept**: README and technical notes match reviewed behavior, unresolved limitations are explicit, all gates have passed, and `currentspec.md` is cleared.
  - **Verify**: `git diff --check` and documentation review against the final implementation and QA report.
  - **Constraints**: Do not document descoped or unverified behavior.
