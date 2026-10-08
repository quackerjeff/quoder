import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface, emitKeypressEvents, type Interface } from "node:readline";

import type { ModelRef, OpencodeClient } from "@opencode-ai/sdk/v2";

import { startEventMonitor, type EventMonitor, type PermissionAsked } from "../event-monitor.js";
import { OpenCodeAdapter, type OpenCodeAgentOption, type OpenCodeModelOption } from "../opencode-adapter.js";
import {
  basicAuthorizationHeader,
  type AuthenticatedServerLaunch,
  type AuthenticatedServerOptions,
} from "../opencode-server.js";
import type { MarkdownRenderer } from "../ui/markdown.js";
import { PLAIN_THEME, type Theme } from "../ui/style.js";
import {
  formatGitDiff,
  formatGitDiffFailure,
  formatGitDiffPage,
  formatProjectMemory,
  formatProjectMemoryFailure,
  EXECUTION_HISTORY_HELP_TEXT,
  formatExecutionHistoryFailure,
  formatLocalStateRecovery,
  formatExecutionHistoryList,
  formatExecutionHistoryRecord,
  formatModelChoices,
  formatAgentChoices,
  HELP_TEXT,
  PROJECT_MEMORY_HELP_TEXT,
  formatGitSummary,
  formatResult,
} from "./format.js";
import { captureGitDiff, hasInspectableGitDiff, type GitDiffResult } from "./git-diff.js";
import { captureGitSnapshot, compareGitSnapshots, type GitComparison, type GitSnapshotResult } from "./git-state.js";
import { buildHarnessContext, createPreviousExecutionSummary } from "./context-builder.js";
import {
  createExecutionHistoryStore,
  EXECUTION_HISTORY_ID_PATTERN,
  type ExecutionHistoryRecord,
  type ExecutionHistoryStore,
  type HistoryCommand,
  type HistoryPermissionDecision,
  type HistoryToolActivity,
} from "./execution-history.js";
import { CONTINUE_MARK, DISABLE_KEYBOARD_PROTOCOL, ENABLE_KEYBOARD_PROTOCOL, LineEndingKeys } from "./line-keys.js";
import { LiveView } from "./live-view.js";
import {
  createOwnedSessionLedger,
  type OwnedSessionLedger,
  type OwnedSessionRecord,
} from "./owned-session-ledger.js";
import type { Project } from "./project.js";
import {
  createProjectMemoryStore,
  emptyProjectMemory,
  PROJECT_MEMORY_MAX_CODE_POINTS,
  PROJECT_MEMORY_MAX_LIST_ITEMS,
  type MemoryUnavailableReason,
  type ProjectMemory,
  type ProjectMemoryStore,
} from "./project-memory.js";
import { SessionTracker, runPrompt, type StopRequest, type TurnOutcome } from "./session-runner.js";
import { resolveAgentSelection, resolveModelSelection } from "./selection.js";
import { narrowStreamEvent } from "./stream-events.js";
import { sanitizeForTerminal, sanitizeLine } from "./terminal-text.js";
import { formatOperationalFailure, type OperationalFailureCategory, type OperationalLogEvent } from "./operational-log.js";

