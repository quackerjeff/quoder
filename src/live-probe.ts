import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { createOpencode, type OpencodeClient, type V2Event } from "@opencode-ai/sdk/v2";

import {
  CAPABILITY_NAMES,
  cancellationPassed,
  classifyIsolation,
  hasExactHelloContent,
  hasFreshSessionIDs,
  isPathConfined,
  type CapabilityName,
  type CapabilityResult,
  type ProbeEvent,
} from "./capabilities.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { buildCapabilityReport, renderCapabilityReport, type CapabilityReport } from "./report.js";

const execFileAsync = promisify(execFile);
export const LIVE_PROBE_TIMEOUT_MS = 120_000;
const SENTINEL = "NO_PRIOR_SESSION";

export interface LiveProbeEnvironment {
  readonly root: string;
  readonly repository: string;
  readonly outside: string;
}

export interface LiveProbeEvidence {
  readonly sessionIDs: readonly string[];
  readonly projectPaths: readonly string[];
  readonly finalResponse: string;
  readonly structuredEventObserved: boolean;
  readonly permissionRequestID?: string;
  readonly helloContent: string;
  readonly cancellationPassed: boolean;
  readonly deletedSessionIDs: readonly string[];
  readonly isolationResponse: string;
  readonly nonce: string;
}

export interface LiveProbeDriver {
  run(environment: LiveProbeEnvironment): Promise<LiveProbeEvidence>;
  close(): Promise<void>;
}

export interface LiveProbeDependencies {
  readonly createEnvironment: () => Promise<LiveProbeEnvironment>;
  readonly createDriver: () => Promise<LiveProbeDriver>;
  readonly removeEnvironment: (environment: LiveProbeEnvironment) => Promise<void>;
}

export interface LiveProbeOutcome {
  readonly report: CapabilityReport;
  readonly output: string;
  readonly exitCode: 0 | 1;
}

const failResults = (message: string): Map<CapabilityName, CapabilityResult> =>
  new Map(
    CAPABILITY_NAMES.map((capability) => [
      capability,
      { capability, status: "FAIL", evidence: [message] },
    ]),
  );

const passOrFail = (
  capability: CapabilityName,
  passed: boolean,
  evidence: string,
): CapabilityResult => ({ capability, status: passed ? "PASS" : "FAIL", evidence: [evidence] });

export function evaluateLiveEvidence(evidence: LiveProbeEvidence): CapabilityReport {
  const results = new Map<CapabilityName, CapabilityResult>();
  results.set(
    "Fresh session creation",
    passOrFail("Fresh session creation", hasFreshSessionIDs(evidence.sessionIDs), `created ${evidence.sessionIDs.length} sessions`),
  );
  results.set(
    "Project directory",
    passOrFail(
      "Project directory",
      evidence.projectPaths.length > 0 && evidence.projectPaths.every((path) => isPathConfined(evidence.projectPaths[0]!, path)),
      `observed ${evidence.projectPaths.length} confined paths`,
    ),
  );
  results.set(
    "Local model invocation",
    passOrFail("Local model invocation", evidence.finalResponse.trim().length > 0, "received final assistant text"),
  );
  results.set(
    "Streaming events",
    passOrFail("Streaming events", evidence.structuredEventObserved, "observed structured event before completion"),
  );
  results.set(
    "Permission handling",
    passOrFail("Permission handling", Boolean(evidence.permissionRequestID), "observed and answered a real permission request"),
  );
  results.set(
    "File modification",
    passOrFail("File modification", hasExactHelloContent(evidence.helloContent), "verified exact hello.txt content"),
  );
  results.set(
    "Cancellation",
    passOrFail("Cancellation", evidence.cancellationPassed, "fixture interrupted and terminated without normal completion"),
  );
  results.set(
    "Session deletion",
    passOrFail(
      "Session deletion",
      evidence.sessionIDs.length > 0 && evidence.sessionIDs.every((id) => evidence.deletedSessionIDs.includes(id)),
      `verified deletion of ${evidence.deletedSessionIDs.length} sessions`,
    ),
  );
  const isolation = classifyIsolation(evidence.nonce, evidence.isolationResponse);
  results.set(
    "Session isolation",
    passOrFail("Session isolation", isolation.status === "PASS", `isolation classification: ${isolation.reason}`),
  );
  return buildCapabilityReport(results);
}

