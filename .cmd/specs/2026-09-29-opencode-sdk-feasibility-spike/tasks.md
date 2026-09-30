# Tasks: OpenCode SDK Feasibility Spike

Spec: `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/spec.md`

## Group 1: Verify OpenCode contracts

- [x] Research and document the installed OpenCode TypeScript SDK/API | `docs/tech.md`
  - **Packages**: Determine and record the exact package name and installed/tested version; do not assume a package identifier before verification.
  - **Accept**: `docs/tech.md` cites authoritative sources or locally inspected package declarations for connection/hosting, project-directory selection, session create/delete, prompt submission, structured event streaming, permission response, cancellation, and final-result retrieval. It records exact package/runtime versions, import paths, signatures or typed call shapes, stability status, a deterministic `ask` action under the existing policy, cancellation terminal-state/event ordering, and version applicability.
  - **Verify**: `rg -n 'Package|Version|Import|Signature|Source|Project directory|Session creation|Session deletion|Streaming|Permission request|Permission response|Cancellation|Final result|Node|npm' docs/tech.md` returns a match for every named contract; then manually inspect the document and record a checklist in the task notes confirming each contract has an official URL or local package-file path and an exact tested version.
  - **Constraints**: Inspect the target environment and official/local package artifacts. Do not implement against inferred APIs. Flag any missing critical capability immediately.
  - **Completed evidence**: Core V2 has no native delete method in 1.18.33. An isolated live check proved `client.session.delete` removes a `client.v2.session.create` session: legacy delete returned HTTP 200/`true`, and the following Core V2 get returned HTTP 404 `SessionNotFoundError`. The version-scoped compatibility bridge and all required contracts/checklist items are recorded in `docs/tech.md`.

## Group 2: Define tests

- [x] Define probe contracts and red-phase automated tests | `src/capabilities.ts`, `src/report.ts`, `tests/unit/`
  - **Packages**: Use only the test/build dependencies approved and versioned by the preceding research task.
  - **Accept**: Tests define all nine capability outcomes, event classification, aggregate PASS/FAIL behavior, cleanup on success/error/cancellation, exact `hello.txt` content, project-directory confinement, the spec's nonce/sentinel isolation predicate, a real-permission-event predicate, and the cancellation start-event/terminal-state/no-late-completion predicates. Tests fail only because implementation is absent.
  - **Verify**: Run the versioned test command selected in `docs/tech.md` and confirm the expected red-phase failures are recorded in the task notes before marking complete.
  - **Constraints**: Test doubles may validate probe-owned logic but must not be presented as evidence that OpenCode capabilities exist. Do not invoke a live model in the default unit-test command.
  - **Completed evidence**: Installed only the approved exact development dependencies: `typescript@7.0.2`, `vitest@5.0.2`, and `@types/node@24.12.2`. The strict TypeScript compile command completed successfully for both contract modules and both unit-test files. `npx --no-install vitest run --reporter=dot` collected 27 tests: one static capability-matrix contract passed and the other 26 failed at the explicit `Group 3 implementation absent: <contract>` placeholders. Those expected red-phase failures cover fresh unique session IDs, correlated final model output, structured events, permission events, exact file content, path confinement, cancellation ordering and no late completion, success/error/cancellation cleanup, verified deletion, nonce/sentinel isolation, and report aggregation/rendering. No live model or OpenCode runtime was invoked.

## Group 3: Implement the probe core

- [x] Build the verified OpenCode integration boundary and capability runner | `src/opencode-adapter.ts`, `src/capabilities.ts`, `src/report.ts`, `package.json`, `tsconfig.json`
  - **Packages**: Use the exact OpenCode SDK/API and TypeScript/tooling versions verified in `docs/tech.md`.
  - **Accept**: The Group 2 tests pass; the implementation exposes only verified operations needed by the spike, applies finite timeouts, preserves structured diagnostic evidence, and attempts session deletion on success, failure, and cancellation.
  - **Verify**: Run the documented typecheck and unit-test commands from `docs/tech.md`.
  - **Constraints**: Do not add CLI/TUI application behavior or later-milestone features. Do not scrape terminal output when a verified structured event exists. Do not silently convert unsupported capabilities to PASS.
  - **Completed evidence**: Implemented the pinned `@opencode-ai/sdk/v2` boundary for session creation, prompt admission, durable event streaming, one-time permission replies, interruption, idle waiting, projected messages, and the verified legacy-delete/Core-V2-404 compatibility assertion. Every request and stream has a finite abort timeout, failures retain structured operation/status/error-tag diagnostics, and the capability runner attempts reverse-order session cleanup on success, error, and cancellation. `npm run typecheck`, `npm test -- --reporter=dot` (27/27 passing), and `git diff --check` passed without invoking OpenCode or a model.

