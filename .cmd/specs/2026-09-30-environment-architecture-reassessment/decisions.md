# Decisions: OpenCode/Ollama Environment and Architecture Reassessment

## 2026-09-30 — Separate environment readiness from capability feasibility

**Context**: The prior authoritative run was reliable and finite, but its first model prompt timed out while Ollama was unavailable. Downstream capability stages were not reached.

**Decision**: Treat environment readiness as a prerequisite diagnostic gate, not as any part of the nine-capability verdict. Diagnose the intended model path in layers before recommending another authoritative run.

**Rationale**: This avoids spending the full scenario timeout on a known-unready dependency without weakening Milestone 0.

## 2026-09-30 — Preserve the completed feasibility spike as historical evidence

**Context**: `2026-09-29-opencode-sdk-feasibility-spike` completed with QA PASS for reliability and Capability Verdict FAIL.

**Decision**: Do not reopen, rewrite, or append new execution cycles to that spec during this reassessment. Reference its reports and decisions as immutable evidence.

**Rationale**: The new work answers a distinct environment/architecture question, and preserving the original record prevents retrospective reinterpretation.

## 2026-09-30 — Require explicit authorization for any future authoritative run

**Context**: A bounded preflight can show that the intended service, model, and OpenCode integration path are ready, but it cannot prove session lifecycle, permissions, cancellation, file modification, or isolation.

**Decision**: This spec may recommend `Future Capability QA: GO`, but it cannot execute `npm run verify:live`. A future run requires explicit user authorization. Milestone 1 remains blocked unless that run passes all nine predicates.

**Rationale**: This preserves the PRD gate and prevents a readiness result from being mislabeled as architectural feasibility.

## Group 1/2 decision state

> **Superseded on 2026-10-02.** The classification and the NO-GO below describe the Group 1/2 state. See "Reclassify the OpenCode inference failure", "QA Cycle 1 recommendation", and "Final reassessment state" later in this log.


- Configured Ollama topology: remote HTTPS OpenAI-compatible service at the redacted host identity `llm.quackerjack.com`; endpoint ownership remains to be confirmed in Group 2.
- Configured OpenCode provider and diagnostic model: provider `ollama` via `@ai-sdk/openai-compatible`; `ollama/qwen3-coder:30b` was discovered by the project-local CLI and used for bounded diagnosis. The product's eventual default model remains unresolved.
- Current classification: `Integration incompatibility`. Direct discovery and inference pass, but pinned project-local OpenCode inference returns HTTP 503 while waiting for the explicitly targeted model session.
- Bounded action: explicitly bind model-executing sessions to `{ providerID: "ollama", id: "qwen3-coder:30b" }` and implement the layered repository-owned preflight. Do not alter user configuration or dependencies.
- Final preflight contract: `npm run verify:environment` with eight fixed readiness rows, 10-second discovery deadlines, 60-second inference deadlines, a 180-second whole-run deadline, deterministic cleanup, and exactly one overall readiness verdict.
- Security review applicability: required because the preflight reads credential-bearing configuration, contacts a remote authenticated service, launches a child process, and emits diagnostics.
- Future Capability QA recommendation: `NO-GO` until all GO criteria are independently validated.

## 2026-09-30 — Classify Group 1 as an integration incompatibility

**Context**: The configured remote endpoint returned HTTP 200 for model discovery and exact bounded direct inference with `qwen3-coder:30b`. The project-local OpenCode CLI also discovered `ollama/qwen3-coder:30b`. A disposable authenticated OpenCode server then created a Core V2 session explicitly targeting that model and admitted a harmless sentinel prompt, but `session.wait` returned HTTP 503 `ServiceUnavailableError`. Session/server/repository cleanup completed. The prior QA run did not explicitly bind its session to this model and its redacted OpenCode log recorded a different provider-token rejection, so “local Ollama was unavailable” is not an adequate root-cause classification.

**Decision**: Classify the current evidence as `Integration incompatibility` and retain `Future Capability QA: NO-GO`. Group 2 must determine whether the smallest reversible correction is explicit model binding, provider configuration correction, or a pinned-version integration change. Do not restore or start a localhost Ollama service based on this evidence.

**Rationale**: The remote model service and intended model work directly, so environment restoration alone does not explain the OpenCode failure. The remaining failure is inside the OpenCode/provider configuration or pinned integration boundary and must be resolved before another nine-capability run is useful.

## 2026-09-30 — Approve explicit binding and a layered preflight

**Classification**: `Integration incompatibility`.