export async function runLiveProbe(
  dependencies: LiveProbeDependencies = defaultLiveProbeDependencies,
): Promise<LiveProbeOutcome> {
  let environment: LiveProbeEnvironment | undefined;
  let driver: LiveProbeDriver | undefined;
  let report: CapabilityReport;
  const cleanupErrors: string[] = [];
  try {
    environment = await dependencies.createEnvironment();
    driver = await dependencies.createDriver();
    report = evaluateLiveEvidence(await driver.run(environment));
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown live probe failure";
    report = buildCapabilityReport(failResults(message));
  } finally {
    if (driver !== undefined) {
      try {
        await driver.close();
      } catch (error) {
        cleanupErrors.push(
          `driver cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    if (environment !== undefined) {
      try {
        await dependencies.removeEnvironment(environment);
      } catch (error) {
        cleanupErrors.push(
          `environment cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
  }
  if (cleanupErrors.length > 0) {
    report = buildCapabilityReport(failResults(cleanupErrors.join("; ")));
  }
  return {
    report,
    output: renderCapabilityReport(report),
    exitCode: report.verdict === "PASS" ? 0 : 1,
  };
}

const validateTemporaryRoot = (root: string): void => {
  const resolvedRoot = resolve(root);
  const resolvedTemp = resolve(tmpdir());
  const fromTemp = relative(resolvedTemp, resolvedRoot);
  if (!isAbsolute(resolvedRoot) || fromTemp.startsWith("..") || isAbsolute(fromTemp) || resolvedRoot === resolvedTemp) {
    throw new Error("Live probe root is not a child of the operating-system temporary directory");
  }
  const fromWorktree = relative(resolve(process.cwd()), resolvedRoot);
  if (fromWorktree === "" || (!fromWorktree.startsWith("..") && !isAbsolute(fromWorktree))) {
    throw new Error("Live probe root must not be inside the Quoder worktree");
  }
};

export async function createDisposableEnvironment(): Promise<LiveProbeEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "quoder-live-probe-"));
  validateTemporaryRoot(root);
  const repository = join(root, "repository");
  const outside = join(root, "permission-target");
  await Promise.all([mkdir(repository), mkdir(outside)]);
  await execFileAsync("git", ["init", "--quiet", repository], { timeout: 10_000 });
  await writeFile(join(repository, ".gitignore"), "fixture-*.marker\nfixture.pid\n", "utf8");
  return { root, repository, outside };
}

export async function removeDisposableEnvironment(environment: LiveProbeEnvironment): Promise<void> {
  validateTemporaryRoot(environment.root);
  if (basename(environment.root).startsWith("quoder-live-probe-") === false) {
    throw new Error("Refusing to remove an unexpected temporary directory");
  }
  await rm(environment.root, { recursive: true, force: true });
}

type DurableEvent = {
  readonly type: string;
  readonly durable?: { readonly seq?: number };
  readonly data?: Readonly<Record<string, unknown>>;
};

const parseDurableEvent = (data: string): DurableEvent | undefined => {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null && typeof Reflect.get(parsed, "type") === "string") {
      return parsed as DurableEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const isStructuredExecutionEvent = (event: DurableEvent): boolean =>
  event.type === "session.next.step.started" ||
  event.type === "session.next.shell.started" ||
  event.type === "session.next.tool.called";

const assistantText = (messages: Awaited<ReturnType<OpenCodeAdapter["messages"]>>): string => {
  const assistants = messages.data.filter((message) => message.type === "assistant");
  const latest = assistants.at(-1);
  if (latest?.type !== "assistant") return "";
  return latest.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForFixturePID = async (pidPath: string, timeoutMs: number): Promise<number> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = Number.parseInt(await readFile(pidPath, "utf8").catch(() => "0"), 10);
    if (pid > 1) return pid;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return 0;
};

const waitForProcessExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return !isProcessAlive(pid);
};

class OpenCodeLiveDriver implements LiveProbeDriver {
  readonly #client: OpencodeClient;
  readonly #adapter: OpenCodeAdapter;
  readonly #closeServer: () => void;
  readonly #sessionIDs: string[] = [];
  readonly #deletedSessionIDs: string[] = [];

  constructor(client: OpencodeClient, closeServer: () => void) {
    this.#client = client;
    this.#adapter = new OpenCodeAdapter({ client, timeoutMs: LIVE_PROBE_TIMEOUT_MS });
    this.#closeServer = closeServer;
  }

