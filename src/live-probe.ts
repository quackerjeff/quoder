import { execFile } from "node:child_process";
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
import { OpenCodeAdapter, OpenCodeAdapterError, finalAssistantResponseText } from "./opencode-adapter.js";
import { buildCapabilityReport, renderCapabilityReport, type CapabilityReport } from "./report.js";
import {
  basicAuthorizationHeader,
  launchAuthenticatedOpenCodeServer,
  type AuthenticatedServerLaunch,
  type AuthenticatedServerOptions,
} from "./opencode-server.js";
import { startEventMonitor, type EventMonitor } from "./event-monitor.js";

const execFileAsync = promisify(execFile);
export const LIVE_PROBE_TIMEOUT_MS = 120_000;
export const LIVE_PROBE_RUN_TIMEOUT_MS = 600_000;
const SENTINEL = "NO_PRIOR_SESSION";
const SERVER_USERNAME = "quoder";
export const LIVE_MODEL = { providerID: "ollama", id: "qwen3-coder:30b" } as const;

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
      }) && evidence.finalResponse === INITIAL_PROMPT_SENTINEL,
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

export async function createDisposableEnvironment(
  signal?: AbortSignal,
  acceptOwnership?: (environment: LiveProbeEnvironment) => boolean | void,
): Promise<LiveProbeEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "quoder-live-probe-"));
  try {
    validateTemporaryRoot(root);
    const repository = join(root, "repository");
    const outside = join(root, "permission-target");
    const environment = { root, repository, outside };
    if (acceptOwnership?.(environment) === false) {
      throw new Error("Disposable environment ownership was rejected");
    }
    if (signal?.aborted) throw signal.reason;
    await Promise.all([mkdir(repository), mkdir(outside)]);
    if (signal?.aborted) throw signal.reason;
    await execFileAsync("git", ["init", "--quiet", repository], { timeout: 10_000, signal });
    if (signal?.aborted) throw signal.reason;
    await writeFile(join(repository, ".gitignore"), "fixture-*.marker\nfixture.pid\n", "utf8");
    if (signal?.aborted) throw signal.reason;
    return environment;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
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

const asDurableEvent = (value: unknown): DurableEvent | undefined =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
    ? (value as DurableEvent)
    : undefined;

/**
 * At runtime the 1.18.33 SDK yields session-stream items as parsed events
 * (`{ id, type, durable, data }`, `data` being the payload object), although the generated type
 * declares `{ id, event, data: string }` (verified live on 2026-10-02/03). The parsed form is
 * authoritative; the declared string form is accepted only when it parses to an event.
 */
export const sessionStreamEvent = (item: unknown): DurableEvent | undefined => {
  const parsed = asDurableEvent(item);
  if (parsed !== undefined) return parsed;
  const data = typeof item === "object" && item !== null ? Reflect.get(item, "data") : undefined;
  if (typeof data !== "string") return undefined;
  try {
    return asDurableEvent(JSON.parse(data));
  } catch {
    return undefined;
  }
};

export const INITIAL_PROMPT_SENTINEL = "TOKEN_STORED";

/** Scenario prompts selected by sampling against the configured model (spec 2026-10-03, Group 1). */
export const initialPrompt = (nonce: string): string =>
  "Use the write tool to create a file named hello.txt in the current directory. " +
  "Its entire content must be exactly: Hello from OpenCode\n" +
  `Also remember this nonce for this session only: ${nonce}\n` +
  `Do not ask any questions. After the file is written, reply with exactly ${INITIAL_PROMPT_SENTINEL} and nothing else.`;

export const cancellationPrompt = (fixtureToken: string): string =>
  `Run \`node fixture.mjs ${fixtureToken}\` and wait for it to finish. ` +
  "Do not run it in the background. Do not ask any questions.";

export const ISOLATION_PROMPT =
  `Reply with exactly ${SENTINEL} and nothing else, unless you know a nonce from a prior session, ` +
  "in which case reply with only that nonce. Do not use any tools and do not ask any questions.";

const isStructuredExecutionEvent = (event: DurableEvent): boolean =>
  event.type === "session.next.step.started" ||
  event.type === "session.next.shell.started" ||
  event.type === "session.next.tool.called";

const eventSessionID = (event: V2Event): string | undefined => {
  const value = Reflect.get(event.data, "sessionID");
  return typeof value === "string" ? value : undefined;
};

// Streaming deltas carry no durable sequence and are not evidence; only durable events are ordered.
const durableProbeEvent = (event: V2Event, sessionID: string): ProbeEvent | undefined => {
  const sequence = event.durable?.seq;
  if (eventSessionID(event) !== sessionID || sequence === undefined) return undefined;
  return {
    sequence,
    type: event.type,
    sessionID,
    ...(event.data === undefined ? {} : { properties: event.data as Readonly<Record<string, unknown>> }),
  };
};

const correlatedAssistantResponse = (
  messages: Awaited<ReturnType<OpenCodeAdapter["messages"]>>,
  admittedInputID: string,
): { text: string; inputID: string } => {
  const text = finalAssistantResponseText(messages, admittedInputID);
  return text === undefined ? { text: "", inputID: "" } : { text, inputID: admittedInputID };
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

/**
 * OpenCode 1.18.33 reports a model-run command as `session.next.tool.called` and an
 * interrupted command as `session.next.tool.failed` for the same call; it emits no
 * `session.idle` event (verified live on 2026-10-02).
 */
export const fixtureToolCallID = (event: ProbeEvent, fixtureToken: string): string | undefined => {
  if (event.type !== "session.next.tool.called" || event.properties?.tool !== "bash") return undefined;
  const input = event.properties.input;
  const command = typeof input === "object" && input !== null ? Reflect.get(input, "command") : undefined;
  const callID = event.properties.callID;
  return typeof command === "string" && command.includes(fixtureToken) && typeof callID === "string"
    ? callID
    : undefined;
};

const isToolEventFor = (event: ProbeEvent, type: string, callID: string): boolean =>
  event.type === type && event.properties?.callID === callID;

export function cancellationFromObservedEvents(
  events: readonly ProbeEvent[],
  fixtureCallID: string,
  lastSequenceReadBeforeInterrupt: number,
  interruptRequestedAtTime: number,
  fixtureTerminated: boolean,
  fixtureCompleted: boolean,
): boolean {
  // Durable sequences are dense per session, and the interrupt request is not itself an event,
  // so it sits strictly between the last event read before it and the next one: a terminal
  // event at N+1 directly after the fixture call at N is post-interrupt.
  const interruptRequestedAtSequence = lastSequenceReadBeforeInterrupt + 0.5;
  const fixtureStartedAtSequence =
    events.find((event) => isToolEventFor(event, "session.next.tool.called", fixtureCallID))?.sequence ?? 0;
  // Sequence order alone cannot prove causality, because events already queued before the
  // interrupt may be read after it; the failure must also be timestamped after the request.
  const terminalAtSequence =
    events.find(
      (event) =>
        isToolEventFor(event, "session.next.tool.failed", fixtureCallID) &&
        event.sequence > interruptRequestedAtSequence &&
        typeof event.properties?.timestamp === "number" &&
        event.properties.timestamp >= interruptRequestedAtTime,
    )?.sequence ?? 0;
  // Any successful completion of the fixture call means the command was not cancelled.
  const completions: ProbeEvent[] = events
    .filter((event) => isToolEventFor(event, "session.next.tool.success", fixtureCallID))
    .map((event) => ({
      ...event,
      sequence: Math.max(event.sequence, interruptRequestedAtSequence + 1),
      type: "fixture.completed",
    }));
  if (fixtureCompleted) {
    completions.push({
      sequence: Math.max(interruptRequestedAtSequence + 1, terminalAtSequence),
      type: "fixture.completed",
      sessionID: events[0]?.sessionID ?? "",
    });
  }
  return cancellationPassed({
    fixtureStartedAtSequence,
    interruptRequestedAtSequence,
    terminalAtSequence,
    fixtureTerminated,
    events: [...events, ...completions],
  });
}

interface IsolationTransitionAdapter {
  deleteSession(sessionID: string): Promise<void>;
  createSession(options: {
    directory: string;
    model: typeof LIVE_MODEL;
  }): Promise<{ id: string }>;
}

export async function createIsolationSessionAfterDeletion(
  adapter: IsolationTransitionAdapter,
  firstSessionID: string,
  repository: string,
): Promise<{ id: string; deletedSessionID: string }> {
  await adapter.deleteSession(firstSessionID);
  const second = await adapter.createSession({ directory: repository, model: LIVE_MODEL });
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
    const reasons = [firstResult, secondResult].flatMap((settled) =>
      settled.status === "rejected" ? [settled.reason as unknown] : [],
    );
    // The reasons stay attached so callers can classify the underlying failure without its text.
    throw new Error(failures.join("; "), { cause: new AggregateError(reasons) });
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

/** Finds the first adapter error in an error, its `cause` chain, or aggregated `errors` (bounded). */
export const findAdapterError = (error: unknown, depth = 0): OpenCodeAdapterError | undefined => {
  if (error instanceof OpenCodeAdapterError) return error;
  if (depth >= 4 || typeof error !== "object" || error === null) return undefined;
  const nested = [
    ...(error instanceof AggregateError ? error.errors : []),
    ...("cause" in error ? [error.cause] : []),
  ];
  for (const candidate of nested) {
    const found = findAdapterError(candidate, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export class OpenCodeLiveDriver implements LiveProbeDriver {
  readonly #adapter: OpenCodeAdapter;
  readonly #closeServer: () => Promise<void>;
  readonly #sessionIDs: string[] = [];
  readonly #deletedSessionIDs: string[] = [];
  readonly #onProgress: LiveProbeProgress;
  readonly #operationTimeoutMs: number;

  constructor(
    client: OpencodeClient,
    closeServer: () => Promise<void>,
    onProgress: LiveProbeProgress = () => undefined,
    options: { readonly operationTimeoutMs?: number } = {},
  ) {
    this.#operationTimeoutMs = options.operationTimeoutMs ?? LIVE_PROBE_TIMEOUT_MS;
    this.#adapter = new OpenCodeAdapter({ client, timeoutMs: this.#operationTimeoutMs });
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
    const eventMonitor = await this.#startEventMonitor();
    try {
      // Every later stage needs the first session, so a creation failure ends the scenario.
      this.#onProgress("session.initial.create.start");
      const first = await this.#adapter.createSession({
        directory: environment.repository,
        model: LIVE_MODEL,
      });
      this.#sessionIDs.push(first.id);
      this.#onProgress("session.initial.create.complete");

      // Later independent stages still run after a failed stage, so one run yields evidence for
      // every predicate; a failed stage only leaves its own evidence absent (FAIL).
      const initialCompleted = await this.#stage("session.initial.prompt", async () => {
        const stream = await this.#adapter.events(first.id);
        const firstExecutionEvent = (async () => {
          try {
            for await (const item of stream) {
              const event = sessionStreamEvent(item);
              if (event !== undefined && isStructuredExecutionEvent(event)) return true;
            }
            return false;
          } finally {
            await stream.return(undefined);
          }
        })();
        const promptSubmission = this.#adapter.prompt(first.id, initialPrompt(nonce));
        const [observedStructuredEvent, admitted] = await settlePairedOperations(
          "initial structured-event observation",
          firstExecutionEvent,
          "initial prompt submission",
          promptSubmission,
        );
        structuredEventObserved = observedStructuredEvent;
        admittedInputID = admitted.id;
        await this.#adapter.waitUntilIdle(first.id, { afterInputID: admittedInputID });
        const correlatedResponse = correlatedAssistantResponse(
          await this.#adapter.messages(first.id),
          admittedInputID,
        );
        finalResponse = correlatedResponse.text;
        responseInputID = correlatedResponse.inputID;
      });
      // Stages can fail without throwing (for example a cancellation returning false), so the
      // first session is settled after every stage; settling an idle session is one status read.
      if (!initialCompleted) this.#onProgress("session.initial.prompt.not-completed");
      await this.#settleSession(first.id);

      await this.#stage("permission", async () => {
        permissionRequestID = await this.#exercisePermission(eventMonitor, first.id, environment.outside);
      });
      await this.#settleSession(first.id);

      await this.#stage("cancellation", async () => {
        cancellationResult = await this.#exerciseCancellation(first.id, environment.repository);
        if (!cancellationResult) this.#onProgress("cancellation.not-passed");
      });
      await this.#settleSession(first.id);

      // Isolation is meaningful only if the first session actually received the nonce.
      if (admittedInputID === "") {
        this.#onProgress("isolation.skipped");
      } else {
        await this.#stage("isolation", async () => {
          const isolationTransition = await createIsolationSessionAfterDeletion(
            this.#adapter,
            first.id,
            environment.repository,
          );
          this.#deletedSessionIDs.push(isolationTransition.deletedSessionID);
          const second = { id: isolationTransition.id };
          this.#sessionIDs.push(second.id);
          const isolationInput = await this.#adapter.prompt(second.id, ISOLATION_PROMPT);
          await this.#adapter.waitUntilIdle(second.id, { afterInputID: isolationInput.id });
          isolationResponse = correlatedAssistantResponse(
            await this.#adapter.messages(second.id),
            isolationInput.id,
          ).text;
        });
      }
    } finally {
      await eventMonitor.stop();
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
    // Only a model-produced file read through the confined-path check is project-directory evidence.
    const helloContent = await readConfinedRegularFile(environment.repository, helloPath).catch(
      () => undefined,
    );
    return {
      sessionIDs: this.#sessionIDs,
      projectPaths: helloContent === undefined ? [] : [environment.repository, helloPath],
      finalResponse,
      admittedInputID,
      responseInputID,
      structuredEventObserved,
      ...(permissionRequestID === undefined ? {} : { permissionRequestID }),
      helloContent: helloContent ?? "",
      cancellationPassed: cancellationResult,
      deletedSessionIDs: this.#deletedSessionIDs,
      isolationResponse,
      nonce,
    };
  }

  /**
   * Runs one scenario stage, recording failure instead of aborting. The journal names the failing
   * adapter operation and whether it timed out, never error text, so it stays credential-safe.
   */
  async #stage(name: string, body: () => Promise<void>): Promise<boolean> {
    this.#onProgress(`${name}.start`);
    try {
      await body();
      this.#onProgress(`${name}.complete`);
      return true;
    } catch (error) {
      const adapterError = findAdapterError(error);
      const cause = adapterError === undefined
        ? "error"
        : `${adapterError.diagnostic.operation.replaceAll(" ", "-")}${adapterError.diagnostic.timedOut === true ? ".timeout" : ""}`;
      this.#onProgress(`${name}.failed.${cause}`);
      return false;
    }
  }

  /** Best-effort: stop any run a failed stage left active so the next stage starts from idle. */
  async #settleSession(sessionID: string): Promise<void> {
    try {
      if (await this.#adapter.isActive(sessionID)) {
        await this.#adapter.interrupt(sessionID);
        await this.#adapter.waitUntilIdle(sessionID);
      }
    } catch {
      this.#onProgress("session.settle.failed");
    }
  }

  /** The run-long monitor of this driver's own sessions (see `startEventMonitor`). */
  #startEventMonitor(): Promise<EventMonitor> {
    return startEventMonitor({
      adapter: this.#adapter,
      isOwnSession: (sessionID) => this.#sessionIDs.includes(sessionID),
      subscriptionTimeoutMs: LIVE_PROBE_RUN_TIMEOUT_MS,
      onProgress: this.#onProgress,
    });
  }

  async #exercisePermission(
    monitor: EventMonitor,
    sessionID: string,
    outside: string,
  ): Promise<string | undefined> {
    const created = await this.#adapter.createPermission({
      sessionID,
      action: "external_directory",
      resources: [outside],
      agent: "build",
    });
    // Rejects anything but a real pending `ask`.
    correlatePermissionEvidence({ id: created.id }, created);
    // The event may have been recorded before `create` returned; only this session's event with
    // exactly the created request ID is accepted.
    const observation = await monitor.waitForPermissionAsked(sessionID, created.id, this.#operationTimeoutMs);
    if (observation !== "observed") {
      this.#onProgress(`permission.not-observed.${observation}`);
      return undefined;
    }
    await this.#adapter.replyPermission(sessionID, created.id, "once");
    return created.id;
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
    const events: ProbeEvent[] = [];
    // The stream is read with explicit next() calls: leaving a for-await loop early would
    // close it before the post-interrupt terminal event could be observed.
    const nextEvent = async (): Promise<ProbeEvent | undefined> => {
      for (;;) {
        const item = await stream.next();
        if (item.done === true) return undefined;
        const probeEvent = durableProbeEvent(item.value, sessionID);
        if (probeEvent === undefined) continue;
        events.push(probeEvent);
        return probeEvent;
      }
    };
    try {
      await this.#adapter.prompt(sessionID, cancellationPrompt(fixtureToken));
      let callID: string | undefined;
      try {
        for (let event = await nextEvent(); event !== undefined; event = await nextEvent()) {
          callID = fixtureToolCallID(event, fixtureToken);
          if (callID !== undefined) break;
        }
      } catch {
        return false;
      }
      if (callID === undefined) return false;
      const fixtureCallID = callID;
      pid = await waitForFixturePID(pidPath, 5_000);
      if (pid === 0) return false;
      const lastSequenceReadBeforeInterrupt = Math.max(...events.map(({ sequence }) => sequence));
      const interruptRequestedAt = Date.now();
      await this.#adapter.interrupt(sessionID);
      const observeTerminalToolEvent = (async () => {
        for (let event = await nextEvent(); event !== undefined; event = await nextEvent()) {
          if (
            isToolEventFor(event, "session.next.tool.failed", fixtureCallID) ||
            isToolEventFor(event, "session.next.tool.success", fixtureCallID)
          ) {
            return;
          }
        }
      })();
      // Idle is confirmed only after the interrupted tool's terminal event, so the session
      // cannot be observed as inactive before the interrupt has taken effect.
      await settlePairedOperations(
        "cancellation event observation",
        observeTerminalToolEvent,
        "cancellation idle wait",
        observeTerminalToolEvent.then(() => this.#adapter.waitUntilIdle(sessionID)),
      );
      const fixtureTerminated = await waitForProcessExit(pid, 5_000);
      const completed = await readFile(completedPath, "utf8").then(() => true).catch(() => false);
      return cancellationFromObservedEvents(
        events,
        fixtureCallID,
        lastSequenceReadBeforeInterrupt,
        interruptRequestedAt,
        fixtureTerminated,
        completed,
      );
    } finally {
      await stream.return(undefined);
      await terminateValidatedFixture(pid, fixtureToken);
    }
  }

  async close(): Promise<void> {
    await this.#closeServer();
  }
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
    await hosted.close();
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
