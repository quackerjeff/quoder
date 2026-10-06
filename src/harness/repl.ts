import { randomBytes } from "node:crypto";
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";

import type { ModelRef, OpencodeClient } from "@opencode-ai/sdk/v2";

import { startEventMonitor, type EventMonitor, type PermissionAsked } from "../event-monitor.js";
import { OpenCodeAdapter } from "../opencode-adapter.js";
import {
  basicAuthorizationHeader,
  type AuthenticatedServerLaunch,
  type AuthenticatedServerOptions,
} from "../opencode-server.js";
import type { MarkdownRenderer } from "../ui/markdown.js";
import { PLAIN_THEME, type Theme } from "../ui/style.js";
import { HELP_TEXT, formatResult } from "./format.js";
import { CONTINUE_MARK, DISABLE_KEYBOARD_PROTOCOL, ENABLE_KEYBOARD_PROTOCOL, LineEndingKeys } from "./line-keys.js";
import { LiveView } from "./live-view.js";
import type { Project } from "./project.js";
import { SessionTracker, runPrompt, type StopRequest, type TurnOutcome } from "./session-runner.js";
import { narrowStreamEvent } from "./stream-events.js";
import { sanitizeForTerminal, sanitizeLine } from "./terminal-text.js";

export const HARNESS_OPERATION_TIMEOUT_MS = 30_000;
/** The monitor's subscription lives as long as its server; this only bounds a forgotten one. */
export const HARNESS_MONITOR_SUBSCRIPTION_MS = 24 * 60 * 60 * 1000;
const SERVER_USERNAME = "quoder";
const permissionKey = (sessionID: string, requestID: string): string => `${sessionID}\u0000${requestID}`;

const permissionDisplayText = (value: string): string =>
  sanitizeForTerminal(value).replace(/\s+/gu, " ").trim();

const wrapPermissionValue = (value: string, width: number, indent = "  "): string => {
  const words = value.split(/\s+/u);
  const lines: string[] = [];
  let line = indent;
  for (let word of words) {
    if (line.length > indent.length && line.length + word.length + 1 > width) {
      lines.push(line);
      line = indent;
    }
    while ([...word].length > width - indent.length) {
      const room = Math.max(1, width - line.length);
      line += [...word].slice(0, room).join("");
      lines.push(line);
      word = [...word].slice(room).join("");
      line = indent;
    }
    if (word !== "") line += `${line === indent ? "" : " "}${word}`;
  }
  if (line !== indent) lines.push(line);
  return lines.join("\n");
};

/** Fixed event names with session IDs and outcome kinds only; never prompt or model text. */
export type HarnessTraceEvent =
  | { readonly event: "server.started" }
  | { readonly event: "server.stopped" }
  | { readonly event: "server.lost" }
  | { readonly event: "monitor.lost" }
  | { readonly event: "session.created"; readonly sessionID: string }
  | { readonly event: "session.deleted"; readonly sessionID: string; readonly verified: boolean }
  | { readonly event: "permission.replied"; readonly sessionID: string; readonly reply: "once" | "always" | "reject"; readonly replied: boolean }
  | { readonly event: "prompt.completed"; readonly outcome: TurnOutcome["kind"]; readonly elapsedMs: number }
  | { readonly event: "prompt.started" }
  | { readonly event: "prompt.retried" }
  | { readonly event: "stream.first-text" }
  | { readonly event: "activity.tool"; readonly tool: string };

export interface HarnessDependencies {
  readonly launchServer: (options: AuthenticatedServerOptions) => Promise<AuthenticatedServerLaunch>;
  readonly createClient: (baseUrl: string, authorization: string) => OpencodeClient;
  readonly startMonitor?: typeof startEventMonitor;
  readonly operationTimeoutMs?: number;
  /** How long an admitted prompt may stay idle without a response before it counts as dropped. */
  readonly noResponseTimeoutMs?: number;
  /** Kept off until the Group 7 security review clears the prerequisite boundary. */
  readonly permissionDecisionsEnabled?: boolean;
  readonly trace?: (event: HarnessTraceEvent) => void;
}

