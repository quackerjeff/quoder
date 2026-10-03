import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { OpenCodeAdapter, finalAssistantResponseText } from "./opencode-adapter.js";
import {
  LIVE_MODEL,
  createDisposableEnvironment,
  removeDisposableEnvironment,
  type LiveProbeEnvironment,
} from "./live-probe.js";
import {
  basicAuthorizationHeader,
  launchAuthenticatedOpenCodeServer,
  type AuthenticatedServerLaunch,
} from "./opencode-server.js";
import { opencodeExecutablePath, packagePath } from "./package-root.js";

const execFileAsync = promisify(execFile);

export const ENVIRONMENT_DISCOVERY_TIMEOUT_MS = 10_000;
export const ENVIRONMENT_INFERENCE_TIMEOUT_MS = 60_000;
export const ENVIRONMENT_RUN_TIMEOUT_MS = 180_000;

export const ENVIRONMENT_ROW_NAMES = [
  "Pinned dependencies",
  "Provider configuration",
  "Endpoint reachability",
  "Model discovery",
  "Direct inference",
  "OpenCode model discovery",
  "OpenCode inference",
  "Cleanup",
] as const;

export type EnvironmentRowName = (typeof ENVIRONMENT_ROW_NAMES)[number];
export type EnvironmentRowStatus = "PASS" | "FAIL";

export interface EnvironmentRow {
  readonly name: EnvironmentRowName;
  readonly status: EnvironmentRowStatus;
  readonly evidence: string;
}

export interface ProviderConfiguration {
  readonly baseURL: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly configuredModels: ReadonlySet<string>;
}

export interface ModelDiscovery {
  readonly modelIDs: ReadonlySet<string>;
}

export interface EnvironmentPreflightDependencies {
  verifyPinnedDependencies(signal: AbortSignal): Promise<void>;
  loadProviderConfiguration(signal: AbortSignal): Promise<ProviderConfiguration>;
  discoverModels(
    configuration: ProviderConfiguration,
    signal: AbortSignal,
  ): Promise<ModelDiscovery>;
  runDirectInference(
    configuration: ProviderConfiguration,
    signal: AbortSignal,
  ): Promise<void>;
  discoverOpenCodeModel(signal: AbortSignal): Promise<void>;
  runOpenCodeInference(signal: AbortSignal, ownership: OperationOwnership): Promise<void>;
  cleanup(signal: AbortSignal): Promise<void>;
}

export interface EnvironmentPreflightOutcome {
  readonly rows: readonly EnvironmentRow[];
  readonly readiness: "PASS" | "FAIL";
  readonly output: string;
  readonly exitCode: 0 | 1;
}

export interface EnvironmentPreflightOptions {
  readonly discoveryTimeoutMs?: number;
  readonly inferenceTimeoutMs?: number;
  readonly runTimeoutMs?: number;
}

class PreflightFailure extends Error {}
class DeadlineExceeded extends Error {
  constructor(readonly handoffIncomplete: boolean) {
    super("deadline exceeded");
  }
}

export interface OperationOwnership {
  /**
   * Must be called synchronously when an operation acquires a disposable resource.
   * False means the deadline gate is closed; the caller must release the resource
   * itself and must not publish it to the preflight's cleanup state.
   */
  accept(): boolean;
}

const safeEvidence = {
  pass: "verified",
  failed: "check failed; sensitive diagnostics suppressed",
  skipped: "prerequisite check failed",
  timeout: "finite deadline exceeded",
} as const;

const positiveFinite = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
};

const bounded = async <Value>(
  operation: (signal: AbortSignal, ownership: OperationOwnership) => Promise<Value>,
  parent: AbortSignal,
  timeoutMs: number,
  hardDeadline: number,
): Promise<Value> => {
  const controller = new AbortController();
  let ownershipOpen = true;
  let deadlineExceeded = false;
  const cancel = () => {
    deadlineExceeded = true;
    ownershipOpen = false;
    controller.abort();
  };
  const availableMs = Math.max(0, Math.min(timeoutMs, hardDeadline - Date.now()));
  const settlementMs = Math.min(50, Math.max(1, Math.floor(availableMs / 4)));
  const operationMs = Math.max(0, availableMs - settlementMs);
  const timer = setTimeout(cancel, operationMs);
  parent.addEventListener("abort", cancel, { once: true });
  if (parent.aborted) cancel();
  const ownership: OperationOwnership = { accept: () => ownershipOpen };
  const operationResult = Promise.resolve()
    .then(() => operation(controller.signal, ownership))
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
  try {
    const result = await Promise.race([
      operationResult,
      new Promise<undefined>((resolveTimeout) => {
        const settleTimer = setTimeout(() => resolveTimeout(undefined), availableMs);
        operationResult.finally(() => clearTimeout(settleTimer)).catch(() => undefined);
      }),
    ]);
    if (result === undefined) throw new DeadlineExceeded(true);
    if (deadlineExceeded) throw new DeadlineExceeded(false);
    if (result.status === "rejected") throw result.error;
    return result.value;
  } finally {
    ownershipOpen = false;
    clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
  }
};

