import { spawn } from "node:child_process";

import { opencodeExecutablePath } from "./package-root.js";
import { assertNoProjectOpenCodePlugins } from "./opencode-project-policy.js";
import { prepareToolSandbox, type ToolSandbox } from "./opencode-tool-sandbox.js";
import { assertSandboxedRuntimeConfig } from "./opencode-sandbox-assertion.js";

/**
 * The authenticated, project-local OpenCode server and the bounded lifecycle of the child process
 * Quoder owns. Shared by the Milestone 0 probe, the environment preflight, and the harness.
 */

export interface AuthenticatedServerLaunch {
  readonly url: string;
  close(): Promise<void>;
  /** Settles when the owned server child exits for any reason, including unexpectedly. */
  readonly exited?: Promise<void>;
}

export interface OwnedChildProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): this;
  removeListener(event: "exit", listener: () => void): this;
}

export const SERVER_TERMINATION_TIMEOUT_MS = 2_000;

const shellEnvironmentPluginURL = new URL("./opencode-shell-env-plugin.js", import.meta.url).href;

function configContentWithShellEnvironmentPlugin(env: NodeJS.ProcessEnv): string {
  let config: Record<string, unknown> = {};
  const existing = env.OPENCODE_CONFIG_CONTENT;
  if (existing !== undefined) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      config = parsed as Record<string, unknown>;
    } catch {
      // Do not echo inline config: it may contain provider credentials.
      throw new Error("OpenCode OPENCODE_CONFIG_CONTENT must be a JSON object for Quoder to add its shell security hook");
    }
  }

  const configuredPlugins = config.plugin ?? [];
  if (!Array.isArray(configuredPlugins) || configuredPlugins.some((plugin) => typeof plugin !== "string")) {
    throw new Error("OpenCode OPENCODE_CONFIG_CONTENT has an invalid plugin list");
  }
  return JSON.stringify({
    ...config,
    // OpenCode applies OPENCODE_CONFIG_CONTENT after the user and project config layers, so this
    // plugin is registered after other configured plugins. Core V2 Bash 1.18.33 does not invoke
    // shell.env hooks; this registration is not a credential-isolation boundary for that tool.
    plugin: [...configuredPlugins, shellEnvironmentPluginURL],
  });
}

const waitForOwnedChildExit = async (
  child: OwnedChildProcess,
  timeoutMs: number,
): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolveExit) => {
    const exited = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", exited);
      resolveExit(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    child.once("exit", exited);
  });
};

export async function terminateOwnedChild(
  child: OwnedChildProcess,
  timeoutMs = SERVER_TERMINATION_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForOwnedChildExit(child, timeoutMs)) return;
  child.kill("SIGKILL");
  if (await waitForOwnedChildExit(child, timeoutMs)) return;
  throw new Error("Owned OpenCode server did not terminate within the bounded shutdown policy");
}

export interface AuthenticatedServerOptions {
  readonly username: string;
  readonly password: string;
  readonly signal?: AbortSignal;
  readonly acceptCloseOwnership?: (close: () => Promise<void>) => boolean | void;
  /** The server's working directory; defaults to the caller's. The harness passes the project root. */
  readonly cwd?: string;
  /**
   * The prepared model-run tool sandbox. When present its private config directory is selected
   * with `OPENCODE_CONFIG_DIR` so Core V2 Bash resolves Quoder's sandbox trampoline as its shell.
   */
  readonly toolSandbox?: Pick<ToolSandbox, "configDirectory" | "shellCommand">;
}

