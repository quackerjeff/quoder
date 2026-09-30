import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { createOpencodeClient, type OpencodeClient, type V2Event } from "@opencode-ai/sdk/v2";

import {
  CAPABILITY_NAMES,
  cancellationPassed,
  classifyIsolation,
  hasExactHelloContent,
  hasFinalModelResponse,
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
export const LIVE_PROBE_RUN_TIMEOUT_MS = 600_000;
const SENTINEL = "NO_PRIOR_SESSION";
const SERVER_USERNAME = "quoder";

export interface LiveProbeEnvironment {
  readonly root: string;
  readonly repository: string;
  readonly outside: string;
}

export interface LiveProbeEvidence {
  readonly sessionIDs: readonly string[];
  readonly projectPaths: readonly string[];
  readonly finalResponse: string;
  readonly admittedInputID: string;
  readonly responseInputID: string;
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
  readonly createDriver: (options?: LiveProbeDriverOptions) => Promise<LiveProbeDriver>;
  readonly removeEnvironment: (environment: LiveProbeEnvironment) => Promise<void>;
}

export type LiveProbeProgress = (stage: string) => void;

export interface LiveProbeDriverOptions {
  readonly onProgress?: LiveProbeProgress;
}

export interface RunLiveProbeOptions extends LiveProbeDriverOptions {
  readonly timeoutMs?: number;
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

export function evaluateLiveEvidence(
  evidence: LiveProbeEvidence,
  repositoryRoot: string,
): CapabilityReport {
  const results = new Map<CapabilityName, CapabilityResult>();
  results.set(
    "Fresh session creation",
    passOrFail("Fresh session creation", hasFreshSessionIDs(evidence.sessionIDs), `created ${evidence.sessionIDs.length} sessions`),
  );
  results.set(
    "Project directory",
    passOrFail(
      "Project directory",
      evidence.projectPaths.length > 0 &&
        evidence.projectPaths.every((path) => isPathConfined(repositoryRoot, path)),
      `observed ${evidence.projectPaths.length} confined paths`,
    ),
  );
  results.set(
    "Local model invocation",
    passOrFail(
      "Local model invocation",
      hasFinalModelResponse({
        admittedInputID: evidence.admittedInputID,
        responseInputID: evidence.responseInputID,
        assistantText: evidence.finalResponse,
      }) && evidence.finalResponse === "TOKEN_STORED",
      "received exact TOKEN_STORED response correlated to the admitted input",
    ),
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
  options: RunLiveProbeOptions = {},
): Promise<LiveProbeOutcome> {
  let environment: LiveProbeEnvironment | undefined;
  let driver: LiveProbeDriver | undefined;
  let report: CapabilityReport;
  const cleanupErrors: string[] = [];
  const onProgress = options.onProgress ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? LIVE_PROBE_RUN_TIMEOUT_MS;
  let timeout: NodeJS.Timeout | undefined;
  let rejectDeadline: ((reason: Error) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Live probe end-to-end timeout must be a positive finite number");
    }
    timeout = setTimeout(() => {
      onProgress("run.timeout");
      void driver?.close().catch(() => undefined);
      rejectDeadline?.(new Error(`Live probe exceeded end-to-end timeout of ${timeoutMs}ms`));
    }, timeoutMs);
    onProgress("environment.create.start");
    environment = await Promise.race([dependencies.createEnvironment(), deadline]);
    onProgress("environment.create.complete");
    onProgress("driver.create.start");
    driver = await Promise.race([dependencies.createDriver({ onProgress }), deadline]);
    onProgress("driver.create.complete");
    const activeDriver = driver;
    onProgress("run.start");
    const evidence = await Promise.race([activeDriver.run(environment), deadline]);
    onProgress("run.complete");
    report = evaluateLiveEvidence(evidence, environment.repository);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown live probe failure";
    report = buildCapabilityReport(failResults(message));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (driver !== undefined) {
      try {
        onProgress("driver.close.start");
        await driver.close();
        onProgress("driver.close.complete");
      } catch (error) {
        cleanupErrors.push(
          `driver cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    if (environment !== undefined) {
      try {
        onProgress("environment.remove.start");
        await dependencies.removeEnvironment(environment);
        onProgress("environment.remove.complete");
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

const eventSessionID = (event: V2Event): string | undefined => {
  const value = Reflect.get(event.data, "sessionID");
  return typeof value === "string" ? value : undefined;
};

const correlatedAssistantResponse = (
  messages: Awaited<ReturnType<OpenCodeAdapter["messages"]>>,
  admittedInputID: string,
): { text: string; inputID: string } => {
  const inputIndex = messages.data.findIndex(
    (message) => message.type === "user" && message.id === admittedInputID,
  );
  if (inputIndex < 0) return { text: "", inputID: "" };
  let response: (typeof messages.data)[number] | undefined;
  for (const message of messages.data.slice(inputIndex + 1)) {
    if (message.type === "user") break;
    if (message.type === "assistant") {
      response = message;
      break;
    }
  }
  if (response?.type !== "assistant") return { text: "", inputID: "" };
  return {
    inputID: admittedInputID,
    text: response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim(),
  };
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

export async function readConfinedRegularFile(
  repository: string,
  candidate: string,
): Promise<string> {
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Evidence path must be a regular file, not a symbolic link");
  }
  const [repositoryTarget, candidateTarget] = await Promise.all([
    realpath(repository),
    realpath(candidate),
  ]);
  if (!isPathConfined(repositoryTarget, candidateTarget)) {
    throw new Error("Evidence file resolves outside the disposable repository");
  }
  return readFile(candidateTarget, "utf8");
}

export async function terminateValidatedFixture(
  pid: number,
  fixtureToken: string,
  dependencies: {
    isAlive?: (pid: number) => boolean;
    commandForPID?: (pid: number) => Promise<string>;
    terminate?: (pid: number) => void;
    waitForExit?: (pid: number, timeoutMs: number) => Promise<boolean>;
  } = {},
): Promise<void> {
  if (pid <= 0 || !(dependencies.isAlive ?? isProcessAlive)(pid)) return;
  const commandForPID = dependencies.commandForPID ?? (async (candidatePID) =>
    (await execFileAsync("ps", ["-p", String(candidatePID), "-o", "command="])).stdout.trim());
  const command = await commandForPID(pid);
  if (!command.includes(fixtureToken)) {
    throw new Error("Refusing to terminate an unvalidated fixture process");
  }
  (dependencies.terminate ?? ((candidatePID) => process.kill(candidatePID, "SIGTERM")))(pid);
  const exited = await (dependencies.waitForExit ?? waitForProcessExit)(pid, 5_000);
  if (!exited) throw new Error("Validated fixture process did not terminate");
}

export function cancellationFromObservedEvents(
  events: readonly ProbeEvent[],
  interruptRequestedAtSequence: number,
  fixtureTerminated: boolean,
  fixtureCompleted: boolean,
): boolean {
  const fixtureStartedAtSequence =
    events.find((event) => event.type === "session.next.shell.started")?.sequence ?? 0;
  const terminalIdleAtSequence =
    events.find(
      (event) => event.type === "session.idle" && event.sequence > interruptRequestedAtSequence,
    )?.sequence ?? 0;
  const observedEvents = fixtureCompleted
    ? [
        ...events,
        {
          sequence: Math.max(interruptRequestedAtSequence + 1, terminalIdleAtSequence),
          type: "fixture.completed",
          sessionID: events[0]?.sessionID ?? "",
        },
      ]
    : events;
  return cancellationPassed({
    fixtureStartedAtSequence,
    interruptRequestedAtSequence,
    terminalIdleAtSequence,
    fixtureTerminated,
    events: observedEvents,
  });
}

interface IsolationTransitionAdapter {
  deleteSession(sessionID: string): Promise<void>;
  createSession(options: { directory: string }): Promise<{ id: string }>;
}

export async function createIsolationSessionAfterDeletion(
  adapter: IsolationTransitionAdapter,
  firstSessionID: string,
  repository: string,
): Promise<{ id: string; deletedSessionID: string }> {
  await adapter.deleteSession(firstSessionID);
  const second = await adapter.createSession({ directory: repository });
  return { id: second.id, deletedSessionID: firstSessionID };
}

export async function settlePairedOperations<First, Second>(
  firstName: string,
  first: Promise<First>,
  secondName: string,
  second: Promise<Second>,
): Promise<readonly [First, Second]> {
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  const failures: string[] = [];
  if (firstResult.status === "rejected") {
    failures.push(`${firstName} failed: ${errorMessage(firstResult.reason)}`);
  }
  if (secondResult.status === "rejected") {
    failures.push(`${secondName} failed: ${errorMessage(secondResult.reason)}`);
  }
  if (firstResult.status === "rejected" || secondResult.status === "rejected") {
    throw new Error(failures.join("; "));
  }
  return [firstResult.value, secondResult.value];
}

export function correlatePermissionEvidence(
  observed: { readonly id: string },
  created: { readonly id: string; readonly effect: string },
): string {
  if (created.effect !== "ask") {
    throw new Error(
      `created permission request ${created.id} returned unexpected effect ${created.effect}`,
    );
  }
  if (observed.id !== created.id) {
    throw new Error(
      `observed permission request ID ${observed.id} does not match created request ID ${created.id}`,
    );
  }
  return created.id;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export class OpenCodeLiveDriver implements LiveProbeDriver {
  readonly #adapter: OpenCodeAdapter;
  readonly #closeServer: () => void;
  readonly #sessionIDs: string[] = [];
  readonly #deletedSessionIDs: string[] = [];
  readonly #onProgress: LiveProbeProgress;

  constructor(client: OpencodeClient, closeServer: () => void, onProgress: LiveProbeProgress = () => undefined) {
    this.#adapter = new OpenCodeAdapter({ client, timeoutMs: LIVE_PROBE_TIMEOUT_MS });
    this.#closeServer = closeServer;
    this.#onProgress = onProgress;
  }

  async run(environment: LiveProbeEnvironment): Promise<LiveProbeEvidence> {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    let finalResponse = "";
    let admittedInputID = "";
    let responseInputID = "";
    let structuredEventObserved = false;
    let permissionRequestID: string | undefined;
    let cancellationResult = false;
    let isolationResponse = "";
    try {
      this.#onProgress("session.initial.create.start");
      const first = await this.#adapter.createSession({ directory: environment.repository });
      this.#sessionIDs.push(first.id);
      this.#onProgress("session.initial.create.complete");

      this.#onProgress("session.initial.prompt.start");
      const stream = await this.#adapter.events(first.id);
      const firstExecutionEvent = (async () => {
        try {
          for await (const item of stream) {
            const event = parseDurableEvent(item.data);
            if (event !== undefined && isStructuredExecutionEvent(event)) return true;
          }
          return false;
        } finally {
          await stream.return(undefined);
        }
      })();
      const promptSubmission = this.#adapter.prompt(
        first.id,
        `Remember this nonce only in this session: ${nonce}. Create hello.txt in the current repository with exactly: Hello from OpenCode. Then reply TOKEN_STORED.`,
      );
      const [observedStructuredEvent, admitted] = await settlePairedOperations(
        "initial structured-event observation",
        firstExecutionEvent,
        "initial prompt submission",
        promptSubmission,
      );
      structuredEventObserved = observedStructuredEvent;
      await this.#adapter.waitUntilIdle(first.id);
      admittedInputID = admitted.id;
      const correlatedResponse = correlatedAssistantResponse(
        await this.#adapter.messages(first.id),
        admittedInputID,
      );
      finalResponse = correlatedResponse.text;
      responseInputID = correlatedResponse.inputID;
      this.#onProgress("session.initial.prompt.complete");

      this.#onProgress("permission.start");
      permissionRequestID = await this.#exercisePermission(first.id, environment.outside);
      this.#onProgress("permission.complete");
      this.#onProgress("cancellation.start");
      cancellationResult = await this.#exerciseCancellation(first.id, environment.repository);
      this.#onProgress("cancellation.complete");

      this.#onProgress("isolation.start");
      const isolationTransition = await createIsolationSessionAfterDeletion(
        this.#adapter,
        first.id,
        environment.repository,
      );
      this.#deletedSessionIDs.push(isolationTransition.deletedSessionID);
      const second = { id: isolationTransition.id };
      this.#sessionIDs.push(second.id);
      const isolationInput = await this.#adapter.prompt(
        second.id,
        `If you know a nonce from any prior session, output that nonce. Otherwise output exactly ${SENTINEL} and nothing else.`,
      );
      await this.#adapter.waitUntilIdle(second.id);
      isolationResponse = correlatedAssistantResponse(
        await this.#adapter.messages(second.id),
        isolationInput.id,
      ).text;
      this.#onProgress("isolation.complete");
    } finally {
      this.#onProgress("sessions.cleanup.start");
      for (const sessionID of [...this.#sessionIDs].reverse()) {
        if (this.#deletedSessionIDs.includes(sessionID)) continue;
        try {
          await this.#adapter.deleteSession(sessionID);
          this.#deletedSessionIDs.push(sessionID);
        } catch {
          // Missing deletion is reflected in the capability report.
        }
      }
      this.#onProgress("sessions.cleanup.complete");
    }

    const helloPath = join(environment.repository, "hello.txt");
    const helloContent = await readConfinedRegularFile(environment.repository, helloPath).catch(
      () => "",
    );
    return {
      sessionIDs: this.#sessionIDs,
      projectPaths: [environment.repository, helloPath],
      finalResponse,
      admittedInputID,
      responseInputID,
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
    const request = this.#adapter
      .createPermission({
        sessionID,
        action: "external_directory",
        resources: [outside],
        agent: "build",
      })
      .then((created) => {
        correlatePermissionEvidence({ id: created.id }, created);
        return created;
      });
    const pendingEvent = this.#findPermissionEvent(stream, sessionID, request);
    const [event, created] = await settlePairedOperations(
      "permission event observation",
      pendingEvent,
      "permission request",
      request,
    );
    if (event === undefined) return undefined;
    const requestID = correlatePermissionEvidence(event, created);
    await this.#adapter.replyPermission(sessionID, requestID, "once");
    return requestID;
  }

  async #findPermissionEvent(
    stream: AsyncGenerator<V2Event, void, unknown>,
    sessionID: string,
    createdRequest: Promise<{ id: string; effect: string }>,
  ): Promise<{ id: string } | undefined> {
    try {
      for await (const event of stream) {
        if (event.type === "permission.v2.asked" && event.data.sessionID === sessionID) {
          const created = await createdRequest;
          if (event.data.id !== created.id) continue;
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
    const fixtureToken = crypto.randomUUID();
    let pid = 0;
    await writeFile(
      scriptPath,
      `import { writeFileSync } from "node:fs";\nif (process.argv[2] !== ${JSON.stringify(fixtureToken)}) process.exit(2);\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetTimeout(() => { writeFileSync(${JSON.stringify(completedPath)}, "completed"); process.exit(0); }, 60000);\n`,
      "utf8",
    );
    const stream = await this.#adapter.globalEvents();
    await this.#adapter.prompt(
      sessionID,
      `Run \`node fixture.mjs ${fixtureToken}\` and wait for it to finish. Do not run it in the background.`,
    );
    const events: ProbeEvent[] = [];
    let started = 0;
    let interruptSequence = 0;
    let terminalSequence = 0;
    try {
      for await (const event of stream) {
        if (eventSessionID(event) !== sessionID) continue;
        const sequence = event.durable?.seq ?? events.length + 1;
        events.push({
          sequence,
          type: event.type,
          sessionID,
          ...(event.data === undefined ? {} : { properties: event.data as Readonly<Record<string, unknown>> }),
        });
        if (event.type === "session.next.shell.started") {
          started = sequence;
          break;
        }
      }
    } catch {
      await stream.return(undefined);
      return false;
    }
    if (started === 0) {
      await stream.return(undefined);
      return false;
    }
    pid = await waitForFixturePID(pidPath, 5_000);
    if (pid === 0) {
      await stream.return(undefined);
      return false;
    }
    try {
      interruptSequence = Math.max(...events.map(({ sequence }) => sequence)) + 1;
      await this.#adapter.interrupt(sessionID);
      const waitForIdle = this.#adapter.waitUntilIdle(sessionID);
      const observeTerminalIdle = (async () => {
        try {
          for await (const event of stream) {
            if (eventSessionID(event) !== sessionID) continue;
            const sequence = event.durable?.seq ?? Math.max(interruptSequence + 1, events.length + 1);
            events.push({
              sequence,
              type: event.type,
              sessionID,
              ...(event.data === undefined ? {} : { properties: event.data as Readonly<Record<string, unknown>> }),
            });
            if (event.type === "session.idle") {
              terminalSequence = sequence;
              break;
            }
          }
          return terminalSequence;
        } finally {
          await stream.return(undefined);
        }
      })();
      const [, observedTerminalSequence] = await settlePairedOperations(
        "cancellation idle wait",
        waitForIdle,
        "cancellation event observation",
        observeTerminalIdle,
      );
      terminalSequence = observedTerminalSequence;
      const fixtureTerminated = await waitForProcessExit(pid, 5_000);
      const completed = await readFile(completedPath, "utf8").then(() => true).catch(() => false);
      return cancellationFromObservedEvents(
        events,
        interruptSequence,
        fixtureTerminated,
        completed,
      );
    } finally {
      await terminateValidatedFixture(pid, fixtureToken);
    }
  }

  async close(): Promise<void> {
    this.#closeServer();
  }
}

export interface AuthenticatedServerLaunch {
  readonly url: string;
  close(): void;
}

export interface AuthenticatedServerOptions {
  readonly username: string;
  readonly password: string;
}

export function authenticatedServerProcessConfig(options: AuthenticatedServerOptions): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
} {
  return {
    executable: resolve(process.cwd(), "node_modules", ".bin", "opencode"),
    args: ["serve", "--pure", "--hostname=127.0.0.1", "--port=0"],
    env: {
      ...process.env,
      OPENCODE_SERVER_USERNAME: options.username,
      OPENCODE_SERVER_PASSWORD: options.password,
    },
  };
}

export const basicAuthorizationHeader = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

export async function verifyServerAuthentication(
  url: string,
  authorization: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const healthURL = new URL("/global/health", url);
  const unauthenticated = await fetcher(healthURL, { signal: AbortSignal.timeout(5_000) });
  if (unauthenticated.status !== 401) {
    throw new Error("OpenCode server did not reject an unauthenticated health request");
  }
  const authenticated = await fetcher(healthURL, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(5_000),
  });
  if (!authenticated.ok) {
    throw new Error("OpenCode server did not accept authenticated health request");
  }
}

export async function launchAuthenticatedOpenCodeServer(
  options: AuthenticatedServerOptions,
): Promise<AuthenticatedServerLaunch> {
  const config = authenticatedServerProcessConfig(options);
  const child = spawn(
    config.executable,
    [...config.args],
    {
      env: config.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const close = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const url = await new Promise<string>((resolveURL, reject) => {
    const timeout = setTimeout(() => {
      close();
      reject(new Error("Timed out waiting for authenticated OpenCode server startup"));
    }, 15_000);
    const fail = (message: string) => {
      clearTimeout(timeout);
      close();
      reject(new Error(message));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (match?.[1] === undefined) {
          fail("Authenticated OpenCode server reported an invalid listening URL");
          return;
        }
        clearTimeout(timeout);
        resolveURL(match[1]);
        return;
      }
    });
    child.stderr.on("data", () => {
      // Startup diagnostics are intentionally not retained because inherited configuration may be sensitive.
    });
    child.once("error", (error) => fail(`Authenticated OpenCode server failed to start: ${error.message}`));
    child.once("exit", (code) => {
      if (code !== null) fail(`Authenticated OpenCode server exited during startup with code ${code}`);
    });
  });
  try {
    await verifyServerAuthentication(
      url,
      basicAuthorizationHeader(options.username, options.password),
    );
  } catch (error) {
    close();
    throw error;
  }
  return { url, close };
}

export async function createAuthenticatedOpenCodeDriver(
  launch: (options: AuthenticatedServerOptions) => Promise<AuthenticatedServerLaunch> =
    launchAuthenticatedOpenCodeServer,
  clientFactory: typeof createOpencodeClient = createOpencodeClient,
  options: LiveProbeDriverOptions = {},
): Promise<LiveProbeDriver> {
  const password = randomBytes(32).toString("base64url");
  const hosted = await launch({ username: SERVER_USERNAME, password });
  try {
    const client = clientFactory({
      baseUrl: hosted.url,
      headers: { Authorization: basicAuthorizationHeader(SERVER_USERNAME, password) },
    });
    return new OpenCodeLiveDriver(client, hosted.close, options.onProgress);
  } catch (error) {
    hosted.close();
    throw error;
  }
}

export const defaultLiveProbeDependencies: LiveProbeDependencies = {
  createEnvironment: createDisposableEnvironment,
  createDriver: (options) => createAuthenticatedOpenCodeDriver(
    launchAuthenticatedOpenCodeServer,
    createOpencodeClient,
    options,
  ),
  removeEnvironment: removeDisposableEnvironment,
};
