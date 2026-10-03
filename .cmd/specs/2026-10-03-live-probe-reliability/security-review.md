# Security Review: Live Probe Reliability

## Cycle 1 — 2026-10-03
Reviewing: Groups 1–3 and Fix Groups 1–2

### Threat Model
- **Trust boundaries.**
  - The probe consumes untrusted output from the model. Through the server, that output reaches the global SSE stream (`question.v2.asked` and tool events) and the per-session stream (`sessionStreamEvent`).
  - The probe then acts on that data: it calls `rejectQuestion` and `interrupt`, and it writes journal names.
  - The server is the probe's own child process, authenticated with HTTP Basic using a 32-byte random password. Other local clients cannot subscribe to its stream or publish events to it without that password.
- **Data flows.**
  - Per-run secrets: the Basic credential, held in the client headers.
  - Per-run values that are not secret but are sent to the remote model in prompts: the nonce (`randomUUID`, hex) and the fixture token (`randomUUID`).
  - Outputs: the journal (`.live-build/verify-live.journal.jsonl` plus stderr), the stdout capability report, and adapter error messages.
- **Attack surfaces.**
  - Model-controlled content: question text, tool inputs, and assistant text.
  - Server event fields: `sessionID`, `id`/`requestID`, `type`, and `durable.seq`.
  - The cause chains inside errors.
- **Assets at risk.**
  - The Basic credential and the user's provider configuration or credentials, which could leak through the journal or report.
  - OpenCode's permission enforcement: the `external_directory` ask must stay intact.
  - Sessions belonging to other clients, which the guard or settle step must not touch.
  - The process lifetime, through unbounded subscriptions or loops.

### Critical
None.

### Warning
None.

### Suggestion
None. No issue with a concrete, plausible attack scenario was identified. The prior spec's carried-forward suggestions are unchanged by this spec and are not repeated.