## Group 4: Implement live integration verification

- [x] Implement the opt-in disposable-repository integration scenario | `tests/integration/`, `scripts/`
  - **Packages**: No additional packages unless researched, versioned, and documented in `docs/tech.md`.
  - **Accept**: `npm run verify:live` creates an isolated temporary Git repository; creates a fresh session scoped to it; invokes the existing local model; observes a structured streaming event; exercises an actual OpenCode permission request and response; verifies exact `hello.txt` content; executes the specified cancellation protocol; deletes sessions; creates a second session; performs the exact nonce/sentinel isolation assertion; prints each of the nine named criteria exactly once; prints an overall verdict; and exits nonzero unless all criteria pass.
  - **Verify**: Run unit tests and a smoke execution using test doubles or a deliberately unavailable-runtime fixture to prove timeout, cleanup, report shape, and exit-code behavior. The authoritative live OpenCode/Ollama run is reserved for the post-review QA gate.
  - **Constraints**: Never run file-modification prompts against the Quoder working tree. Use an explicit temporary directory, validate the resolved path before use, and clean it up safely. Do not change OpenCode/Ollama configuration.
  - **Completed evidence**: Added the opt-in `npm run verify:live` entry point, an OS-temporary disposable Git repository with validated cleanup boundaries, the two-session nonce/sentinel scenario, real Core V2 event and permission handling, exact file verification, cancellation fixture/process checks, deletion evidence, and the ordered nine-row verdict. Deterministic integration tests and `npm run verify:live:smoke` exercise report shape, nonzero unavailable-runtime behavior, finite timeout configuration, driver cleanup, temporary-environment cleanup, and conservative FAIL verdicts for either cleanup failure without invoking OpenCode or a model. `npm run typecheck`, `npm test -- --reporter=dot` (33/33), `npm run verify:live:smoke`, and `git diff --check` passed. The authoritative live scenario was not run and remains reserved for Group 7 QA.

## Group 5: Review gate

- [x] Code review of the feasibility implementation | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md`
  - **Packages**: None.
  - **Accept**: Reviewer returned a verdict of PASS, and the orchestrator persisted the report verbatim to `review.md`. Zero critical findings and zero warnings.
  - **Verify**: `grep -i 'verdict.*pass' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md`
  - **Constraints**: Do not proceed until this passes. Maximum three review cycles; escalate if still failing.
  - **Failed cycle 1**: Reviewer found four critical evidence/test gaps and one warning. See `review.md`. Security review is blocked pending the fix groups and a passing review cycle.
  - **Completed evidence**: After the user-authorized Cycle 4 correction, narrowly scoped Cycle 5 returned PASS with zero critical findings and zero warnings. The corrected Core V2 permission-event path and driver-level regression coverage close the final escalated general-review finding. See `review.md`.

## Fix Group 1: Repair live evidence integrity

- [x] Correct isolation, cancellation, response-correlation, and confinement evidence | `src/live-probe.ts`, `tests/integration/live-probe.test.ts`
  - **Packages**: None.
  - **Accept**: Session one is deleted and verified before session two is created; cancellation ordering and late-completion rejection derive from observed post-interrupt events; the final `TOKEN_STORED` response is correlated to the admitted input; path evidence is evaluated against the independently created disposable repository; regression tests cover each corrected behavior including an outside-repository negative case.
  - **Verify**: `npm run typecheck && npm test -- --reporter=dot && npm run verify:live:smoke`
  - **Constraints**: Do not run the authoritative live model scenario. Do not weaken any capability predicate to make tests pass. Preserve temporary-directory safety and conservative failure behavior.
  - **Completed evidence**: Session one now passes the adapter's delete-plus-Core-V2-404 verification before session two is created, and the verified deletion is retained without duplicate cleanup. Cancellation keeps the structured global event stream open through interruption and an observed session-idle event, derives ordering from those observations, and rejects a post-interrupt fixture completion. Final assistant text is selected only after the admitted user input and must equal `TOKEN_STORED`; path evidence is checked against the independently created disposable repository. Regression coverage includes deletion/creation order, post-interrupt completion, response mismatch/decorated output, and an outside-repository path. `npm run typecheck`, `npm test -- --reporter=dot` (37/37), `npm run verify:live:smoke`, and `git diff --check` passed without invoking OpenCode or a model.

## Fix Group 2: Test the OpenCode adapter boundary

- [x] Add typed fake-client coverage for the version-sensitive adapter | `tests/unit/opencode-adapter.test.ts`, `src/opencode-adapter.ts`
  - **Packages**: None.
  - **Accept**: Tests cover verified request payloads, finite abort timeouts, structured error diagnostics, one-time permission replies, stream cleanup, and legacy-delete followed by Core V2 404 verification, including representative success and failure paths.
  - **Verify**: `npm run typecheck && npm test -- --reporter=dot && git diff --check`
  - **Constraints**: Do not invoke OpenCode or a model. Test doubles must match the pinned 1.18.33 shapes closely enough for strict TypeScript compilation.
  - **Completed evidence**: Added SDK-derived typed fake-client coverage for Core V2 session, prompt, permission, and SSE payloads; finite request aborts; structured operation/status/error-tag diagnostics; default one-time permission replies; per-session and global stream teardown; and the version-scoped legacy-delete/Core-V2-404 bridge across success and failure paths. The fake responses preserve the pinned 1.18.33 nested response envelopes. `npm run typecheck`, `npm test -- --reporter=dot` (47/47), and `git diff --check` passed without invoking OpenCode or a model.

## Fix Group 3: Review cycle 2

- [!] Re-review Groups 2–4 and cycle-1 fixes | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md`
  - **Packages**: None.
  - **Accept**: Reviewer returns PASS with zero critical findings and zero warnings; the complete report is appended verbatim as Cycle 2 in `review.md`; the original Group 5 review task is then marked `[x]`.
  - **Verify**: `grep -i '## Cycle 2' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md && tail -n 20 .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md | grep -i 'verdict.*pass'`
  - **Constraints**: Do not start Group 6 security review until Cycle 2 passes. Maximum three total review cycles.
  - **Failed cycle 2**: Reviewer confirmed Cycle 1 findings were resolved but found two critical unjoined-promise paths in permission handling and cancellation idle waiting. See `review.md`. Security review remains blocked.