export interface HarnessOptions {
  readonly project: Project;
  readonly model: ModelRef;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  /**
   * True for an interactive TTY: readline handles Ctrl-C, lines typed while busy are refused, and an
   * animated status line is drawn while a prompt runs.
   */
  readonly terminal: boolean;
  /** Colour theme; plain by default. */
  readonly theme?: Theme;
  /** Terminal width, read on every status-line frame. */
  readonly columns?: () => number | undefined;
  /** Renders model Markdown; the CLI passes the isolated (worker) renderer. */
  readonly renderMarkdown?: MarkdownRenderer;
}

interface ServerSession {
  readonly launch: AuthenticatedServerLaunch;
  readonly adapter: OpenCodeAdapter;
  readonly monitor: EventMonitor;
  /** Set when the monitor is lost or a rejection fails; the server is replaced before the next prompt. */
  unhealthy: boolean;
}

/**
 * The persistent Quoder harness: one OpenCode server, a fresh session per prompt, and a live view
 * of each prompt's activity (Milestone 2).
 *
 * One sequential loop consumes input lines in order. EOF, `/exit`, and signals end the loop, and
 * the loop's exit path alone runs the single, memoized shutdown, so a server is never left behind.
 */
export class Harness {
  readonly #options: HarnessOptions;
  readonly #dependencies: HarnessDependencies;
  readonly #tracker = new SessionTracker();
  readonly #permissionQueue: PermissionAsked[] = [];
  #permissionReplyInFlight: string | undefined;
  /**
   * Aborts a server launch that is still in progress when an exit is requested. Never aborted once
   * a server is up, so a running prompt's session can still be settled and deleted during shutdown.
   */
  #launchAbort: AbortController | undefined;
  readonly #lines: string[] = [];
  /** Whether the line readline is about to report ends with Shift+Return (terminal only). */
  #continueArmed = false;
  #lineContinues = false;
  /** Lines of a multi-line prompt still being typed (Shift+Return). */
  readonly #pendingLines: string[] = [];
  #rawMode = false;
  /** Restores the terminal's keyboard mode if the process exits without the orderly shutdown. */
  #keyboardExitHook: (() => void) | undefined;
  readonly #undeletedSessions: string[] = [];
  /** Server problems found while a prompt runs, shown after that prompt's result. */
  readonly #notices: string[] = [];
  #wakeLoop: (() => void) | undefined;
  #readline: Interface | undefined;
  #server: ServerSession | undefined;
  #startingServer: Promise<ServerSession> | undefined;
  #running: AbortController | undefined;
  /** The running prompt's live display. */
  #view: LiveView | undefined;
  #inputClosed = false;
  #exitCode: number | undefined;
  #finished: Promise<number> | undefined;
  #shutdown: Promise<number> | undefined;

  constructor(options: HarnessOptions, dependencies: HarnessDependencies) {
    this.#options = options;
    this.#dependencies = dependencies;
  }

  /** Runs until the developer exits; resolves with the process exit code. */
  run(): Promise<number> {
    this.#finished ??= this.#main().catch(() => this.#shutdownOnce(1));
    return this.#finished;
  }

  /** Ctrl-C: cancel the running prompt, or leave Quoder when idle or still starting. */
  interrupt(): void {
    if (this.#running !== undefined) {
      if (this.#running.signal.aborted) {
        this.#notice("Still cleaning up the cancelled prompt…\n");
      } else {
        if (this.#view === undefined) this.#write("\nCancelling OpenCode execution…\n");
        else this.#view.cancelling();
        this.#permissionQueue.length = 0;
        this.#running.abort();
      }
      return;
    }
    if (this.#pendingLines.length > 0) {
      this.#discardPendingPrompt();
      return;
    }
    this.#requestExit(0);
  }

  /** Ctrl-C while typing a multi-line prompt discards it and starts again, as a shell does. */
  #discardPendingPrompt(): void {
    this.#pendingLines.length = 0;
    const readline = this.#readline;
    if (readline === undefined) return;
    readline.write(null, { ctrl: true, name: "e" });
    readline.write(null, { ctrl: true, name: "u" });
    this.#write("\n");
    readline.setPrompt(this.#mainPrompt);
    readline.prompt();
  }

  get #mainPrompt(): string {
    return `${this.#theme.paint("prompt", sanitizeLine(this.#options.project.name))} ${this.#theme.paint("accent", "❯")} `;
  }

