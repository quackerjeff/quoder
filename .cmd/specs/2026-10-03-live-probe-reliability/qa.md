# QA Report: Live Probe Reliability

## Cycle 1 — 2026-10-03
Validating: Groups 1–4 and Fix Groups 1–2

### Coverage
- **Automated:**
  - `npm run typecheck`.
  - `npm test -- --reporter=dot`, three consecutive runs.
  - `git diff --check`.
  - The driver and unit tests were reviewed against the five required behaviours (see Results, section 5).
- **Manual (real environment, bounded, no `verify:live`):**
  - The real preflight, `npm run verify:environment`, run twice, with residue checks.
  - An independent re-sampling of the **implemented** prompts against the real model. A scratch harness outside the repository imported `initialPrompt`, `cancellationPrompt`, `ISOLATION_PROMPT` and `INITIAL_PROMPT_SENTINEL` from the compiled `.live-build/src/live-probe.js`; no prompt string was copied by hand.
    - Each sample used a fresh `createDisposableEnvironment` and a fresh `launchAuthenticatedOpenCodeServer` with Basic auth.
    - Sessions were bound to `LIVE_MODEL`. Operations went through `OpenCodeAdapter` with `LIVE_PROBE_TIMEOUT_MS`.
    - `question.v2.asked` events for the sample's own sessions were rejected with `client.v2.session.question.reject`.
    - Grading used the module's own predicate helpers: `finalAssistantResponseText`, `hasExactHelloContent`, `fixtureToolCallID`, `cancellationFromObservedEvents` and `classifyIsolation`.
    - The cancellation fixture script is byte-identical to the driver's: a PID file, then a completion marker after 60 s.
    - The isolation samples follow the driver's flow: the first session receives `initialPrompt(nonce)`, is deleted (delete plus 404 check), and then a fresh session is asked `ISOLATION_PROMPT`.
- **Not covered:**
  - `npm run verify:live`, the authoritative nine-predicate run. It is explicitly out of scope and needs separate user authorization.
  - The permission-handling stage, which does not depend on the model, was not re-sampled live; it is covered by Group 1 evidence and driver tests.
  - Deleting a session that is still active (see Residual Gaps).
  - Multi-stage stalls that exceed the 600 s run deadline.

### Environment
| Item | Value |
| --- | --- |
| OS | macOS 26.7 (build 25G229), Darwin 25.6.0 |
| Node / npm | v24.18.1 / 12.0.2 |
| Pins (`npm ls --depth=0`) | `@opencode-ai/sdk@1.18.33`, `opencode-ai@1.18.33` |
| Endpoint | `curl … https://llm.quackerjack.com/v1/models` (no credentials) → `200`, exit 0, under 1 s. It was re-checked 3 times at 06:39 and returned `200` each time. Inside the user's LAN the edge proxy does not require authentication. |
| Model | `ollama/qwen3-coder:30b` (`LIVE_MODEL`) |

### Results

#### 1. Automated checks
| Command | Exit | Time | Result |
| --- | --- | --- | --- |
| `npm run typecheck` | 0 | under 1 s | clean |
| `npm test -- --reporter=dot` (run 1) | 0 | 4 s | 5 files, 133/133 passed |
| `npm test -- --reporter=dot` (run 2) | 0 | 4 s | 133/133 passed |
| `npm test -- --reporter=dot` (run 3) | 0 | 3 s | 133/133 passed |
| `git diff --check` | 0 | under 1 s | clean |
| `npm run build:live` | 0 | under 1 s | compiled module used by the harness |

#### 2. Real preflight (`npm run verify:environment`)
| Row | Run 1 | Run 2 |
| --- | --- | --- |
| Pinned dependencies | PASS | PASS |
| Provider configuration | PASS | PASS |
| Endpoint reachability | PASS | PASS |
| Model discovery | PASS | PASS |
| Direct inference | PASS | PASS |
| OpenCode model discovery | PASS | PASS |
| OpenCode inference | PASS | PASS |
| Cleanup | PASS | PASS |
| **Verdict** | Environment Readiness: PASS | Environment Readiness: PASS |
| Exit code / elapsed | 0 / 4.3 s | 0 / 3.9 s |
| Residue | no `opencode serve`; no `$TMPDIR/quoder-live-probe-*` | no `opencode serve`; no `$TMPDIR/quoder-live-probe-*` |

#### 3. Prompt re-sampling with the implemented prompts
Times are measured from prompt submission to the end of grading. In the "Tools" column, `-` means no structured tool call.

**Initial prompt** (exact `hello.txt`, final reply exactly `TOKEN_STORED`, session idle):