## Fix Group 4: Settle paired async operations

- [x] Join permission/event and idle-wait/event operations safely | `src/live-probe.ts`, `tests/integration/live-probe.test.ts`
  - **Packages**: None.
  - **Accept**: Permission request and event observation are always settled when either branch succeeds, fails, ends, or times out, with request diagnostics preserved; cancellation idle wait and event observation are likewise always settled; regression tests cover stream failure/no matching event plus request rejection and each cancellation branch failing first.
  - **Verify**: `npm run typecheck && npm test -- --reporter=dot && npm run verify:live:smoke && git diff --check`
  - **Constraints**: Do not run the authoritative live model scenario. Do not suppress or detach promise rejections. Preserve conservative FAIL behavior and finite timeouts.
  - **Completed evidence**: Added a paired-operation settlement helper that awaits both branches with `Promise.allSettled`, reports branch-labeled diagnostics for either or both failures, and never detaches a rejection. Permission event observation (including the one-time reply) is now joined with permission creation, so stream end/failure cannot abandon the request. Post-interrupt event observation is likewise joined with the idle wait and always closes its stream. Regression tests cover combined permission stream/request rejection, no matching permission event plus later request rejection, and cancellation failures in both first-failing orders. `npm run typecheck`, `npm test -- --reporter=dot` (51/51), `npm run verify:live:smoke`, and `git diff --check` passed without invoking OpenCode or a model.

## Fix Group 5: Review cycle 3