**Context**: A target-environment repeat ruled out sandbox networking: an explicitly targeted `ollama/qwen3-coder:30b` session still returned HTTP 503 from `session.wait` and cleaned up successfully. A one-second wait-registration delay produced the same result. Polling correlated session messages for 30 seconds produced no assistant response. Direct inference against the configured endpoint continued to pass, while the prior feasibility probe did not explicitly bind its sessions to the intended model.

**Decision**: Select explicit model binding plus a deterministic layered preflight as the smallest reversible repository correction. Group 3 will add `npm run verify:environment`, bind all model-executing feasibility sessions with the verified Core V2 `ModelRef` `{ providerID: "ollama", id: "qwen3-coder:30b" }`, and retain exact package pins. Environment readiness remains FAIL until the OpenCode inference row passes. Security review is required. `Future Capability QA: NO-GO` and the Milestone 1 block remain in force.

**Rationale**: Explicit binding eliminates the proven ambient-default mismatch. The current user configuration is not selected for mutation because authenticated discovery and direct inference pass. A pinned-version change is not selected because no alternate version has verified compatibility evidence and an upgrade would broaden risk. The preflight turns the remaining incompatibility into a fast, reproducible gate without pretending to solve it or weakening the nine-capability milestone.

**Options rejected**:

- **Environment restoration**: rejected because the configured remote service and model are already reachable and complete direct inference.
- **User provider/configuration change**: rejected because the configured header, endpoint, and model work directly; no specific configuration defect is proven.
- **Dependency upgrade or downgrade**: rejected until a candidate version is independently verified against the same endpoint and model contract.
- **Architecture change away from OpenCode**: deferred because the failure is localized but not yet proven fundamental; the preflight provides the evidence boundary for a later decision.

**Preflight contract**: Emit `Pinned dependencies`, `Provider configuration`, `Endpoint reachability`, `Model discovery`, `Direct inference`, `OpenCode model discovery`, `OpenCode inference`, and `Cleanup`, followed by exactly one `Environment Readiness: PASS|FAIL`. Use 10-second discovery, 60-second inference, and 180-second whole-run limits. Never emit credentials, authorization headers, raw configuration, model response content, or unrestricted server diagnostics. Automated tests use typed fakes and never contact the real service.

## 2026-10-02 — Authorize one exceptional startup-lifecycle fix and review cycle

**Context**: Group 4 review Cycle 3, the last cycle permitted by the shared CMD three-cycle limit, failed with one critical finding: the startup failure branches of `launchAuthenticatedOpenCodeServer` reject before owned-child termination is confirmed and can leave a close rejection unhandled. The orchestrator stopped and escalated as required.

**Decision**: The user explicitly authorized one exceptional fix group (Fix Group 3) limited to that defect, followed by one fresh general Review Cycle 4 limited to the correction. If Cycle 4 fails, work stops and escalates again; no further cycle is implied.

**Rationale**: The defect is confined to one function and has a mechanical correction. Reopening the architecture or abandoning the spec would discard sound, reviewed preflight work over a localized lifecycle issue. The exception keeps the review gate intact rather than bypassing it.

## 2026-10-02 — Reclassify the OpenCode inference failure: unimplemented `session.wait`, not provider incompatibility

**Context**: Inspection of the pinned `opencode-ai@1.18.33` CLI bundle shows that the Core V2 `V2Session.wait` handler looks up the session and then always fails with `Session.OperationUnavailableError({ operation: "wait" })`. The HTTP layer maps that error to 503 `ServiceUnavailableError`, "Session wait is not available yet". `compact`, `shell`, and `skill` are stubbed the same way. A bounded, credential-sanitized diagnostic on 2026-10-02 then ran without `session.wait`. It used the existing disposable environment, the authenticated launcher, and the explicitly bound `ollama/qwen3-coder:30b`. The diagnostic was a scratch script outside the repository, and `npm run verify:live` was not run. Observed:

- Prompt admitted at about 1.9 s. `GET /api/session/active` listed the session as running, followed by durable events `session.next.prompt.admitted`, `session.next.prompted`, `session.next.step.started`, `session.next.text.started`, `session.next.text.ended`, and `session.next.step.ended`.
- At about 4.0 s, `session.active` no longer listed the session. The projected assistant message was complete and its text exactly matched the `ENVIRONMENT_READY` sentinel.
- No `session.idle` event appeared on the per-session V2 stream, which stayed silent for about 80 s after `step.ended`.
- `session.messages` returned newest-first by default (`assistant,user`). The SDK accepts `order: "asc"`.
- Session deletion, server termination, and environment removal all succeeded, and no OpenCode server or temporary repository remained.