| Batch | Sample | Result | Time | Tools | Failure summary |
| --- | --- | --- | --- | --- | --- |
| A | 1 | PASS | 3.2 s | write, todowrite | |
| A | 2 | PASS | 2.5 s | write | |
| A | 3 | PASS | 2.6 s | write | |
| A | 4 | PASS | 3.0 s | write | |
| A | 5 | PASS | 2.8 s | write, todowrite | |
| B | 1 | FAIL | 19.9 s | todowrite | No `write` call and no `hello.txt`, yet the reply was the exact sentinel. Taken right after a provider 502 window; slow inference. |
| C | 1 | PASS | 2.7 s | write, todowrite | |
| C | 2 | PASS | 2.8 s | write, todowrite | |
| C | 3 | PASS | 3.0 s | write, todowrite | |
| C | 4 | PASS | 2.8 s | write, todowrite | |
| C | 5 | FAIL | 2.3 s | - | The model emitted its `write` call as plain-text markup instead of a structured call, so no file was written and the reply was not the sentinel. |

Total: **9/11** (first three: 3/3). No questions were raised, and every sample went idle finitely.

**Cancellation** (`bash` `tool.called` containing the token, PID file present, `interrupt`, `tool.failed` for that `callID`, idle, fixture gone, no marker, and `cancellationFromObservedEvents` true):

| Batch | Result | Time per sample | Tools | Failure summary |
| --- | --- | --- | --- | --- |
| A | 1/3 | 2.5 s, 9.7 s, 2.5 s | -, -, bash | **#1:** the turn ended after about 2.5 s with no tool call and an empty final text. The cause is undetermined; this batch ran before message-shape diagnostics were added. **#2:** the known failure mode, a tool call emitted as plain-text `<function=bash>` markup. |
| B | 4/4 | 2.7–2.8 s | bash | |
| C | 3/3 | 2.7–3.4 s | bash (one also used glob) | |
| D | 5/5 | 2.6–2.8 s | bash | |

Total: **13/15** (first three: 1/3; first ten: 8/10). Every passing sample showed `tool.failed` after the interrupt, the session idle, the fixture terminated by OpenCode, and no completion marker. No questions were raised.

**Isolation** (a fresh session after the nonce session was deleted; reply exactly `NO_PRIOR_SESSION`, with `classifyIsolation` PASS):

| Batch | Result | Time | Notes |
| --- | --- | --- | --- |
| A | 0/5 — **invalid (environment)** | 0.3–0.4 s | The diagnostic re-run showed the turn failing with `session.next.step.failed` "Provider request failed with HTTP 502 Bad Gateway" from the upstream nginx. `GET /v1/models` still returned 200. The probe's grading failed these finitely and correctly. They are excluded from model reliability. |
| B (diagnostic) | 0/1, then 1/1 | 9.2 s / 0.4 s | The first was the same 502; the provider recovered about one minute later. |
| C | 5/5 | 0.3–0.9 s | No tools; exact sentinel. |

Valid total: **6/6**. No questions were raised.

**Residue after all sampling:**
- 0 `opencode serve` processes;
- 0 `fixture.mjs` processes;
- 0 `$TMPDIR/quoder-live-probe-*` directories.

No harness reported a failed settle, session deletion, server termination or environment removal.

#### 4. Comparison with Group 1
| Stage | Group 1 | QA re-sample | Spec target (≥ 4/5) |
| --- | --- | --- | --- |
| Initial | 5/5 | 9/11 (82%) | met |
| Cancellation | 9/10 | 13/15 (87%) | met |
| Isolation | 5/5 | 6/6 valid | met |

The combined estimate that all three model stages cooperate in one run is about 0.82 × 0.87 × 1.0 ≈ **0.7**, lower than the 0.9 estimated in Group 1. No blocking behaviour was observed: no `question` calls, no stalls, and every failure ended within 20 s.

#### 5. Automated evidence review (`tests/integration/live-probe.test.ts`)
| Required behaviour | Covered by | Status |
| --- | --- | --- |
| Stage isolation with no false PASS | "continues past a failed initial prompt without turning missing evidence into a PASS". It asserts the exact nine-row status map (only Permission, Cancellation and Deletion PASS), empty `projectPaths`, isolation skipped, and verdict FAIL. Also "records an interrupt failure as missing cancellation evidence and continues to isolation". | Covered |
| Full nine-row PASS path | "reports all nine predicates PASS when every stage produces its evidence": a model-written `hello.txt`, confined `projectPaths`, no `.failed`/`not-passed` markers, no `question.guard.ended`, verdict PASS. | Covered |
| Question rejection scoped to own sessions | "rejects questions raised by its own sessions and ignores other sessions' questions": exactly one reject call, with `session-1`/`question-1`. | Covered |
| Settling after a stage that fails without throwing | "settles a session left running by a cancellation that failed without throwing": `cancellation.not-passed`, then interrupt, then an `active` read, then isolation creation. | Covered |
| Credential-safe journal contract | The tests assert exact journal entries `session.initial.prompt.failed.submit-prompt` (paired cause, and no `.failed.error`) and `…failed.wait-for-session.timeout` (direct timeout), `question.guard.ended` both present and absent, `findAdapterError` cases including the depth bound, and the JSONL journal format. Because the entries are matched exactly, error text such as "prompt rejected" cannot be appended to them. | Covered (see Suggestion) |