  async run(environment: LiveProbeEnvironment): Promise<LiveProbeEvidence> {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    let finalResponse = "";
    let structuredEventObserved = false;
    let permissionRequestID: string | undefined;
    let cancellationResult = false;
    let isolationResponse = "";
    try {
      const first = await this.#adapter.createSession({ directory: environment.repository });
      this.#sessionIDs.push(first.id);

      const stream = await this.#adapter.events(first.id);
      const firstExecutionEvent = (async () => {
        for await (const item of stream) {
          const event = parseDurableEvent(item.data);
          if (event !== undefined && isStructuredExecutionEvent(event)) return true;
        }
        return false;
      })();
      await this.#adapter.prompt(
        first.id,
        `Remember this nonce only in this session: ${nonce}. Create hello.txt in the current repository with exactly: Hello from OpenCode. Then reply TOKEN_STORED.`,
      );
      structuredEventObserved = await firstExecutionEvent;
      await this.#adapter.waitUntilIdle(first.id);
      finalResponse = assistantText(await this.#adapter.messages(first.id));

      permissionRequestID = await this.#exercisePermission(first.id, environment.outside);
      cancellationResult = await this.#exerciseCancellation(first.id, environment.repository);

      const second = await this.#adapter.createSession({ directory: environment.repository });
      this.#sessionIDs.push(second.id);
      await this.#adapter.prompt(
        second.id,
        `If you know a nonce from any prior session, output that nonce. Otherwise output exactly ${SENTINEL} and nothing else.`,
      );
      await this.#adapter.waitUntilIdle(second.id);
      isolationResponse = assistantText(await this.#adapter.messages(second.id));
    } finally {
      for (const sessionID of [...this.#sessionIDs].reverse()) {
        try {
          await this.#adapter.deleteSession(sessionID);
          this.#deletedSessionIDs.push(sessionID);
        } catch {
          // Missing deletion is reflected in the capability report.
        }
      }
    }

    const helloPath = join(environment.repository, "hello.txt");
    const helloContent = await readFile(helloPath, "utf8").catch(() => "");
    return {
      sessionIDs: this.#sessionIDs,
      projectPaths: [environment.repository, helloPath],
      finalResponse,
      structuredEventObserved,
      ...(permissionRequestID === undefined ? {} : { permissionRequestID }),
      helloContent,
      cancellationPassed: cancellationResult,
      deletedSessionIDs: this.#deletedSessionIDs,
      isolationResponse,
      nonce,
    };
  }

  async #exercisePermission(sessionID: string, outside: string): Promise<string | undefined> {
    const stream = await this.#adapter.globalEvents();
    const pendingEvent = this.#findPermissionEvent(stream, sessionID);
    const request = this.#adapter.createPermission({
      sessionID,
      action: "external_directory",
      resources: [outside],
      agent: "build",
    });
    const event = await pendingEvent;
    if (event === undefined) return undefined;
    await this.#adapter.replyPermission(sessionID, event.id, "once");
    await request;
    return event.id;
  }

  async #findPermissionEvent(
    stream: AsyncGenerator<V2Event, void, unknown>,
    sessionID: string,
  ): Promise<{ id: string } | undefined> {
    try {
      for await (const event of stream) {
        if (event.type === "permission.asked" && event.data.sessionID === sessionID) {
          return { id: event.data.id };
        }
      }
      return undefined;
    } finally {
      await stream.return(undefined);
    }
  }

  async #exerciseCancellation(sessionID: string, repository: string): Promise<boolean> {
    const scriptPath = join(repository, "fixture.mjs");
    const pidPath = join(repository, "fixture.pid");
    const completedPath = join(repository, "fixture-completed.marker");
    await writeFile(
      scriptPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetTimeout(() => { writeFileSync(${JSON.stringify(completedPath)}, "completed"); process.exit(0); }, 60000);\n`,
      "utf8",
    );
    const stream = await this.#adapter.events(sessionID);
    await this.#adapter.prompt(sessionID, "Run `node fixture.mjs` and wait for it to finish. Do not run it in the background.");
    const events: ProbeEvent[] = [];
    let started = 0;
    try {
      for await (const item of stream) {
        const event = parseDurableEvent(item.data);
        if (event === undefined) continue;
        const sequence = event.durable?.seq ?? events.length + 1;
        events.push({
          sequence,
          type: event.type,
          sessionID,
          ...(event.data === undefined ? {} : { properties: event.data }),
        });
        if (event.type === "session.next.shell.started") {
          started = sequence;
          break;
        }
      }
    } finally {
      await stream.return(undefined);
    }
    if (started === 0) return false;
    const pid = await waitForFixturePID(pidPath, 5_000);
    if (pid === 0) return false;
    const interruptSequence = started + 1;
    await this.#adapter.interrupt(sessionID);
    await this.#adapter.waitUntilIdle(sessionID);
    const terminalSequence = interruptSequence + 1;
    const fixtureTerminated = await waitForProcessExit(pid, 5_000);
    const completed = await readFile(completedPath, "utf8").then(() => true).catch(() => false);
    return cancellationPassed({
      fixtureStartedAtSequence: started,
      interruptRequestedAtSequence: interruptSequence,
      terminalIdleAtSequence: terminalSequence,
      fixtureTerminated,
      events: completed
        ? [...events, { sequence: terminalSequence, type: "fixture.completed", sessionID }]
        : events,
    });
  }

  async close(): Promise<void> {
    this.#closeServer();
  }
}

async function createOpenCodeDriver(): Promise<LiveProbeDriver> {
  const hosted = await createOpencode({ hostname: "127.0.0.1", port: 0, timeout: 15_000 });
  return new OpenCodeLiveDriver(hosted.client, hosted.server.close);
}

export const defaultLiveProbeDependencies: LiveProbeDependencies = {
  createEnvironment: createDisposableEnvironment,
  createDriver: createOpenCodeDriver,
  removeEnvironment: removeDisposableEnvironment,
};
