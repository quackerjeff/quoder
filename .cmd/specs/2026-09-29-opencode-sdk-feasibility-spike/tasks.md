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

- [ ] Code review of the feasibility implementation | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md`
  - **Packages**: None.
  - **Accept**: Reviewer returned a verdict of PASS, and the orchestrator persisted the report verbatim to `review.md`. Zero critical findings and zero warnings.
  - **Verify**: `grep -i 'verdict.*pass' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/review.md`
  - **Constraints**: Do not proceed until this passes. Maximum three review cycles; escalate if still failing.

## Group 6: Security review gate

- [ ] Security review of process execution, permissions, paths, and cleanup | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/security-review.md`
  - **Packages**: None.
  - **Accept**: Security reviewer returned a verdict of PASS, and the orchestrator persisted the report verbatim to `security-review.md`. Zero critical findings and zero warnings.
  - **Verify**: `grep -i 'verdict.*pass' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/security-review.md`
  - **Constraints**: Run only after general review passes. Pay particular attention to shell injection, temporary-directory confinement, permission bypass, sensitive diagnostic output, timeouts, and cleanup.

## Group 7: QA gate

- [ ] Validate the live OpenCode/Ollama feasibility scenario | `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/qa.md`
  - **Packages**: None beyond the reviewed implementation.
  - **Accept**: QA runs `npm run verify:live` in the target environment and records its exit code, exact environment/version details, automated versus live checks, evidence for each of the nine PRD exit criteria, residual gaps, release confidence, a `Capability Verdict: PASS|FAIL`, and a separate QA `Verdict: PASS|FAIL` covering whether validation was executed reliably. QA may return PASS with a capability FAIL when all checks ran and the negative result is trustworthy.
  - **Verify**: Run `npm run verify:live` and record its output and exit code even when nonzero. Confirm `qa.md` contains each of the nine named capability rows with `PASS` or `FAIL`, exactly one `Capability Verdict: PASS|FAIL`, and exactly one QA `Verdict: PASS|FAIL`; `grep -i '^### Verdict: PASS' .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/qa.md` must pass before documentation begins.
  - **Constraints**: A capability FAIL is a valid completed-spike outcome and proceeds only to Group 8 documentation; it blocks Milestone 1 and requires architecture reassessment. A QA Verdict FAIL means the validation itself is unreliable and must be corrected before proceeding. Do not reinterpret mocked results as live evidence.

## Group 8: Documentation update

- [ ] Document the verified feasibility result and next-step decision | `README.md`, `docs/tech.md`, `.cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/decisions.md`
  - **Packages**: None.
  - **Accept**: Documentation identifies the exact tested environment and OpenCode version, gives reproducible commands, reports limitations honestly, and branches on the capability verdict: capability PASS authorizes scoping Milestone 1; capability FAIL records the blocker and required architecture reassessment without representing Milestone 0 as successful.
  - **Verify**: `rg -n 'npm run verify:live|OpenCode.*version|Node.*version|Fresh session creation|Project directory|Local model invocation|Streaming events|Permission handling|File modification|Cancellation|Session deletion|Session isolation|limitation' README.md docs/tech.md .cmd/specs/2026-09-29-opencode-sdk-feasibility-spike/decisions.md` covers the reproducible command, environment versions, all nine capabilities, and limitations; `rg -n 'TODO|FIXME|PLACEHOLDER|<[^>]+>' README.md docs/ || true` returns no spec-related placeholders.
  - **Constraints**: This is the final group. Do not claim untested platform support or document later milestones as implemented.
