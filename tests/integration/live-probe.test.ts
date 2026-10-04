import { OpenCodeAdapterError } from "../../src/opencode-adapter.js";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient, V2Event } from "@opencode-ai/sdk/v2";
import { describe, expect, it, vi } from "vitest";

import { CAPABILITY_NAMES } from "../../src/capabilities.js";
import {
  createLiveRunJournal,
  liveRunTimeoutFromEnvironment,
} from "../../src/live-observability.js";
import {
  LIVE_PROBE_TIMEOUT_MS,
  LIVE_MODEL,
  OpenCodeLiveDriver,
  cancellationFromObservedEvents,
  correlatePermissionEvidence,
  createAuthenticatedOpenCodeDriver,
  createIsolationSessionAfterDeletion,
  evaluateLiveEvidence,
  findAdapterError,
  fixtureToolCallID,
  INITIAL_PROMPT_SENTINEL,
  ISOLATION_PROMPT,
  cancellationPrompt,
  initialPrompt,
  sessionStreamEvent,
  readConfinedRegularFile,
  runLiveProbe,
  settlePairedOperations,
  terminateValidatedFixture,
  type LiveProbeDependencies,
  type LiveProbeDriver,
  type LiveProbeEvidence,
  type LiveProbeEnvironment,
} from "../../src/live-probe.js";
import {
  SERVER_TERMINATION_UNCONFIRMED_MESSAGE,
  authenticatedServerProcessConfig,
  basicAuthorizationHeader,
  launchAuthenticatedOpenCodeServer,
  terminateOwnedChild,
  verifyServerAuthentication,
  type AuthenticatedServerLauncherDependencies,
} from "../../src/opencode-server.js";

type ClientMethod = (...args: never[]) => unknown;
type Method<T extends ClientMethod> = T;

const response = (status = 200): Response => new Response(null, { status });

/**
 * A fake v2 global stream that behaves like the 1.18.33 SDK and server: it is not connected until
 * its first read (events published earlier are lost, as non-durable events are), it then sends
 * `server.connected` first, and it delivers later events until the driver aborts or `end()`.
 */
const eventChannel = () => {
  const queue: V2Event[] = [];
  let wake: (() => void) | undefined;
  let connected = false;
  let closed = false;
  return {
    push(event: V2Event): void {
      if (!connected) return;
      queue.push(event);
      wake?.();
    },
    end(): void {
      closed = true;
      wake?.();
    },
    async *stream(signal: AbortSignal): AsyncGenerator<V2Event, void, unknown> {
      connected = true;
      yield { id: "connected", type: "server.connected", data: {} } as unknown as V2Event;
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (signal.aborted || closed) return;
        await new Promise<void>((resolveWake) => {
          wake = resolveWake;
          signal.addEventListener("abort", () => resolveWake(), { once: true });
        });
        wake = undefined;
      }
    },
  };
};

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

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const environment: LiveProbeEnvironment = {
  root: "/tmp/quoder-live-probe-test",
  repository: "/tmp/quoder-live-probe-test/repository",
  outside: "/tmp/quoder-live-probe-test/permission-target",
};

const passingEvidence: LiveProbeEvidence = {
  sessionIDs: ["session-1", "session-2"],
  projectPaths: [environment.repository, `${environment.repository}/hello.txt`],
  finalResponse: "TOKEN_STORED",
  admittedInputID: "input-1",
  responseInputID: "input-1",
  structuredEventObserved: true,
  permissionRequestID: "permission-1",
  helloContent: "Hello from OpenCode\n",
  cancellationPassed: true,
  deletedSessionIDs: ["session-2", "session-1"],
  isolationResponse: "NO_PRIOR_SESSION",
  nonce: "private-nonce",
};

const dependenciesWith = (
  driver: LiveProbeDriver,
): LiveProbeDependencies => ({
  createEnvironment: vi.fn().mockResolvedValue(environment),
  createDriver: vi.fn().mockResolvedValue(driver),
  removeEnvironment: vi.fn().mockResolvedValue(undefined),
});