- [!] Final re-review of Groups 2–4 and all fixes | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md`
  - **Packages**: None.
  - **Accept**: A fresh reviewer returns PASS with zero critical findings and zero warnings; the complete report is appended verbatim as Cycle 3; the original Group 5 review task is marked `[x]`.
  - **Verify**: `grep -i '## Cycle 3' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md && tail -n 20 .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md | grep -i 'verdict.*pass'`
  - **Constraints**: This is the third and final allowed review cycle. If it fails, escalate unresolved criticals to the user. Do not start security review without PASS.
  - **Failed cycle 3**: The fresh reviewer found an unjoined initial prompt/event pair and missing correlation between the observed permission event and the permission request created by the probe. This exhausted the three-cycle review limit; the unresolved criticals are escalated to the user and security review remains blocked. See `review.md`.

## Fix Group 6: Resolve Cycle 3 correctness findings

- [x] Join initial prompt/event operations and correlate permission evidence | `src/live-probe.ts`, `tests/integration/live-probe.test.ts`
  - **Packages**: None.
  - **Accept**: Initial prompt submission and structured-event observation always settle together when either branch succeeds, fails, ends, or times out, preserving diagnostics from both branches; regression tests cover each branch failing first. Permission capability evidence requires the created request to have the expected ask effect and the observed permission event ID to equal the created request ID; negative tests cover mismatched IDs and unexpected effects.
  - **Verify**: `npm run typecheck && npm test -- --reporter=dot && npm run verify:live:smoke && git diff --check`
  - **Constraints**: Implement only the two Cycle 3 critical fixes. Do not run the authoritative live model scenario. Do not weaken finite timeouts, conservative FAIL behavior, permission enforcement, or structured diagnostics. Do not represent unrelated session permission events as evidence.
  - **Completed evidence**: Initial prompt submission and event observation now use paired all-settled handling with both branch diagnostics and deterministic stream closure. Permission creation requires effect `ask`, event observation filters for the exact created request ID, and the reply occurs only after explicit correlation. Regression tests cover either initial branch failing first, mismatched permission IDs, and unexpected effects. `npm run typecheck`, 56/56 tests, `npm run verify:live:smoke`, and `git diff --check` passed on 2026-09-29. The authoritative live model scenario was not run.

## Fix Group 7: Exceptional review cycle 4

- [!] Fresh re-review of Groups 2–4 and all fixes | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md`
  - **Packages**: None.
  - **Accept**: A fresh reviewer returns PASS with zero critical findings and zero warnings; the complete report is appended verbatim as Cycle 4; the original Group 5 review task is marked `[x]` only on PASS.
  - **Verify**: `grep -i '## Cycle 4' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md && tail -n 25 .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md | grep -i 'verdict.*pass'`
  - **Constraints**: This is the single user-authorized exception to the three-cycle limit. If Cycle 4 fails, mark this task `[!]`, keep security review blocked, escalate the complete findings to the user, and stop. Do not create Cycle 5.
  - **Failed cycle 4**: Reviewer found that the live permission observer uses the legacy `permission.asked` event instead of the verified Core V2 `permission.v2.asked` event and payload. The authorized exception is exhausted; security review remains blocked and no Cycle 5 was created. See `review.md`.

## Fix Group 8: Narrowly scoped review cycle 5

- [x] Fresh review of only the user-directed Cycle 4 correction | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md`
  - **Packages**: None.
  - **Accept**: A fresh reviewer confirms the production permission observation/classification path uses the pinned Core V2 `permission.v2.asked` event and typed payload; the driver-level typed-fake regression test proves request-ID correlation, required `ask` effect, reply only for the correlated request, completion without event timeout, and rejection of legacy `permission.asked` as evidence. The reviewer returns PASS with zero critical findings and zero warnings in this scope; the report is appended verbatim as Cycle 5; the original Group 5 review gate is marked `[x]`.
  - **Verify**: `npm run typecheck && npm test -- --reporter=dot && npm run verify:live:smoke && git diff --check && grep -i '## Cycle 5' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md && tail -n 30 .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md | grep -i 'verdict.*pass'`
  - **Constraints**: Review only the user-directed Cycle 4 correction. Do not broaden into Cycle 5 implementation work. Do not run the authoritative live OpenCode/Ollama scenario. Do not begin security review or QA under this authorization.
  - **Completed evidence**: Fresh Cycle 5 review returned PASS with no critical findings, warnings, or suggestions. Typecheck, 57/57 tests, conservative live smoke verification, and diff hygiene passed; the authoritative live scenario was not run.

## Group 6: Security review gate

- [x] Security review of process execution, permissions, paths, and cleanup | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/security-review.md`
  - **Packages**: None.
  - **Accept**: Security reviewer returned a verdict of PASS, and the orchestrator persisted the report verbatim to `security-review.md`. Zero critical findings and zero warnings.
  - **Verify**: `grep -i 'verdict.*pass' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/security-review.md`
  - **Constraints**: Run only after general review passes. Pay particular attention to shell injection, temporary-directory confinement, permission bypass, sensitive diagnostic output, timeouts, and cleanup.
  - **Failed cycle 1**: Security review found one warning: the loopback OpenCode server is not explicitly authenticated, exposing a local confused-deputy endpoint with the developer's privileges. Two non-blocking hardening suggestions cover symlink-aware path evidence and explicit fixture-process cleanup. QA remains blocked. See `security-review.md`.
  - **Completed evidence**: Fresh Security Review Cycle 2 returned PASS with zero critical findings and zero warnings. It confirmed the authenticated loopback server, credential boundaries, realpath/symlink evidence checks, validated PID termination, and related security invariants. One bounded pre-PID cancellation-cleanup suggestion remains non-blocking. See `security-review.md`.