**Decision**: Reclassify the `OpenCode inference` failure from `Integration incompatibility` (provider/model path) to a pinned-version contract defect in Quoder's use of Core V2. The provider, endpoint, model, and OpenCode model execution all work. The fix is repository-local and needs no dependency or user-configuration change:

1. Replace `waitUntilIdle`'s use of `v2.session.wait` with bounded completion detection. Treat the session as complete once `GET /api/session/active` no longer lists it after admission, corroborated by `session.next.step.ended` where the stream is available.
2. Read messages in a defined order (`order: "asc"`) or correlate assistant messages without depending on the default order. The current preflight and `correlatedAssistantResponse` assume ascending order, so they would report a sentinel mismatch even after a successful run.
3. Re-verify the cancellation contract. `#exerciseCancellation` and `cancellationFromObservedEvents` expect `wait` and a `session.idle` event, and neither appeared in this version.

**Rationale**: Direct evidence shows the model run completes in about 2 s through pinned OpenCode. The earlier 503 is unconditional for this version, and the earlier 30 s message poll most likely missed the reply because it assumed ascending order. A version change is not required.

## 2026-10-02 — Refine completion corroboration and final-response correlation (Review Cycle 5)

**Context**: Review Cycle 5 confirmed in the 1.18.33 bundle that a prompt registers its run synchronously before responding, that the session stays in `active` until every step drains, and that each model step appends its own assistant message. The earlier reclassification decision proposed corroborating idle with `session.next.step.ended`.

**Decision**: Corroborate idle for a prompt with an assistant message inside the admitted input's turn rather than with `step.ended`. Take the final result to be that turn's last assistant message, which must be completed. Cancellation's terminal `tool.failed` must be timestamped no earlier than the local interrupt request, and any `tool.success` for the fixture call fails cancellation.

**Rationale**: Turn-scoped message evidence is durable and directly queryable after the session leaves `active`, so it is stronger than a streamed event. Multi-step turns made first-message correlation wrong. The timestamp check closes the gap left by the synthetic interrupt sequence.

## 2026-10-02 — Authorize Fix Group 6 and Review Cycle 7

**Context**: Review Cycle 6 confirmed that the Cycle 5 findings were resolved but found that `interruptSequence = max observed + 1` collides with the dense per-session sequence of a `tool.failed` that immediately follows the fixture's `tool.called`. A genuine interrupt would therefore fail.

**Decision**: The user authorized one fix group and one fresh review (Cycle 7). The interrupt is positioned strictly between the last durable event read before it and the next one (`last + 0.5`). Ordering relies on sequences, and causality on the terminal event's timestamp not preceding the local interrupt request. If Cycle 7 fails, work stops and escalates.

**Rationale**: The sequence counter cannot place an out-of-band interrupt request, but it can bound which events were read before it. The timestamp distinguishes events produced after the request from events that were already queued.

## 2026-10-02 — Verify the Core V2 permission round-trip live (diagnostic only)

**Context**: Before security review, the user asked whether Milestone 0 can pass. The one live-probe stage never exercised against the pinned server was permission handling. A failure there would also stop the later Cancellation and Session isolation stages from running.

**Evidence**: A bounded scratch diagnostic outside the repository ran against an authenticated disposable 1.18.33 server, with no model call (the remote model endpoint was down). `v2.session.permission.create({ action: "external_directory", resources: [<outside path>], save: [], agent: "build" })` returned HTTP 200 with `{ id, effect: "ask" }` in about 0.8 s and did not block waiting for a reply. The global stream delivered `permission.v2.asked` with the same `id`, `action`, and resource at the same moment. `permission.reply({ reply: "once" })` returned HTTP 204, followed by `permission.v2.replied` (`reply=once`). Cleanup was complete. Permission events carry no durable sequence.

**Decision**: No code change. The live probe's permission contract (`effect: "ask"`, matching the correlated `permission.v2.asked` ID, one-time reply) matches the pinned server. Residual risk: `permission.v2.asked` is not replayable, and the SDK's SSE subscription connects lazily on the first read. The probe starts reading immediately after dispatching `create`, and `create` takes hundreds of milliseconds, so missing the event is unlikely but not structurally impossible. Hardening, by connecting the stream before `create`, would need a separately authorized change.

**Rationale**: The diagnostic removes the largest unverified dependency in the nine-capability run without changing code.

## 2026-10-02 — Accept the permission-event subscription race