describe("live probe smoke behavior", () => {
  it("prints the nine-row report once and exits zero only for a complete pass", async () => {
    const dependencies = dependenciesWith({
      run: vi.fn().mockResolvedValue(passingEvidence),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(0);
    for (const capability of CAPABILITY_NAMES) {
      expect(outcome.output.match(new RegExp(`^${capability}: PASS$`, "gm"))).toHaveLength(1);
    }
    expect(outcome.output.match(/^Capability Verdict: PASS$/gm)).toHaveLength(1);
  });

  it("reports every capability as failed and exits nonzero when the runtime is unavailable", async () => {
    const removeEnvironment = vi.fn().mockResolvedValue(undefined);
    const dependencies: LiveProbeDependencies = {
      createEnvironment: vi.fn().mockResolvedValue(environment),
      createDriver: vi.fn().mockRejectedValue(new Error("runtime unavailable")),
      removeEnvironment,
    };

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.results).toHaveLength(9);
    expect(outcome.report.results.every(({ status }) => status === "FAIL")).toBe(true);
    expect(removeEnvironment).toHaveBeenCalledWith(environment);
  });

  it("closes the runtime and removes the disposable repository after a probe error", async () => {
    const driver: LiveProbeDriver = {
      run: vi.fn().mockRejectedValue(new Error("probe timed out")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const dependencies = dependenciesWith(driver);

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(driver.close).toHaveBeenCalledOnce();
    expect(dependencies.removeEnvironment).toHaveBeenCalledWith(environment);
  });

  it("forces a failed report when runtime cleanup fails after successful evidence", async () => {
    const dependencies = dependenciesWith({
      run: vi.fn().mockResolvedValue(passingEvidence),
      close: vi.fn().mockRejectedValue(new Error("server remained active")),
    });

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.verdict).toBe("FAIL");
    expect(outcome.report.results.every(({ status }) => status === "FAIL")).toBe(true);
    expect(outcome.report.results[0]?.evidence).toContain(
      "driver cleanup failed: server remained active",
    );
  });

  it("forces a failed report when temporary-environment cleanup fails", async () => {
    const dependencies = dependenciesWith({
      run: vi.fn().mockResolvedValue(passingEvidence),
      close: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(dependencies.removeEnvironment).mockRejectedValue(
      new Error("temporary repository remained"),
    );

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.verdict).toBe("FAIL");
    expect(outcome.report.results.every(({ status }) => status === "FAIL")).toBe(true);
    expect(outcome.report.results[0]?.evidence).toContain(
      "environment cleanup failed: temporary repository remained",
    );
  });

  it("uses a finite live-operation timeout", () => {
    expect(LIVE_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(LIVE_PROBE_TIMEOUT_MS)).toBe(true);
  });

  it("fails every capability, cleans up, and records progress at the end-to-end deadline", async () => {
    const stages: string[] = [];
    const driver: LiveProbeDriver = {
      run: vi.fn(() => new Promise<LiveProbeEvidence>(() => undefined)),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const dependencies = dependenciesWith(driver);

    const outcome = await runLiveProbe(dependencies, {
      timeoutMs: 20,
      onProgress: (stage) => stages.push(stage),
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.results).toHaveLength(9);
    expect(outcome.report.results.every(({ status }) => status === "FAIL")).toBe(true);
    expect(outcome.report.results[0]?.evidence[0]).toContain("end-to-end timeout of 20ms");
    expect(stages).toContain("run.timeout");
    expect(driver.close).toHaveBeenCalled();
    expect(dependencies.removeEnvironment).toHaveBeenCalledWith(environment);
  });

  it("writes a durable timestamped journal and validates timeout overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-live-journal-test-"));
    const path = join(root, "nested", "journal.jsonl");
    const diagnostics: string[] = [];
    try {
      const journal = createLiveRunJournal(path, (line) => diagnostics.push(line));
      journal.progress("permission.start");
      journal.finish(1);
      const entries = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.map(({ event }: { event: string }) => event)).toEqual([
        "process.start",
        "stage.permission.start",
        "process.finish.exit-1",
      ]);
      expect(entries.every(({ timestamp }: { timestamp: string }) => !Number.isNaN(Date.parse(timestamp)))).toBe(true);
      expect(diagnostics).toHaveLength(3);
      expect(liveRunTimeoutFromEnvironment("1250")).toBe(1250);
      expect(() => liveRunTimeoutFromEnvironment("0")).toThrow(/positive finite/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("live evidence integrity", () => {
  it("deletes and verifies session one before creating the isolation session", async () => {
    const operations: string[] = [];
    const adapter = {
      deleteSession: vi.fn(async (sessionID: string) => {
        operations.push(`delete:${sessionID}`);
      }),
      createSession: vi.fn(async () => {
        operations.push("create:session-2");
        return { id: "session-2" };
      }),
    };

    await expect(
      createIsolationSessionAfterDeletion(adapter, "session-1", environment.repository),
    ).resolves.toEqual({ id: "session-2", deletedSessionID: "session-1" });
    expect(operations).toEqual(["delete:session-1", "create:session-2"]);
    expect(adapter.createSession).toHaveBeenCalledWith({
      directory: environment.repository,
      model: LIVE_MODEL,
    });
  });

  const toolEvent = (
    sequence: number,
    type: string,
    callID: string,
    extra: Record<string, unknown> = {},
  ) => ({ sequence, type, sessionID: "session-1", properties: { callID, ...extra } });
  const fixtureCall = (sequence: number, callID = "call-fixture", command = "node fixture.mjs token-1") =>
    toolEvent(sequence, "session.next.tool.called", callID, { tool: "bash", input: { command } });

  it("identifies only the bash tool call that runs the tokenized fixture", () => {
    expect(fixtureToolCallID(fixtureCall(7), "token-1")).toBe("call-fixture");
    expect(fixtureToolCallID(fixtureCall(7, "call-other", "node fixture.mjs other"), "token-1")).toBeUndefined();
    expect(
      fixtureToolCallID(
        toolEvent(7, "session.next.tool.called", "call-glob", { tool: "glob", input: { pattern: "token-1" } }),
        "token-1",
      ),
    ).toBeUndefined();
    expect(
      fixtureToolCallID(toolEvent(7, "session.next.tool.success", "call-fixture", { tool: "bash" }), "token-1"),
    ).toBeUndefined();
  });

  const interruptAt = 1_000;
  const interrupted = (sequence: number, callID = "call-fixture", timestamp = interruptAt + 5) =>
    toolEvent(sequence, "session.next.tool.failed", callID, {
      timestamp,
      error: { type: "unknown", message: "Tool execution interrupted" },
    });

  it("passes cancellation on the verified 1.18.33 interrupted-tool sequence", () => {
    const observedEvents = [
      fixtureCall(15),
      interrupted(16),
      { sequence: 17, type: "session.next.step.ended", sessionID: "session-1" },
    ];
    const withInterveningEvent = [
      fixtureCall(15),
      { sequence: 16, type: "session.next.text.ended", sessionID: "session-1" },
      interrupted(17),
    ];

    // Dense sequences: the terminal failure directly follows the last event read before the interrupt.
    expect(cancellationFromObservedEvents(observedEvents, "call-fixture", 15, interruptAt, true, false)).toBe(true);
    expect(cancellationFromObservedEvents(withInterveningEvent, "call-fixture", 15, interruptAt, true, false)).toBe(true);
  });

  it("rejects cancellation when the fixture call completes normally at any point", () => {
    const markerOnly = [fixtureCall(15), interrupted(17)];
    const successAfter = [fixtureCall(15), toolEvent(17, "session.next.tool.success", "call-fixture")];
    const successBefore = [
      fixtureCall(15),
      toolEvent(16, "session.next.tool.success", "call-fixture"),
      interrupted(18),
    ];

    expect(cancellationFromObservedEvents(markerOnly, "call-fixture", 16, interruptAt, true, true)).toBe(false);
    expect(cancellationFromObservedEvents(successAfter, "call-fixture", 16, interruptAt, true, false)).toBe(false);
    expect(cancellationFromObservedEvents(successBefore, "call-fixture", 17, interruptAt, true, false)).toBe(false);
  });

  it("rejects cancellation without correlated, correctly ordered interruption evidence", () => {
    const unrelatedFailure = [fixtureCall(15), interrupted(16, "call-other")];
    // Read before the interrupt was requested, so it cannot be the interrupt's effect.
    const failureReadBeforeInterrupt = [fixtureCall(15), interrupted(16)];
    // Read after the interrupt but produced before it (an already-queued event).
    const failureTimestampedBeforeInterrupt = [fixtureCall(15), interrupted(16, "call-fixture", interruptAt - 1)];
    const failureWithoutTimestamp = [fixtureCall(15), toolEvent(16, "session.next.tool.failed", "call-fixture")];
    const verified = [fixtureCall(15), interrupted(16)];

    expect(cancellationFromObservedEvents(unrelatedFailure, "call-fixture", 15, interruptAt, true, false)).toBe(false);
    expect(
      cancellationFromObservedEvents(failureReadBeforeInterrupt, "call-fixture", 16, interruptAt, true, false),
    ).toBe(false);
    expect(
      cancellationFromObservedEvents(failureTimestampedBeforeInterrupt, "call-fixture", 15, interruptAt, true, false),
    ).toBe(false);
    expect(
      cancellationFromObservedEvents(failureWithoutTimestamp, "call-fixture", 15, interruptAt, true, false),
    ).toBe(false);
    expect(cancellationFromObservedEvents(verified, "call-other", 15, interruptAt, true, false)).toBe(false);
    expect(cancellationFromObservedEvents(verified, "call-fixture", 15, interruptAt, false, false)).toBe(false);
  });

  it("requires exact response text correlated to the admitted input", () => {
    const decorated = evaluateLiveEvidence(
      { ...passingEvidence, finalResponse: "TOKEN_STORED\nextra" },
      environment.repository,
    );
    const uncorrelated = evaluateLiveEvidence(
      { ...passingEvidence, responseInputID: "input-2" },
      environment.repository,
    );

    expect(decorated.results.find(({ capability }) => capability === "Local model invocation")?.status).toBe("FAIL");
    expect(uncorrelated.results.find(({ capability }) => capability === "Local model invocation")?.status).toBe("FAIL");
  });

  it("evaluates all path evidence against the independently created repository", () => {
    const report = evaluateLiveEvidence(
      {
        ...passingEvidence,
        projectPaths: [environment.repository, `${environment.root}/outside-write.txt`],
      },
      environment.repository,
    );

    expect(report.results.find(({ capability }) => capability === "Project directory")?.status).toBe("FAIL");
  });
});

describe("paired live-operation settlement", () => {
  it("settles initial event observation when initial prompt submission fails first", async () => {
    const observation = deferred<boolean>();
    let completed = false;
    const result = settlePairedOperations(
      "initial structured-event observation",
      observation.promise,
      "initial prompt submission",
      Promise.reject(new Error("prompt failed first")),
    ).finally(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    observation.reject(new Error("event stream failed later"));
    await expect(result).rejects.toThrow(
      "initial structured-event observation failed: Error: event stream failed later; initial prompt submission failed: Error: prompt failed first",
    );
  });

  it("settles initial prompt submission when initial event observation fails first", async () => {
    const prompt = deferred<{ id: string }>();
    let completed = false;
    const result = settlePairedOperations(
      "initial structured-event observation",
      Promise.reject(new Error("event stream failed first")),
      "initial prompt submission",
      prompt.promise,
    ).finally(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    prompt.reject(new Error("prompt failed later"));
    await expect(result).rejects.toThrow(
      "initial structured-event observation failed: Error: event stream failed first; initial prompt submission failed: Error: prompt failed later",
    );
  });

  it("retains both diagnostics when an event observation and its request both reject", async () => {
    await expect(
      settlePairedOperations(
        "event observation",
        Promise.reject(new Error("event stream aborted")),
        "request",
        Promise.reject(new Error("request timed out")),
      ),
    ).rejects.toThrow(
      "event observation failed: Error: event stream aborted; request failed: Error: request timed out",
    );
  });

  it("preserves a request rejection when the paired event observation ends without a match", async () => {
    await expect(
      settlePairedOperations(
        "event observation",
        Promise.resolve(undefined),
        "request",
        Promise.reject(new Error("request rejected after stream end")),
      ),
    ).rejects.toThrow(
      "request failed: Error: request rejected after stream end",
    );
  });

  it("settles the event observation when the cancellation idle wait fails first", async () => {
    const observation = deferred<number>();
    let completed = false;
    const result = settlePairedOperations(
      "cancellation idle wait",
      Promise.reject(new Error("idle wait failed first")),
      "cancellation event observation",
      observation.promise,
    ).finally(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    observation.reject(new Error("event stream failed later"));
    await expect(result).rejects.toThrow(
      "cancellation idle wait failed: Error: idle wait failed first; cancellation event observation failed: Error: event stream failed later",
    );
  });

  it("settles the idle wait when cancellation event observation fails first", async () => {
    const idleWait = deferred<void>();
    let completed = false;
    const result = settlePairedOperations(
      "cancellation idle wait",
      idleWait.promise,
      "cancellation event observation",
      Promise.reject(new Error("event stream failed first")),
    ).finally(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    idleWait.reject(new Error("idle wait failed later"));
    await expect(result).rejects.toThrow(
      "cancellation idle wait failed: Error: idle wait failed later; cancellation event observation failed: Error: event stream failed first",
    );
  });
});

describe("permission evidence correlation", () => {
  it("accepts the observed event only when its ID matches an ask request", () => {
    expect(
      correlatePermissionEvidence({ id: "permission-1" }, { id: "permission-1", effect: "ask" }),
    ).toBe("permission-1");
  });

  it("rejects an observed event for a different permission request", () => {
    expect(() =>
      correlatePermissionEvidence({ id: "unrelated" }, { id: "permission-1", effect: "ask" }),
    ).toThrow("observed permission request ID unrelated does not match created request ID permission-1");
  });

  it("rejects a created permission result with an unexpected effect", () => {
    expect(() =>
      correlatePermissionEvidence({ id: "permission-1" }, { id: "permission-1", effect: "allow" }),
    ).toThrow("created permission request permission-1 returned unexpected effect allow");
  });

  it("observes and replies only to the correlated Core V2 permission event", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-permission-driver-test-"));
    const repository = join(root, "repository");
    const outside = join(root, "permission-target");
    await Promise.all([mkdir(repository), mkdir(outside)]);

    const operations: string[] = [];
    const create = vi
      .fn()
      .mockResolvedValueOnce(result({ data: { id: "session-1" } }))
      .mockResolvedValueOnce(result({ data: { id: "session-2" } }));
    const prompt = vi
      .fn()
      .mockResolvedValueOnce(result({ data: { id: "input-1" } }))
      .mockResolvedValueOnce(result({ data: { id: "cancellation-input" } }))
      .mockResolvedValueOnce(result({ data: { id: "input-2" } }));
    const monitorChannel = eventChannel();
    const permissionCreate = vi.fn().mockImplementation(async () => {
      // The warm server publishes the non-durable asked events before `create` responds.
      operations.push("emitted:legacy");
      monitorChannel.push(legacyEvent);
      operations.push("emitted:core-v2");
      monitorChannel.push(coreV2Event);
      operations.push("created:permission-1:ask");
      return result({ data: { id: "permission-1", effect: "ask" } });
    });
    const permissionReply = vi.fn().mockImplementation(async (parameters: { requestID: string }) => {
      operations.push(`replied:${parameters.requestID}`);
      return result(undefined, 204);
    });

    const legacyEvent = {
      id: "legacy-event",
      type: "permission.asked",
      data: {
        id: "permission-1",
        sessionID: "session-1",
        permission: "external_directory",
        patterns: [outside],
        metadata: {},
        always: [],
      },
    } satisfies V2Event;
    const coreV2Event = {
      id: "core-v2-event",
      type: "permission.v2.asked",
      data: {
        id: "permission-1",
        sessionID: "session-1",
        action: "external_directory",
        resources: [outside],
        save: [],
      },
    } satisfies V2Event;

    async function* initialEvents() {
      // The 1.18.33 SDK yields parsed events at runtime, not the generated `data: string` form.
      yield {
        id: "durable-1",
        type: "session.next.step.started",
        durable: { seq: 1 },
        data: { sessionID: "session-1" },
      };
    }
    async function* noCancellationEvents() {
      return;
    }

    const subscribe = vi
      .fn()
      .mockImplementationOnce(async (options: { signal: AbortSignal }) => ({ stream: monitorChannel.stream(options.signal) }))
      .mockResolvedValueOnce({ stream: noCancellationEvents() });
    const transcripts: Record<string, unknown[]> = {
      // OpenCode 1.18.33 appends one assistant message per model step; the final one is the result.
      "session-1": [
        { id: "input-1", type: "user", time: { created: 1 }, text: "prompt" },
        {
          id: "assistant-1-tool-step",
          type: "assistant",
          time: { created: 2, completed: 3 },
          agent: "build",
          model: { providerID: "ollama", id: "model" },
          finish: "tool-calls",
          content: [
            { type: "text", id: "text-1a", text: "I'll create the file." },
            { type: "tool", id: "tool-1", tool: "write", state: { status: "completed" } },
          ],
        },
        {
          id: "assistant-1",
          type: "assistant",
          time: { created: 4, completed: 5 },
          agent: "build",
          model: { providerID: "ollama", id: "model" },
          content: [{ type: "text", id: "text-1", text: "TOKEN_STORED" }],
        },
      ],
      "session-2": [
        { id: "input-2", type: "user", time: { created: 3 }, text: "prompt" },
        {
          id: "assistant-2",
          type: "assistant",
          time: { created: 4, completed: 5 },
          agent: "build",
          model: { providerID: "ollama", id: "model" },
          content: [{ type: "text", id: "text-2", text: "NO_PRIOR_SESSION" }],
        },
      ],
    };
    const messages = vi.fn().mockImplementation(async (parameters: { sessionID: string }) =>
      result({ data: transcripts[parameters.sessionID] ?? [], cursor: {} }),
    );
    const active = vi.fn().mockResolvedValue(result({ data: {} }));
    const deleteSession = vi.fn().mockResolvedValue(result(true));
    const get = vi
      .fn()
      .mockResolvedValue(failedResult({ _tag: "SessionNotFoundError", message: "not found" }, 404));

    const client = {
      v2: {
        session: {
          create: create as Method<OpencodeClient["v2"]["session"]["create"]>,
          prompt: prompt as Method<OpencodeClient["v2"]["session"]["prompt"]>,
          events: vi.fn().mockResolvedValue({ stream: initialEvents() }) as Method<
            OpencodeClient["v2"]["session"]["events"]
          >,
          permission: {
            create: permissionCreate as Method<
              OpencodeClient["v2"]["session"]["permission"]["create"]
            >,
            reply: permissionReply as Method<
              OpencodeClient["v2"]["session"]["permission"]["reply"]
            >,
          },
          interrupt: vi.fn() as Method<OpencodeClient["v2"]["session"]["interrupt"]>,
          active: active as Method<OpencodeClient["v2"]["session"]["active"]>,
          messages: messages as Method<OpencodeClient["v2"]["session"]["messages"]>,
          get: get as Method<OpencodeClient["v2"]["session"]["get"]>,
        },
        event: {
          subscribe: subscribe as Method<OpencodeClient["v2"]["event"]["subscribe"]>,
        },
      },
      session: {
        delete: deleteSession as Method<OpencodeClient["session"]["delete"]>,
      },
    } as unknown as OpencodeClient;

    const closeServer = vi.fn();
    const driver = new OpenCodeLiveDriver(client, closeServer);
    try {
      const evidence = await driver.run({ root, repository, outside });

      expect(evidence.permissionRequestID).toBe("permission-1");
      await expect(permissionCreate.mock.results[0]?.value).resolves.toMatchObject({
        data: { data: { id: "permission-1", effect: "ask" } },
      });
      expect(permissionReply).toHaveBeenCalledOnce();
      expect(permissionReply).toHaveBeenCalledWith(
        { sessionID: "session-1", requestID: "permission-1", reply: "once" },
        { signal: expect.any(AbortSignal) },
      );
      expect(create).toHaveBeenNthCalledWith(
        1,
        {
          agent: "build",
          location: { directory: repository },
          model: LIVE_MODEL,
        },
        { signal: expect.any(AbortSignal) },
      );
      expect(create).toHaveBeenNthCalledWith(
        2,
        {
          agent: "build",
          location: { directory: repository },
          model: LIVE_MODEL,
        },
        { signal: expect.any(AbortSignal) },
      );
      expect(evidence.finalResponse).toBe("TOKEN_STORED");
      expect(evidence.isolationResponse).toBe("NO_PRIOR_SESSION");
      expect(messages).toHaveBeenCalledWith(
        { sessionID: "session-1", order: "asc" },
        { signal: expect.any(AbortSignal) },
      );
      expect(active).toHaveBeenCalled();
      expect(operations).toEqual([
        "emitted:legacy",
        "emitted:core-v2",
        "created:permission-1:ask",
        "replied:permission-1",
      ]);
      // Only the run-long monitor and the cancellation stage subscribe; the permission stage opens
      // no late subscription that could miss a non-durable event.
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      await driver.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("security hardening", () => {
  it("awaits delayed owned-child exit after SIGTERM", async () => {
    class FakeChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly signals: NodeJS.Signals[] = [];
      kill(signal: NodeJS.Signals): boolean {
        this.signals.push(signal);
        if (signal === "SIGTERM") {
          setTimeout(() => {
            this.signalCode = signal;
            this.emit("exit");
          }, 5);
        }
        return true;
      }
    }
    const child = new FakeChild();

    await terminateOwnedChild(child, 25);

    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("fails finitely when an owned child ignores SIGTERM and SIGKILL", async () => {
    class FakeChild extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly signals: NodeJS.Signals[] = [];
      kill(signal: NodeJS.Signals): boolean {
        this.signals.push(signal);
        return true;
      }
    }
    const child = new FakeChild();
    const started = Date.now();

    await expect(terminateOwnedChild(child, 5)).rejects.toThrow("did not terminate");

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("generates child-only server credentials and a matching Basic authorization value", async () => {
    const inheritedUsername = process.env.OPENCODE_SERVER_USERNAME;
    const inheritedPassword = process.env.OPENCODE_SERVER_PASSWORD;
    let launched: { username: string; password: string } | undefined;
    let clientConfig: Parameters<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>[0];
    const close = vi.fn();

    const driver = await createAuthenticatedOpenCodeDriver(
      async (options) => {
        launched = options;
        return { url: "http://127.0.0.1:43210", close };
      },
      (config) => {
        clientConfig = config;
        return {} as OpencodeClient;
      },
    );

    expect(launched).toBeDefined();
    expect(launched?.username).toBe("quoder");
    expect(launched?.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      Buffer.from(
        basicAuthorizationHeader(launched!.username, launched!.password).slice("Basic ".length),
        "base64",
      ).toString("utf8"),
    ).toBe(`quoder:${launched!.password}`);
    expect(clientConfig).toMatchObject({
      baseUrl: "http://127.0.0.1:43210",
      headers: {
        Authorization: basicAuthorizationHeader(launched!.username, launched!.password),
      },
    });
    expect(process.env.OPENCODE_SERVER_USERNAME).toBe(inheritedUsername);
    expect(process.env.OPENCODE_SERVER_PASSWORD).toBe(inheritedPassword);

    await driver.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps server credentials in the child environment and out of process arguments", () => {
    const config = authenticatedServerProcessConfig({
      username: "quoder",
      password: "secret-value",
    });
    expect(config.executable).toBe(join(process.cwd(), "node_modules", ".bin", "opencode"));
    expect(config.args).toEqual(["serve", "--pure", "--hostname=127.0.0.1", "--port=0"]);
    expect(config.args.join(" ")).not.toContain("secret-value");
    expect(config.env).toMatchObject({
      OPENCODE_SERVER_USERNAME: "quoder",
      OPENCODE_SERVER_PASSWORD: "secret-value",
    });
  });

  it("closes the authenticated server if client construction fails", async () => {
    const close = vi.fn();
    await expect(
      createAuthenticatedOpenCodeDriver(
        async () => ({ url: "http://127.0.0.1:43210", close }),
        () => {
          throw new Error("client construction failed");
        },
      ),
    ).rejects.toThrow("client construction failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed unless the server rejects anonymous and accepts authenticated requests", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await expect(
      verifyServerAuthentication("http://127.0.0.1:43210", "Basic credential", fetcher),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      new URL("http://127.0.0.1:43210/global/health"),
      { signal: expect.any(AbortSignal) },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL("http://127.0.0.1:43210/global/health"),
      { headers: { Authorization: "Basic credential" }, signal: expect.any(AbortSignal) },
    );

    await expect(
      verifyServerAuthentication(
        "http://127.0.0.1:43210",
        "Basic credential",
        vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      ),
    ).rejects.toThrow("did not reject an unauthenticated health request");
  });

  it("reads only real regular evidence files confined to the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-realpath-test-"));
    const repository = join(root, "repository");
    const outside = join(root, "outside.txt");
    const regular = join(repository, "hello.txt");
    const linked = join(repository, "linked.txt");
    await mkdir(repository);
    await writeFile(regular, "Hello from OpenCode", "utf8");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, linked);
    try {
      await expect(readConfinedRegularFile(repository, regular)).resolves.toBe("Hello from OpenCode");
      await expect(readConfinedRegularFile(repository, linked)).rejects.toThrow("not a symbolic link");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminates only a live fixture PID whose command contains the per-run token", async () => {
    const terminate = vi.fn();
    const waitForExit = vi.fn().mockResolvedValue(true);
    await terminateValidatedFixture(4321, "fixture-token", {
      isAlive: () => true,
      commandForPID: async () => "node fixture.mjs fixture-token",
      terminate,
      waitForExit,
    });
    expect(terminate).toHaveBeenCalledWith(4321);
    expect(waitForExit).toHaveBeenCalledWith(4321, 5_000);

    const rejectTerminate = vi.fn();
    await expect(
      terminateValidatedFixture(4322, "fixture-token", {
        isAlive: () => true,
        commandForPID: async () => "unrelated-process",
        terminate: rejectTerminate,
      }),
    ).rejects.toThrow("Refusing to terminate an unvalidated fixture process");
    expect(rejectTerminate).not.toHaveBeenCalled();
  });
});

describe("authenticated server startup lifecycle", () => {
  class FakeServerChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    readonly signals: NodeJS.Signals[] = [];

    constructor(private readonly exitDelayAfterSignalMs?: number) {
      super();
    }

    kill(signal: NodeJS.Signals): boolean {
      this.signals.push(signal);
      if (this.exitDelayAfterSignalMs !== undefined && this.signals.length === 1) {
        setTimeout(() => this.exit(null, signal), this.exitDelayAfterSignalMs);
      }
      return true;
    }

    exit(code: number | null, signal: NodeJS.Signals | null): void {
      this.exitCode = code;
      this.signalCode = signal;
      this.emit("exit", code, signal);
    }

    get exited(): boolean {
      return this.exitCode !== null || this.signalCode !== null;
    }

    listen(line: string): void {
      this.stdout.emit("data", Buffer.from(`${line}\n`, "utf8"));
    }
  }

  const launcher = (
    child: FakeServerChild,
    overrides: Partial<AuthenticatedServerLauncherDependencies> = {},
  ): AuthenticatedServerLauncherDependencies => ({
    spawnServer: () => child,
    verifyAuthentication: async () => undefined,
    startupTimeoutMs: 1_000,
    terminationTimeoutMs: 50,
    ...overrides,
  });

  // Captures whether the owned child had exited at the instant the caller observed the outcome.
  const observe = (launch: Promise<unknown>, child: FakeServerChild) => launch.then(
    () => ({ status: "fulfilled" as const, message: "", exitedWhenObserved: child.exited }),
    (error: Error) => ({ status: "rejected" as const, message: error.message, exitedWhenObserved: child.exited }),
  );

  const watchUnhandledRejections = () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    return async () => {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
      process.off("unhandledRejection", unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    };
  };

  const credentials = { username: "quoder", password: "secret-value" } as const;

  it("awaits delayed child exit before rejecting a startup timeout", async () => {
    const child = new FakeServerChild(30);
    let published: (() => Promise<void>) | undefined;
    const started = Date.now();

    const outcome = await observe(
      launchAuthenticatedOpenCodeServer(
        { ...credentials, acceptCloseOwnership: (close) => { published = close; } },
        launcher(child, { startupTimeoutMs: 10 }),
      ),
      child,
    );

    expect(outcome).toEqual({
      status: "rejected",
      message: "Timed out waiting for authenticated OpenCode server startup",
      exitedWhenObserved: true,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(child.signals).toEqual(["SIGTERM"]);
    await expect(published?.()).resolves.toBeUndefined();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it.each([
    ["child error", (child: FakeServerChild) => child.emit("error", new Error("spawn failed")),
      "Authenticated OpenCode server failed to start: spawn failed"],
    ["invalid listening output", (child: FakeServerChild) => child.listen("opencode server listening on"),
      "Authenticated OpenCode server reported an invalid listening URL"],
  ])("awaits delayed child exit before rejecting startup %s", async (_name, trigger, message) => {
    const child = new FakeServerChild(20);
    const launch = observe(launchAuthenticatedOpenCodeServer(credentials, launcher(child)), child);

    trigger(child);

    await expect(launch).resolves.toEqual({ status: "rejected", message, exitedWhenObserved: true });
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("stops a live server if the Quoder process exits, and unregisters once the server has exited", async () => {
    const child = new FakeServerChild(5);
    let hook: (() => void) | undefined;
    const unregister = vi.fn();
    const launch = launchAuthenticatedOpenCodeServer(
      credentials,
      launcher(child, {
        onProcessExit: (registered) => {
          hook = registered;
          return unregister;
        },
      }),
    );
    child.listen("opencode server listening on http://127.0.0.1:4096");
    await expect(launch).resolves.toMatchObject({ url: "http://127.0.0.1:4096" });

    hook?.();
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.waitFor(() => expect(child.exited).toBe(true));
    expect(unregister).toHaveBeenCalledTimes(1);
    hook?.();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("rejects premature exit without signalling the already-exited child", async () => {
    const child = new FakeServerChild();
    const launch = observe(launchAuthenticatedOpenCodeServer(credentials, launcher(child)), child);

    child.exit(1, null);

    await expect(launch).resolves.toEqual({
      status: "rejected",
      message: "Authenticated OpenCode server exited during startup with code 1",
      exitedWhenObserved: true,
    });
    expect(child.signals).toEqual([]);
  });

  it("rejects cancelled startup only after the shared termination settles", async () => {
    const child = new FakeServerChild(20);
    const controller = new AbortController();
    const launch = observe(
      launchAuthenticatedOpenCodeServer({ ...credentials, signal: controller.signal }, launcher(child)),
      child,
    );

    controller.abort();

    await expect(launch).resolves.toEqual({
      status: "rejected",
      message: "Authenticated OpenCode server startup was cancelled",
      exitedWhenObserved: true,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("settles simultaneous startup failures once through one termination sequence", async () => {
    const child = new FakeServerChild(30);
    const verifyAuthentication = vi.fn(async () => undefined);
    const launch = observe(
      launchAuthenticatedOpenCodeServer(
        credentials,
        launcher(child, { startupTimeoutMs: 5, verifyAuthentication }),
      ),
      child,
    );

    child.emit("error", new Error("first"));
    child.listen("opencode server listening on");
    child.emit("error", new Error("second"));
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    child.listen("opencode server listening on http://127.0.0.1:4096");

    await expect(launch).resolves.toEqual({
      status: "rejected",
      message: "Authenticated OpenCode server failed to start: first",
      exitedWhenObserved: true,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(verifyAuthentication).not.toHaveBeenCalled();
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it.each([
    ["startup timeout", (_child: FakeServerChild, _controller: AbortController) => undefined],
    ["cancellation", (_child: FakeServerChild, controller: AbortController) => controller.abort()],
    ["child error", (child: FakeServerChild) => { child.emit("error", new Error("spawn failed")); }],
  ])("rejects with fixed text when a non-terminating child survives %s", async (_name, trigger) => {
    const assertNoUnhandledRejection = watchUnhandledRejections();
    const child = new FakeServerChild();
    const controller = new AbortController();
    let published: (() => Promise<void>) | undefined;
    const started = Date.now();
    const launch = observe(
      launchAuthenticatedOpenCodeServer(
        {
          ...credentials,
          signal: controller.signal,
          acceptCloseOwnership: (close) => { published = close; },
        },
        launcher(child, { startupTimeoutMs: 5, terminationTimeoutMs: 5 }),
      ),
      child,
    );

    trigger(child, controller);

    await expect(launch).resolves.toEqual({
      status: "rejected",
      message: SERVER_TERMINATION_UNCONFIRMED_MESSAGE,
      exitedWhenObserved: false,
    });
    expect(SERVER_TERMINATION_UNCONFIRMED_MESSAGE).not.toContain("secret-value");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeLessThan(200);
    await expect(published?.()).rejects.toThrow("did not terminate");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await assertNoUnhandledRejection();
  });

  it("awaits termination before surfacing post-launch authentication failure", async () => {
    const child = new FakeServerChild(20);
    const launch = observe(
      launchAuthenticatedOpenCodeServer(
        credentials,
        launcher(child, {
          verifyAuthentication: async () => {
            throw new Error("OpenCode server did not reject an unauthenticated health request");
          },
        }),
      ),
      child,
    );

    child.listen("opencode server listening on http://127.0.0.1:4096");

    await expect(launch).resolves.toEqual({
      status: "rejected",
      message: "OpenCode server did not reject an unauthenticated health request",
      exitedWhenObserved: true,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("preserves the authenticated success path with idempotent async close", async () => {
    const assertNoUnhandledRejection = watchUnhandledRejections();
    const child = new FakeServerChild(5);
    const verifyAuthentication = vi.fn(async () => undefined);
    const spawnServer = vi.fn(() => child);
    let published: (() => Promise<void>) | undefined;
    const launch = launchAuthenticatedOpenCodeServer(
      { ...credentials, acceptCloseOwnership: (close) => { published = close; } },
      launcher(child, { spawnServer, verifyAuthentication, startupTimeoutMs: 20 }),
    );

    expect(published).toBeDefined();
    child.listen("opencode server listening on http://127.0.0.1:4096");
    const server = await launch;

    expect(server.url).toBe("http://127.0.0.1:4096");
    expect(spawnServer).toHaveBeenCalledWith(expect.objectContaining({
      args: ["serve", "--pure", "--hostname=127.0.0.1", "--port=0"],
    }));
    expect(verifyAuthentication).toHaveBeenCalledWith(
      "http://127.0.0.1:4096",
      basicAuthorizationHeader("quoder", "secret-value"),
    );
    expect(server.close).toBe(published);
    await new Promise((resolveTick) => setTimeout(resolveTick, 30));
    expect(child.signals).toEqual([]);
    child.emit("error", new Error("late error"));
    child.listen("opencode server listening on");
    expect(child.stdout.listenerCount("data")).toBe(1);

    const first = server.close();
    expect(server.close()).toBe(first);
    await first;
    expect(child.signals).toEqual(["SIGTERM"]);
    await assertNoUnhandledRejection();
  });
});

describe("cancellation orchestration against the verified 1.18.33 event contract", () => {
  const durable = (seq: number, type: string, data: Record<string, unknown>) =>
    ({ id: `event-${seq}`, type, durable: { seq }, data: { sessionID: "session-1", ...data } }) as unknown as V2Event;
  const delta = () =>
    ({ id: "delta", type: "session.next.text.delta", data: { sessionID: "session-1", delta: "x" } }) as unknown as V2Event;

  interface Scenario {
    /** Emits the tokenized bash call; without it the fixture never starts. */
    readonly fixtureCall?: boolean;
    /** Post-interrupt terminal event for the fixture call. */
    readonly terminal?: "failed" | "success";
    /** Emits an unrelated call's failure before the fixture's terminal event. */
    readonly unrelatedFailureFirst?: boolean;
    readonly completionMarker?: boolean;
    readonly interruptFails?: boolean;
    /** Question requests the model raises once the initial prompt is submitted. */
    readonly questions?: readonly { readonly sessionID: string; readonly id: string }[];
    readonly initialPromptFails?: boolean;
    /** The cancellation turn keeps the session running until something interrupts it. */
    readonly cancellationTurnStaysActive?: boolean;
    /** The fake model writes the exact hello.txt during the initial prompt. */
    readonly modelWritesHello?: boolean;
    /** The first active-session poll never answers, so the initial idle wait times out. */
    readonly firstActivePollHangs?: boolean;
    /** The run-long monitor's stream ends on its own instead of waiting for the driver to stop it. */
    readonly monitorStreamEndsEarly?: boolean;
    /** The monitor's stream ends while the permission stage is waiting for its event. */
    readonly monitorEndsDuringPermissionWait?: boolean;
    /** When and how the server publishes `permission.v2.asked` relative to `permission.create`. */
    readonly permissionEvent?: "beforeCreate" | "afterCreate" | "none" | "otherSession" | "mismatchedId";
    readonly operationTimeoutMs?: number;
  }

  const runScenario = async ({
    fixtureCall = true,
    terminal = "failed",
    unrelatedFailureFirst = false,
    completionMarker = false,
    interruptFails = false,
    questions = [],
    initialPromptFails = false,
    cancellationTurnStaysActive = false,
    modelWritesHello = false,
    firstActivePollHangs = false,
    monitorStreamEndsEarly = false,
    monitorEndsDuringPermissionWait = false,
    permissionEvent = "beforeCreate",
    operationTimeoutMs,
  }: Scenario = {}) => {
    const root = await mkdtemp(join(tmpdir(), "quoder-cancellation-driver-test-"));
    const repository = join(root, "repository");
    const outside = join(root, "permission-target");
    await Promise.all([mkdir(repository), mkdir(outside)]);
    const pidPath = join(repository, "fixture.pid");
    // A PID that has already exited stands in for a fixture that OpenCode terminated.
    const exitedPID = spawnSync(process.execPath, ["-e", ""]).pid;
    const order: string[] = [];
    let fixtureToken = "";
    let cancellationStreamClosed = false;
    let pidFileExistedAtInterrupt: boolean | undefined;
    let releaseInterrupt: () => void = () => undefined;
    const interrupted = new Promise<void>((resolveInterrupt) => {
      releaseInterrupt = resolveInterrupt;
    });

    let sessionRunning = false;
    let createdSessions = 0;
    let releaseQuestions: () => void = () => undefined;
    const questionsReleased = new Promise<void>((resolveRelease) => {
      releaseQuestions = resolveRelease;
    });
    const questionReject = vi.fn().mockResolvedValue(result(undefined, 204));
    const prompt = vi.fn().mockImplementation(async (parameters: { prompt: { text: string } }) => {
      const token = /fixture\.mjs ([0-9a-f-]{36})/u.exec(parameters.prompt.text)?.[1];
      if (parameters.prompt.text.includes("hello.txt")) {
        releaseQuestions();
        if (initialPromptFails) return failedResult({ _tag: "UnknownError", message: "prompt rejected" }, 500);
        if (modelWritesHello) await writeFile(join(repository, "hello.txt"), "Hello from OpenCode", "utf8");
      }
      if (token !== undefined && cancellationTurnStaysActive) sessionRunning = true;
      if (token === undefined) {
        return result({ data: { id: parameters.prompt.text.includes("hello.txt") ? "input-1" : "input-2" } });
      }
      fixtureToken = token;
      return result({ data: { id: "cancellation-input" } });
    });
    async function* initialEvents() {
      // The 1.18.33 SDK yields parsed events at runtime, not the generated `data: string` form.
      yield {
        id: "durable-1",
        type: "session.next.step.started",
        durable: { seq: 1 },
        data: { sessionID: "session-1" },
      };
    }
    const monitorChannel = eventChannel();
    const permissionAsked = (sessionID: string, id: string) =>
      ({
        id: `permission-event-${id}`,
        type: "permission.v2.asked",
        data: { id, sessionID, action: "external_directory", resources: [outside], save: [] },
      }) as unknown as V2Event;
    const publishPermission = () => {
      if (permissionEvent === "otherSession") monitorChannel.push(permissionAsked("session-unrelated", "permission-1"));
      if (permissionEvent === "mismatchedId") monitorChannel.push(permissionAsked("session-1", "permission-other"));
      if (permissionEvent === "beforeCreate" || permissionEvent === "afterCreate") {
        order.push("emit:permission.v2.asked");
        monitorChannel.push(permissionAsked("session-1", "permission-1"));
      }
    };
    const permissionReply = vi.fn().mockImplementation(async () => {
      order.push("permission-reply");
      return result(undefined, 204);
    });
    async function* cancellationEvents() {
      try {
        yield delta();
        yield durable(5, "session.next.tool.called", { callID: "call-glob", tool: "glob", input: { pattern: "*" } });
        yield durable(6, "session.next.tool.success", { callID: "call-glob", timestamp: Date.now() });
        if (!fixtureCall) return;
        yield delta();
        // The fixture reports its PID some time after its tool call starts; the driver must wait
        // for it. The timer is armed before the yield because the driver stops pulling events here.
        setTimeout(() => {
          order.push("pid-written");
          if (completionMarker) {
            void writeFile(join(repository, "fixture-completed.marker"), "completed", "utf8");
          }
          void writeFile(pidPath, String(exitedPID), "utf8");
        }, 200);
        yield durable(7, "session.next.tool.called", {
          callID: "call-fixture",
          tool: "bash",
          input: { command: `node fixture.mjs ${fixtureToken}` },
        });
        await interrupted;
        let seq = 8;
        if (unrelatedFailureFirst) {
          yield durable(seq++, "session.next.tool.failed", { callID: "call-other", timestamp: Date.now(), error: {} });
          yield delta();
        }
        order.push(`emit:${terminal}:call-fixture`);
        yield durable(seq++, `session.next.tool.${terminal}`, {
          callID: "call-fixture",
          timestamp: Date.now(),
          error: { type: "unknown", message: "Tool execution interrupted" },
        });
        yield durable(seq, "session.next.step.ended", { finish: "tool-calls" });
        await new Promise(() => undefined);
      } finally {
        cancellationStreamClosed = true;
      }
    }
    const transcripts: Record<string, unknown[]> = {
      "session-1": [
        { id: "input-1", type: "user", time: { created: 1 }, text: "prompt" },
        {
          id: "assistant-1",
          type: "assistant",
          time: { created: 2, completed: 3 },
          agent: "build",
          model: { providerID: "ollama", id: "model" },
          content: [{ type: "text", id: "text-1", text: "TOKEN_STORED" }],
        },
      ],
      "session-2": [
        { id: "input-2", type: "user", time: { created: 4 }, text: "prompt" },
        {
          id: "assistant-2",
          type: "assistant",
          time: { created: 5, completed: 6 },
          agent: "build",
          model: { providerID: "ollama", id: "model" },
          content: [{ type: "text", id: "text-2", text: "NO_PRIOR_SESSION" }],
        },
      ],
    };

    const client = {
      v2: {
        session: {
          create: vi.fn().mockImplementation(async () => {
            const id = `session-${++createdSessions}`;
            order.push(`create:${id}`);
            return result({ data: { id } });
          }),
          prompt,
          events: vi.fn().mockResolvedValue({ stream: initialEvents() }),
          permission: {
            create: vi.fn().mockImplementation(async () => {
              if (monitorEndsDuringPermissionWait) setTimeout(() => monitorChannel.end(), 20);
              else if (permissionEvent !== "afterCreate") publishPermission();
              else setTimeout(publishPermission, 20);
              order.push("permission-created");
              return result({ data: { id: "permission-1", effect: "ask" } });
            }),
            reply: permissionReply,
          },
          question: { reject: questionReject },
          interrupt: vi.fn().mockImplementation(async () => {
            order.push("interrupt");
            sessionRunning = false;
            pidFileExistedAtInterrupt = existsSync(pidPath);
            releaseInterrupt();
            return interruptFails
              ? failedResult({ _tag: "UnknownError", message: "interrupt failed" }, 500)
              : result(undefined, 204);
          }),
          active: vi.fn().mockImplementation(async (options: { signal: AbortSignal }) => {
            order.push("active");
            if (firstActivePollHangs && order.filter((entry) => entry === "active").length === 1) {
              return new Promise((_resolve, reject) => {
                options.signal.addEventListener("abort", () =>
                  reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
              });
            }
            return result({ data: sessionRunning ? { "session-1": { type: "running" } } : {} });
          }),
          messages: vi.fn().mockImplementation(async (parameters: { sessionID: string }) =>
            result({ data: transcripts[parameters.sessionID] ?? [], cursor: {} }),
          ),
          get: vi.fn().mockResolvedValue(failedResult({ _tag: "SessionNotFoundError", message: "not found" }, 404)),
        },
        event: {
          subscribe: vi
            .fn()
            .mockImplementationOnce(async (options: { signal: AbortSignal }) => {
              order.push("subscribe:monitor");
              void questionsReleased.then(() => {
                for (const { sessionID, id } of questions) {
                  monitorChannel.push(
                    ({ id: `question-event-${id}`, type: "question.v2.asked", data: { id, sessionID } }) as unknown as V2Event,
                  );
                }
              });
              return {
                stream: monitorStreamEndsEarly
                  ? (async function* (): AsyncGenerator<V2Event, void, unknown> {})()
                  : monitorChannel.stream(options.signal),
              };
            })
            .mockResolvedValueOnce({ stream: cancellationEvents() }),
        },
      },
      session: { delete: vi.fn().mockResolvedValue(result(true)) },
    } as unknown as OpencodeClient;

    const driver = new OpenCodeLiveDriver(
      client,
      vi.fn(),
      (stage) => order.push(`progress:${stage}`),
      operationTimeoutMs === undefined ? {} : { operationTimeoutMs },
    );
    try {
      const outcome = await driver.run({ root, repository, outside }).then(
        (evidence) => ({ evidence, error: undefined }),
        (error: Error) => ({ evidence: undefined, error }),
      );
      return { ...outcome, order, cancellationStreamClosed, pidFileExistedAtInterrupt, questionReject, permissionReply, repository };
    } finally {
      await driver.close();
      await rm(root, { recursive: true, force: true });
    }
  };

  it("passes when the fixture's failure directly follows its call, confirming idle afterwards", async () => {
    const { evidence, order, cancellationStreamClosed, pidFileExistedAtInterrupt } = await runScenario();

    expect(evidence?.cancellationPassed).toBe(true);
    expect(evidence?.finalResponse).toBe("TOKEN_STORED");
    expect(evidence?.structuredEventObserved).toBe(true);
    const interruptAt = order.indexOf("interrupt");
    const terminalAt = order.indexOf("emit:failed:call-fixture");
    expect(pidFileExistedAtInterrupt).toBe(true);
    expect(order.indexOf("pid-written")).toBeLessThan(interruptAt);
    expect(interruptAt).toBeLessThan(terminalAt);
    expect(order.indexOf("active", interruptAt)).toBeGreaterThan(terminalAt);
    expect(cancellationStreamClosed).toBe(true);
  });

  it("ignores an unrelated call's failure and waits for the fixture's own terminal event", async () => {
    const { evidence, order, cancellationStreamClosed } = await runScenario({ unrelatedFailureFirst: true });

    expect(evidence?.cancellationPassed).toBe(true);
    expect(order.indexOf("active", order.indexOf("interrupt"))).toBeGreaterThan(
      order.indexOf("emit:failed:call-fixture"),
    );
    expect(cancellationStreamClosed).toBe(true);
  });

  it("fails when the fixture wrote its completion marker despite a valid terminal event", async () => {
    const { evidence, cancellationStreamClosed } = await runScenario({ completionMarker: true });

    expect(evidence?.cancellationPassed).toBe(false);
    expect(cancellationStreamClosed).toBe(true);
  });

  it("fails when the fixture call completes successfully", async () => {
    const { evidence, cancellationStreamClosed } = await runScenario({ terminal: "success" });

    expect(evidence?.cancellationPassed).toBe(false);
    expect(cancellationStreamClosed).toBe(true);
  });

  it("fails and closes the stream when the fixture call never starts", async () => {
    const { evidence, order, cancellationStreamClosed } = await runScenario({ fixtureCall: false });

    expect(evidence?.cancellationPassed).toBe(false);
    expect(order).not.toContain("interrupt");
    expect(cancellationStreamClosed).toBe(true);
  });

  it("rejects questions raised by its own sessions and ignores other sessions' questions", async () => {
    const { evidence, questionReject } = await runScenario({
      questions: [
        { sessionID: "session-1", id: "question-1" },
        { sessionID: "session-unrelated", id: "question-2" },
      ],
    });

    expect(evidence?.cancellationPassed).toBe(true);
    expect(questionReject).toHaveBeenCalledOnce();
    expect(questionReject).toHaveBeenCalledWith(
      { sessionID: "session-1", requestID: "question-1" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("continues past a failed initial prompt without turning missing evidence into a PASS", async () => {
    const { evidence, error, repository } = await runScenario({ initialPromptFails: true });

    expect(error).toBeUndefined();
    expect(evidence?.admittedInputID).toBe("");
    expect(evidence?.permissionRequestID).toBe("permission-1");
    expect(evidence?.cancellationPassed).toBe(true);
    // Isolation needs a first session that received the nonce, so it is skipped.
    expect(evidence?.sessionIDs).toEqual(["session-1"]);
    expect(evidence?.isolationResponse).toBe("");
    expect(evidence?.projectPaths).toEqual([]);

    const report = evaluateLiveEvidence(evidence!, repository);
    const status = Object.fromEntries(report.results.map((r) => [r.capability, r.status]));
    expect(status).toEqual({
      "Fresh session creation": "FAIL",
      "Project directory": "FAIL",
      "Local model invocation": "FAIL",
      "Streaming events": "FAIL",
      "Permission handling": "PASS",
      "File modification": "FAIL",
      Cancellation: "PASS",
      "Session deletion": "PASS",
      "Session isolation": "FAIL",
    });
    expect(report.verdict).toBe("FAIL");
  });

  it("settles a session left running by a cancellation that failed without throwing", async () => {
    const { evidence, order } = await runScenario({ fixtureCall: false, cancellationTurnStaysActive: true });

    expect(evidence?.cancellationPassed).toBe(false);
    const notPassed = order.indexOf("progress:cancellation.not-passed");
    const settleInterrupt = order.indexOf("interrupt", notPassed);
    const isolationCreate = order.indexOf("create:session-2");
    expect(notPassed).toBeGreaterThan(-1);
    expect(settleInterrupt).toBeGreaterThan(notPassed);
    // The settle waits for idle (an `active` read after the interrupt) before isolation begins.
    expect(order.indexOf("active", settleInterrupt)).toBeLessThan(isolationCreate);
    expect(isolationCreate).toBeGreaterThan(settleInterrupt);
    expect(evidence?.isolationResponse).toBe("NO_PRIOR_SESSION");
  });

  it("reports all nine predicates PASS when every stage produces its evidence", async () => {
    const { evidence, repository, order } = await runScenario({ modelWritesHello: true });

    expect(evidence?.projectPaths).toEqual([repository, join(repository, "hello.txt")]);
    expect(
      order.filter((entry) =>
        [".failed", "not-passed", "not-observed", "not-completed", "unconfirmed"].some((marker) => entry.includes(marker))),
    ).toEqual([]);
    // The monitor is subscribed, and confirmed connected, before any session or request exists.
    expect(order.indexOf("subscribe:monitor")).toBeGreaterThan(-1);
    expect(order.indexOf("subscribe:monitor")).toBeLessThan(order.indexOf("create:session-1"));
    expect(order).not.toContain("progress:event.monitor.ended");
    const report = evaluateLiveEvidence(evidence!, repository);
    expect(report.results.filter((r) => r.status !== "PASS").map((r) => r.capability)).toEqual([]);
    expect(report.verdict).toBe("PASS");
  });

  it("journals the adapter operation of a paired-operation failure, not a generic error", async () => {
    const { order } = await runScenario({ initialPromptFails: true });

    expect(order).toContain("progress:session.initial.prompt.failed.submit-prompt");
    expect(order).not.toContain("progress:session.initial.prompt.failed.error");
  });

  it("journals a direct adapter timeout with its operation and timeout flag", async () => {
    const { order, evidence } = await runScenario({
      firstActivePollHangs: true,
      fixtureCall: false,
      operationTimeoutMs: 300,
    });

    expect(order).toContain("progress:session.initial.prompt.failed.wait-for-session.timeout");
    expect(evidence?.finalResponse).toBe("");
  });

  it("journals an event monitor that ends early, and then fails permission instead of waiting", async () => {
    const { order, evidence, permissionReply } = await runScenario({ monitorStreamEndsEarly: true });

    expect(order).toContain("progress:event.monitor.unconfirmed");
    expect(order).toContain("progress:event.monitor.ended");
    expect(order).toContain("progress:permission.not-observed.monitor-ended");
    expect(evidence?.permissionRequestID).toBeUndefined();
    expect(permissionReply).not.toHaveBeenCalled();
    expect(evidence?.cancellationPassed).toBe(true);
  });

  it.each(["beforeCreate", "afterCreate"] as const)(
    "observes the permission request published %s through the run-long monitor",
    async (permissionEvent) => {
      const { evidence, order, permissionReply } = await runScenario({ permissionEvent });

      expect(evidence?.permissionRequestID).toBe("permission-1");
      expect(permissionReply).toHaveBeenCalledOnce();
      expect(permissionReply).toHaveBeenCalledWith(
        { sessionID: "session-1", requestID: "permission-1", reply: "once" },
        { signal: expect.any(AbortSignal) },
      );
      expect(order.indexOf("permission-reply")).toBeGreaterThan(order.indexOf("emit:permission.v2.asked"));
    },
  );

  it.each(["none", "otherSession", "mismatchedId"] as const)(
    "fails permission handling within its bound when the matching event is %s",
    async (permissionEvent) => {
      const { evidence, permissionReply, order } = await runScenario({
        permissionEvent,
        fixtureCall: false,
        operationTimeoutMs: 300,
      });

      expect(evidence?.permissionRequestID).toBeUndefined();
      expect(permissionReply).not.toHaveBeenCalled();
      expect(order).toContain("progress:permission.not-observed.timeout");
    },
  );

  it("fails permission promptly when the monitor ends during the wait", async () => {
    const started = Date.now();
    // The default 120 s operation bound applies, so only the monitor's end can settle the wait.
    const { evidence, order, permissionReply } = await runScenario({
      monitorEndsDuringPermissionWait: true,
      fixtureCall: false,
    });

    expect(evidence?.permissionRequestID).toBeUndefined();
    expect(permissionReply).not.toHaveBeenCalled();
    expect(order).toContain("progress:permission.not-observed.monitor-ended");
    expect(order).toContain("progress:event.monitor.ended");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("records an interrupt failure as missing cancellation evidence and continues to isolation", async () => {
    const { evidence, error, cancellationStreamClosed } = await runScenario({ interruptFails: true });

    expect(error).toBeUndefined();
    expect(evidence?.cancellationPassed).toBe(false);
    expect(evidence?.isolationResponse).toBe("NO_PRIOR_SESSION");
    expect(evidence?.sessionIDs).toEqual(["session-1", "session-2"]);
    expect(cancellationStreamClosed).toBe(true);
  });
});

describe("live probe reliability (spec 2026-10-03)", () => {
  it("parses session-stream items in the verified runtime form and the declared string form", () => {
    const runtime = { id: "e1", type: "session.next.step.started", durable: { seq: 3 }, data: { sessionID: "s" } };
    expect(sessionStreamEvent(runtime)).toMatchObject({ type: "session.next.step.started", durable: { seq: 3 } });
    expect(
      sessionStreamEvent({ id: "e1", event: "message", data: JSON.stringify({ type: "session.next.step.started" }) }),
    ).toMatchObject({ type: "session.next.step.started" });
    expect(sessionStreamEvent({ id: "e1", event: "message", data: "not json" })).toBeUndefined();
    expect(sessionStreamEvent({ id: "e1", data: { type: 7 } })).toBeUndefined();
    expect(sessionStreamEvent(undefined)).toBeUndefined();
  });

  it("uses the sampled prompts with exact sentinels and the per-run token and nonce", () => {
    const initial = initialPrompt("nonce-123");
    expect(initial).toContain("write tool");
    expect(initial).toContain("hello.txt");
    expect(initial).toContain("exactly: Hello from OpenCode");
    expect(initial).toContain("nonce-123");
    expect(initial).toContain(`reply with exactly ${INITIAL_PROMPT_SENTINEL} and nothing else`);
    expect(initial).toContain("Do not ask any questions");
    expect(cancellationPrompt("token-9")).toBe(
      "Run `node fixture.mjs token-9` and wait for it to finish. Do not run it in the background. Do not ask any questions.",
    );
    expect(ISOLATION_PROMPT).toContain("Reply with exactly NO_PRIOR_SESSION and nothing else");
    expect(ISOLATION_PROMPT).toContain("Do not use any tools and do not ask any questions");
  });
});

describe("stage failure classification", () => {
  const adapterError = (operation: string, timedOut = false) =>
    new OpenCodeAdapterError({ operation, message: "server text that must not be journaled", ...(timedOut ? { timedOut } : {}) });

  it("finds the adapter error directly, through a cause, or through aggregated reasons", async () => {
    const direct = adapterError("wait for session", true);
    expect(findAdapterError(direct)).toBe(direct);
    expect(findAdapterError(new Error("wrapped", { cause: direct }))).toBe(direct);

    const paired = await settlePairedOperations(
      "first",
      Promise.reject(new Error("plain failure")),
      "second",
      Promise.reject(adapterError("submit prompt")),
    ).catch((error: unknown) => error);
    expect(paired).toBeInstanceOf(Error);
    expect(findAdapterError(paired)?.diagnostic.operation).toBe("submit prompt");
  });

  it("returns undefined for non-adapter failures and bounds its search depth", () => {
    expect(findAdapterError(new Error("correlation mismatch"))).toBeUndefined();
    expect(findAdapterError("not an error")).toBeUndefined();
    let deep: unknown = adapterError("submit prompt");
    for (let i = 0; i < 6; i++) deep = new Error("wrapper", { cause: deep });
    expect(findAdapterError(deep)).toBeUndefined();
  });
});