## Fix Group 9: Resolve security review findings

- [x] Authenticate the hosted server and harden filesystem/process cleanup | `src/live-probe.ts`, `src/capabilities.ts`, `tests/integration/live-probe.test.ts`, `docs/tech.md`
  - **Packages**: None; continue using exact `opencode-ai@1.18.33` and `@opencode-ai/sdk@1.18.33`.
  - **Accept**: Each probe run generates a high-entropy Basic Auth password, launches the project-local OpenCode server with `OPENCODE_SERVER_PASSWORD` and a fixed per-probe username in the child environment only, and sends the matching Authorization header without placing credentials in arguments, persisted configuration, output, or diagnostics. Evidence-file reads reject symlinks/non-regular files and verify realpath confinement. Cancellation exceptional paths explicitly terminate a still-running fixture only after validating its PID command contains the per-run fixture token, then verify exit. Automated tests cover authentication wiring and redaction boundaries, symlink rejection, and validated fixture cleanup.
  - **Verify**: `npm run typecheck && npm test -- --reporter=dot && npm run verify:live:smoke && git diff --check`
  - **Constraints**: Do not run the authoritative live OpenCode/Ollama scenario. Do not weaken capability predicates or permission enforcement. Do not mutate parent-process authentication environment variables. Do not place credentials on the command line or in diagnostics. Do not signal an unvalidated PID.
  - **Completed evidence**: Replaced the unauthenticated SDK hosting helper with a project-local CLI launch that generates a 256-bit per-run password, passes username/password only in the child environment, constructs the SDK client with the matching Basic Authorization header, and probes that anonymous health access is rejected while authenticated access succeeds. Client-construction and authentication failures close the server without reporting credentials. Evidence reads now reject symlinks/non-regular files and require realpath confinement. Cancellation uses a per-run fixture token, validates it against the PID command before signaling, terminates a surviving fixture in `finally`, and verifies exit. Tests cover child-only credential placement, matching headers, fail-closed authentication, server cleanup, symlink rejection, and validated/refused PID termination. `npm run typecheck`, `npm test -- --reporter=dot` (63/63), `npm run verify:live:smoke`, and `git diff --check` passed without running the authoritative live scenario.

## Fix Group 10: Security review cycle 2

- [x] Fresh security re-review of Group 6 fixes | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/security-review.md`
  - **Packages**: None.
  - **Accept**: A fresh security reviewer completes threat modeling, targeted review, and variant hunting; confirms the blocking authentication warning and both hardening suggestions are resolved; returns PASS with zero critical findings and zero warnings; and the complete report is appended verbatim as Cycle 2. On PASS, the original Group 6 security-review task is marked `[x]`.
  - **Verify**: `npm run typecheck && npm test -- --reporter=dot && npm run verify:live:smoke && git diff --check && grep -i '## Cycle 2' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/security-review.md && tail -n 30 .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/security-review.md | grep -i 'verdict.*pass'`
  - **Constraints**: Repository read-only review. Do not run the authoritative live OpenCode/Ollama scenario. Do not begin QA. Persist the returned report verbatim without altering findings or verdict.
  - **Completed evidence**: Fresh security reviewer completed all four review phases and returned PASS with no critical findings or warnings. `npm run typecheck`, `npm test -- --reporter=dot` (63/63), `npm run verify:live:smoke`, and `git diff --check` passed; the authoritative live scenario was not run.

## Group 7: QA gate

- [x] Validate the live OpenCode/Ollama feasibility scenario | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/qa.md`
  - **Packages**: None beyond the reviewed implementation.
  - **Accept**: QA runs `npm run verify:live` in the target environment and records its exit code, exact environment/version details, automated versus live checks, evidence for each of the nine PRD exit criteria, residual gaps, release confidence, a `Capability Verdict: PASS|FAIL`, and a separate QA `Verdict: PASS|FAIL` covering whether validation was executed reliably. QA may return PASS with a capability FAIL when all checks ran and the negative result is trustworthy.
  - **Verify**: Run `npm run verify:live` and record its output and exit code even when nonzero. Confirm `qa.md` contains each of the nine named capability rows with `PASS` or `FAIL`, exactly one `Capability Verdict: PASS|FAIL`, and exactly one QA `Verdict: PASS|FAIL`; `grep -i '^### Verdict: PASS' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/qa.md` must pass before documentation begins.
  - **Constraints**: A capability FAIL is a valid completed-spike outcome and proceeds only to Group 8 documentation; it blocks Milestone 1 and requires architecture reassessment. A QA Verdict FAIL means the validation itself is unreliable and must be corrected before proceeding. Do not reinterpret mocked results as live evidence.
  - **Blocked cycle 1**: The authoritative `npm run verify:live` attempt returned no captured stdout or exit code before the execution wrapper was interrupted after 1162.2 seconds. Later process inspection found no surviving verifier or OpenCode server process, but the nine live capability outcomes and cleanup evidence are unavailable. QA Verdict is FAIL because validation reliability could not be established; see `qa.md`. Group 8 remains blocked.
  - **Completed cycle 2**: The user-authorized authoritative `npm run verify:live` run completed reliably with exit code `1`, a durable stage journal, all nine capability rows, and verified cleanup. The authenticated server and first Core V2 session were created, but the initial model prompt reached its finite 120-second operation timeout while the configured Ollama service was unavailable. Capability Verdict is FAIL; QA Verdict is PASS because the negative result is complete and auditable. Milestone 1 remains blocked, and Group 8 may document the failed feasibility result. See `qa.md`.

