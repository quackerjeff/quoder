# Decisions: Live Probe Reliability

## 2026-10-03 — Open this spec; show model replies in scratch diagnostics only

**Context**: The 2026-10-02 authoritative run failed. The diagnostics identified a stream-parsing defect, a blocking `question` tool, unreliable instruction-following, and fail-fast scenario behavior. The user deferred to the recommendation.

**Decision**: Open this spec. Scratch diagnostics may print model replies to tune prompts. Tracked artifacts record only summaries. Credentials and configuration are never printed.

**Rationale**: Blind prompt tuning wastes model calls. The replies come from harmless test prompts and contain no secrets.

## 2026-10-03 — Group 1 progress: question mitigation candidates (partial; endpoint outage)

**Verified in the pinned 1.18.33 bundle**:
- The CLI documents `OPENCODE_CONFIG_CONTENT`. Its JSON is merged as *local*-scope configuration. Setting it only in the probe's own server child (option b) confines it to the disposable server and never touches user configuration files.
- `--pure` only disables external plugins.
- The SDK also exposes a Core V2 question API (`v2.session.question` list/reply/reject), kept as fallback option (c).

**Verified live (no model call needed)**: with `OPENCODE_CONFIG_CONTENT={"permission":{"question":"deny"}}` in the server child, `permission.create(external_directory)` still returned `effect: "ask"`. The permission-handling predicate's trigger is therefore preserved.

**Not yet verified**: whether `question: "deny"` stops the model's question call from blocking, and the prompt-reliability sampling. Both attempts were invalidated by an outage of the remote model endpoint: every step failed with `session.next.step.failed` "HTTP transport failed", with and without the mitigation, and the unauthenticated probe got no connection. Resume Group 1 when the endpoint is reachable. Prompt candidates and the sampling harness are ready in scratch.

## 2026-10-03 — Group 1 results: question mitigation and prompt reliability

**Endpoint note**: Inside the user's LAN, `llm.quackerjack.com` resolves to a private address. The edge proxy enforces authentication only for outside access. The Claude app needed macOS Local Network permission to reach it, which the user granted. After that, an unauthenticated `GET /v1/models` returned HTTP 200 and `npm run verify:environment` passed all eight rows.

**Question mitigation (live, 2026-10-03)**:
- Option (b), `OPENCODE_CONFIG_CONTENT={"permission":{"question":"deny"}}` in the server child, did **not** prevent blocking. The model still called `question`, `question.v2.asked` was emitted, and the tool stayed `running` for 60 s. Rejected.
- Option (c), observing `question.v2.asked` for the probe's session on the global stream and calling `v2.session.question.reject({ sessionID, requestID })`, **works**. The reply is HTTP 204, then `question.v2.rejected`. The question tool call fails, and the session goes idle in about 3 s (the turn ends). Rejecting a question is not a permission decision. `external_directory` still returned `effect: "ask"`. **Selected.**

**Prompt sampling (live, with option (c) active; model replies seen only in scratch output)**:

| Stage | Selected prompt (summary) | Result |
| --- | --- | --- |
| Initial | Use the write tool to create `hello.txt` with exact content; remember the nonce; ask no questions; then reply exactly `TOKEN_STORED` | 5/5. Every sample used `write`, produced an exact file and an exact sentinel, in about 3 s. |
| Cancellation | The original "Run \`node fixture.mjs <token>\` and wait for it to finish. Do not run it in the background." plus "Do not ask any questions." | 9/10. Each passing sample started a real `bash` call, was interrupted, went idle, and the fixture was gone. |
| Isolation | Reply exactly `NO_PRIOR_SESSION` unless you know a prior nonce (then only the nonce); no tools; no questions | 5/5, exact sentinel. |

Other results:
- A more directive cancellation prompt ("Use the bash tool to run exactly this command…") scored 0/5. The model wrote its tool call as plain text (`<function=bash> … </tool_call>`) instead of a structured call.
- The original wording without "no questions" scored 4/5, with the same text-markup failure.

**Decision**: Implement option (c) and the three selected prompts. A model emitting its tool call as text is the residual, nondeterministic risk, observed in about 1 in 10 cancellation samples. It fails Cancellation conservatively and finitely; it never produces a false PASS. No retry is added, so the predicate evidence stays simple. If an authoritative run fails only on this, a rerun is a legitimate response.

**Rationale**: All three stages meet the spec target (at least 4/5 cooperating samples, no blocking). The single-run probability that all three model stages cooperate is estimated at about 0.9.

## 2026-10-03 — Tighten Project directory evidence

**Context**: Project directory passed whenever its two constant paths (the repository and `hello.txt`) were confined, regardless of whether the model did anything. While the scenario was fail-fast, any error turned all nine rows to FAIL, so this was masked. With stage isolation, a run in which the model produced nothing would have reported Project directory PASS.

**Decision**: The driver reports project paths only when the model-produced `hello.txt` was read through `readConfinedRegularFile`, which applies realpath confinement and rejects symlinks. Otherwise the list is empty and the predicate FAILs.

**Rationale**: Continuing past failures must never turn absent evidence into a PASS. This makes the predicate stricter than before, and it now depends on real model file activity inside the repository.

## 2026-10-03 — Final state (Group 6 close-out)

**Context**: All gates passed: general review at Cycle 3, security review at Cycle 1, and QA at Cycle 1, with `Authoritative Run: GO` and CONDITIONAL confidence.

**Decision**: Close this spec with:
- the stream-parsing fix;
- question rejection through the Core V2 question API, scoped to the probe's own sessions;
- the sampled prompts;
- stage isolation with settling after every stage and a credential-safe failure journal;
- stricter Project directory evidence.

**Recommendation**: `Authoritative Run: GO`. This is a recommendation only. It does not pass Milestone 0, does not authorize Milestone 1, and does not authorize `npm run verify:live`.

**Precise next action**: run `npm run verify:environment`. Then, only with explicit user authorization, run `npm run verify:live`. Milestone 0 passes only if all nine predicates PASS in that run. If the run fails only because the model emitted a plain-text tool call or did not cooperate (the journal shows `cancellation.not-passed`, or `session.initial.prompt.*` without adapter-operation timeouts), a rerun is a legitimate response. A deterministic failure needs diagnosis first.

**Carried forward**:
- model nondeterminism (estimated about 0.7 joint cooperation per run);
- the permission-event subscription race, previously accepted;
- the 600 s run-deadline residual;
- deletion of an active session, still unverified;
- QA's suggestions: a journal-text assertion, and inspecting assistant `finish`/`error` when cancellation sees no bash call;
- Review Cycle 3's optional self-referential cause test;
- the prior spec's security suggestions, including withholding server credentials from tool environments before Milestone 1.