  /** Aligns the continuation marker under the prompt's `❯`. */
  get #continuationPrompt(): string {
    const projectName = sanitizeLine(this.#options.project.name);
    return `${" ".repeat([...projectName].length)} ${this.#theme.paint("dim", "…")} `;
  }

  /** SIGTERM or SIGHUP: cancel any running prompt, clean up, and exit with `exitCode`. */
  terminate(exitCode: number): void {
    this.#running?.abort();
    this.#requestExit(exitCode);
  }

  #requestExit(exitCode: number): void {
    this.#exitCode ??= exitCode;
    this.#lines.length = 0;
    this.#launchAbort?.abort();
    this.#wakeLoop?.();
  }

  async #main(): Promise<number> {
    const { project, model } = this.#options;
    const theme = this.#theme;
    const projectName = sanitizeLine(project.name);
    const projectRoot = sanitizeLine(project.root);
    this.#write(
      `${theme.paint("prompt", "Quoder")} ${theme.paint("dim", "·")} ${theme.paint("strong", projectName)} ${theme.paint("dim", projectRoot)}\n` +
        `${theme.paint("dim", "Model")} ${theme.paint("accent", `${model.providerID}/${model.id}`)}\n` +
        `${theme.paint("dim", "Starting OpenCode server…")}\n`,
    );
    try {
      await this.#ensureServer();
    } catch {
      if (this.#exitCode !== undefined) return this.#shutdownOnce(this.#exitCode);
      this.#write(`${theme.paint("error", "Could not start the OpenCode server.")} Run \`npm run verify:environment\` in Quoder to diagnose.\n`);
      return this.#shutdownOnce(1);
    }
    if (this.#exitCode !== undefined) return this.#shutdownOnce(this.#exitCode);
    // Do not claim the sandbox here. OpenCode 1.18.33 has two Bash implementations: one uses the
    // configured `shell` verbatim, the other passes it through `Shell.preferred()`, which only
    // accepts recognised shell names and otherwise silently falls back to the default shell.
    // Quoder's trampoline is not a recognised name, so the boundary does not hold on that path.
    // Until the trampoline is accepted by both, stating "sandboxed" would be a false assurance.
    this.#write(
      `${theme.paint("error", "Model-run tool sandbox is NOT verified on this path.")} ${theme.paint("dim", "Treat model-run commands as unconfined; see decisions.md.")}\n`,
    );
    this.#write(`${theme.paint("success", "Ready.")} ${theme.paint("dim", "Type /help for help.")}\n\n`);
    let input = this.#options.input;
    if (this.#options.terminal) {
      // Readline sees the keys through this filter, so it no longer puts the terminal in raw mode
      // itself; Quoder does, and restores it on shutdown.
      const keys = new LineEndingKeys({
        // While a prompt runs, typing is not echoed over the status line; Return explains why.
        isBusy: () => this.#running !== undefined,
        onReturnWhileBusy: () => this.#notice("Quoder is still running the previous prompt; press Ctrl-C to cancel it.\n"),
        onBusyDecisionKey: (key) => this.#onPermissionKey(key),
      });
      input = this.#options.input.pipe(keys);
      // Registered before readline's own keypress listener, so each Return is classified just
      // before readline turns it into a `line`.
      emitKeypressEvents(keys);
      keys.on("keypress", (sequence: string | undefined, key: { name?: string } | undefined) => {
        if (sequence === CONTINUE_MARK) {
          this.#continueArmed = true;
          return;
        }
        if (key?.name === "return" || key?.name === "enter") this.#lineContinues = this.#continueArmed;
        this.#continueArmed = false;
      });
      this.#setRawMode(true);
      this.#setKeyboardProtocol(true);
    }
    const readline = createInterface({
      input,
      output: this.#options.output,
      terminal: this.#options.terminal,
      prompt: this.#mainPrompt,
    });
    this.#readline = readline;
    readline.on("line", (line) => this.#receive(line));
    readline.on("SIGINT", () => this.interrupt());
    // Ctrl+Z would suspend Quoder with the terminal still in raw mode and the keyboard protocol on,
    // leaving the shell unusable; a listener stops readline from suspending.
    readline.on("SIGTSTP", () => undefined);
    readline.on("close", () => {
      this.#inputClosed = true;
      if (this.#running !== undefined && !this.#running.signal.aborted) {
        this.#permissionQueue.length = 0;
        this.#running.abort();
      }
      this.#wakeLoop?.();
    });
    readline.prompt();
    for (;;) {
      const line = await this.#nextLine();
      if (line === undefined || !(await this.#handle(line)) || this.#exitCode !== undefined) break;
      if (this.#lines.length === 0 && !this.#inputClosed) readline.prompt();
    }
    return this.#shutdownOnce(this.#exitCode ?? 0);
  }

  #receive(line: string): void {
    const continues = this.#options.terminal && this.#lineContinues;
    this.#lineContinues = false;
    if (this.#exitCode !== undefined) return;
    if (this.#running !== undefined && this.#options.terminal) {
      this.#pendingLines.length = 0;
      this.#notice("Quoder is still running the previous prompt; press Ctrl-C to cancel it.\n");
      return;
    }
    if (continues) {
      this.#pendingLines.push(line);
      this.#readline?.setPrompt(this.#continuationPrompt);
      this.#readline?.prompt();
      return;
    }
    const prompt = [...this.#pendingLines.splice(0), line].join("\n");
    this.#readline?.setPrompt(this.#mainPrompt);
    this.#lines.push(prompt);
    this.#wakeLoop?.();
  }

  #onPermissionAsked(server: ServerSession | undefined, permission: PermissionAsked): void {
    if (
      this.#dependencies.permissionDecisionsEnabled === true &&
      this.#options.terminal &&
      this.#running !== undefined &&
      !this.#running.signal.aborted
    ) {
      if (!this.#permissionQueue.some((item) => permissionKey(item.sessionID, item.requestID) === permissionKey(permission.sessionID, permission.requestID))) {
        this.#permissionQueue.push(permission);
      }
      this.#renderPermissionQueue();
      return;
    }

    this.#notice(this.#options.terminal
      ? "Interactive permission decisions are disabled pending security review; Quoder is denying the request.\n"
      : "OpenCode requested permission in non-interactive mode; Quoder is denying the request.\n");
    void this.#replyToPermission(server, permission, "reject", false);
  }

  #onPermissionKey(key: "a" | "p" | "d" | "escape"): void {
    if (
      this.#dependencies.permissionDecisionsEnabled !== true ||
      !this.#options.terminal ||
      this.#permissionReplyInFlight !== undefined
    ) return;
    const permission = this.#permissionQueue[0];
    const server = this.#server;
    if (permission === undefined || server === undefined || server.unhealthy) return;

    if (key === "p" && permission.save.length === 0) {
      this.#notice("Allow for project is unavailable because OpenCode supplied no saved patterns.\n");
      this.#renderPermissionQueue();
      return;
    }
    const reply = key === "a" ? "once" : key === "p" ? "always" : "reject";
    void this.#replyToPermission(server, permission, reply, true);
  }

  async #replyToPermission(
    server: ServerSession | undefined,
    permission: PermissionAsked,
    reply: "once" | "always" | "reject",
    interactive: boolean,
  ): Promise<void> {
    const key = permissionKey(permission.sessionID, permission.requestID);
    if (interactive) this.#permissionReplyInFlight = key;
    try {
      if (server === undefined) throw new Error("server unavailable");
      await server.adapter.replyPermission(permission.sessionID, permission.requestID, reply);
      this.#removeQueuedPermission(key);
      this.#trace({ event: "permission.replied", sessionID: permission.sessionID, reply, replied: true });
      if (interactive) {
        this.#permissionReplyInFlight = undefined;
        this.#renderPermissionQueue(true);
      }
    } catch {
      this.#removeQueuedPermission(key);
      if (interactive) this.#permissionReplyInFlight = undefined;
      this.#permissionQueue.length = 0;
      this.#trace({ event: "permission.replied", sessionID: permission.sessionID, reply, replied: false });
      this.#markUnhealthy(server, "Quoder could not confirm OpenCode's permission decision.");
    }
  }

  #removeQueuedPermission(key: string): void {
    const index = this.#permissionQueue.findIndex((item) => permissionKey(item.sessionID, item.requestID) === key);
    if (index >= 0) this.#permissionQueue.splice(index, 1);
  }

  #renderPermissionQueue(replySent = false): void {
    const view = this.#view;
    if (view === undefined) return;
    const permission = this.#permissionQueue[0];
    if (permission === undefined) {
      if (replySent) view.note("Permission reply sent to OpenCode.\n");
      return;
    }
    const width = Math.max(24, (this.#options.columns?.() ?? 80) - 2);
    const action = permission.action === undefined ? "unknown" : sanitizeLine(permission.action, 120);
    const resources = permission.resources.length === 0
      ? "  (none reported)"
      : permission.resources.map((resource) => wrapPermissionValue(permissionDisplayText(resource), width)).join("\n");
    const saved = permission.save.length === 0
      ? "  (unavailable: no saved patterns)"
      : permission.save.map((pattern) => wrapPermissionValue(permissionDisplayText(pattern), width)).join("\n");
    const projectChoice = permission.save.length === 0
      ? "[P] Allow for project (unavailable)"
      : "[P] Allow for project";
    const text = [
      `OpenCode requests permission (${1} of ${this.#permissionQueue.length})`,
      `Action: ${action}`,
      "Requested resources:",
      resources,
      "Allow for project would also allow:",
      saved,
      `[A] Allow once  ${projectChoice}  [D] Deny  [Esc] Deny`,
      "",
    ].join("\n");
    view.note(text);
  }

  /** Asks the terminal to report Shift+Return distinctly (see `line-keys.ts`), and undoes it. */
  #setKeyboardProtocol(enabled: boolean): void {
    if (enabled === (this.#keyboardExitHook !== undefined)) return;
    if (enabled) {
      const output = this.#options.output;
      this.#keyboardExitHook = () => output.write(DISABLE_KEYBOARD_PROTOCOL);
      process.once("exit", this.#keyboardExitHook);
      this.#write(ENABLE_KEYBOARD_PROTOCOL);
      return;
    }
    const hook = this.#keyboardExitHook;
    if (hook !== undefined) process.removeListener("exit", hook);
    this.#keyboardExitHook = undefined;
    this.#write(DISABLE_KEYBOARD_PROTOCOL);
  }

  #setRawMode(enabled: boolean): void {
    const input = this.#options.input as Partial<{ isTTY: boolean; setRawMode: (mode: boolean) => unknown }>;
    if (input.isTTY !== true || typeof input.setRawMode !== "function" || this.#rawMode === enabled) return;
    input.setRawMode(enabled);
    this.#rawMode = enabled;
  }

  /** The next input line, or undefined once input has ended or an exit was requested. */
  async #nextLine(): Promise<string | undefined> {
    for (;;) {
      if (this.#exitCode !== undefined) return undefined;
      const line = this.#lines.shift();
      if (line !== undefined) return line;
      if (this.#inputClosed) return undefined;
      await new Promise<void>((resolveWake) => {
        this.#wakeLoop = resolveWake;
      });
      this.#wakeLoop = undefined;
    }
  }

  /** Handles one line; false means the developer asked to leave. */
  async #handle(line: string): Promise<boolean> {
    const input = line.trim();
    if (input === "") return true;
    if (input === "/exit") return false;
    if (input === "/help") {
      this.#write(`${HELP_TEXT}\n\n`);
      return true;
    }
    if (input.startsWith("/")) {
      this.#write("Unknown command. Type /help for the commands Quoder supports.\n\n");
      return true;
    }
    await this.#runPrompt(input);
    return true;
  }

  async #runPrompt(prompt: string): Promise<void> {
    const controller = new AbortController();
    this.#running = controller;
    const theme = this.#theme;
    this.#write(`${theme.paint("dim", "Starting fresh OpenCode session…")}\n`);
    const view = new LiveView({
      theme,
      write: (text) => this.#write(text),
      root: this.#options.project.root,
      modelLabel: this.#options.model.id,
      statusLine: this.#options.terminal,
      ...(this.#options.columns === undefined ? {} : { columns: this.#options.columns }),
      ...(this.#options.renderMarkdown === undefined ? {} : { render: this.#options.renderMarkdown }),
      onFirstText: () => this.#trace({ event: "stream.first-text" }),
      onToolFinished: (tool) => this.#trace({ event: "activity.tool", tool }),
    });
    this.#view = view;
    this.#trace({ event: "prompt.started" });
    try {
      let server: ServerSession;
      try {
        server = await this.#ensureServer();
      } catch {
        view.finish();
        this.#write(`${theme.paint("error", "Could not start the OpenCode server; the prompt was not run.")}\n\n`);
        return;
      }
      const result = await runPrompt({
        adapter: server.adapter,
        tracker: this.#tracker,
        directory: this.#options.project.root,
        model: this.#options.model,
        prompt,
        cancel: controller.signal,
        ...(this.#dependencies.noResponseTimeoutMs === undefined ? {} : { noResponseTimeoutMs: this.#dependencies.noResponseTimeoutMs }),
        onRetry: () => {
          this.#trace({ event: "prompt.retried" });
          view.note(`${theme.paint("dim", "OpenCode did not start on the prompt; sending it again in a fresh session…")}\n`);
        },
        onSessionCreated: (sessionID) => {
          view.setSession(sessionID);
          this.#trace({ event: "session.created", sessionID });
        },
        onSessionDeleted: (sessionID, verified) => this.#trace({ event: "session.deleted", sessionID, verified }),
      });
      if (result.sessionID !== undefined && !result.sessionDeleted) this.#undeletedSessions.push(result.sessionID);
      this.#trace({ event: "prompt.completed", outcome: result.outcome.kind, elapsedMs: result.elapsedMs });
      const stats = view.finish(result);
      this.#write(`\n${formatResult(result, theme, stats)}\n`);
      for (const notice of this.#notices.splice(0)) {
        const alreadyShown = result.outcome.kind === "failed" && result.outcome.reason.startsWith(notice);
        if (!alreadyShown) this.#write(`${theme.paint("warning", `Note: ${notice} A new OpenCode server will start with your next prompt.`)}\n\n`);
      }
    } finally {
      view.finish();
      this.#view = undefined;
      this.#running = undefined;
    }
  }

  /** Stops the running prompt for a harness reason; the outcome reports `message`. */
  #stopRunning(message: string): void {
    if (this.#running === undefined || this.#running.signal.aborted) return;
    const reason: StopRequest = { stopped: message };
    this.#running.abort(reason);
  }

  async #ensureServer(): Promise<ServerSession> {
    const current = this.#server;
    if (current !== undefined && !current.unhealthy) return current;
    if (current !== undefined) await this.#retire(current);
    this.#startingServer ??= this.#launchServer().finally(() => {
      this.#startingServer = undefined;
    });
    return this.#startingServer;
  }

  async #launchServer(): Promise<ServerSession> {
    if (this.#exitCode !== undefined) throw new Error("Quoder is shutting down");
    const password = randomBytes(32).toString("base64url");
    const launchAbort = new AbortController();
    this.#launchAbort = launchAbort;
    let launch: AuthenticatedServerLaunch;
    try {
      launch = await this.#dependencies.launchServer({
        username: SERVER_USERNAME,
        password,
        cwd: this.#options.project.root,
        signal: launchAbort.signal,
      });
    } finally {
      if (this.#launchAbort === launchAbort) this.#launchAbort = undefined;
    }
    let server: ServerSession | undefined;
    try {
      const client = this.#dependencies.createClient(launch.url, basicAuthorizationHeader(SERVER_USERNAME, password));
      const adapter = new OpenCodeAdapter({
        client,
        timeoutMs: this.#dependencies.operationTimeoutMs ?? HARNESS_OPERATION_TIMEOUT_MS,
      });
      const monitor = await (this.#dependencies.startMonitor ?? startEventMonitor)({
        adapter,
        isOwnSession: (sessionID) => this.#tracker.owns(sessionID),
        subscriptionTimeoutMs: HARNESS_MONITOR_SUBSCRIPTION_MS,
        onSessionEvent: (raw) => {
          const event = narrowStreamEvent(raw);
          if (event !== undefined) this.#view?.handle(event);
        },
        onSessionRegistered: (sessionID, parentID) => {
          if (parentID !== undefined) this.#tracker.registerChild(sessionID, parentID);
        },
        onQuestionAsked: (question) => this.#tracker.noteQuestion(question),
        onQuestionRejected: (_question, rejected) => {
          if (!rejected) this.#markUnhealthy(server, "Quoder could not reject the model's question.");
        },
        onPermissionAsked: (permission) => {
          this.#tracker.notePermission(permission);
          this.#onPermissionAsked(server, permission);
        },
        onPermissionReplied: (sessionID, requestID) => {
          const key = permissionKey(sessionID, requestID);
          if (key === this.#permissionReplyInFlight) return;
          const previousLength = this.#permissionQueue.length;
          this.#removeQueuedPermission(key);
          if (this.#permissionQueue.length !== previousLength) {
            if (this.#permissionQueue.length === 0) this.#view?.note("OpenCode resolved the permission request before Quoder replied.\n");
            else this.#renderPermissionQueue();
          }
        },
        onEnded: () => {
          this.#trace({ event: "monitor.lost" });
          this.#markUnhealthy(server, "Quoder lost its connection to OpenCode's events.");
        },
      });
      if (!monitor.confirmed) {
        await monitor.stop();
        throw new Error("OpenCode did not confirm the event subscription");
      }
      server = { launch, adapter, monitor, unhealthy: false };
      if (this.#exitCode !== undefined) {
        await monitor.stop();
        throw new Error("Quoder is shutting down");
      }
      this.#server = server;
      this.#trace({ event: "server.started" });
      const launched = server;
      void launch.exited?.then(() => this.#onServerExit(launched));
      await this.#retryUndeletedSessions(launched);
      return launched;
    } catch (error) {
      await this.#closeLaunch(launch);
      throw error;
    }
  }

  /**
   * The server can no longer be trusted to resolve requests for us: replace it before the next
   * prompt. The developer is always told — through the stopped prompt's outcome, or directly.
   */
  #markUnhealthy(server: ServerSession | undefined, problem: string): void {
    if (server === undefined || this.#server !== server || server.unhealthy) return;
    server.unhealthy = true;
    if (this.#running !== undefined) {
      // The turn may already be classified, so the notice is also queued for after its result.
      this.#notices.push(problem);
      this.#stopRunning(`${problem} The prompt was stopped.`);
    } else {
      this.#notifyIdle(`\n${problem} A new OpenCode server will start with your next prompt.\n`);
    }
  }

  #onServerExit(server: ServerSession): void {
    if (this.#server !== server) return;
    this.#server = undefined;
    void server.monitor.stop().catch(() => undefined);
    if (this.#shutdown !== undefined) return;
    this.#trace({ event: "server.lost" });
    // A server already marked unhealthy (usually its event stream dropped first) was reported then.
    if (server.unhealthy) return;
    if (this.#running !== undefined) {
      this.#stopRunning("The OpenCode server stopped unexpectedly, so the prompt was stopped.");
    } else {
      this.#notifyIdle("\nThe OpenCode server stopped unexpectedly; a new one will start with your next prompt.\n");
    }
  }

  /** Closes a server that is no longer trustworthy. */
  async #retire(server: ServerSession): Promise<void> {
    if (this.#server === server) this.#server = undefined;
    await server.monitor.stop().catch(() => undefined);
    await this.#closeLaunch(server.launch);
  }

  /** Closes a server, reporting (never swallowing) a termination that could not be confirmed. */
  async #closeLaunch(launch: AuthenticatedServerLaunch): Promise<boolean> {
    try {
      await launch.close();
      return true;
    } catch {
      this.#notice(`${this.#theme.paint("error", "Warning: an OpenCode server did not confirm termination.")}\n`);
      return false;
    }
  }

  /** Sessions whose deletion could not be verified (for example after a server loss) are retried. */
  async #retryUndeletedSessions(server: ServerSession): Promise<void> {
    const pending = this.#undeletedSessions.splice(0);
    if (pending.length === 0) return;
    let deleted = 0;
    for (const sessionID of pending) {
      try {
        await server.adapter.deleteSession(sessionID);
        deleted++;
        this.#trace({ event: "session.deleted", sessionID, verified: true });
      } catch {
        this.#undeletedSessions.push(sessionID);
      }
    }
    if (deleted > 0) this.#notice(`Deleted ${deleted} earlier OpenCode session(s) that could not be verified before.\n`);
  }

  #shutdownOnce(exitCode: number): Promise<number> {
    this.#shutdown ??= this.#performShutdown(exitCode);
    return this.#shutdown;
  }

  async #performShutdown(exitCode: number): Promise<number> {
    this.#launchAbort?.abort();
    this.#readline?.close();
    this.#setKeyboardProtocol(false);
    this.#setRawMode(false);
    await this.#startingServer?.catch(() => undefined);
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined && !server.unhealthy) await this.#retryUndeletedSessions(server);
    if (this.#undeletedSessions.length > 0) {
      this.#write(`Warning: ${this.#undeletedSessions.length} OpenCode session(s) could not be verified as deleted.\n`);
    }
    if (server === undefined) return exitCode;
    await server.monitor.stop().catch(() => undefined);
    if (!(await this.#closeLaunch(server.launch))) return exitCode === 0 ? 1 : exitCode;
    this.#trace({ event: "server.stopped" });
    return exitCode;
  }

  get #theme(): Theme {
    return this.#options.theme ?? PLAIN_THEME;
  }

  /** Output that may appear while a prompt runs: through the live view, so its status line is erased first. */
  #notice(text: string): void {
    if (this.#view === undefined) this.#write(text);
    else this.#view.note(text);
  }

  #write(text: string): void {
    this.#options.output.write(text);
  }

  /** A notice while no prompt runs; in a terminal the prompt label is drawn again after it. */
  #notifyIdle(text: string): void {
    this.#write(text);
    if (this.#options.terminal && this.#running === undefined && this.#shutdown === undefined) this.#readline?.prompt(true);
  }

  #trace(event: HarnessTraceEvent): void {
    try {
      this.#dependencies.trace?.(event);
    } catch {
      // Tracing is diagnostic only and must never affect the session lifecycle.
    }
  }
}
