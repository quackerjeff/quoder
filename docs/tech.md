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

Sources: `Permission2.reply` and `V2SessionPermissionReplyData`/responses in the local declarations. Use one-time approval; do not persist an `always` rule.

### Cancellation

Core V2 calls cancellation `interrupt`:

```ts
client.v2.session.interrupt({ sessionID: string });
```

Wire contract: `POST /api/session/{sessionID}/interrupt`. It interrupts execution owned by the current OpenCode process; idle interruption is a no-op.

Version-specific ordering and pass predicate:

1. Observe a durable event proving the long-running fixture started.
2. Call `client.v2.session.interrupt({ sessionID })` and require success.
3. Call `client.v2.session.wait({ sessionID })`; it waits for idle and returns HTTP 204.
4. Confirm no normal successful fixture-completion event occurs after interruption and the fixture process is gone.

Sources: `Session3.interrupt`, `Session3.wait`, and corresponding generated wire types. The declarations do not promise a distinct terminal `cancelled` event, so tests must not invent one.

### Final Result

Core V2 separates admission from completion:

- `client.v2.session.prompt(...)` returns `SessionInputAdmitted`.
- `client.v2.session.wait(...)` waits for idle.
- `client.v2.session.messages(...)` retrieves projected messages.
- `client.v2.session.message(...)` retrieves one projected message.
- `client.v2.session.history(...)` and `.events(...)` provide durable evidence.

Sources: the corresponding `Session3` signatures and V2 wire types in the local declarations. The final result is the final projected assistant message after `wait`, correlated to the admitted input. Prompt admission alone is not success.

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
- The user-level OpenCode config has no explicit permission policy. Official Core V2 defaults are the documented basis for the `external_directory` ask trigger; live verification is still required.
- The provider configuration contains an inline authorization credential. It is not reproduced here. Rotate it and move it to an environment/secret mechanism before capturing live probe logs.
- A sandbox may require localhost-bind permission and writable XDG data/state directories; that is an execution-environment concern, not an OpenCode API limitation.

## Open Verification Items

1. Confirm exact `LocationRef` construction by TypeScript compilation.
2. Confirm the one-time `PermissionV2Reply` literal through compilation.
3. Confirm V2 event union and cursor handling through compiled tests.
4. Execute the permission trigger against the real server without changing saved policy.
5. Re-verify the legacy-delete/Core-V2 compatibility bridge whenever OpenCode is upgraded.

## Group 1 Verification Checklist

- [x] Package and runtime versions recorded with local evidence.
- [x] Import paths and hosting/client signatures recorded with 1.18.33 declaration paths.
- [x] Location, creation, prompt, streaming, permission, cancellation, and final-result contracts recorded with exact methods and sources.
- [x] Deterministic `ask` action identified from official V2 defaults and the real permission-create API.
- [x] Cancellation ordering documented without inventing a terminal event.
- [x] Native Core V2 deletion is absent, but the bundled legacy delete endpoint was verified to remove a Core V2-created session under 1.18.33; post-delete Core V2 lookup returned 404.