const row = (
  name: EnvironmentRowName,
  status: EnvironmentRowStatus,
  evidence: string,
): EnvironmentRow => ({ name, status, evidence });

const renderEnvironmentPreflight = (
  rows: readonly EnvironmentRow[],
  readiness: "PASS" | "FAIL",
): string => [
  ...rows.map(({ name, status, evidence }) => `${name}: ${status} - ${evidence}`),
  `Environment Readiness: ${readiness}`,
].join("\n");

export async function runEnvironmentPreflight(
  dependencies: EnvironmentPreflightDependencies = createDefaultEnvironmentPreflightDependencies(),
  options: EnvironmentPreflightOptions = {},
): Promise<EnvironmentPreflightOutcome> {
  const discoveryTimeoutMs = positiveFinite(
    options.discoveryTimeoutMs ?? ENVIRONMENT_DISCOVERY_TIMEOUT_MS,
    "discoveryTimeoutMs",
  );
  const inferenceTimeoutMs = positiveFinite(
    options.inferenceTimeoutMs ?? ENVIRONMENT_INFERENCE_TIMEOUT_MS,
    "inferenceTimeoutMs",
  );
  const runTimeoutMs = positiveFinite(
    options.runTimeoutMs ?? ENVIRONMENT_RUN_TIMEOUT_MS,
    "runTimeoutMs",
  );
  const runController = new AbortController();
  const hardDeadline = Date.now() + runTimeoutMs;
  const cleanupReserveMs = Math.min(discoveryTimeoutMs, Math.max(1, Math.floor(runTimeoutMs / 4)));
  const workDeadline = hardDeadline - cleanupReserveMs;
  const runTimer = setTimeout(() => runController.abort(), runTimeoutMs);
  const rows: EnvironmentRow[] = [];
  let incompleteHandoff = false;
  let configuration: ProviderConfiguration | undefined;
  let modelDiscovery: ModelDiscovery | undefined;

  const execute = async (
    name: EnvironmentRowName,
    timeoutMs: number,
    operation: (signal: AbortSignal, ownership: OperationOwnership) => Promise<void>,
    prerequisite = true,
  ): Promise<boolean> => {
    if (!prerequisite || runController.signal.aborted) {
      rows.push(row(name, "FAIL", safeEvidence.skipped));
      return false;
    }
    try {
      await bounded(operation, runController.signal, timeoutMs, workDeadline);
      rows.push(row(name, "PASS", safeEvidence.pass));
      return true;
    } catch (error) {
      if (error instanceof DeadlineExceeded && error.handoffIncomplete) incompleteHandoff = true;
      const timedOut = runController.signal.aborted || error instanceof DeadlineExceeded;
      rows.push(row(name, "FAIL", timedOut ? safeEvidence.timeout : safeEvidence.failed));
      return false;
    }
  };

  try {
    await execute("Pinned dependencies", discoveryTimeoutMs, (signal) =>
      dependencies.verifyPinnedDependencies(signal));

    const configPassed = await execute(
      "Provider configuration",
      discoveryTimeoutMs,
      async (signal) => {
        configuration = await dependencies.loadProviderConfiguration(signal);
      },
    );

    const endpointPassed = await execute(
      "Endpoint reachability",
      discoveryTimeoutMs,
      async (signal) => {
        if (configuration === undefined) throw new PreflightFailure("missing configuration");
        modelDiscovery = await dependencies.discoverModels(configuration, signal);
      },
      configPassed,
    );

    const modelPassed = await execute(
      "Model discovery",
      discoveryTimeoutMs,
      async () => {
        if (!modelDiscovery?.modelIDs.has(LIVE_MODEL.id)) {
          throw new PreflightFailure("configured model missing");
        }
      },
      endpointPassed,
    );

    const directInferencePassed = await execute(
      "Direct inference",
      inferenceTimeoutMs,
      (signal) => {
        if (configuration === undefined) throw new PreflightFailure("missing configuration");
        return dependencies.runDirectInference(configuration, signal);
      },
      modelPassed,
    );

    const openCodeDiscoveryPassed = await execute(
      "OpenCode model discovery",
      discoveryTimeoutMs,
      (signal) => dependencies.discoverOpenCodeModel(signal),
      modelPassed,
    );

    await execute(
      "OpenCode inference",
      inferenceTimeoutMs,
      (signal, ownership) => dependencies.runOpenCodeInference(signal, ownership),
      directInferencePassed && openCodeDiscoveryPassed,
    );
  } finally {
    clearTimeout(runTimer);
    try {
      await bounded(
        (signal) => dependencies.cleanup(signal),
        new AbortController().signal,
        Math.max(1, hardDeadline - Date.now()),
        hardDeadline,
      );
      rows.push(row("Cleanup", incompleteHandoff ? "FAIL" : "PASS", incompleteHandoff ? safeEvidence.failed : safeEvidence.pass));
    } catch {
      rows.push(row("Cleanup", "FAIL", safeEvidence.failed));
    }
  }

  for (const name of ENVIRONMENT_ROW_NAMES) {
    if (!rows.some((candidate) => candidate.name === name)) {
      rows.push(row(name, "FAIL", safeEvidence.skipped));
    }
  }
  rows.sort(
    (left, right) => ENVIRONMENT_ROW_NAMES.indexOf(left.name) - ENVIRONMENT_ROW_NAMES.indexOf(right.name),
  );
  const readiness = rows.every(({ status }) => status === "PASS") ? "PASS" : "FAIL";
  return {
    rows,
    readiness,
    output: renderEnvironmentPreflight(rows, readiness),
    exitCode: readiness === "PASS" ? 0 : 1,
  };
}