### Verification Evidence
- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: 5 files, 133/133 passed.
- **Diffs reviewed:** `git diff` of `src/live-probe.ts` and `src/opencode-adapter.ts`, read in full in the changed regions. The relevant tests were read selectively.
- **Question guard** (`#startQuestionGuard`):
  - **Scope:** it acts only when `type === "question.v2.asked"`, `data.sessionID` is a string present in `this.#sessionIDs` (the probe's own sessions, IDs that the server issued to `createSession`), and `data.id` is a string. Questions from other sessions are ignored; a test covers this ("ignores other sessions' questions").
  - **Spoofing:** the global stream is served only by the probe's own Basic-authenticated child server, so another local client cannot inject events.
  - **Model control:** a prompt-injected model controls the question *content*, which is never read, logged or acted on. It does not control the server-generated `id` or `sessionID`.
  - **Path safety:** the SDK path-encodes `sessionID` and `requestID` with `encodeURIComponent` (`gen/core/utils.gen.js:49`), and the route is the session-scoped `POST /api/session/{sessionID}/question/{requestID}/reject`. A crafted ID cannot be redirected to the permission-reply route.
- **Rejection is not a permission decision:**
  - The guard matches only `question.v2.*`, never `permission.v2.asked`. Rejecting moves toward *less* action: the tool call fails and the turn ends.
  - `decisions.md` records a live check that `external_directory` still returns `effect: "ask"`. The permission reply path (`once`, correlated) is unchanged.
- **Automatic interrupt** (`#settleSession`): it targets only `first.id`, a session the probe owns, and interrupts only when `isActive` is true. Each call is bounded by the adapter timeout. Failure journals the fixed `session.settle.failed`. Interrupting cannot grant anything.
- **Journal names:**
  - `#stage` journals `<fixed stage>.failed.<operation>[.timeout]`.
  - `operation` comes only from locally constructed `OpenCodeAdapterError`s, all string literals (`opencode-adapter.ts` lines 150–394), with spaces replaced by `-`. Without an adapter error the cause is `error`.
  - Server- or model-derived text cannot reach a journal name, because `OpenCodeAdapterError` instances are never deserialized from the server.
  - Every other new journal name is a fixed literal: `question.rejected`, `question.reject.failed`, `question.guard.ended`, `isolation.skipped`, `cancellation.not-passed`, `session.initial.prompt.not-completed`, `session.settle.failed`.
- **`findAdapterError`:** recursion is bounded by `depth >= 4` (a cyclic `cause` cannot loop), and it only *returns* an instance; it never prints one.
- **`settlePairedOperations` cause:**
  - The new `AggregateError` cause is never serialized.
  - Inside stages, errors are now swallowed by `#stage`, which journals only the classification. This strictly *reduces* the error text reaching the stdout report compared with the prior fail-fast behaviour.
  - At top level, `runLiveProbe` uses only `error.name` and `error.message`. The `verify-live.ts` rethrow that would print causes stays unreachable in practice, as the prior review established.
- **Prompts:**
  - The nonce (`randomUUID` with dashes removed) and the fixture token (`randomUUID`) are generated locally in a fixed hex/UUID alphabet, so the prompt text cannot be injected into.
  - Sending the nonce to the model is required by the predicate and was already the case. Neither value is a credential.
  - The token appears in the bash command only as the model's own tool input. The fixture is still signalled only after `ps` validation of the UUID, which is unchanged.
- **`sessionStreamEvent`:** it accepts an object with a string `type` or `JSON.parse`s a string `data` inside try/catch. The result feeds only a boolean type check (`isStructuredExecutionEvent`) and is never logged.
- **Lifecycle:**
  - The guard's subscription is bounded by `LIVE_PROBE_RUN_TIMEOUT_MS` and by an `AbortController` that `stop()` aborts in the driver's `finally`, before session cleanup. In `globalEvents`, the abort listener is removed on both the success and failure paths.
  - SDK SSE inspection (`gen/core/serverSentEvents.gen.js`): an abort cancels the reader; after a connection error, the client backs off (at most 30 s) and then exits when `signal.aborted`. `stop()` is therefore bounded.
  - Each question costs one rejection and ends that turn, and each rejection is bounded by the operation timeout, so the model cannot drive unbounded work. The settle step does at most one interrupt plus one bounded idle wait per stage.
  - The 600 s whole-run deadline still closes the server.
- **Test-only hook:**
  - `operationTimeoutMs` is a constructor parameter only.
  - `createAuthenticatedOpenCodeDriver` calls `new OpenCodeLiveDriver(client, hosted.close, options.onProgress)` without it.
  - No environment variable or CLI flag reads it; the only environment inputs remain `QUODER_LIVE_TIMEOUT_MS` (validated) and `QUODER_LIVE_JOURNAL_PATH`.
- **Constraints followed:** no live command was run, no network endpoint was contacted, and the user's OpenCode configuration was not read.

### Variant Hunting
- **Session-ID filtering everywhere the probe acts:** applied consistently. The guard filters on `#sessionIDs`, settle and interrupt use `first.id`, `durableProbeEvent` filters by `sessionID`, `fixtureToolCallID` additionally requires the per-run token and `tool === "bash"`, and cancellation matches on `callID`.
- **Credential-safe journaling:** every `onProgress` call site in the diff passes a literal or a literal built from adapter operation names. None interpolates `error.message`, model text or event data. This matches the `docs/tech.md` claim that the journal holds fixed stage names only.
- **Comment versus code:**
  - The comment "rejects questions raised by its own sessions only" matches the code.
  - The comment "Rejecting a question is not a permission decision" holds, because the guard never touches `permission.*`.
  - The comment "Error text is never journaled" holds.
- **Fail-open variants:** continuing past failed stages never converts a failure into a PASS.
  - Project directory evidence is now *stricter*: it requires the model-produced `hello.txt`, read through `readConfinedRegularFile`.
  - When the nonce was never admitted, isolation is skipped and therefore FAILs.
- **Observation (not a security finding):** a malformed global event without `data` would make `eventSessionID` throw and end the guard. That is caught and journaled as `question.guard.ended`, it fails closed (the stage times out), and only the probe's own authenticated server could emit such an event.

### Verdict: PASS
