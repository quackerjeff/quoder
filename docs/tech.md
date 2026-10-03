# Technical Notes

Use this file for confirmed implementation facts only.

## Verification Scope

Verified on 2026-09-29 for the active OpenCode SDK feasibility spike.

Verification index: Package, Version, Import, Signature, Source, Project directory, Session creation, Session deletion, Streaming, Permission request, Permission response, Cancellation, Final result, Node, and npm.

| Component | Exact version | Evidence |
| --- | --- | --- |
| Quoder-local OpenCode CLI package | `opencode-ai@1.18.33` | `package-lock.json`; `npx --no-install opencode --version` |
| Quoder-local OpenCode SDK package | `@opencode-ai/sdk@1.18.33` | `package-lock.json`; `node_modules/@opencode-ai/sdk/package.json` |
| Node runtime | `v24.18.1` | `node --version` |
| npm runtime | `12.0.2` | `npm --version` |
| TypeScript approved for Group 2 | `typescript@7.0.2` | `npm view typescript version` on 2026-09-29 |
| Vitest approved for Group 2 | `vitest@5.0.2` | `npm view vitest version` on 2026-09-29 |
| Node types approved for Group 2 | `@types/node@24.12.2` | Node 24 line and SDK package's declared development version |

The system OpenCode executable at `/Users/jeffrey/.local/bin/opencode` remains version `1.18.20` and is out of scope. Quoder must use the project-local package through `npx --no-install opencode` or `node_modules/.bin/opencode`.

## Stability And Selected Surface

- **Package:** `@opencode-ai/sdk@1.18.33`
- **Import:** `@opencode-ai/sdk/v2`
- **Client factory:** `createOpencodeClient`
- **Hosted server factory:** `createOpencode`
- **Core V2 API namespace:** `client.v2`
- **Stability:** The package exposes legacy endpoints and a newer Core V2 namespace from the same `/v2` import. Generated names such as `Session2`, `Session3`, and `/api/...` routes show an evolving surface. Exact dependency pinning is mandatory.

Sources:

