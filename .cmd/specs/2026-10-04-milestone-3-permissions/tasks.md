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

## Group 3: Security hardening (not a gate on grants)

- [~] Isolate server credentials from model-run shell environments | `src/opencode-server.ts`, `src/opencode-project-policy.ts`, OpenCode plugin/config loading, `tests/`
  - **Accept**: Preserve server authentication, reject project plugin sources before launch while allowing plugin-free project settings, document user-level plugins as trusted, and state the verified credential-isolation limits without overclaiming containment. Isolation gaps are follow-up hardening, not a permission-prompt gate.
  - **Verify**: `npx vitest run tests/unit tests/integration` plus focused environment-isolation coverage.
  - **Constraints**: Re-verify exact pinned-version `shell.env` and `--pure` semantics against Group 1 evidence. Never put credentials in arguments, project files, traces, or fixtures.
- **Status**: PARTIAL, descoped from blocking. The plugin hook is not called by Core V2 Bash 1.18.33, and same-user `ps` can read the server environment. Per the 2026-10-06 requirement restatement this is defence in depth, not a precondition for grants, so it no longer blocks. Remaining hardening is tracked in Group 3.1; see `decisions.md`.

## Group 3.1: Optional macOS Seatbelt hardening

- [~] Extend Seatbelt verification to the Core V2 session path | `src/opencode-tool-sandbox.ts`, `src/opencode-sandbox-assertion.ts`, `scripts/verify-sandbox.ts`, `tests/`
  - **Accept**: Report the sandbox as active only when verified through the exact harness session path. Keep the current UI disclosure that model-run tools are unconfined until that evidence exists. This optional hardening does not gate permission prompts.
  - **Verify**: Retain the deterministic `opencode debug agent --tool bash` regression checks, and require a real harness-session invocation before claiming Core V2 containment. Verify the effective shell and tool process behavior rather than relying on `/config` alone.
  - **Constraints**: Do not change the accepted permission-grant risk decision. Do not claim that sandboxing contains the Core V2 path based on the debug-agent path. Linux remains without a verified sandbox backend.
  - **Evidence**: Implemented in `src/opencode-tool-sandbox.ts`, `src/opencode-sandbox-assertion.ts`, `launchSandboxedOpenCodeServer` in `src/opencode-server.ts`, wired through `src/cli.ts`, with project `shell` rejection in `src/opencode-project-policy.ts`. `npm run typecheck`, `npm test` (25 files, 485 tests), `npm run build`, `npm run build:live`, and `git diff --check` all passed. `npm run verify:sandbox` reports PASS for all ten predicates with no model call, driving real Core V2 Bash through `opencode debug agent --tool bash`. End-to-end against a real server: the resolved `shell` is Quoder's trampoline, zero local MCP servers, unauthenticated `/global/health` still returns 401, and the sandbox directory is removed on close. A negative control that neuters the profile correctly fails the loopback, private-config, and nested-escape predicates.
  - **Startup diagnosis**: The earlier exit-code-1 failure was not caused by any configuration the probe wrote. Fourteen launch variants, including an exact reconstruction, all started; `opencode serve` performs no startup configuration validation, and port contention is excluded. See `decisions.md`.
  - **Residual**: The boundary does not hold on the Core V2 Bash path, because `Shell.preferred()` discards a configured shell whose filename is not a recognised shell name. LSP and formatter paths are not asserted against. `OPENCODE_SERVER_PASSWORD` stays in the server's own environment by design. Linux has no verified backend. These gaps are optional hardening and do not block grants under the 2026-10-06 requirement restatement.
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
  - **Evidence**: `npm run typecheck`; focused `vitest` run of `line-keys`, `event-monitor`, `session-runner`, `opencode-adapter`, and `integration/harness` passed (150 tests). Permission forwarding is enabled by the CLI as of 2026-10-06.

## Group 5: Automated acceptance coverage