### Critical
None.

### Warning
- **[model reliability]** The text-markup tool-call failure, previously seen only in Cancellation, also occurred in the **Initial** stage (1/11). A further Initial sample called only `todowrite`, wrote no file, and still replied with the exact sentinel. Initial reliability is 9/11, not 5/5, and the estimated single-run probability of all three model stages cooperating is about 0.7 rather than about 0.9.
  - Impact: a single authoritative run has a meaningful chance (about 30%) of failing one or more model-dependent predicates for nondeterministic reasons.
  - The probe fails such runs conservatively and finitely, with no false PASS. In the `todowrite` case, File modification and Project directory FAIL on the missing file, while Local model invocation could still PASS on the exact sentinel, which matches what the model actually did.
  - Accepted for a GO recommendation because every stage meets the spec's 4/5 target, but the user should expect that a rerun may be needed.
- **[environment stability]** During QA the provider transiently returned **HTTP 502 Bad Gateway** for inference for about a minute, while `GET /v1/models` still returned 200.
  - The probe handled it correctly: `step.failed`, no completed final text, a finite FAIL.
  - However, an outage during `verify:live` would fail the model predicates, and an unauthenticated `/v1/models` check alone does not detect it.
  - Run `npm run verify:environment` (which includes direct and OpenCode inference) immediately before any authoritative run, and treat a FAIL that coincides with provider errors as environmental.

### Suggestion
- **[journal contract test]** Add one negative assertion to the failure-scenario driver tests: no progress entry contains the injected error text (`prompt rejected`, `interrupt failed`). The current exact-entry assertions cannot catch a *separate* extra entry that carries message text.
- **[test residue]** `$TMPDIR` holds 16 stale `quoder-cancellation-driver-test-*` directories, dated 2026-10-02 and 2026-10-03 between 06:11 and 06:12. They come from earlier interrupted test processes. The test removes its root in `finally`, and none was created by this cycle's three suite runs. QA did not remove them, because it did not create them; the owner may delete them.
- **[undiagnosed failure]** Cancellation batch A #1 (a turn ending with no tool call and empty text) had no shape diagnostics. If an authoritative run's Cancellation fails with `cancellation.not-passed` and no `bash` call, inspect the assistant message's `finish` and `error` to separate a provider error from a model no-op.

### Residual Gaps
- **Model nondeterminism.** Cancellation was 9/10 in Group 1 and 13/15 here. Initial was 9/11 here, with the text-markup and `todowrite`-only failure modes. Isolation was 6/6 valid. No retry exists by design, so a single authoritative run can fail on model behaviour alone. A rerun is a legitimate response, as recorded in `decisions.md`.
- **Permission-event subscription race (accepted, prior spec).** `permission.v2.asked` has no durable sequence and is observed only if the global stream is already reading. The small race remains accepted. If Permission handling fails with no observed event, investigate this first.
- **600 s run-deadline residual.** Several stalled stages can sum per-operation 120 s bounds past the whole-run deadline, collapsing the report to all-FAIL and losing per-predicate evidence for that run. This was not exercised; it is documented in `docs/tech.md`.
- **Deleting an active session is unverified** in 1.18.33. It is reachable only if settling fails (journaled `session.settle.failed`). This was not exercised, because every QA sample settled to idle before deletion.
- **The authoritative nine-predicate run has not been performed.** All of the above is pre-run evidence only.

### Release Confidence
- CONDITIONAL. The probe changes behave as specified, the automated suite is stable, the preflight is reproducible with no residue, the implemented prompts meet the spec target, and failures, including provider 502s, are finite and conservative. The conditions are a passing preflight immediately before the run and acceptance of an estimated 0.7 single-run cooperation probability.

Authoritative Run: GO

**Milestone statement:** GO is a recommendation only. It does not pass Milestone 0, does not authorize Milestone 1, and does not authorize `npm run verify:live`, which requires explicit user authorization. Model nondeterminism remains: Cancellation was about 9/10 in Group 1 (13/15 here), and Initial was 9/11 here. Milestone 0 passes only on an authoritative, user-authorized run in which all nine predicates PASS together.

### Verdict: PASS
