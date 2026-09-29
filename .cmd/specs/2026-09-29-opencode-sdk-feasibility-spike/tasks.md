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

- [ ] Define probe contracts and red-phase automated tests | `src/capabilities.ts`, `src/report.ts`, `tests/unit/`
  - **Packages**: Use only the test/build dependencies approved and versioned by the preceding research task.
  - **Accept**: Tests define all nine capability outcomes, event classification, aggregate PASS/FAIL behavior, cleanup on success/error/cancellation, exact `hello.txt` content, project-directory confinement, the spec's nonce/sentinel isolation predicate, a real-permission-event predicate, and the cancellation start-event/terminal-state/no-late-completion predicates. Tests fail only because implementation is absent.
  - **Verify**: Run the versioned test command selected in `docs/tech.md` and confirm the expected red-phase failures are recorded in the task notes before marking complete.
  - **Constraints**: Test doubles may validate probe-owned logic but must not be presented as evidence that OpenCode capabilities exist. Do not invoke a live model in the default unit-test command.

## Group 3: Implement the probe core

- [ ] Build the verified OpenCode integration boundary and capability runner | `src/opencode-adapter.ts`, `src/capabilities.ts`, `src/report.ts`, `package.json`, `tsconfig.json`
  - **Packages**: Use the exact OpenCode SDK/API and TypeScript/tooling versions verified in `docs/tech.md`.
  - **Accept**: The Group 2 tests pass; the implementation exposes only verified operations needed by the spike, applies finite timeouts, preserves structured diagnostic evidence, and attempts session deletion on success, failure, and cancellation.
  - **Verify**: Run the documented typecheck and unit-test commands from `docs/tech.md`.
  - **Constraints**: Do not add CLI/TUI application behavior or later-milestone features. Do not scrape terminal output when a verified structured event exists. Do not silently convert unsupported capabilities to PASS.

## Group 4: Implement live integration verification

- [ ] Implement the opt-in disposable-repository integration scenario | `tests/integration/`, `scripts/`
  - **Packages**: No additional packages unless researched, versioned, and documented in `docs/tech.md`.
  - **Accept**: `npm run verify:live` creates an isolated temporary Git repository; creates a fresh session scoped to it; invokes the existing local model; observes a structured streaming event; exercises an actual OpenCode permission request and response; verifies exact `hello.txt` content; executes the specified cancellation protocol; deletes sessions; creates a second session; performs the exact nonce/sentinel isolation assertion; prints each of the nine named criteria exactly once; prints an overall verdict; and exits nonzero unless all criteria pass.
  - **Verify**: Run unit tests and a smoke execution using test doubles or a deliberately unavailable-runtime fixture to prove timeout, cleanup, report shape, and exit-code behavior. The authoritative live OpenCode/Ollama run is reserved for the post-review QA gate.
  - **Constraints**: Never run file-modification prompts against the Quoder working tree. Use an explicit temporary directory, validate the resolved path before use, and clean it up safely. Do not change OpenCode/Ollama configuration.

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
