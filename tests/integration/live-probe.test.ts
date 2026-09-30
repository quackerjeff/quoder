import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpencodeClient, V2Event } from "@opencode-ai/sdk/v2";
import { describe, expect, it, vi } from "vitest";

import { CAPABILITY_NAMES } from "../../src/capabilities.js";
import {
  LIVE_PROBE_TIMEOUT_MS,
  OpenCodeLiveDriver,
  authenticatedServerProcessConfig,
  basicAuthorizationHeader,
  cancellationFromObservedEvents,
  correlatePermissionEvidence,
  createAuthenticatedOpenCodeDriver,
  createIsolationSessionAfterDeletion,
  evaluateLiveEvidence,
  readConfinedRegularFile,
  runLiveProbe,
  settlePairedOperations,
  terminateValidatedFixture,
  verifyServerAuthentication,
  type LiveProbeDependencies,
  type LiveProbeDriver,
  type LiveProbeEvidence,
  type LiveProbeEnvironment,
} from "../../src/live-probe.js";

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
  });

  it("rejects cancellation when an observed completion occurs after interruption", () => {
    const observedEvents = [
      { sequence: 2, type: "session.next.shell.started", sessionID: "session-1" },
      { sequence: 5, type: "session.idle", sessionID: "session-1" },
    ];

    expect(cancellationFromObservedEvents(observedEvents, 3, true, false)).toBe(true);
    expect(cancellationFromObservedEvents(observedEvents, 3, true, true)).toBe(false);
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

  it("retains both the permission stream and request diagnostics when both reject", async () => {
    await expect(
      settlePairedOperations(
        "permission event observation",
        Promise.reject(new Error("event stream aborted")),
        "permission request",
        Promise.reject(new Error("create permission timed out")),
      ),
    ).rejects.toThrow(
      "permission event observation failed: Error: event stream aborted; permission request failed: Error: create permission timed out",
    );
  });

  it("preserves a permission request rejection when the event stream ends without a match", async () => {
    await expect(
      settlePairedOperations(
        "permission event observation",
        Promise.resolve(undefined),
        "permission request",
        Promise.reject(new Error("request rejected after stream end")),
      ),
    ).rejects.toThrow(
      "permission request failed: Error: request rejected after stream end",
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
    const permissionCreate = vi.fn().mockImplementation(async () => {
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
      yield {
        id: "durable-1",
        event: "session.next.step.started",
        data: JSON.stringify({ type: "session.next.step.started", durable: { seq: 1 } }),
      };
    }
    async function* permissionEvents() {
      operations.push("emitted:legacy");
      yield legacyEvent;
      operations.push("emitted:core-v2");
      yield coreV2Event;
    }
    async function* noCancellationEvents() {
      return;
    }

    const subscribe = vi
      .fn()
      .mockResolvedValueOnce({ stream: permissionEvents() })
      .mockResolvedValueOnce({ stream: noCancellationEvents() });
    const messages = vi
      .fn()
      .mockResolvedValueOnce(
        result({
          data: [
            { id: "input-1", type: "user", time: { created: 1 }, text: "prompt" },
            {
              id: "assistant-1",
              type: "assistant",
              time: { created: 2 },
              agent: "build",
              model: { providerID: "ollama", id: "model" },
              content: [{ type: "text", id: "text-1", text: "TOKEN_STORED" }],
            },
          ],
          cursor: {},
        }),
      )
      .mockResolvedValueOnce(
        result({
          data: [
            { id: "input-2", type: "user", time: { created: 3 }, text: "prompt" },
            {
              id: "assistant-2",
              type: "assistant",
              time: { created: 4 },
              agent: "build",
              model: { providerID: "ollama", id: "model" },
              content: [{ type: "text", id: "text-2", text: "NO_PRIOR_SESSION" }],
            },
          ],
          cursor: {},
        }),
      );
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
          wait: vi.fn().mockResolvedValue(result(undefined, 204)) as Method<
            OpencodeClient["v2"]["session"]["wait"]
          >,
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
      expect(operations).toEqual([
        "created:permission-1:ask",
        "emitted:legacy",
        "emitted:core-v2",
        "replied:permission-1",
      ]);
    } finally {
      await driver.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("security hardening", () => {
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