export function authenticatedServerProcessConfig(options: AuthenticatedServerOptions): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
} {
  const serverEnvironment = { ...process.env };
  // OPENCODE_PURE disables external plugins, so remove it to preserve Quoder's configured plugin
  // behavior. This does not isolate credentials for Core V2 Bash in OpenCode 1.18.33.
  delete serverEnvironment.OPENCODE_PURE;
  return {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    executable: opencodeExecutablePath(),
    args: ["serve", "--hostname=127.0.0.1", "--port=0"],
    env: {
      ...serverEnvironment,
      OPENCODE_SERVER_USERNAME: options.username,
      OPENCODE_SERVER_PASSWORD: options.password,
      OPENCODE_CONFIG_CONTENT: configContentWithShellEnvironmentPlugin(process.env),
      ...(options.toolSandbox === undefined ? {} : {
        // Core V2 Bash reads `shell` from the filesystem-backed global config document, which
        // Global.make selects from OPENCODE_CONFIG_DIR. The directory is a private mirror of the
        // user's configuration, so their real settings are preserved and never modified.
        OPENCODE_CONFIG_DIR: options.toolSandbox.configDirectory,
      }),
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

export interface ServerOutputStream {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  removeListener(event: "data", listener: (chunk: Buffer) => void): this;
}

export interface AuthenticatedServerChild extends OwnedChildProcess {
  readonly stdout: ServerOutputStream;
  readonly stderr: ServerOutputStream;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface AuthenticatedServerLauncherDependencies {
  readonly spawnServer: (
    config: ReturnType<typeof authenticatedServerProcessConfig>,
  ) => AuthenticatedServerChild;
  readonly verifyAuthentication: (url: string, authorization: string) => Promise<void>;
  readonly startupTimeoutMs: number;
  readonly terminationTimeoutMs: number;
  /**
   * Registers a hook run synchronously if the Quoder process exits while the server is alive (for
   * example after an uncaught error); returns its unregistration. Defaults to `process.once("exit")`.
   */
  readonly onProcessExit?: (hook: () => void) => () => void;
}

const registerProcessExitHook = (hook: () => void): (() => void) => {
  process.once("exit", hook);
  return () => process.removeListener("exit", hook);
};

export const SERVER_STARTUP_TIMEOUT_MS = 15_000;
export const SERVER_TERMINATION_UNCONFIRMED_MESSAGE =
  "Authenticated OpenCode server termination was not confirmed after launch failure";
export const defaultAuthenticatedServerLauncherDependencies: AuthenticatedServerLauncherDependencies = {
  spawnServer: (config) => spawn(
    config.executable,
    [...config.args],
    {
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      env: config.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ),
  verifyAuthentication: (url, authorization) => verifyServerAuthentication(url, authorization),
  startupTimeoutMs: SERVER_STARTUP_TIMEOUT_MS,
  terminationTimeoutMs: SERVER_TERMINATION_TIMEOUT_MS,
};

const discardOutput = (): void => {
  // Server diagnostics are intentionally not retained because inherited configuration may be sensitive.
};

export async function launchAuthenticatedOpenCodeServer(
  options: AuthenticatedServerOptions,
  dependencies: AuthenticatedServerLauncherDependencies = defaultAuthenticatedServerLauncherDependencies,
): Promise<AuthenticatedServerLaunch> {
  assertNoProjectOpenCodePlugins(options.cwd ?? process.cwd());
  const child = dependencies.spawnServer(authenticatedServerProcessConfig(options));
  // Last resort: a Quoder process that dies without its orderly shutdown must not orphan the server.
  const unregisterExitHook = (dependencies.onProcessExit ?? registerProcessExitHook)(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  child.once("exit", unregisterExitHook);
  const exited = new Promise<void>((resolveExited) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExited();
    else child.once("exit", () => resolveExited());
  });
  let closePromise: Promise<void> | undefined;
  function closeOnAbort(): void {
    void close().catch(() => undefined);
  }
  const close = (): Promise<void> => {
    options.signal?.removeEventListener("abort", closeOnAbort);
    closePromise ??= terminateOwnedChild(child, dependencies.terminationTimeoutMs);
    return closePromise;
  };
  // Every launch failure awaits the shared close promise, so the caller never observes
  // failure while the owned child may still be alive and termination failure is never detached.
  const closeThenFail = async (failure: unknown): Promise<never> => {
    try {
      await close();
    } catch {
      throw new Error(SERVER_TERMINATION_UNCONFIRMED_MESSAGE);
    }
    throw failure;
  };
  // An 'error' event without a listener would be thrown, so this listener stays attached
  // for the child's lifetime; after startup settles it is ignored.
  let startupFailure: ((message: string) => void) | undefined;
  child.on("error", (error) => startupFailure?.(`Authenticated OpenCode server failed to start: ${error.message}`));
  child.stderr.on("data", discardOutput);
  const ownershipAccepted = options.acceptCloseOwnership?.(close);
  options.signal?.addEventListener("abort", closeOnAbort, { once: true });
  if (options.signal?.aborted) closeOnAbort();
  if (ownershipAccepted === false) {
    await closeThenFail(new Error("Authenticated OpenCode server ownership was rejected"));
  }
  const startup = await new Promise<
    { readonly status: "listening"; readonly url: string } | { readonly status: "failed"; readonly error: Error }
  >((settle) => {
    let settled = false;
    let output = "";
    const finish = (
      result: { readonly status: "listening"; readonly url: string } | { readonly status: "failed"; readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      startupFailure = undefined;
      clearTimeout(timeout);
      child.stdout.removeListener("data", onOutput);
      child.stdout.on("data", discardOutput);
      child.removeListener("exit", onExit);
      options.signal?.removeEventListener("abort", onAbort);
      settle(result);
    };
    const fail = (message: string) => finish({ status: "failed", error: new Error(message) });
    const timeout = setTimeout(
      () => fail("Timed out waiting for authenticated OpenCode server startup"),
      dependencies.startupTimeoutMs,
    );
    function onOutput(chunk: Buffer): void {
      output += chunk.toString("utf8");
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (match?.[1] === undefined) {
          fail("Authenticated OpenCode server reported an invalid listening URL");
          return;
        }
        finish({ status: "listening", url: match[1] });
        return;
      }
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      if (code !== null || signal !== null) {
        fail(`Authenticated OpenCode server exited during startup with code ${code ?? signal}`);
      }
    }
    function onAbort(): void {
      fail("Authenticated OpenCode server startup was cancelled");
    }
    startupFailure = fail;
    child.stdout.on("data", onOutput);
    child.once("exit", onExit);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
  if (startup.status === "failed") return closeThenFail(startup.error);
  try {
    await dependencies.verifyAuthentication(
      startup.url,
      basicAuthorizationHeader(options.username, options.password),
    );
  } catch (error) {
    return closeThenFail(error);
  }
  return { url: startup.url, close, exited };
}

/**
 * Reads the running server's resolved configuration. The body carries provider credentials, so it
 * is returned to the fail-closed assertion and never logged, traced, or included in an error.
 */
export async function readRuntimeOpenCodeConfig(
  url: string,
  authorization: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(new URL("/config", url), {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("OpenCode server rejected the resolved configuration request");
  return response.json();
}

export interface SandboxedServerDependencies {
  readonly launch: typeof launchAuthenticatedOpenCodeServer;
  readonly prepareSandbox: typeof prepareToolSandbox;
  readonly assertRuntimeConfig: typeof assertSandboxedRuntimeConfig;
  readonly readRuntimeConfig: (url: string, authorization: string) => Promise<unknown>;
}

export const defaultSandboxedServerDependencies: SandboxedServerDependencies = {
  launch: launchAuthenticatedOpenCodeServer,
  prepareSandbox: prepareToolSandbox,
  assertRuntimeConfig: assertSandboxedRuntimeConfig,
  readRuntimeConfig: readRuntimeOpenCodeConfig,
};

/**
 * Launches the authenticated server with the model-run tool sandbox in force.
 *
 * The sandbox is prepared before launch because Core V2 Bash resolves `shell` from the global
 * config document, and it is verified after launch because `opencode serve` does not validate
 * configuration at startup: a config that never took effect would otherwise leave model-run
 * shells unsandboxed with no error. Any failure terminates the server and removes the sandbox, so
 * Quoder never runs with a partially applied boundary.
 */
export async function launchSandboxedOpenCodeServer(
  options: Omit<AuthenticatedServerOptions, "toolSandbox">,
  dependencies: SandboxedServerDependencies = defaultSandboxedServerDependencies,
): Promise<AuthenticatedServerLaunch> {
  const sandbox = await dependencies.prepareSandbox();
  let launch: AuthenticatedServerLaunch;
  try {
    launch = await dependencies.launch({ ...options, toolSandbox: sandbox });
  } catch (error) {
    await sandbox.remove().catch(() => undefined);
    throw error;
  }

  const close = async (): Promise<void> => {
    try {
      await launch.close();
    } finally {
      await sandbox.remove().catch(() => undefined);
    }
  };

  try {
    await dependencies.assertRuntimeConfig(
      {
        readConfig: () => dependencies.readRuntimeConfig(
          launch.url,
          basicAuthorizationHeader(options.username, options.password),
        ),
      },
      { shellCommand: sandbox.shellCommand },
    );
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  return {
    url: launch.url,
    close,
    ...(launch.exited === undefined ? {} : { exited: launch.exited }),
  };
}