- [x] Cover required permission scenarios and security regressions | `tests/`, `scripts/verify-harness.ts`, `scripts/verify-permissions.ts`
  - **Accept**: Deterministic coverage verifies allowed command execution, ask prompting, denied command blocking, outside-project read policy, outside-project edit policy, saved-pattern project scoping and revocation, and the prerequisite security cases. The live acceptance procedure is documented and does not run automatically.
  - **Verify**: `npx vitest run` and `npx tsc --noEmit -p .`.
  - **Constraints**: Live model acceptance requires explicit developer authorization for that run. Do not record model replies in tracked files.
  - **Evidence**: `npm test` passed (22 files, 441 tests); `npm run typecheck`, `npm run build:live`, and `git diff --check` passed. `npm run verify:permissions` passed the no-model runtime checks for pending ask, exact native saved pattern, project A/B isolation, revocation, and ask-after-revocation. Model-based scenarios remain optional follow-up; the gate is now enabled.

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
  - **Cycle 2**: PASS with no critical findings or warnings. Its suggestion to keep decisions default-off until QA verifies tool-shell isolation is explicitly declined per the 2026-10-06 requirement restatement: the prompt is a safety affordance, not a containment boundary, and the residual self-approval risk is accepted for this single-developer local tool.

## Fix Group 7.1: Close escaped plugin-key scanner bypass

- [x] Parse project OpenCode JSON/JSONC configuration and reject decoded `plugin` properties | `src/opencode-project-policy.ts`, `tests/unit/opencode-project-policy.test.ts`
  - **Accept**: Valid JSON and JSONC property spellings that decode to `plugin` are rejected before server launch; unrelated strings/comments containing the word do not cause a false rejection. Existing scanner boundaries remain covered.
  - **Verify**: `npm test` and `npm run typecheck`.
  - **Constraints**: Do not weaken fail-closed behavior on malformed or unreadable config. The later 2026-10-06 requirement restatement enables prompts in the CLI while keeping the harness dependency default-off; do not reintroduce a global default-off gate.
  - **Evidence**: Added escaped-key rejection plus decoy-string/comment and comment-separated-colon tests. `npm test` passed (22 files, 444 tests), `npm run typecheck`, and `git diff --check` passed.

## Group 8: QA gate

- [x] Validate regression, permission scenarios, and release confidence for the restated scope | `.cmd/specs/2026-10-04-milestone-3-permissions/qa.md`
  - **Accept**: QA report records automated and manual coverage, residual gaps, release confidence, and PASS/FAIL. Any live scenarios remain pending until explicitly authorized and performed.
  - **Verify**: `rg -i 'verdict.*pass|verdict.*fail' .cmd/specs/2026-10-04-milestone-3-permissions/qa.md`
  - **Constraints**: Keep historical failed QA cycles as history; use the 2026-10-06 verdict for the restated scope. Credential isolation, outside-project live scenarios, and adversarial `core.worktree` coverage are follow-ups, not gates on interactive prompts.
  - **Evidence**: The 2026-10-06 QA report records PASS for interactive permission handling under the changed scope, automated checks, and explicit disclosure that model-run tools are unconfined. Remaining scenarios are listed as non-blocking follow-ups in `qa.md`.

## Group 9: Documentation and closure

- [x] Update user and technical documentation; close the spec | `README.md`, `docs/tech.md`, `.cmd/specs/currentspec.md`
  - **Accept**: README and technical notes match reviewed behavior, unresolved limitations are explicit, all gates have passed, and `currentspec.md` is cleared.
  - **Verify**: `git diff --check` and documentation review against the final implementation and QA report.
  - **Constraints**: Do not document descoped or unverified behavior.
  - **Evidence**: Reviewed against `handoff-credentials.md`, the 2026-10-06 QA PASS, and the passing general/security review cycles. README, `docs/tech.md`, and `SYSTEM_CONTEXT.md` describe enabled permission prompts and the unconfined model-run tools consistently. Historical failed QA cycles remain labeled as superseded history; optional hardening and QA follow-ups are disclosed. `git diff --check` passed.