const stripJsonCommentsAndTrailingCommas = (source: string): string => {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") output += "\n";
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }
  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index] ?? "";
    if (inString) {
      withoutTrailingCommas += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      withoutTrailingCommas += character;
      continue;
    }
    if (character === ",") {
      let nextIndex = index + 1;
      while (/\s/u.test(output[nextIndex] ?? "")) nextIndex += 1;
      if (output[nextIndex] === "}" || output[nextIndex] === "]") continue;
    }
    withoutTrailingCommas += character;
  }
  return withoutTrailingCommas;
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PreflightFailure("expected object");
  }
  return value as Record<string, unknown>;
};

export function parseProviderConfiguration(source: string): ProviderConfiguration {
  const root = asRecord(JSON.parse(stripJsonCommentsAndTrailingCommas(source)));
  const provider = asRecord(asRecord(root.provider).ollama);
  if (provider.npm !== "@ai-sdk/openai-compatible") {
    throw new PreflightFailure("unexpected provider implementation");
  }
  const options = asRecord(provider.options);
  if (typeof options.baseURL !== "string") throw new PreflightFailure("missing base URL");
  const baseURL = new URL(options.baseURL);
  if (baseURL.protocol !== "https:") throw new PreflightFailure("provider endpoint must use HTTPS");
  const rawHeaders = asRecord(options.headers);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new PreflightFailure("provider header must be a non-empty string");
    }
    headers[name] = value;
  }
  const models = asRecord(provider.models);
  const configuredModels = new Set(Object.keys(models));
  if (!configuredModels.has(LIVE_MODEL.id)) throw new PreflightFailure("model not configured");
  return { baseURL, headers, configuredModels };
}

const jsonResponse = async (response: Response): Promise<Record<string, unknown>> => {
  if (!response.ok) throw new PreflightFailure("request rejected");
  return asRecord(await response.json());
};

const endpointURL = (baseURL: URL, path: string): URL => {
  const normalized = baseURL.href.endsWith("/") ? baseURL : new URL(`${baseURL.href}/`);
  return new URL(path, normalized);
};