**Context**: The permission diagnostic showed that `permission.v2.asked` is not replayable and that the SDK's SSE subscription connects lazily on its first read. The live probe begins reading immediately after dispatching `permission.create`, which took about 0.8 s server-side.

**Decision**: The user explicitly accepted this residual risk. No hardening change will be made in this spec. If a future `verify:live` reports Permission handling FAIL with no observed `permission.v2.asked` event, investigate this race first (fix: connect the global stream before `create`).

**Rationale**: The race window is small relative to server-side `create` latency. A missed event would fail conservatively (Permission handling FAIL, finitely bounded by the 120 s stream timeout) rather than produce a false PASS.

## 2026-10-02 — Carry forward security suggestions; flag server-credential inheritance for Milestone 1

**Context**: Security Review Cycle 1 passed with four nonblocking suggestions. The most significant (medium confidence): in 1.18.33, OpenCode's shell tool inherits the server process environment, so model-run commands can read `OPENCODE_SERVER_PASSWORD` and call the local authenticated API, including permission replies. This gives no privilege gain in the feasibility probe, which already grants `bash` and answers its own permission request. It would undercut the invariant "Quoder does not bypass OpenCode's permission enforcement" once Milestone 1 forwards real user permission decisions.

**Decision**: No change in this spec. Milestone 1 design must treat server-credential exposure to tool processes as a known limitation and choose a mitigation before forwarding real permission decisions, for example a `shell.env` plugin hook that blanks the server credentials, or an upstream fix. The other three suggestions (`redirect: "error"` on preflight fetches, resolving the package root from the module location instead of `process.cwd()`, and an exclusive-create write for the fixture) are logged as low-confidence hardening for a later change.

**Rationale**: The security gate passed, and none of the suggestions has a privilege-gaining attack within this spec's scope. Recording the Milestone 1 implication now keeps it from being lost.

## 2026-10-02 — QA Cycle 1 recommendation: Future Capability QA: GO

**Context**: Group 6 QA independently validated the preflight on the final code, with the general review (Cycle 7) and security review (Cycle 1) both passed. Evidence:
- `npm run verify:environment` passed all eight rows with exit 0 on 5 of 5 real runs, in about 4.8–5.5 s, with no residue.
- 7 synthetic failure-path runs used temporary configs only. Each exited 1 with the correct failing row and `Cleanup: PASS`. They included a real 10 s discovery-deadline expiry.
- Structural redaction checks over all 12 outputs found only fixed evidence strings.
- Typecheck passed, and 117/117 tests passed. See `qa.md`.

**Decision**: `Future Capability QA: GO`. This supersedes the NO-GO in the "Group 1/2 decision state" section above. It is a readiness recommendation only: it does not pass Milestone 0, does not authorize Milestone 1, and does not authorize `npm run verify:live`, which still requires explicit user authorization. Re-run `npm run verify:environment` immediately before any authorized `verify:live`, because the endpoint had an outage on 2026-10-02. The prior capability verdict (FAIL) is unchanged until that run.

**Rationale**: Every GO criterion in `spec.md` is met: documented topology, all readiness layers passing, finite, redacted and reproducible output, and passing review, security and QA gates.

## 2026-10-02 — Final reassessment state (Group 7 close-out)

**Context**: All gates of this spec passed: the general review (Cycle 7, after user-authorized exceptional cycles), the security review (Cycle 1), and QA (Cycle 1).

**Decision**: Close the reassessment with:
- **Topology:** remote authenticated HTTPS OpenAI-compatible endpoint; provider `ollama`; model `ollama/qwen3-coder:30b`, explicitly bound.
- **Classification:** pinned-version contract defects in Quoder's Core V2 usage, now corrected. The defects were the unimplemented `session.wait`, the default newest-first message order, per-step assistant messages, and an unverified cancellation event contract.
- **Readiness:** `Environment Readiness: PASS`.
- **Recommendation:** `Future Capability QA: GO`.
- **Unchanged:** the capability verdict is still FAIL from the 2026-09-30 run. Milestone 0 is not passed, and Milestone 1 stays blocked.

**Precise next action**: re-run `npm run verify:environment`. If it passes, and only with explicit user authorization, run `npm run verify:live`. Milestone 0 passes only if that run reports PASS for all of these: Fresh session creation, Project directory, Local model invocation, Streaming events, Permission handling, File modification, Cancellation, Session deletion, and Session isolation.

**Carried forward**:
- the accepted permission-event subscription race;
- the security suggestions, including withholding server credentials from tool environments before Milestone 1;
- the nonblocking review and QA suggestions in `review.md`, `security-review.md`, and `qa.md`.