## Diagnostic Group 11: Durable live-run observability and deadline

- [x] Make authoritative live validation diagnosable and finite before QA Cycle 2 | `src/live-probe.ts`, `src/live-observability.ts`, `scripts/verify-live.ts`, `tests/integration/live-probe.test.ts`, `docs/tech.md`
  - **Packages**: None.
  - **Accept**: `npm run verify:live` writes timestamped stage transitions durably to a known JSONL journal and mirrors them to stderr; the journal contains no credentials or raw provider/server diagnostics. A positive finite whole-run deadline covers environment creation, driver creation, and scenario execution. Expiry closes an available driver, cleans the disposable environment, emits a complete conservative nine-row FAIL report, and exits nonzero. The default deadline and journal path are documented and may be overridden for diagnostics.
  - **Verify**: `npm run typecheck && npm test -- --reporter=dot && npm run verify:live:smoke && git diff --check`
  - **Constraints**: Do not run the authoritative live OpenCode/Ollama scenario. Do not authorize or begin QA Cycle 2. Do not weaken capability predicates, permission enforcement, authentication, confinement, or cleanup behavior.
  - **Completed evidence**: The live verifier now writes fixed, timestamped stage events synchronously to `.live-build/verify-live.journal.jsonl` and mirrors them to stderr. A 600,000 ms default whole-run deadline (overridable with `QUODER_LIVE_TIMEOUT_MS`) covers environment creation, driver creation, and scenario execution; expiry records the timeout, closes an available driver, follows normal cleanup, and produces the existing conservative nine-row FAIL report with a nonzero exit. Tests cover a permanently stalled driver, cleanup, the complete failure report, durable journal entries, and override validation. `npm run typecheck`, `npm test -- --reporter=dot` (65/65), `npm run verify:live:smoke`, and `git diff --check` passed on 2026-09-30. The authoritative live scenario and QA Cycle 2 were not run.

## Group 8: Documentation update

- [ ] Document the verified feasibility result and next-step decision | `README.md`, `docs/tech.md`, `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/decisions.md`
  - **Packages**: None.
  - **Accept**: Documentation identifies the exact tested environment and OpenCode version, gives reproducible commands, reports limitations honestly, and branches on the capability verdict: capability PASS authorizes scoping Milestone 1; capability FAIL records the blocker and required architecture reassessment without representing Milestone 0 as successful.
  - **Verify**: `rg -n 'npm run verify:live|OpenCode.*version|Node.*version|Fresh session creation|Project directory|Local model invocation|Streaming events|Permission handling|File modification|Cancellation|Session deletion|Session isolation|limitation' README.md docs/tech.md .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/decisions.md` covers the reproducible command, environment versions, all nine capabilities, and limitations; `rg -n 'TODO|FIXME|PLACEHOLDER|<[^>]+>' README.md docs/ || true` returns no spec-related placeholders.
  - **Constraints**: This is the final group. Do not claim untested platform support or document later milestones as implemented.
