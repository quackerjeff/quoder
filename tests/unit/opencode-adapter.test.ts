import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenCodeAdapter,
  OpenCodeAdapterError,
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
  wait: ReturnType<typeof vi.fn>;
  messages: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  globalEvents: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
}

const fakeClient = (): { client: OpencodeClient; methods: FakeMethods } => {
  const methods: FakeMethods = {
    create: vi.fn(),
    prompt: vi.fn(),
    events: vi.fn(),
    createPermission: vi.fn(),
    replyPermission: vi.fn(),
    interrupt: vi.fn(),
    wait: vi.fn(),
    messages: vi.fn(),
    get: vi.fn(),
    globalEvents: vi.fn(),
    deleteSession: vi.fn(),
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
        wait: methods.wait as Method<OpencodeClient["v2"]["session"]["wait"]>,
        messages: methods.messages as Method<OpencodeClient["v2"]["session"]["messages"]>,
        get: methods.get as Method<OpencodeClient["v2"]["session"]["get"]>,
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
    await adapter.replyPermission("session-1", "permission-1");

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
