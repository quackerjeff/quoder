import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenCodeAdapter,
  OpenCodeAdapterError,
  finalAssistantResponseText,
  hasAssistantResponseAfter,
} from "../../src/opencode-adapter.js";

type ClientMethod = (...args: never[]) => unknown;
type Method<T extends ClientMethod> = T;

const response = (status = 200): Response => new Response(null, { status });

const result = <T>(data: T, status = 200) => ({
  data,
  error: undefined,
  response: response(status),
});

const failedResult = (error: unknown, status: number) => ({
  data: undefined,
  error,
  response: response(status),
});

interface FakeMethods {
  create: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  events: ReturnType<typeof vi.fn>;
  createPermission: ReturnType<typeof vi.fn>;
  replyPermission: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  active: ReturnType<typeof vi.fn>;
  messages: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  globalEvents: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  rejectQuestion: ReturnType<typeof vi.fn>;
}

const fakeClient = (): { client: OpencodeClient; methods: FakeMethods } => {
  const methods: FakeMethods = {
    create: vi.fn(),
    prompt: vi.fn(),
    events: vi.fn(),
    createPermission: vi.fn(),
    replyPermission: vi.fn(),
    interrupt: vi.fn(),
    active: vi.fn(),
    messages: vi.fn(),
    get: vi.fn(),
    globalEvents: vi.fn(),
    deleteSession: vi.fn(),
    rejectQuestion: vi.fn(),
  };

  const client = {
    v2: {
      session: {
        create: methods.create as Method<OpencodeClient["v2"]["session"]["create"]>,
        prompt: methods.prompt as Method<OpencodeClient["v2"]["session"]["prompt"]>,
        events: methods.events as Method<OpencodeClient["v2"]["session"]["events"]>,
        permission: {
          create: methods.createPermission as Method<
            OpencodeClient["v2"]["session"]["permission"]["create"]
          >,
          reply: methods.replyPermission as Method<
            OpencodeClient["v2"]["session"]["permission"]["reply"]
          >,
        },
        interrupt: methods.interrupt as Method<OpencodeClient["v2"]["session"]["interrupt"]>,
        active: methods.active as Method<OpencodeClient["v2"]["session"]["active"]>,
        messages: methods.messages as Method<OpencodeClient["v2"]["session"]["messages"]>,
        get: methods.get as Method<OpencodeClient["v2"]["session"]["get"]>,
        question: {
          reject: methods.rejectQuestion as Method<OpencodeClient["v2"]["session"]["question"]["reject"]>,
        },
      },
      event: {
        subscribe: methods.globalEvents as Method<OpencodeClient["v2"]["event"]["subscribe"]>,
      },
    },
    session: {
      delete: methods.deleteSession as Method<OpencodeClient["session"]["delete"]>,
    },
  } as unknown as OpencodeClient;

  return { client, methods };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("verified OpenCode 1.18.33 request payloads", () => {
  it("creates a Core V2 session with a non-empty payload and location", async () => {
    const { client, methods } = fakeClient();
    methods.create.mockResolvedValue(result({ data: { id: "session-1" } }));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100 });

    await expect(
      adapter.createSession({
        directory: "/tmp/quoder-repository",
        agent: "build",
        model: { providerID: "ollama", id: "model" },
      }),
    ).resolves.toMatchObject({ id: "session-1" });

    expect(methods.create).toHaveBeenCalledWith(
      {
        agent: "build",
        location: { directory: "/tmp/quoder-repository" },
        model: { providerID: "ollama", id: "model" },
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("submits text using the Core V2 prompt shape", async () => {
    const { client, methods } = fakeClient();
    methods.prompt.mockResolvedValue(result({ data: { id: "input-1" } }));
    const adapter = new OpenCodeAdapter({ client });

    await adapter.prompt("session-1", "hello");

    expect(methods.prompt).toHaveBeenCalledWith(
      { sessionID: "session-1", prompt: { text: "hello" } },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("creates and replies to a permission request with one-time approval", async () => {
    const { client, methods } = fakeClient();
    methods.createPermission.mockResolvedValue(
      result({ data: { id: "permission-1", effect: "ask" } }),
    );
    methods.replyPermission.mockResolvedValue(result(undefined, 204));
    const adapter = new OpenCodeAdapter({ client });

    await adapter.createPermission({
      sessionID: "session-1",
      action: "external_directory",
      resources: ["/tmp/quoder-outside"],
      agent: "build",
    });
    await adapter.replyPermission("session-1", "permission-1", "once");

    expect(methods.createPermission).toHaveBeenCalledWith(
      {
        sessionID: "session-1",
        action: "external_directory",
        resources: ["/tmp/quoder-outside"],
        save: [],
        agent: "build",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(methods.replyPermission).toHaveBeenCalledWith(
      { sessionID: "session-1", requestID: "permission-1", reply: "once" },
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe("timeouts and diagnostics", () => {
  it("aborts a request after the configured finite timeout", async () => {
    vi.useFakeTimers();
    const { client, methods } = fakeClient();
    methods.create.mockImplementation(
      (_parameters: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 25 });

    const pending = adapter.createSession({ directory: "/tmp/repository" });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "OpenCodeAdapterError",
      diagnostic: { operation: "create session", message: "timed out after 25ms" },
    });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    const signal = methods.create.mock.calls[0]?.[1].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it("preserves operation, HTTP status, and structured error tag", async () => {
    const { client, methods } = fakeClient();
    methods.prompt.mockResolvedValue(
      failedResult({ _tag: "InvalidRequestError", message: "prompt rejected" }, 400),
    );
    const adapter = new OpenCodeAdapter({ client });

    await expect(adapter.prompt("session-1", "hello")).rejects.toEqual(
      expect.objectContaining<Partial<OpenCodeAdapterError>>({
        diagnostic: {
          operation: "submit prompt",
          status: 400,
          errorTag: "InvalidRequestError",
          message: "prompt rejected",
        },
      }),
    );
  });
});

describe("event stream lifecycle", () => {
  it("passes the cursor and aborts the SSE subscription when iteration closes", async () => {
    const { client, methods } = fakeClient();
    let sourceClosed = false;
    async function* source() {
      try {
        yield { sequence: "1", event: { type: "session.idle", properties: {} } };
      } finally {
        sourceClosed = true;
      }
    }
    methods.events.mockResolvedValue({ stream: source() });
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100 });

    const stream = await adapter.events("session-1", "cursor-1");
    await stream.next();
    await stream.return(undefined);

    expect(methods.events).toHaveBeenCalledWith(
      { sessionID: "session-1", after: "cursor-1" },
      { signal: expect.any(AbortSignal), sseMaxRetryAttempts: 0 },
    );
    const signal = methods.events.mock.calls[0]?.[1].signal as AbortSignal;
    expect(sourceClosed).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("clears and aborts a global event stream when the consumer closes it", async () => {
    const { client, methods } = fakeClient();
    async function* source() {
      yield { type: "server.connected", properties: {} };
    }
    methods.globalEvents.mockResolvedValue({ stream: source() });
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100 });

    const stream = await adapter.globalEvents();
    await stream.next();
    await stream.return(undefined);

    const options = methods.globalEvents.mock.calls[0]?.[0] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(true);
    expect(options).toMatchObject({ sseMaxRetryAttempts: 0 });
  });
});

describe("version-scoped session deletion bridge", () => {
  it("accepts legacy deletion only after Core V2 confirms SessionNotFoundError", async () => {
    const { client, methods } = fakeClient();
    methods.deleteSession.mockResolvedValue(result(true));
    methods.get.mockResolvedValue(
      failedResult({ _tag: "SessionNotFoundError", message: "not found" }, 404),
    );
    const adapter = new OpenCodeAdapter({ client });

    await expect(adapter.deleteSession("session-1")).resolves.toBeUndefined();

    expect(methods.deleteSession).toHaveBeenCalledWith(
      { sessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(methods.get).toHaveBeenCalledWith(
      { sessionID: "session-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(methods.deleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      methods.get.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects a legacy endpoint that does not accept deletion", async () => {
    const { client, methods } = fakeClient();
    methods.deleteSession.mockResolvedValue(result(false));
    const adapter = new OpenCodeAdapter({ client });

    await expect(adapter.deleteSession("session-1")).rejects.toMatchObject({
      diagnostic: { operation: "delete session", status: 200 },
    });
    expect(methods.get).not.toHaveBeenCalled();
  });

  it("rejects a lookup that does not prove the Core V2 session is gone", async () => {
    const { client, methods } = fakeClient();
    methods.deleteSession.mockResolvedValue(result(true));
    methods.get.mockResolvedValue(result({ id: "session-1" }));
    const adapter = new OpenCodeAdapter({ client });

    await expect(adapter.deleteSession("session-1")).rejects.toMatchObject({
      diagnostic: {
        operation: "verify session deletion",
        status: 200,
        message: "Core V2 lookup did not confirm deletion",
      },
    });
  });
});

describe("Core V2 completion without the unimplemented 1.18.33 session.wait", () => {
  const transcript = (...messages: unknown[]) => result({ data: messages, cursor: {} });
  const user = (id: string) => ({ id, type: "user", time: { created: 1 }, text: "prompt" });
  const assistant = (id: string) => ({
    id,
    type: "assistant",
    time: { created: 2 },
    agent: "build",
    model: { providerID: "ollama", id: "model" },
    content: [{ type: "text", id: `${id}-text`, text: "done" }],
  });
  const running = (sessionID: string) => result({ data: { [sessionID]: { type: "running" } } });
  const idle = () => result({ data: {} });

  it("requests messages in ascending order", async () => {
    const { client, methods } = fakeClient();
    methods.messages.mockResolvedValue(transcript());
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100 });

    await adapter.messages("session-1");

    expect(methods.messages).toHaveBeenCalledWith(
      { sessionID: "session-1", order: "asc" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("never calls session.wait and completes once the session leaves the active set", async () => {
    const { client, methods } = fakeClient();
    methods.active
      .mockResolvedValueOnce(running("session-1"))
      .mockResolvedValueOnce(running("session-1"))
      .mockResolvedValue(idle());
    methods.messages.mockResolvedValue(transcript(user("input-1"), assistant("assistant-1")));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 1_000, idlePollIntervalMs: 1 });

    await expect(adapter.waitUntilIdle("session-1", { afterInputID: "input-1" })).resolves.toBeUndefined();

    expect(methods.active).toHaveBeenCalledTimes(3);
    expect(methods.active).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(Reflect.get(client.v2.session, "wait")).toBeUndefined();
  });

  it("ignores other running sessions", async () => {
    const { client, methods } = fakeClient();
    methods.active.mockResolvedValue(running("session-other"));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100, idlePollIntervalMs: 1 });

    await expect(adapter.waitUntilIdle("session-1")).resolves.toBeUndefined();
  });

  it("does not treat an inactive session without a response to the admitted input as complete", async () => {
    vi.useFakeTimers();
    const { client, methods } = fakeClient();
    methods.active.mockResolvedValue(idle());
    methods.messages
      .mockResolvedValueOnce(transcript(user("input-1")))
      .mockResolvedValueOnce(transcript(user("input-1"), assistant("assistant-old"), user("input-2")))
      .mockResolvedValue(transcript(user("input-1"), assistant("assistant-1")));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 1_000, idlePollIntervalMs: 10 });

    const completion = adapter.waitUntilIdle("session-1", { afterInputID: "input-2" });
    const outcome = completion.then(() => "resolved", (error: Error) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcome).resolves.toMatchObject({
      diagnostic: { operation: "wait for session", message: "timed out after 1000ms" },
    });
  });

  it("fails finitely when the session is still running at the deadline", async () => {
    vi.useFakeTimers();
    const { client, methods } = fakeClient();
    methods.active.mockResolvedValue(running("session-1"));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100, idlePollIntervalMs: 10 });

    const outcome = adapter.waitUntilIdle("session-1").then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);

    const error = await outcome;
    expect(error).toBeInstanceOf(OpenCodeAdapterError);
    expect(error).toMatchObject({ diagnostic: { operation: "wait for session" } });
    expect(methods.active.mock.calls.length).toBeGreaterThan(1);
    expect(methods.messages).not.toHaveBeenCalled();
  });

  it("surfaces a failed active-session request with its diagnostic", async () => {
    const { client, methods } = fakeClient();
    methods.active.mockResolvedValue(failedResult({ _tag: "UnauthorizedError", message: "denied" }, 401));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100, idlePollIntervalMs: 1 });

    await expect(adapter.waitUntilIdle("session-1")).rejects.toMatchObject({
      diagnostic: { operation: "list active sessions", status: 401, errorTag: "UnauthorizedError" },
    });
  });

  it("bounds each poll request by the remaining wait deadline", async () => {
    vi.useFakeTimers();
    const { client, methods } = fakeClient();
    methods.active.mockImplementation(
      (options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100, idlePollIntervalMs: 10 });

    const outcome = adapter.waitUntilIdle("session-1").then(() => "resolved", (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);

    await expect(outcome).resolves.toMatchObject({
      diagnostic: { operation: "wait for session", message: "timed out after 100ms" },
      cause: { diagnostic: { operation: "list active sessions" } },
    });
  });

  it("takes the turn's last completed assistant message as the final response", () => {
    const step = (id: string, text: string, completed: number | undefined) => ({
      ...assistant(id),
      time: completed === undefined ? { created: 2 } : { created: 2, completed },
      content: [{ type: "text", id: `${id}-text`, text }],
    });
    const multiStep = {
      data: [user("input-1"), step("tool-step", "Creating the file.", 3), step("final", " TOKEN_STORED ", 4), user("input-2")],
      cursor: {},
    } as unknown as Parameters<typeof finalAssistantResponseText>[0];
    const incompleteFinal = {
      data: [user("input-1"), step("tool-step", "TOKEN_STORED", 3), step("final", "TOKEN", undefined)],
      cursor: {},
    } as unknown as Parameters<typeof finalAssistantResponseText>[0];

    expect(finalAssistantResponseText(multiStep, "input-1")).toBe("TOKEN_STORED");
    expect(finalAssistantResponseText(multiStep, "input-2")).toBeUndefined();
    expect(finalAssistantResponseText(multiStep, "missing")).toBeUndefined();
    expect(finalAssistantResponseText(incompleteFinal, "input-1")).toBeUndefined();
  });

  it("does not accept a final step that failed as the final response", () => {
    const failedStep = (extra: Record<string, unknown>) => ({
      data: [
        user("input-1"),
        {
          ...assistant("final"),
          time: { created: 2, completed: 3 },
          content: [{ type: "text", id: "final-text", text: "TOKEN_STORED" }],
          ...extra,
        },
      ],
      cursor: {},
    }) as unknown as Parameters<typeof finalAssistantResponseText>[0];

    expect(finalAssistantResponseText(failedStep({ finish: "error" }), "input-1")).toBeUndefined();
    expect(
      finalAssistantResponseText(failedStep({ error: { type: "unknown", message: "failed" } }), "input-1"),
    ).toBeUndefined();
    expect(finalAssistantResponseText(failedStep({ finish: "stop" }), "input-1")).toBe("TOKEN_STORED");
  });

  it("maps only structured poll timeouts to the wait timeout", async () => {
    const { client, methods } = fakeClient();
    methods.active.mockResolvedValue(
      failedResult({ _tag: "UnknownError", message: "timed out upstream" }, 500),
    );
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100, idlePollIntervalMs: 1 });

    await expect(adapter.waitUntilIdle("session-1")).rejects.toMatchObject({
      diagnostic: { operation: "list active sessions", status: 500, message: "timed out upstream" },
    });
  });

  it("correlates an assistant response only within the admitted input's turn", () => {
    const messages = {
      data: [user("input-1"), assistant("assistant-1"), user("input-2")],
      cursor: {},
    } as unknown as Parameters<typeof hasAssistantResponseAfter>[0];

    expect(hasAssistantResponseAfter(messages, "input-1")).toBe(true);
    expect(hasAssistantResponseAfter(messages, "input-2")).toBe(false);
    expect(hasAssistantResponseAfter(messages, "missing")).toBe(false);
  });
});

describe("question rejection and long-lived global streams", () => {
  async function* pendingUntilAborted(signal: AbortSignal) {
    if (!signal.aborted) {
      await new Promise<void>((resolveAbort) => signal.addEventListener("abort", () => resolveAbort(), { once: true }));
    }
  }

  it("rejects a pending question through the Core V2 question API", async () => {
    const { client, methods } = fakeClient();
    methods.rejectQuestion.mockResolvedValue(result(undefined, 204));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100 });

    await adapter.rejectQuestion("session-1", "question-1");

    expect(methods.rejectQuestion).toHaveBeenCalledWith(
      { sessionID: "session-1", requestID: "question-1" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("surfaces a failed question rejection with its diagnostic", async () => {
    const { client, methods } = fakeClient();
    methods.rejectQuestion.mockResolvedValue(failedResult({ _tag: "NotFoundError", message: "gone" }, 404));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 100 });

    await expect(adapter.rejectQuestion("session-1", "question-1")).rejects.toMatchObject({
      diagnostic: { operation: "reject question request", status: 404 },
    });
  });

  it("ends a global stream when the caller's signal aborts, even with a read pending", async () => {
    const { client, methods } = fakeClient();
    methods.globalEvents.mockImplementation(async (options: { signal: AbortSignal }) => ({
      stream: pendingUntilAborted(options.signal),
    }));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 60_000 });
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");

    const stream = await adapter.globalEvents({ signal: caller.signal });
    const read = stream.next();
    caller.abort();

    await expect(read).resolves.toMatchObject({ done: true });
    const inner = methods.globalEvents.mock.calls[0]?.[0].signal as AbortSignal;
    expect(inner.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("aborts at once for an already-aborted caller signal", async () => {
    const { client, methods } = fakeClient();
    methods.globalEvents.mockImplementation(async (options: { signal: AbortSignal }) => ({
      stream: pendingUntilAborted(options.signal),
    }));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 60_000 });

    const stream = await adapter.globalEvents({ signal: AbortSignal.abort() });

    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("bounds a global stream by its own timeout instead of the adapter default", async () => {
    vi.useFakeTimers();
    const { client, methods } = fakeClient();
    methods.globalEvents.mockImplementation(async (options: { signal: AbortSignal }) => ({
      stream: pendingUntilAborted(options.signal),
    }));
    const adapter = new OpenCodeAdapter({ client, timeoutMs: 10 });

    const stream = await adapter.globalEvents({ timeoutMs: 1_000 });
    const read = stream.next();
    const inner = methods.globalEvents.mock.calls[0]?.[0].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(500);
    expect(inner.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);

    await expect(read).resolves.toMatchObject({ done: true });
    expect(inner.aborted).toBe(true);
  });
});