- Official SDK source: [anomalyco/opencode JavaScript SDK](https://github.com/anomalyco/opencode/tree/dev/packages/sdk/js)
- Official Core V2 permissions: [OpenCode V2 permissions](https://opencode.ai/v2/docs/permissions)
- Official server API: [OpenCode server](https://dev.opencode.ai/docs/server/)
- Local package manifest: `node_modules/@opencode-ai/sdk/package.json` (`1.18.33`)
- Local generated client declarations: `node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` (`1.18.33`)
- Local generated wire types: `node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` (`1.18.33`)

## Framework Patterns

### Hosting And Client Connection

Import and signatures:

```ts
import {
  createOpencode,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2";

createOpencode(options?: ServerOptions): Promise<{
  client: OpencodeClient;
  server: { url: string; close(): void };
}>;

createOpencodeClient(config?: Config & {
  directory?: string;
  experimental_workspaceID?: string;
}): OpencodeClient;
```

Sources: local `dist/v2/index.d.ts`, `client.d.ts`, and `server.d.ts`. `ServerOptions` accepts `hostname`, `port`, `signal`, `timeout`, and `config`. The official server documentation confirms an OpenAPI server and SSE transport.

The pinned SDK helper does not expose a child-environment or authentication option. OpenCode `1.18.33` protects `serve` with HTTP Basic Auth when `OPENCODE_SERVER_PASSWORD` is set; `OPENCODE_SERVER_USERNAME` overrides the default username. An authenticated embedded launch must therefore start the project-local CLI with those variables only in the child environment and construct the SDK client with the matching `Authorization: Basic ...` header. Credentials must not be placed in command arguments, persisted configuration, or diagnostics. Sources: official OpenCode server authentication documentation and local inspection of `@opencode-ai/sdk@1.18.33` `dist/v2/server.js`, `dist/v2/client.js`, and `dist/v2/gen/client/types.gen.d.ts`.

Local server command:

```bash
npx --no-install opencode serve --pure --hostname 127.0.0.1 --port <port>
```

### Project Directory / Location

Core V2 session creation uses a location, not the legacy client's directory query:

```ts
client.v2.session.create({
  id?: string,
  agent?: string,
  model?: ModelRef,
  location?: LocationRef,
});
```

Source: `Session3.create` and `V2SessionCreateData` in the local generated 1.18.33 declarations. Group 2 must compile the precise `LocationRef` construction. Do not substitute `client.session.create({ directory })` and claim Core V2 behavior.

### Session Creation

`client.v2.session.create(...)` uses `POST /api/session` and returns `{ data: SessionV2Info }`.

Sources: `Session3.create` and `V2SessionCreateData`/`V2SessionCreateResponses` in the local generated 1.18.33 declarations.

### Prompt Submission

```ts
client.v2.session.prompt({
  sessionID: string,
  id?: string,
  prompt?: PromptInput,
  delivery?: "steer" | "queue",
  resume?: boolean,
});
```

Wire contract: `POST /api/session/{sessionID}/prompt` returns `{ data: SessionInputAdmitted }`. This admits input and schedules execution; it is not a final response.

Sources: `Session3.prompt` and `V2SessionPromptData`/responses in the local declarations.

### Streaming

```ts
client.v2.session.events({
  sessionID: string,
  after?: string,
}): Promise<ServerSentEventsResult<V2SessionEventsResponses>>;
```

Wire contract: `GET /api/session/{sessionID}/event`. It replays durable events after the aggregate sequence and continues with new events.

Source: `Session3.events` and `V2SessionEventsData` in the local declarations. The broader generated event union includes permission, session, message, and tool lifecycle events, but implementation must narrow against the actual V2 per-session response union rather than assume all global/legacy events appear there.

### Permission Request

Core V2 uses ordered `permissions` rules with `action`, `resource`, and `effect`. Official V2 documentation states that an unmatched permission defaults to `ask`; the base policy also asks for external-directory and `.env` access.

Deterministic, model-independent trigger:

```ts
client.v2.session.permission.create({
  sessionID,
  action: "external_directory",
  resources: [canonicalHarmlessPathOutsideDisposableRepository],
  save: [],
  agent,
});
```

Source: `Permission2.create` and route `POST /api/session/{sessionID}/permission` in the local declarations, plus the official V2 permissions defaults. The path must be purpose-created under the spike's temporary root. The probe must observe the real OpenCode pending request/event; a test double is not live evidence.

Verified live against 1.18.33 on 2026-10-02, with no model call. `create` returned HTTP 200 with `{ id, effect: "ask" }` in about 0.8 s and **does not block** until a reply arrives. The global event stream (`client.v2.event.subscribe`) delivered `permission.v2.asked` with the same `id`, `action`, and `resources`. Permission events carry **no durable sequence** and cannot be replayed, and the SDK's SSE subscription connects on its first read. A consumer must therefore be reading before the event is published. The live probe begins reading immediately after dispatching `create`. The small remaining race was explicitly accepted (see the reassessment spec's `decisions.md`).

### Permission Response

```ts
client.v2.session.permission.reply({
  sessionID: string,
  requestID: string,
  reply?: PermissionV2Reply,
  message?: string,
});
```

Wire contract: `POST /api/session/{sessionID}/permission/{requestID}/reply`, returning HTTP 204.

Sources: `Permission2.reply` and `V2SessionPermissionReplyData`/responses in the local declarations. Use one-time approval; do not persist an `always` rule. Verified live on 2026-10-02: `reply: "once"` returned HTTP 204, followed by a `permission.v2.replied` event (`reply=once`).

### Cancellation

Core V2 calls cancellation `interrupt`:

```ts
client.v2.session.interrupt({ sessionID: string });
```

Wire contract: `POST /api/session/{sessionID}/interrupt`. It interrupts execution owned by the current OpenCode process; idle interruption is a no-op.

Version-specific ordering and pass predicate, verified live against 1.18.33 on 2026-10-02:

1. Observe the durable `session.next.tool.called` event whose `tool` is `bash` and whose `input.command` contains the fixture's random token; record its `callID`. The fixture's PID file confirms the process started. OpenCode 1.18.33 emits no `session.next.shell.started` event for model-run commands, and the bash call did not raise a permission request under the default policy.
2. Call `client.v2.session.interrupt({ sessionID })` and require success.
3. Observe the durable `session.next.tool.failed` event for the same `callID` after the interrupt (live error: `Tool execution interrupted`). `session.next.step.ended` was observed next, but it is not required. Durable sequences are dense per session, and the interrupt request is not an event, so it is placed strictly between the last durable event read before it and the next one. A `tool.failed` at N+1 directly after the fixture's `tool.called` at N is therefore post-interrupt. Its `timestamp` must not precede the local interrupt request, because events queued before the interrupt can be read after it. Then confirm idle by polling `GET /api/session/active` until the session is no longer listed. No `session.idle` event is emitted. Read the start and terminal events from one global stream with explicit `next()` calls: leaving a `for await` loop early closes the stream.
4. Confirm the fixture process is gone (OpenCode terminated it), that no `session.next.tool.success` exists for that `callID`, and that no fixture-completion marker exists.

Sources: `Session3.interrupt`, `Session3.active`, the corresponding generated wire types, and the 2026-10-02 bounded live diagnostic recorded in the reassessment spec's `decisions.md`. The declarations do not promise a distinct terminal `cancelled` event, so tests must not invent one.

### Final Result

Core V2 separates admission from completion:

- `client.v2.session.prompt(...)` returns `SessionInputAdmitted`.
- `client.v2.session.active()` (`GET /api/session/active`) returns a map keyed by the IDs of running sessions (`{ type: "running" }`).
- `client.v2.session.messages({ sessionID, order: "asc" })` retrieves projected messages oldest-first. **The default order is newest-first**, so correlation must request `asc`.
- `client.v2.session.message(...)` retrieves one projected message.
- `client.v2.session.history(...)` and `.events(...)` provide durable evidence. Streaming `session.next.text.delta` events carry no durable sequence.

**`client.v2.session.wait(...)` is not implemented in 1.18.33.** It is generated in the SDK, but the bundled server handler looks up the session and then always fails with `Session.OperationUnavailableError({ operation: "wait" })`, returned as HTTP 503 `ServiceUnavailableError` "Session wait is not available yet". `compact`, `shell`, and `skill` are stubbed the same way. Do not call `wait`.

Verified completion contract (live, 2026-10-02): after admission the session appears in `active` at once and emits durable `session.next.prompted`, `session.next.step.started`, `session.next.text.started`, `session.next.text.ended`, and `session.next.step.ended`, with tool events between steps. The session stays listed between steps and leaves `active` when the run finishes. `OpenCodeAdapter.waitUntilIdle` polls `active` within its finite deadline. For a prompt it also requires an assistant message after the admitted input in the ascending list, so a run that has not yet been scheduled cannot be mistaken for completion. In the 1.18.33 bundle, admission synchronously registers the run before the HTTP response, and the session stays registered until every step drains.

OpenCode 1.18.33 appends **one assistant message per model step**. When a step starts, the projector completes the previous assistant message and appends a new one. A turn that uses tools therefore holds several assistant messages, for example a tool-call step followed by a final text step. The final result is the turn's **last** assistant message: after the admitted input and before the next user input in the ascending list, with `time.completed` set (`finalAssistantResponseText`). Earlier step messages are intermediate and never the result. Prompt admission alone is not success.

Sources: the corresponding `Session3` signatures and V2 wire types in the local declarations, inspection of the 1.18.33 server bundle, and the bounded live diagnostics recorded in the reassessment spec's `decisions.md`. Re-verify on every OpenCode upgrade, and switch to a native `wait` when one is implemented.

### Session Deletion — Verified Compatibility Bridge

Core V2 1.18.33 has no native generated session-deletion method, but the bundled legacy deletion endpoint is verified against a Core V2-created session for this exact version pair.

`client.v2.session` exposes list, create, active, get, switch, prompt, compact, wait, context, history, events, interrupt, messages, revert, permission, and question operations. It exposes no `delete` method, and generated Core V2 types contain no `DELETE /api/session/{sessionID}` operation.

The same package exposes:

```ts
client.session.delete({ sessionID, directory?, workspace? });
```

on `DELETE /session/{sessionID}`.

Live compatibility evidence on 2026-09-29, using an isolated temporary XDG data/config/state root and the project-local CLI/SDK pair:

1. `client.v2.session.create({ agent: "build" })` created `ses_f119a3330ffe2zY5QMJPk5V7Af`.
2. `client.v2.session.get(...)` returned HTTP 200.
3. `client.session.delete(...)` returned HTTP 200 and `true`.
4. A second `client.v2.session.get(...)` returned HTTP 404 with `SessionNotFoundError`.

Sources: the live check above; manual inspection of `Session3`, every Core V2 `/api/session/{sessionID}` route, legacy `Session2.delete`, and `SessionDeleteData` in the local declarations. Official legacy server documentation also lists the deletion endpoint.

For `1.18.33`, the adapter may use this compatibility bridge, but it must keep deletion behind one adapter method and assert the post-delete Core V2 lookup returns 404. Re-verify on every OpenCode upgrade and replace it with a native Core V2 delete method when one becomes available.

### Session Creation Payload Caveat

Although `Session3.create(parameters?)` is generated with an optional parameter, live calls with no argument or `{}` produced `InvalidRequestError: Expected object, got undefined` because the empty body was omitted. Supplying `{ agent: "build" }` succeeded. Group 2 must always send a non-empty creation payload and cover this 1.18.33 behavior in tests.

## Dependency Choices

Group 3 verification commands:

```bash
npm run typecheck
npm test
```

Approved exact Group 2 development dependencies:

```bash
npm install --save-dev --save-exact \
  typescript@7.0.2 \
  vitest@5.0.2 \
  @types/node@24.12.2
```

Runtime dependencies are pinned exactly in `package.json`: `@opencode-ai/sdk@1.18.33` and `opencode-ai@1.18.33`. Do not use a global CLI or the transitive SDK under `~/.config/opencode`.

## Contracts And Integrations

- OpenCode remains the permission-enforcement and execution engine.
- Use Core V2 methods only for Core V2 capability claims.
- Use the project-local CLI/SDK pair at `1.18.33`.
- Use a purpose-created disposable repository and harmless temporary path.
- Never emit authorization headers or provider credentials into reports, logs, tests, or fixtures.

## Environment Notes

- Local CLI invocation: `npx --no-install opencode`.
- The user-level OpenCode config has no explicit permission policy. Under it, the `external_directory` trigger returned `effect: "ask"` live on 2026-10-02. A model-run `bash` command and the `glob` tool executed without a permission request.
- **Known limitation for Milestone 1:** in 1.18.33, OpenCode's shell tool inherits the server process environment, so model-run commands can read `OPENCODE_SERVER_PASSWORD` and call the local authenticated server API, including permission replies. The feasibility probe gains no privilege from this, because it already grants `bash` and answers its own request. Before Quoder forwards real user permission decisions, it must keep server credentials out of tool environments, for example with a `shell.env` plugin hook or an upstream fix.
- The provider configuration contains an inline authorization credential. It is not reproduced here. Rotate it and move it to an environment/secret mechanism before capturing live probe logs.
- A sandbox may require localhost-bind permission and writable XDG data/state directories; that is an execution-environment concern, not an OpenCode API limitation.

## Live Verification Diagnostics

`npm run verify:live` records timestamped lifecycle and scenario-stage transitions in
`.live-build/verify-live.journal.jsonl` and mirrors the same entries to stderr. The journal is
rewritten for each invocation, is gitignored with the rest of `.live-build`, and deliberately
contains only fixed stage names—never authorization headers, credentials, model content, or raw
server diagnostics.

The complete live run has a default 600,000 ms deadline. Override it only when diagnosing a
specific environment:

```bash
QUODER_LIVE_TIMEOUT_MS=300000 \
QUODER_LIVE_JOURNAL_PATH=/tmp/quoder-live.journal.jsonl \
npm run verify:live
```

On deadline expiry, the verifier records `stage.run.timeout`, closes any available driver,
attempts normal disposable-environment cleanup, prints a conservative nine-capability FAIL
report, and exits nonzero.

## Milestone 0 Live Result

QA Cycle 2 ran the authoritative `npm run verify:live` command on 2026-09-30
with the following environment:

| Component | Tested value |
| --- | --- |
| Platform | macOS 26.7 (Build 25G229), arm64 |
| Node | `v24.18.1` |
| npm | `12.0.2` |
| OpenCode CLI | project-local `opencode-ai@1.18.33` |
| OpenCode SDK | project-local `@opencode-ai/sdk@1.18.33` |
| Ollama service | Unavailable immediately before the run |

The command exited `1` after 120.9 seconds. It created the disposable
environment, launched and authenticated the project-local OpenCode server, and
created the first Core V2 session. The initial prompt did not complete before
its 120-second operation timeout. The journal then recorded session cleanup,
driver close, environment removal, and the nonzero process exit. Post-run
inspection found no residual verifier, OpenCode server, cancellation fixture,
or generated temporary repository.

Authoritative command:

```bash
npm run verify:live
```

Observed capability matrix:

| Capability | Result | Evidence limitation |
| --- | --- | --- |
| Fresh session creation | FAIL | One Core V2 session was created; the second unique session was not reached. |
| Project directory | FAIL | No completed model file activity proved repository confinement. |
| Local model invocation | FAIL | The initial prompt timed out while the Ollama service was unavailable. |
| Streaming events | FAIL | No qualifying structured execution event was observed before timeout. |
| Permission handling | FAIL | The Core V2 permission request/reply stage was not reached. |
| File modification | FAIL | No verified `hello.txt` containing `Hello from OpenCode` was produced. |
| Cancellation | FAIL | Fixture start, interrupt, idle, termination, and no-late-completion validation were not reached. |
| Session deletion | FAIL | Cleanup completed, but normal deletion of both required sessions plus Core V2 404 checks was not proven. |
| Session isolation | FAIL | The second session and exact `NO_PRIOR_SESSION` exchange were not reached. |

**Capability Verdict: FAIL.** The nine predicates are conjunctive and remain
failed when their complete live evidence is absent. Most predicates were not
reached; this result must not be interpreted as proof that their underlying SDK
operations inherently fail.

**QA Verdict: PASS.** The validation mechanism ran reliably, terminated in
finite time, retained an auditable stage record, emitted the complete matrix,
and cleaned up. This validates the quality of the negative result, not the
feasibility of Quoder's disposable-session architecture.

Milestone 0 did not pass and Milestone 1 remains blocked. Before another live
feasibility attempt, restore and preflight the required Ollama/model service or
reassess the architecture and its environment dependency in a separate spec.
Passing unit tests and `npm run verify:live:smoke` do not substitute for this
live evidence.

## Remaining Live Verification Items

The environment reassessment (2026-10-02) verified each underlying mechanism
live against the pinned 1.18.33 server, in bounded scratch diagnostics:

- model completion through `session/active`, and ascending final-response
  correlation;
- the permission create/asked/reply round-trip;
- the interrupted-tool cancellation sequence;
- session deletion during cleanup.

None of these is capability evidence. All nine predicates above still have to
pass together in one explicitly authorized `npm run verify:live` run against
the configured model. That run additionally depends on the model following
instructions exactly:

- writing `hello.txt` and replying `TOKEN_STORED`;
- running the fixture once, in the foreground;
- replying `NO_PRIOR_SESSION` in the isolation session.

Run `npm run verify:environment` immediately beforehand. If Permission handling
fails with no observed `permission.v2.asked` event, investigate the accepted
subscription race first. Re-verify the legacy-delete/Core-V2 compatibility
bridge and the `wait`/`active` contracts whenever OpenCode is upgraded.

## Environment Reassessment — Group 1 Diagnosis

Collected on 2026-09-30 (completed at `2026-09-30T23:10:43Z`) without changing
the service, models, user configuration, or pinned packages.

The active OpenCode configuration defines provider `ollama` through
`@ai-sdk/openai-compatible`, using a remote HTTPS OpenAI-compatible endpoint at
`llm.quackerjack.com/v1`. Authorization is supplied by an inline header; its
value was neither printed nor persisted. The provider declares six models,
including `qwen3-coder:30b`. Historical OpenCode state also identifies
`ollama/qwen3-coder:30b` as a previously selected model. Endpoint ownership and
the product's eventual default model remain decisions for Group 2; this group
tested the currently configured provider and model without treating localhost
Ollama availability as authoritative.

| Layer | Bound | Exit | Result | Evidence |
| --- | --- | --- | --- | --- |
| Versions | Command completion | 0 | PASS | Node `v24.18.1`, npm `12.0.2`, Ollama client `0.34.0`, `opencode-ai@1.18.33`, and `@opencode-ai/sdk@1.18.33`. The local Ollama client reported no localhost service, but localhost is not the configured provider endpoint. |
| Remote endpoint and model discovery | 10 seconds | 0 | PASS | Authenticated `GET /v1/models` returned HTTP 200 in 295 ms, reported seven models, and included `qwen3-coder:30b`. |
| Direct inference | 45 seconds | 0 | PASS | Authenticated `POST /v1/chat/completions` using `qwen3-coder:30b` returned HTTP 200 and exact `ENVIRONMENT_READY` in 16,370 ms. An earlier attempt was excluded as inconclusive because its command wrapper stopped capturing before the request's own deadline. |
| Project-local OpenCode discovery | Command completion | 0 | PASS | `npx --no-install opencode models ollama --pure` listed the configured models, including `ollama/qwen3-coder:30b`. |
| Project-local OpenCode inference | 45 seconds per adapter operation | 1 | FAIL | An authenticated disposable OpenCode server created a Core V2 session explicitly targeting `ollama/qwen3-coder:30b` and admitted the sentinel prompt, but `session.wait` returned HTTP 503 `ServiceUnavailableError`; total time was 1,548 ms. |
| Cleanup | Bounded adapter deletion and synchronous server close | 0 | PASS | The diagnostic deleted the session through the verified compatibility bridge, closed the server, removed the disposable repository, and completed cleanup in 1,679 ms. A post-run process check found no matching OpenCode server or diagnostic process. |

The first explicit-model attempt used the invalid field name `modelID` instead
of the verified Core V2 `ModelRef.id`; it failed session validation in 670 ms,
cleaned up in 676 ms, and is excluded from provider compatibility evidence.

Group 1/2 taxonomy classification (**superseded on 2026-10-02**, see "Reassessment
Outcome" below): **Integration incompatibility**. Equivalent
direct inference succeeds while the pinned project-local OpenCode integration
fails. This classification does not yet distinguish an OpenCode/provider
configuration mismatch from a defect or version incompatibility inside the
pinned integration boundary; Group 2 must make that architectural distinction.
The result is `Future Capability QA: NO-GO` until a reviewed correction and
deterministic preflight pass. No Milestone 0 capability changed to PASS.

Group 2 repeated the explicit-model OpenCode check in the unrestricted target
environment, ruling out sandbox networking as the cause: `session.wait` again
returned HTTP 503 in 1,775 ms and cleanup completed in 1,884 ms. A one-second
runner-registration delay produced the same 503 in 2,396 ms. A separate
30-second correlated-message poll observed no assistant response and cleaned up
in 31,864 ms. Explicit model binding is therefore necessary to eliminate the
prior ambient-default mismatch but is not sufficient to make the pinned
integration ready.

The approved smallest reversible correction is to bind model-executing sessions
to `{ providerID: "ollama", id: "qwen3-coder:30b" }` and add the layered
`npm run verify:environment` preflight. User provider configuration and exact
package pins remain unchanged because direct inference passes and no alternate
package version has verified compatibility evidence. Security review applies.

### Environment Preflight Implementation

Group 3 added `npm run verify:environment`. It reads only the approved provider
shape, validates both declared and installed OpenCode `1.18.33` pins, performs
bounded discovery and sentinel inference, launches an authenticated disposable
OpenCode server, and always emits these eight credential-safe rows in order:

1. `Pinned dependencies`
2. `Provider configuration`
3. `Endpoint reachability`
4. `Model discovery`
5. `Direct inference`
6. `OpenCode model discovery`
7. `OpenCode inference`
8. `Cleanup`

The command uses 10-second discovery deadlines, 60-second inference deadlines,
and a 180-second whole-run deadline. It exits zero only when all rows pass and
prints exactly one `Environment Readiness: PASS|FAIL` verdict. Diagnostics use
fixed evidence text; raw configuration, authorization values, model content,
and server diagnostics are not rendered.

The target-environment verification on 2026-09-30 produced PASS for every row
except `OpenCode inference`, so the command exited 1 with
`Environment Readiness: FAIL`.

### Reassessment Outcome

On 2026-10-02 the `OpenCode inference` failure was traced to Quoder's use of
Core V2, not to the provider, the model, or OpenCode's execution:

- `session.wait` is an unconditional 503 stub in 1.18.33. See "Final Result"
  for the bundle evidence and the replacement completion contract.
- The earlier 30-second poll most likely missed the reply because messages
  default to newest-first.
- Model execution itself completed in about 2 s.

After the corrections, the authenticated disposable OpenCode run returns the
exact sentinel. The real preflight passed all eight rows with exit 0 on every
run on 2026-10-02: QA Cycle 1 recorded 5 of 5 runs at about 5 s each, with no
residue. Seven synthetic failure-path runs used temporary configurations, each
exited 1 with the correct failing row, and all output was structurally free of
credentials.

The general review (Cycle 7), the security review (Cycle 1), and QA (Cycle 1)
all passed. The recommendation is **`Future Capability QA: GO`**. This does not
pass Milestone 0, does not authorize Milestone 1, and does not authorize
`npm run verify:live`, which requires explicit user authorization. The
capability verdict above remains FAIL until that run.

## Group 1 Verification Checklist

- [x] Package and runtime versions recorded with local evidence.
- [x] Import paths and hosting/client signatures recorded with 1.18.33 declaration paths.
- [x] Location, creation, prompt, streaming, permission, cancellation, and final-result contracts recorded with exact methods and sources.
- [x] Deterministic `ask` action identified from official V2 defaults and the real permission-create API.
- [x] Cancellation ordering documented without inventing a terminal event.
- [x] Native Core V2 deletion is absent, but the bundled legacy delete endpoint was verified to remove a Core V2-created session under 1.18.33; post-delete Core V2 lookup returned 404.