export const HARNESS_OPERATION_TIMEOUT_MS = 30_000;
/** The monitor's subscription lives as long as its server; this only bounds a forgotten one. */
export const HARNESS_MONITOR_SUBSCRIPTION_MS = 24 * 60 * 60 * 1000;
const SERVER_USERNAME = "quoder";
type DiffKey = "v" | "n" | "p" | "q" | "enter" | "escape" | "ctrl-c" | "ctrl-d" | "exit";
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
  /**
   * Enables the interactive permission prompt. Defaults to off so non-interactive embedders and
   * tests keep the deny-by-default behaviour; `cli.ts` turns it on.
   *
   * This is deliberately not gated on model-run tool sandboxing. The permission prompt shows what
   * is about to run and lets you refuse it; it is not a containment boundary, because an approved
   * Bash command already carries full host-user authority. Credential isolation hardens the prompt
   * against self-approval but is not a precondition for having one.
   */
  readonly permissionDecisionsEnabled?: boolean;
  /** Injectable for harness tests; production uses the bounded Git snapshot implementation. */
  readonly captureGitSnapshot?: (root: string) => Promise<GitSnapshotResult>;
  /** Injectable for harness tests; production compares the captured endpoint snapshots. */
  readonly compareGitSnapshots?: typeof compareGitSnapshots;
  readonly captureGitDiff?: typeof captureGitDiff;
  readonly trace?: (event: HarnessTraceEvent) => void;
  /** Metadata-only logger; it never receives prompts, responses, tool output, or raw errors. */
  readonly operationalLog?: (event: OperationalLogEvent) => void;
  /** Injectable project-memory store factory for harness tests and embedders. */
  readonly createProjectMemoryStore?: (projectRoot: string) => ProjectMemoryStore;
  /** Injectable history store for tests and embedders; production uses Quoder's local store. */
  readonly createExecutionHistoryStore?: (project: Project) => ExecutionHistoryStore;
  /** Injectable Quoder-owned OpenCode session intent ledger. */
  readonly createOwnedSessionLedger?: (project: Project) => OwnedSessionLedger | undefined;
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
  reconciled: boolean;
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
  readonly #memoryStore: ProjectMemoryStore | undefined;
  readonly #historyStore: ExecutionHistoryStore | undefined;
  readonly #ownedSessionLedger: OwnedSessionLedger | undefined;
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
  #activeHistory: {
    readonly id: string;
    readonly startedAt: number;
    readonly permissions: HistoryPermissionDecision[];
    readonly permissionIndexes: Map<string, number>;
    readonly commands: HistoryCommand[];
    readonly toolActivity: HistoryToolActivity[];
    attempts: number;
  } | undefined;
  #wakeLoop: (() => void) | undefined;
  #readline: Interface | undefined;
  #cleanupDecisionResolve: ((confirmed: boolean) => void) | undefined;
  #server: ServerSession | undefined;
  #startingServer: Promise<ServerSession> | undefined;
  #running: AbortController | undefined;
  /** The running prompt's live display. */
  #view: LiveView | undefined;
  #inputClosed = false;
  #exitCode: number | undefined;
  #finished: Promise<number> | undefined;
  #shutdown: Promise<number> | undefined;
  #diffInteraction: "choice" | "viewer" | undefined;
  #diffKeyResolver: ((key: DiffKey) => void) | undefined;
  #memory: ProjectMemory | undefined;
  #memoryUnavailable: MemoryUnavailableReason | undefined;
  #selectedModel: ModelRef;
  #selectedAgent = "build";

  constructor(options: HarnessOptions, dependencies: HarnessDependencies) {
    this.#options = options;
    this.#dependencies = dependencies;
    this.#selectedModel = options.model;
    try {
      this.#memoryStore = (dependencies.createProjectMemoryStore ?? createProjectMemoryStore)(options.project.root);
    } catch {
      this.#memoryStore = undefined;
      this.#memoryUnavailable = "io-error";
    }
    try {
      this.#historyStore = (dependencies.createExecutionHistoryStore ?? createExecutionHistoryStore)(options.project);
    } catch {
      this.#historyStore = undefined;
    }
    this.#ownedSessionLedger = dependencies.createOwnedSessionLedger === undefined
      ? createOwnedSessionLedger(options.project.root)
      : dependencies.createOwnedSessionLedger(options.project);
  }

  /** Runs until the developer exits; resolves with the process exit code. */
  run(): Promise<number> {
    this.#finished ??= this.#main().catch(() => this.#shutdownOnce(1));
    return this.#finished;
  }

  /** Ctrl-C: cancel the running prompt, or leave Quoder when idle or still starting. */
  interrupt(): void {
    if (this.#cleanupDecisionResolve !== undefined) {
      this.#write("\nCleanup declined; the listed OpenCode session remains and no cleanup was attempted.\n");
      this.#resolveCleanupDecision(false);
      return;
    }
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
    this.#resolveCleanupDecision(false);
    this.#exitCode ??= exitCode;
    this.#lines.length = 0;
    this.#launchAbort?.abort();
    this.#diffKeyResolver?.("exit");
    this.#wakeLoop?.();
  }

  async #main(): Promise<number> {
    const { project } = this.#options;
    const theme = this.#theme;
    const projectName = sanitizeLine(project.name);
    const projectRoot = sanitizeLine(project.root);
    await this.#loadProjectMemory();
    this.#write(
      `${theme.paint("prompt", "Quoder")} ${theme.paint("dim", "·")} ${theme.paint("strong", projectName)} ${theme.paint("dim", projectRoot)}\n` +
        `${theme.paint("dim", "Model")} ${theme.paint("accent", `${this.#selectedModel.providerID}/${this.#selectedModel.id}`)}\n` +
        `${theme.paint("dim", "Agent")} ${theme.paint("accent", this.#selectedAgent)}\n` +
        `${theme.paint("dim", "Starting OpenCode server…")}\n`,
    );
    let initialServer: ServerSession;
    try {
      initialServer = await this.#ensureServer();
    } catch {
      if (this.#exitCode !== undefined) return this.#shutdownOnce(this.#exitCode);
      this.#reportFailure("OpenCode", "Could not start the OpenCode server.");
      return this.#shutdownOnce(1);
    }
    if (this.#exitCode !== undefined) return this.#shutdownOnce(this.#exitCode);
    // State the actual posture rather than claiming a boundary. Permission prompts are on, and
    // an approved Bash command carries full host-user authority: OpenCode's own advisory says
    // "Bash runs with host-user filesystem, process, and network authority". The model-run tool
    // sandbox is not in force on the Core V2 Bash path (see decisions.md), so nothing here should
    // be read as containment.
    this.#write(
      `${theme.paint("dim", "Permission prompts on")} ${theme.paint("dim", "·")} `
      + `${theme.paint("dim", "approved commands run with your full user authority; model-run tools are unconfined")}\n`,
    );
    if (this.#memory !== undefined) {
      this.#write(
        `${theme.paint("dim", "Project context memory is stored locally")} ${theme.paint("dim", "·")} `
        + `${theme.paint("dim", `automatic previous-result summary ${this.#memory.automaticSummary ? "on" : "off"}`)} ${theme.paint("dim", "·")} `
        + `${theme.paint("dim", "type /memory help for details")}\n`,
      );
    } else {
      const reason = this.#memoryUnavailable ?? "io-error";
      const guidance = formatLocalStateRecovery("Project memory", formatProjectMemoryFailure(reason));
      this.#write(`${theme.paint("warning", `${guidance} Prompts continue without memory.`)}\n`);
    }
    this.#write(`${theme.paint("dim", "Execution history is stored locally and may contain verbatim prompts, context, commands, and responses. Quoder does not redact secrets; other processes running as your user may be able to read it. Type /history help for retention and deletion controls.")}\n`);
    this.#write(`${theme.paint("success", "Ready.")} ${theme.paint("dim", "Type /help for help.")}\n\n`);
    let input = this.#options.input;
    if (this.#options.terminal) {
      // Readline sees the keys through this filter, so it no longer puts the terminal in raw mode
      // itself; Quoder does, and restores it on shutdown.
      const keys = new LineEndingKeys({
        // While a prompt runs, typing is not echoed over the status line; Return explains why.
        // A stale-session decision may be requested while a new prompt is obtaining a
        // replacement server. Route Return to the confirmation instead of the busy notice.
        isBusy: () => this.#running !== undefined && this.#cleanupDecisionResolve === undefined,
        onReturnWhileBusy: () => {
          if (this.#cleanupDecisionResolve === undefined) {
            this.#notice("Quoder is still running the previous prompt; press Ctrl-C to cancel it.\n");
          }
        },
        onBusyDecisionKey: (key) => this.#onPermissionKey(key),
        isDiffInteraction: () => this.#diffInteraction !== undefined,
        onDiffInteractionKey: (key) => this.#onDiffInteractionKey(key),
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
      this.#resolveCleanupDecision(false);
      this.#diffKeyResolver?.("exit");
      if (this.#running !== undefined && !this.#running.signal.aborted) {
        this.#permissionQueue.length = 0;
        this.#running.abort();
      }
      this.#wakeLoop?.();
    });
    try {
      await this.#reconcileOwnedSessions(initialServer);
      initialServer.reconciled = true;
    } catch {
      this.#write(`${formatLocalStateRecovery("OpenCode session ownership", "The ownership ledger is corrupt, unsafe, or unavailable.")}\n`);
      this.#log({ event: "failure.reported", category: "Local state" });
      return this.#shutdownOnce(1);
    }
    if (this.#exitCode !== undefined) return this.#shutdownOnce(this.#exitCode);
    if (!this.#inputClosed) readline.prompt();
    for (;;) {
      const line = await this.#nextLine();
      if (line === undefined || !(await this.#handle(line)) || this.#exitCode !== undefined) break;
      if (this.#lines.length === 0 && !this.#inputClosed) readline.prompt();
    }
    return this.#shutdownOnce(this.#exitCode ?? 0);
  }

  #receive(line: string): void {
    if (this.#cleanupDecisionResolve !== undefined) {
      const choice = line.trim().toLowerCase();
      this.#resolveCleanupDecision(choice === "y" || choice === "yes");
      return;
    }
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
    const key = permissionKey(permission.sessionID, permission.requestID);
    const activeHistory = this.#activeHistory;
    if (activeHistory !== undefined && !activeHistory.permissionIndexes.has(key)) {
      activeHistory.permissionIndexes.set(key, activeHistory.permissions.length);
      activeHistory.permissions.push({
        action: permission.action ?? null,
        resourceCount: permission.resources.length,
        reply: "not-replied",
        replied: false,
      });
    }
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
      ? "Interactive permission decisions are off in this harness configuration; Quoder is denying the request.\n"
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
      this.#recordPermissionReply(key, reply, true);
      this.#removeQueuedPermission(key);
      this.#trace({ event: "permission.replied", sessionID: permission.sessionID, reply, replied: true });
      if (interactive) {
        this.#permissionReplyInFlight = undefined;
        this.#renderPermissionQueue(true);
      }
    } catch {
      this.#recordPermissionReply(key, reply, false);
      this.#removeQueuedPermission(key);
      if (interactive) this.#permissionReplyInFlight = undefined;
      this.#permissionQueue.length = 0;
      this.#trace({ event: "permission.replied", sessionID: permission.sessionID, reply, replied: false });
      this.#markUnhealthy(server, "Quoder could not confirm OpenCode's permission decision.");
    }
  }

  #recordPermissionReply(key: string, reply: "once" | "always" | "reject", replied: boolean): void {
    const capture = this.#activeHistory;
    const index = capture?.permissionIndexes.get(key);
    if (capture === undefined || index === undefined) return;
    const current = capture.permissions[index];
    if (current !== undefined) capture.permissions[index] = { ...current, reply, replied };
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
    if (input === "/model" || input.startsWith("/model ")) {
      await this.#handleModelCommand(input);
      return true;
    }
    if (input === "/agent" || input.startsWith("/agent ")) {
      await this.#handleAgentCommand(input);
      return true;
    }
    if (input === "/memory" || input.startsWith("/memory ")) {
      await this.#handleMemoryCommand(input);
      return true;
    }
    if (input === "/history" || input.startsWith("/history ")) {
      await this.#handleHistoryCommand(input);
      return true;
    }
    if (input.startsWith("/")) {
      this.#write("Unknown command. Type /help for the commands Quoder supports.\n\n");
      return true;
    }
    await this.#runPrompt(input);
    return true;
  }

  #selectionMessage(message: string, warning = false): void {
    const painted = warning ? this.#theme.paint("warning", message) : this.#theme.paint("success", message);
    this.#write(`${painted}\n\n`);
  }

  async #handleModelCommand(input: string): Promise<void> {
    const query = input.slice("/model".length).trim();
    let models: readonly OpenCodeModelOption[];
    try {
      const server = await this.#ensureServer();
      models = await server.adapter.listModels(this.#options.project.root);
    } catch {
      this.#log({ event: "failure.reported", category: "OpenCode" });
      this.#selectionMessage(`${formatOperationalFailure("OpenCode")} Could not load configured models; the current model selection is unchanged.`, true);
      return;
    }
    if (query === "") {
      this.#write(`${formatModelChoices(models, this.#selectedModel, this.#theme)}\n`);
      return;
    }
    const result = resolveModelSelection(query, models);
    if (result.kind === "selected") {
      this.#selectedModel = result.value;
      this.#selectionMessage(`Model selected for future prompts: ${sanitizeLine(`${result.value.providerID}/${result.value.id}`, 180)}.`);
      return;
    }
    if (result.kind === "ambiguous") {
      const matches = result.matches.map((match) => sanitizeLine(`${match.providerID}/${match.id}`, 180));
      this.#selectionMessage(`Model query is ambiguous. Use one of these full IDs; selection is unchanged:\n  ${matches.join("\n  ")}`, true);
    } else {
      this.#selectionMessage(`No enabled model matches "${sanitizeLine(query, 80)}"; the selection is unchanged.`, true);
    }
    this.#write(`${formatModelChoices(models, this.#selectedModel, this.#theme)}\n`);
  }

  async #handleAgentCommand(input: string): Promise<void> {
    const query = input.slice("/agent".length).trim();
    let agents: readonly OpenCodeAgentOption[];
    try {
      const server = await this.#ensureServer();
      agents = await server.adapter.listAgents(this.#options.project.root);
    } catch {
      this.#log({ event: "failure.reported", category: "OpenCode" });
      this.#selectionMessage(`${formatOperationalFailure("OpenCode")} Could not load configured agents; the current agent selection is unchanged.`, true);
      return;
    }
    if (query === "") {
      this.#write(`${formatAgentChoices(agents, this.#selectedAgent, this.#theme)}\n`);
      return;
    }
    const result = resolveAgentSelection(query, agents);
    if (result.kind === "selected") {
      this.#selectedAgent = result.value;
      this.#selectionMessage(`Agent selected for future prompts: ${sanitizeLine(result.value, 120)}.`);
      return;
    }
    if (result.kind === "ambiguous") {
      const matches = result.matches.map((agent) => sanitizeLine(agent, 120));
      this.#selectionMessage(`Agent query is ambiguous. Use one of these full IDs; selection is unchanged:\n  ${matches.join("\n  ")}`, true);
    } else {
      this.#selectionMessage(`No selectable agent matches "${sanitizeLine(query, 80)}"; the selection is unchanged.`, true);
    }
    this.#write(`${formatAgentChoices(agents, this.#selectedAgent, this.#theme)}\n`);
  }

  async #loadProjectMemory(): Promise<void> {
    if (this.#memoryStore === undefined) {
      this.#memoryUnavailable ??= "io-error";
      return;
    }
    try {
      const result = await this.#memoryStore.load();
      if (result.status === "unavailable") {
        this.#memory = undefined;
        this.#memoryUnavailable = result.reason;
        this.#log({ event: "failure.reported", category: "Local state" });
      } else {
        this.#memory = result.memory;
        this.#memoryUnavailable = undefined;
      }
    } catch {
      this.#memory = undefined;
      this.#memoryUnavailable = "io-error";
      this.#log({ event: "failure.reported", category: "Local state" });
    }
  }

  #memoryMessage(message: string, warning = false): void {
    const painted = warning ? this.#theme.paint("warning", message) : this.#theme.paint("success", message);
    this.#write(`${painted}\n\n`);
  }

  #historyMessage(message: string, warning = false): void {
    const painted = warning ? this.#theme.paint("warning", message) : this.#theme.paint("success", message);
    this.#write(`${painted}\n\n`);
  }

  #historyUnavailable(reason?: import("./execution-history.js").HistoryUnavailableReason): void {
    this.#log({ event: "failure.reported", category: "Local state" });
    const detail = reason === undefined ? "Execution history is unavailable." : formatExecutionHistoryFailure(reason);
    this.#historyMessage(formatLocalStateRecovery("Execution history", detail), true);
  }

  async #handleHistoryCommand(input: string): Promise<void> {
    const command = input.slice("/history".length).trim();
    const store = this.#historyStore;
    if (store === undefined) {
      this.#historyUnavailable("io-error");
      return;
    }
    try {
      if (command === "" || command === "help") {
        if (command === "help") this.#write(`${EXECUTION_HISTORY_HELP_TEXT}\n\n`);
        else {
          const result = await store.list();
          if (result.status === "unavailable") this.#historyUnavailable(result.reason);
          else this.#write(`${formatExecutionHistoryList(result.records, this.#theme)}\n`);
        }
        return;
      }
      if (command === "retention") {
        const result = await store.retention();
        if (result.status === "unavailable") this.#historyUnavailable(result.reason);
        else this.#historyMessage(`Maximum completed execution records: ${result.maxCompletedRecords}.`);
        return;
      }
      const retention = command.match(/^retention\s+(\S+)$/u);
      if (retention !== null) {
        const rawCount = retention[1] ?? "";
        const count = /^\d+$/u.test(rawCount) ? Number(rawCount) : Number.NaN;
        if (!Number.isInteger(count) || count < 1 || count > 1_000) {
          this.#historyMessage("Retention must be a whole number from 1 through 1,000.", true);
          return;
        }
        const result = await store.setRetention(count);
        if (!result.ok) this.#historyUnavailable(result.reason);
        else this.#historyMessage(`Execution history retention set to ${count} completed records.`);
        return;
      }
      if (command === "clear all") {
        const result = await store.clearAll();
        if (result.status === "unavailable") this.#historyUnavailable(result.reason);
        else this.#historyMessage(`Cleared ${result.deleted} execution history record${result.deleted === 1 ? "" : "s"}.`);
        return;
      }
      const clear = command.match(/^clear\s+(\S+)$/u);
      if (clear !== null) {
        const id = clear[1] ?? "";
        if (!EXECUTION_HISTORY_ID_PATTERN.test(id)) {
          this.#historySyntax();
          return;
        }
        const result = await store.delete(id);
        if (result.status === "unavailable") this.#historyUnavailable(result.reason);
        else this.#historyMessage(result.status === "deleted" ? "Execution history record deleted." : "No history record with that ID.", result.status === "missing");
        return;
      }
      if (!EXECUTION_HISTORY_ID_PATTERN.test(command)) {
        this.#historySyntax();
        return;
      }
      const result = await store.get(command);
      if (result.status === "unavailable") this.#historyUnavailable(result.reason);
      else if (result.status === "missing") this.#historyMessage("No history record with that ID.", true);
      else this.#write(`${formatExecutionHistoryRecord(result.record, this.#theme)}\n`);
    } catch {
      this.#historyUnavailable("io-error");
    }
  }

  #historySyntax(): void {
    this.#historyMessage("Usage: /history [<id>|help|retention [<count>]|clear <id|all>]", true);
  }

  async #saveProjectMemory(memory: ProjectMemory, success: string): Promise<void> {
    if (this.#memoryStore === undefined) {
      this.#memoryMessage(`${formatProjectMemoryFailure("io-error", "save")} No changes were saved.`, true);
      return;
    }
    try {
      const result = await this.#memoryStore.save(memory);
      if (!result.ok) {
        const detail = formatProjectMemoryFailure(result.reason, "save");
        const message = ["corrupt", "unsupported-version", "invalid-data", "oversized", "unsafe-path"].includes(result.reason)
          ? formatLocalStateRecovery("Project memory", detail)
          : `${detail} No changes were saved.`;
        this.#memoryMessage(message, true);
        return;
      }
      this.#memory = memory;
      this.#memoryUnavailable = undefined;
      this.#memoryMessage(success);
    } catch {
      this.#memoryMessage(`${formatProjectMemoryFailure("io-error", "save")} No changes were saved.`, true);
    }
  }

  async #clearProjectMemory(): Promise<void> {
    if (this.#memory === undefined) {
      this.#memoryMessage(formatLocalStateRecovery(
        "Project memory",
        formatProjectMemoryFailure(this.#memoryUnavailable ?? "io-error"),
      ), true);
      return;
    }
    if (this.#memoryStore === undefined) {
      this.#memoryMessage(`${formatProjectMemoryFailure("io-error", "clear")} No changes were saved.`, true);
      return;
    }
    try {
      const result = await this.#memoryStore.clear();
      if (!result.ok) {
        const detail = formatProjectMemoryFailure(result.reason, "clear");
        const message = ["corrupt", "unsupported-version", "invalid-data", "oversized", "unsafe-path"].includes(result.reason)
          ? formatLocalStateRecovery("Project memory", detail)
          : `${detail} No changes were saved.`;
        this.#memoryMessage(message, true);
        return;
      }
      this.#memory = emptyProjectMemory();
      this.#memoryUnavailable = undefined;
      this.#memoryMessage("Project memory cleared. Automatic summaries will resume after the next answered prompt.");
    } catch {
      this.#memoryMessage(`${formatProjectMemoryFailure("io-error", "clear")} No changes were saved.`, true);
    }
  }

  async #handleMemoryCommand(input: string): Promise<void> {
    const command = input.slice("/memory".length).trim();
    if (command === "" || command === "show") {
      await this.#loadProjectMemory();
      if (this.#memory === undefined) {
        this.#memoryMessage(formatLocalStateRecovery(
          "Project memory",
          formatProjectMemoryFailure(this.#memoryUnavailable ?? "io-error"),
        ), true);
        return;
      }
      this.#write(`${formatProjectMemory(this.#memory, this.#memoryStore?.filePath ?? "(unavailable)", this.#theme)}\n`);
      return;
    }
    if (command === "help") {
      this.#write(`${PROJECT_MEMORY_HELP_TEXT}\n\n`);
      return;
    }
    if (command === "clear") {
      await this.#clearProjectMemory();
      return;
    }
    if (this.#memory === undefined) {
      this.#memoryMessage(formatLocalStateRecovery(
        "Project memory",
        formatProjectMemoryFailure(this.#memoryUnavailable ?? "io-error"),
      ), true);
      return;
    }

    if (command === "objective" || command === "task") {
      this.#memoryMessage("Memory values cannot be empty; use /memory clear objective or /memory clear task.", true);
      return;
    }
    const setting = command.match(/^(objective|task)\s+([\s\S]+)$/u);
    if (setting !== null) {
      const field = setting[1] as "objective" | "task";
      const value = setting[2]?.trim() ?? "";
      if (value === "") {
        this.#memoryMessage("Memory values cannot be empty; use /memory clear objective or /memory clear task.", true);
        return;
      }
      if (Array.from(value).length > PROJECT_MEMORY_MAX_CODE_POINTS) {
        this.#memoryMessage(`That value exceeds ${PROJECT_MEMORY_MAX_CODE_POINTS} Unicode characters. No changes were saved.`, true);
        return;
      }
      await this.#saveProjectMemory({ ...this.#memory, [field]: value }, `${field === "objective" ? "Objective" : "Task"} saved.`);
      return;
    }

    if (/^add\s+(decision|constraint|issue)$/u.test(command)) {
      this.#memoryMessage("Memory entries cannot be empty. No changes were saved.", true);
      return;
    }
    const add = command.match(/^add\s+(decision|constraint|issue)\s+([\s\S]+)$/u);
    if (add !== null) {
      const kind = add[1];
      const value = add[2]?.trim() ?? "";
      if (value === "") {
        this.#memoryMessage("Memory entries cannot be empty. No changes were saved.", true);
        return;
      }
      if (Array.from(value).length > PROJECT_MEMORY_MAX_CODE_POINTS) {
        this.#memoryMessage(`That entry exceeds ${PROJECT_MEMORY_MAX_CODE_POINTS} Unicode characters. No changes were saved.`, true);
        return;
      }
      const field = kind === "decision" ? "decisions" : kind === "constraint" ? "constraints" : "unresolvedIssues";
      const current = this.#memory[field];
      if (current.length >= PROJECT_MEMORY_MAX_LIST_ITEMS) {
        this.#memoryMessage(`That list already has ${PROJECT_MEMORY_MAX_LIST_ITEMS} entries. Remove one before adding another.`, true);
        return;
      }
      const next = [...current, value];
      const label = kind === "decision" ? "Decision" : kind === "constraint" ? "Constraint" : "Issue";
      await this.#saveProjectMemory({ ...this.#memory, [field]: next }, `${label} ${next.length} saved.`);
      return;
    }

    const remove = command.match(/^remove\s+(decision|constraint|issue)\s+(\d+)$/u);
    if (remove !== null) {
      const kind = remove[1];
      const index = Number(remove[2]) - 1;
      const field = kind === "decision" ? "decisions" : kind === "constraint" ? "constraints" : "unresolvedIssues";
      const current = this.#memory[field];
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        this.#memoryMessage("That memory item number does not exist. Use /memory show to see list numbers.", true);
        return;
      }
      const next = current.filter((_entry, candidate) => candidate !== index);
      const label = kind === "decision" ? "Decision" : kind === "constraint" ? "Constraint" : "Issue";
      await this.#saveProjectMemory({ ...this.#memory, [field]: next }, `${label} ${index + 1} removed.`);
      return;
    }

    const auto = command.match(/^auto\s+(on|off)$/u);
    if (auto !== null) {
      const enabled = auto[1] === "on";
      await this.#saveProjectMemory(
        { ...this.#memory, automaticSummary: enabled },
        `Automatic previous-result summaries ${enabled ? "enabled" : "disabled"}.`,
      );
      return;
    }

    const clear = command.match(/^clear\s+(objective|task|decisions|constraints|issues|summary)$/u);
    if (clear !== null) {
      const field = clear[1];
      const next = field === "objective" || field === "task"
        ? { ...this.#memory, [field]: null }
        : field === "decisions"
          ? { ...this.#memory, decisions: [] }
          : field === "constraints"
            ? { ...this.#memory, constraints: [] }
            : field === "issues"
              ? { ...this.#memory, unresolvedIssues: [] }
              : { ...this.#memory, previousExecution: null };
      const label = field === "objective" ? "Objective"
        : field === "task" ? "Task"
          : field === "decisions" ? "Decisions"
            : field === "constraints" ? "Constraints"
              : field === "issues" ? "Issues" : "Previous summary";
      await this.#saveProjectMemory(next, `${label} cleared.`);
      return;
    }

    this.#memoryMessage("Unknown memory command. Type /memory help for the supported commands.", true);
  }

  async #runPrompt(prompt: string): Promise<void> {
    const controller = new AbortController();
    this.#running = controller;
    const model = this.#selectedModel;
    const agent = this.#selectedAgent;
    const theme = this.#theme;
    const beforeGit = await this.#captureGitState();
    const memory = this.#memory ?? emptyProjectMemory();
    const harnessContext = buildHarnessContext(prompt, memory, beforeGit);
    const startedAt = Date.now();
    const historyStart = await this.#beginHistory(prompt, harnessContext.context, beforeGit, startedAt, model, agent);
    if (historyStart !== undefined) {
      this.#activeHistory = {
        id: historyStart.id,
        startedAt,
        permissions: [],
        permissionIndexes: new Map(),
        commands: [],
        toolActivity: [],
        attempts: 1,
      };
    }
    this.#write(`${theme.paint("dim", "Starting fresh OpenCode session…")}\n`);
    const view = new LiveView({
      theme,
      write: (text) => this.#write(text),
      root: this.#options.project.root,
      modelLabel: model.id,
      statusLine: this.#options.terminal,
      ...(this.#options.columns === undefined ? {} : { columns: this.#options.columns }),
      ...(this.#options.renderMarkdown === undefined ? {} : { render: this.#options.renderMarkdown }),
      onFirstText: () => this.#trace({ event: "stream.first-text" }),
      onToolFinished: (tool) => this.#trace({ event: "activity.tool", tool }),
      onToolRecorded: (activity, command) => {
        const capture = this.#activeHistory;
        if (capture === undefined) return;
        capture.toolActivity.push(activity);
        if (command !== undefined) capture.commands.push(command);
      },
    });
    this.#view = view;
    this.#trace({ event: "prompt.started" });
    try {
      view.note(`${theme.paint("dim", `Harness context: ${harnessContext.contextCharacters} code points · Prompt: ${harnessContext.promptCharacters} code points`)}\n`);
      let server: ServerSession;
      try {
        server = await this.#ensureServer();
      } catch {
        view.finish();
        this.#reportFailure("OpenCode", "Could not start the OpenCode server; the prompt was not run.");
        const afterGit = await this.#captureGitState();
        const comparison = await this.#compareGitState(beforeGit, afterGit);
        this.#write(formatGitSummary(comparison, theme));
        await this.#completeHistory("failed", null, comparison, "server-start");
        this.#view = undefined;
        this.#running = undefined;
        await this.#presentGitDiff(comparison);
        return;
      }
      const result = await runPrompt({
        adapter: server.adapter,
        tracker: this.#tracker,
        ...(this.#ownedSessionLedger === undefined ? {} : { ownedSessionLedger: this.#ownedSessionLedger }),
        directory: this.#options.project.root,
        model,
        agent,
        prompt: harnessContext.combinedPrompt,
        cancel: controller.signal,
        ...(this.#dependencies.noResponseTimeoutMs === undefined ? {} : { noResponseTimeoutMs: this.#dependencies.noResponseTimeoutMs }),
        onRetry: () => {
          if (this.#activeHistory !== undefined) this.#activeHistory.attempts = 2;
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
      if (result.outcome.kind === "failed") {
        this.#log({ event: "failure.reported", category: result.outcome.category ?? "OpenCode" });
      }
      const stats = view.finish(result);
      this.#write(`\n${formatResult(result, theme, stats)}\n`);
      const afterGit = await this.#captureGitState();
      const comparison = await this.#compareGitState(beforeGit, afterGit);
      this.#write(`${formatGitSummary(comparison, theme)}\n`);
      const status = result.outcome.kind;
      await this.#completeHistory(
        status,
        result.outcome.kind === "answered" ? result.outcome.text : null,
        comparison,
      );
      if (result.outcome.kind === "answered" && this.#memory?.automaticSummary === true && this.#memoryStore !== undefined) {
        const updated = {
          ...this.#memory,
          previousExecution: createPreviousExecutionSummary(prompt, result.outcome.text),
        };
        try {
          const saved = await this.#memoryStore.save(updated);
          if (saved.ok) this.#memory = updated;
          else this.#memoryMessage(`${formatProjectMemoryFailure(saved.reason, "save")} Automatic summary was not updated.`, true);
        } catch {
          this.#memoryMessage(`${formatProjectMemoryFailure("io-error", "save")} Automatic summary was not updated.`, true);
        }
      }
      for (const notice of this.#notices.splice(0)) {
        this.#write(`${theme.paint("warning", `Note: ${notice} A new OpenCode server will start with your next prompt.`)}\n\n`);
      }
      this.#view = undefined;
      this.#running = undefined;
      await this.#presentGitDiff(comparison);
    } finally {
      this.#activeHistory = undefined;
      view.finish();
      this.#view = undefined;
      this.#running = undefined;
    }
  }

  async #beginHistory(
    prompt: string,
    injectedContext: string,
    before: GitSnapshotResult,
    startedAt: number,
    model: ModelRef,
    agent: string,
  ): Promise<ExecutionHistoryRecord | undefined> {
    const store = this.#historyStore;
    if (store === undefined) {
      this.#historyWarning("begin", "io-error");
      return undefined;
    }
    try {
      const result = await store.begin({
        startedAt: new Date(startedAt).toISOString(),
        branch: before.kind === "available" ? before.branch ?? null : null,
        startingHead: before.kind === "available" ? before.head ?? null : null,
        model: { providerID: model.providerID, id: model.id },
        agent,
        prompt,
        injectedContext,
      });
      if (result.status === "created") return result.record;
      this.#historyWarning("begin", result.reason);
    } catch {
      this.#historyWarning("begin", "io-error");
    }
    return undefined;
  }

  async #completeHistory(
    status: "answered" | "permission-rejected" | "question-rejected" | "cancelled" | "failed",
    finalResponse: string | null,
    comparison: GitComparison,
    failureStage?: "server-start",
  ): Promise<void> {
    const store = this.#historyStore;
    const capture = this.#activeHistory;
    if (store === undefined || capture === undefined) return;
    const filesChanged = comparison.kind === "available"
      ? {
        status: "available" as const,
        paths: comparison.observedChanges.map((change) => ({
          kind: change.kind,
          path: change.path,
          previousPath: change.previousPath ?? null,
        })),
        reason: null,
      }
      : {
        status: "unavailable" as const,
        paths: [],
        reason: comparison.before.kind === "unavailable"
          ? comparison.before.reason
          : comparison.after.kind === "unavailable" ? comparison.after.reason : "command-failed",
      };
    try {
      const result = await store.complete(capture.id, {
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - capture.startedAt),
        status,
        permissionDecisions: capture.permissions,
        commands: capture.commands,
        toolActivity: capture.toolActivity,
        filesChanged,
        finalResponse,
        attempts: failureStage === "server-start" ? 0 : capture.attempts,
        ...(failureStage === undefined ? {} : { failureStage }),
      });
      if (!result.ok) this.#historyWarning("complete", result.reason);
    } catch {
      this.#historyWarning("complete", "io-error");
    }
  }

  #historyWarning(operation: "begin" | "complete", reason: string): void {
    this.#log({ event: "failure.reported", category: "Local state" });
    this.#write(`${this.#theme.paint("warning", `Execution history ${operation} failed (${reason}); the prompt outcome is unchanged.`)}\n`);
  }

  async #captureGitState(): Promise<GitSnapshotResult> {
    try {
      return await (this.#dependencies.captureGitSnapshot ?? captureGitSnapshot)(this.#options.project.root);
    } catch {
      return { kind: "unavailable", root: this.#options.project.root, reason: "command-failed" };
    }
  }

  async #compareGitState(before: GitSnapshotResult, after: GitSnapshotResult) {
    try {
      return await (this.#dependencies.compareGitSnapshots ?? compareGitSnapshots)(before, after);
    } catch {
      return {
        kind: "unavailable" as const,
        before,
        after: { kind: "unavailable" as const, root: this.#options.project.root, reason: "command-failed" as const },
        observedChanges: [],
        preExistingPaths: [],
        resolvedPaths: [],
        headChanged: false,
        branchChanged: false,
        committedDiff: undefined,
      };
    }
  }

  #onDiffInteractionKey(key: Exclude<DiffKey, "exit">): void {
    if (key === "ctrl-c") {
      this.interrupt();
      return;
    }
    if (key === "ctrl-d") {
      this.#requestExit(0);
      return;
    }
    this.#diffKeyResolver?.(key);
  }

  async #waitForDiffKey(mode: "choice" | "viewer", prompt: string): Promise<DiffKey> {
    if (this.#exitCode !== undefined || this.#inputClosed) return "exit";
    this.#diffInteraction = mode;
    const readline = this.#readline;
    if (readline !== undefined) {
      readline.setPrompt(prompt);
      readline.prompt();
    }
    const key = await new Promise<DiffKey>((resolveKey) => {
      this.#diffKeyResolver = resolveKey;
    });
    this.#diffKeyResolver = undefined;
    this.#diffInteraction = undefined;
    return key;
  }

  async #presentGitDiff(comparison: GitComparison): Promise<void> {
    if (!hasInspectableGitDiff(comparison) || this.#exitCode !== undefined) return;
    const capture = this.#dependencies.captureGitDiff ?? captureGitDiff;
    if (!this.#options.terminal) {
      const result = await capture(comparison).catch((): GitDiffResult => ({ kind: "unavailable", reason: "command-failed" }));
      this.#write(result.kind === "available" ? formatGitDiff(result) : formatGitDiffFailure(result, this.#theme));
      return;
    }

    let document: Extract<GitDiffResult, { kind: "available" }> | undefined;
    for (;;) {
      const key = await this.#waitForDiffKey("choice", "View diff [v] / Continue [Enter]: ");
      if (key === "exit" || key === "ctrl-c" || key === "ctrl-d") break;
      this.#write("\n");
      if (key === "enter") break;
      if (key !== "v") continue;
      if (document === undefined) {
        const result = await capture(comparison).catch((): GitDiffResult => ({ kind: "unavailable", reason: "command-failed" }));
        if (result.kind === "unavailable") {
          this.#write(formatGitDiffFailure(result, this.#theme));
          continue;
        }
        document = result;
      }
      let page = 0;
      for (;;) {
        const view = formatGitDiffPage(document, page);
        page = view.page;
        this.#write(view.text);
        const pageKey = await this.#waitForDiffKey("viewer", `Diff ${view.page + 1}/${view.pages} [n]ext / [p]revious / [q]uit: `);
        if (pageKey === "exit" || pageKey === "ctrl-c" || pageKey === "ctrl-d") return;
        this.#write("\n");
        if (pageKey === "q" || pageKey === "escape") break;
        if (pageKey === "n" || pageKey === "enter") page = Math.min(view.pages - 1, page + 1);
        if (pageKey === "p") page = Math.max(0, page - 1);
      }
    }
    this.#readline?.setPrompt(this.#mainPrompt);
  }

  /** Stops the running prompt for a harness reason; the outcome reports `message`. */
  #stopRunning(message: string): void {
    if (this.#running === undefined || this.#running.signal.aborted) return;
    const reason: StopRequest = { stopped: message };
    this.#running.abort(reason);
  }

  async #reconcileOwnedSessions(server: ServerSession): Promise<void> {
    if (this.#ownedSessionLedger === undefined) return;
    const listed = await this.#ownedSessionLedger.list();
    if (listed.status !== "available") {
      throw new Error("OpenCode session ownership ledger is unavailable");
    }

    const candidates: OwnedSessionRecord[] = [];
    let leftUntouched = 0;
    for (const record of listed.records) {
      if (record.state !== "created") {
        leftUntouched++;
        continue;
      }
      let session;
      try {
        session = await server.adapter.getSession(record.id);
      } catch {
        this.#reportFailure("OpenCode", "Could not inspect a Quoder-owned session; no cleanup was attempted.");
        throw new Error("OpenCode session reconciliation failed");
      }
      if (session === undefined) {
        // Exact Core V2 404 is the only evidence that an abandoned intent can be retired.
        await this.#ownedSessionLedger.remove(record.id);
        continue;
      }
      const remoteRoot = typeof session.location?.directory === "string"
        ? await realpath(session.location.directory).catch(() => resolve(session.location.directory))
        : undefined;
      if (session.id !== record.id || remoteRoot !== resolve(this.#options.project.root) ||
        record.projectRoot !== resolve(this.#options.project.root)) {
        leftUntouched++;
        continue;
      }
      candidates.push(record);
    }

    if (leftUntouched > 0) {
      this.#write(`Left ${leftUntouched} report-only or mismatched Quoder session record(s) untouched.\n`);
    }
    if (candidates.length === 0) return;

    this.#write(
      `Found ${candidates.length} Quoder-owned OpenCode session(s) from an earlier run:\n`
      + `${candidates.map(({ id }) => `  ${id}`).join("\n")}\n`
      + "Activity on these sessions is unknown; cleanup may interrupt work if an older OpenCode server is still using one.\n",
    );
    if (!this.#options.terminal) {
      this.#write("Cleanup was skipped because confirmation requires a terminal. Run Quoder for this project in a TTY to review each session.\n");
      return;
    }

    for (const candidate of candidates) {
      const confirmed = await this.#confirmOwnedSessionCleanup(candidate.id);
      if (!confirmed) {
        this.#write(`Kept ${candidate.id}; no cleanup was attempted.\n`);
        continue;
      }
      try {
        const current = await server.adapter.getSession(candidate.id);
        if (current === undefined) {
          await this.#ownedSessionLedger.remove(candidate.id);
          this.#write(`Session ${candidate.id} is already absent; its ledger entry was retired.\n`);
          continue;
        }
        const currentRoot = typeof current.location?.directory === "string"
          ? await realpath(current.location.directory).catch(() => resolve(current.location.directory))
          : undefined;
        if (current.id !== candidate.id || currentRoot !== resolve(this.#options.project.root)) {
          this.#write(`Kept ${candidate.id}; its current ID or project location no longer matches the ledger.\n`);
          continue;
        }
        await server.adapter.deleteSession(candidate.id);
        this.#trace({ event: "session.deleted", sessionID: candidate.id, verified: true });
        await this.#ownedSessionLedger.remove(candidate.id);
        for (let index = this.#undeletedSessions.indexOf(candidate.id); index >= 0; index = this.#undeletedSessions.indexOf(candidate.id)) {
          this.#undeletedSessions.splice(index, 1);
        }
        this.#write(`Deleted ${candidate.id}; OpenCode confirmed it is absent.\n`);
      } catch {
        this.#write(`Could not confirm cleanup of ${candidate.id}; its ownership record was preserved for review.\n`);
      }
    }
  }

  #confirmOwnedSessionCleanup(sessionID: string): Promise<boolean> {
    if (!this.#options.terminal || this.#readline === undefined || this.#inputClosed || this.#exitCode !== undefined) {
      return Promise.resolve(false);
    }
    this.#write(`Delete only ${sessionID}? [y/N] `);
    return new Promise((resolveDecision) => {
      this.#cleanupDecisionResolve = resolveDecision;
    });
  }

  #resolveCleanupDecision(confirmed: boolean): void {
    const resolveDecision = this.#cleanupDecisionResolve;
    if (resolveDecision === undefined) return;
    this.#cleanupDecisionResolve = undefined;
    resolveDecision(confirmed);
  }

  async #ensureServer(): Promise<ServerSession> {
    const current = this.#server;
    if (current !== undefined && !current.unhealthy) return current;
    if (current !== undefined) await this.#retire(current);
    this.#startingServer ??= this.#launchServer().finally(() => {
      this.#startingServer = undefined;
    });
    const started = await this.#startingServer;
    if (this.#readline !== undefined && !started.reconciled) {
      await this.#reconcileOwnedSessions(started);
      started.reconciled = true;
    }
    return started;
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
      server = { launch, adapter, monitor, unhealthy: false, reconciled: false };
      if (this.#exitCode !== undefined) {
        await monitor.stop();
        throw new Error("Quoder is shutting down");
      }
      this.#server = server;
      this.#trace({ event: "server.started" });
      const launched = server;
      void launch.exited?.then(() => this.#onServerExit(launched));
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
      this.#notifyIdle(`\n${formatOperationalFailure("OpenCode")} ${problem} A new OpenCode server will start with your next prompt.\n`);
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
      const notice = "The OpenCode server stopped unexpectedly, so the prompt was stopped.";
      this.#notices.push(notice);
      this.#stopRunning(notice);
    } else {
      this.#notifyIdle(`\n${formatOperationalFailure("OpenCode")} The OpenCode server stopped unexpectedly; a new one will start with your next prompt.\n`);
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
    let safeEvent: OperationalLogEvent | undefined;
    switch (event.event) {
      case "server.started":
      case "server.stopped":
      case "server.lost":
      case "monitor.lost":
      case "prompt.started":
      case "prompt.retried":
        safeEvent = { event: event.event };
        break;
      case "prompt.completed":
        safeEvent = { event: event.event, outcome: event.outcome, elapsedMs: event.elapsedMs };
        break;
      case "session.created":
        safeEvent = { event: event.event };
        break;
      case "session.deleted":
        safeEvent = { event: event.event, verified: event.verified };
        break;
      case "stream.first-text":
      case "permission.replied":
      case "activity.tool":
        break;
    }
    if (safeEvent !== undefined) this.#log(safeEvent);
  }

  #log(event: OperationalLogEvent): void {
    try {
      this.#dependencies.operationalLog?.(event);
    } catch {
      // Diagnostics cannot change prompt, cleanup, or recovery outcomes.
    }
  }

  #reportFailure(category: OperationalFailureCategory, suffix = ""): void {
    this.#log({ event: "failure.reported", category });
    const explanation = formatOperationalFailure(category);
    this.#write(`${this.#theme.paint("error", `${explanation}${suffix === "" ? "" : ` ${suffix}`}`)}\n`);
  }
}