export function createDefaultEnvironmentPreflightDependencies(): EnvironmentPreflightDependencies {
  let environment: LiveProbeEnvironment | undefined;
  let server: AuthenticatedServerLaunch | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  let adapter: OpenCodeAdapter | undefined;
  let sessionID: string | undefined;
  let removeInferenceAbortListener: (() => void) | undefined;

  return {
    async verifyPinnedDependencies() {
      const manifest = asRecord(JSON.parse(await readFile(packagePath("package.json"), "utf8")));
      const dependencies = asRecord(manifest.dependencies);
      const sdkManifest = asRecord(JSON.parse(
        await readFile(packagePath("node_modules", "@opencode-ai", "sdk", "package.json"), "utf8"),
      ));
      const cliManifest = asRecord(JSON.parse(
        await readFile(packagePath("node_modules", "opencode-ai", "package.json"), "utf8"),
      ));
      if (
        dependencies["@opencode-ai/sdk"] !== "1.18.33" ||
        dependencies["opencode-ai"] !== "1.18.33" ||
        sdkManifest.version !== "1.18.33" ||
        cliManifest.version !== "1.18.33"
      ) {
        throw new PreflightFailure("dependency pins differ");
      }
    },

    async loadProviderConfiguration() {
      const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
      const candidates = [
        join(configRoot, "opencode", "opencode.jsonc"),
        join(configRoot, "opencode", "opencode.json"),
      ];
      for (const candidate of candidates) {
        const source = await readFile(candidate, "utf8").catch(() => undefined);
        if (source !== undefined) return parseProviderConfiguration(source);
      }
      throw new PreflightFailure("provider configuration absent");
    },

    async discoverModels(configuration, signal) {
      const response = await fetch(endpointURL(configuration.baseURL, "models"), {
        headers: configuration.headers,
        signal,
      });
      const body = await jsonResponse(response);
      if (!Array.isArray(body.data)) throw new PreflightFailure("invalid model response");
      const modelIDs = new Set(
        body.data.flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const id = Reflect.get(item, "id");
          return typeof id === "string" ? [id] : [];
        }),
      );
      return { modelIDs };
    },

    async runDirectInference(configuration, signal) {
      const response = await fetch(endpointURL(configuration.baseURL, "chat/completions"), {
        method: "POST",
        headers: { ...configuration.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: LIVE_MODEL.id,
          messages: [{ role: "user", content: "Reply exactly ENVIRONMENT_READY" }],
          temperature: 0,
        }),
        signal,
      });
      const body = await jsonResponse(response);
      const choices = body.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new PreflightFailure("inference response missing result");
      }
      const message = asRecord(asRecord(choices[0]).message);
      if (message.content !== "ENVIRONMENT_READY") {
        throw new PreflightFailure("inference sentinel mismatch");
      }
    },

    async discoverOpenCodeModel(signal) {
      const executable = opencodeExecutablePath();
      const result = await execFileAsync(executable, ["models", "ollama", "--pure"], {
        signal,
        maxBuffer: 1024 * 1024,
      });
      const models = result.stdout.split(/\r?\n/u);
      if (!models.includes(`${LIVE_MODEL.providerID}/${LIVE_MODEL.id}`)) {
        throw new PreflightFailure("OpenCode model missing");
      }
    },

    async runOpenCodeInference(signal, ownership) {
      environment = await createDisposableEnvironment(signal, (ownedEnvironment) => {
        if (!ownership.accept()) return false;
        environment = ownedEnvironment;
        return true;
      });
      if (signal.aborted) return;
      const password = randomBytes(32).toString("base64url");
      server = await launchAuthenticatedOpenCodeServer({
        username: "quoder",
        password,
        signal,
        acceptCloseOwnership: (close) => {
          if (!ownership.accept()) return false;
          closeServer = close;
          return true;
        },
      });
      const closeOnAbort = () => void server?.close().catch(() => undefined);
      signal.addEventListener("abort", closeOnAbort, { once: true });
      removeInferenceAbortListener = () => signal.removeEventListener("abort", closeOnAbort);
      if (signal.aborted) closeOnAbort();
      const client = createOpencodeClient({
        baseUrl: server.url,
        headers: { Authorization: basicAuthorizationHeader("quoder", password) },
      });
      adapter = new OpenCodeAdapter({ client, timeoutMs: ENVIRONMENT_INFERENCE_TIMEOUT_MS });
      const session = await adapter.createSession({
        directory: environment.repository,
        model: LIVE_MODEL,
      });
      sessionID = session.id;
      const admitted = await adapter.prompt(session.id, "Reply exactly ENVIRONMENT_READY");
      await adapter.waitUntilIdle(session.id, { afterInputID: admitted.id });
      const text = finalAssistantResponseText(await adapter.messages(session.id), admitted.id);
      if (text !== "ENVIRONMENT_READY") {
        throw new PreflightFailure("OpenCode inference sentinel mismatch");
      }
    },

    async cleanup(signal) {
      const errors: unknown[] = [];
      removeInferenceAbortListener?.();
      removeInferenceAbortListener = undefined;
      if (adapter !== undefined && sessionID !== undefined) {
        await adapter.deleteSession(sessionID).catch((error) => errors.push(error));
      }
      if (closeServer !== undefined) {
        await closeServer().catch((error) => errors.push(error));
      }
      if (environment !== undefined) {
        await removeDisposableEnvironment(environment).catch((error) => errors.push(error));
      }
      if (signal.aborted) errors.push(new DeadlineExceeded(true));
      if (errors.length > 0) throw new PreflightFailure("owned resource cleanup failed");
    },
  };
}
