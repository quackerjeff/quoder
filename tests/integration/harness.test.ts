import { PassThrough } from "node:stream";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, it, vi } from "vitest";

import type { EventMonitorOptions } from "../../src/event-monitor.js";
import type { GitSnapshot, GitSnapshotResult } from "../../src/harness/git-state.js";
import type { GitDiffDocument } from "../../src/harness/git-diff.js";
import {
  emptyProjectMemory,
  type ProjectMemory,
  type ProjectMemoryLoadResult,
  type ProjectMemoryStore,
  type ProjectMemoryWriteResult,
} from "../../src/harness/project-memory.js";
import { Harness, type HarnessTraceEvent } from "../../src/harness/repl.js";
import type { AuthenticatedServerOptions } from "../../src/opencode-server.js";
import { createTheme, type Theme } from "../../src/ui/style.js";

const MODEL = { providerID: "ollama", id: "glm-4.7-flash:latest" };
const PROJECT = { root: "/work/QuackTrack", name: "QuackTrack" };

const response = (status = 200): Response => new Response(null, { status });
const result = <T>(data: T, status = 200) => ({ data, error: undefined, response: response(status) });
const failedResult = (error: unknown, status: number) => ({ data: undefined, error, response: response(status) });

const gitSnapshot = (paths: GitSnapshot["paths"] = [], trackedFiles = 0): GitSnapshot => ({
  kind: "available",
  root: PROJECT.root,
  head: "0123456789abcdef0123456789abcdef01234567",
  branch: "main",
  branchState: "attached",
  paths,
  untrackedPaths: paths.filter(({ kind }) => kind === "untracked").map(({ path }) => path),
  trackedDiff: { files: trackedFiles, additions: trackedFiles === 0 ? 0 : 2, deletions: trackedFiles === 0 ? 0 : 1, binaryFiles: 0 },
});

const gate = () => {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  return { opened, release };
};

interface FakeOptions {
  /** The first `createSession` waits until this gate opens. */
  readonly createGate?: ReturnType<typeof gate>;
  /** Permission replies fail (the server cannot be told to reject). */
  readonly permissionReplyFails?: boolean;
  readonly permissionSave?: readonly string[];
  readonly permissionDecisionsEnabled?: boolean;
  readonly permissionRequestCount?: number;
  readonly permissionOperation?: "read" | "edit";
  /** Session deletion waits until this gate opens. */
  readonly deleteGate?: ReturnType<typeof gate>;
}

/**
 * A fake OpenCode behind the real adapter. Prompt text selects the scripted behaviour:
 * "perm…" raises a permission request (and ends the turn), "permok…" raises one and still answers,
 * "ask…" raises a question, "slow…" runs until interrupted, "boom…" ends with a step error;
 * "drop…" is dropped by OpenCode in its first session (idle, no response) and answered in the next;
 * "stream…" streams text and a read tool before answering ("streammiss…" drops part of the final
 * text from the stream; "streamslow…" streams, starts a bash tool, and runs until interrupted);
 * anything else is answered with "Answer: <prompt>". While `dead`, every call fails like a
 * stopped server.
 */
const fakeOpenCode = (options: FakeOptions = {}) => {
  const calls: string[] = [];
  const pendingPermissions = new Set<string>();
  const pendingPermissionIDs = new Map<string, Set<string>>();
  const state = {
    dead: false,
    monitor: undefined as EventMonitorOptions | undefined,
    executedOperations: new Set<string>(),
    resolvePermission: (sessionID: string) => {
      pendingPermissionIDs.delete(sessionID);
      return pendingPermissions.delete(sessionID);
    },
  };
  let sessions = 0;
  const prompts = new Map<string, string>();
  const interrupted = new Set<string>();
  const deleted = new Set<string>();
  const permissionReplies = new Map<string, string>();
  const alive = async () => {
    if (state.dead) throw new TypeError("fetch failed");
  };
  const STREAMED_ANSWER = "Streamed **answer** done.";
  const emit = (type: string, data: Record<string, unknown>) => state.monitor?.onSessionEvent?.({ type: `session.next.${type}`, data });
  /** The live display events a real OpenCode would publish for a "stream…" prompt (shapes verified live). */
  const streamEvents = (sessionID: string, text: string) => {
    const base = { timestamp: 1, sessionID };
    emit("step.started", { ...base, assistantMessageID: `step-${sessionID}`, agent: "build", model: MODEL });
    for (const delta of ["Reading ", "the file.", "\n\n"]) emit("text.delta", { ...base, assistantMessageID: `step-${sessionID}`, textID: "t1", delta });
    emit("tool.input.started", { ...base, assistantMessageID: `step-${sessionID}`, callID: "c1", name: "read" });
    emit("tool.called", { ...base, assistantMessageID: `step-${sessionID}`, callID: "c1", tool: "read", input: { path: `${PROJECT.root}/notes.txt` } });
    emit("text.ended", { ...base, assistantMessageID: `step-${sessionID}`, textID: "t1", text: "Reading the file.\n\n" });
    emit("tool.success", { ...base, assistantMessageID: `step-${sessionID}`, callID: "c1", structured: { content: "alpha\nbeta\n" }, content: [], outputPaths: [] });
    emit("step.ended", { ...base, assistantMessageID: `step-${sessionID}`, finish: "tool-calls", cost: 0, tokens: { input: 900, output: 40, reasoning: 0, cache: { read: 0, write: 0 } } });
    if (text.startsWith("streamslow")) {
      emit("step.started", { ...base, assistantMessageID: `slow-${sessionID}`, agent: "build", model: MODEL });
      emit("tool.called", { ...base, assistantMessageID: `slow-${sessionID}`, callID: "c2", tool: "bash", input: { command: "sleep 60" } });
      return;
    }
    emit("step.started", { ...base, assistantMessageID: `asst-${sessionID}`, agent: "build", model: MODEL });
    const deltas = text.startsWith("streammiss") ? ["Streamed "] : ["Streamed **ans", "wer** done."];
    for (const delta of deltas) emit("text.delta", { ...base, assistantMessageID: `asst-${sessionID}`, textID: "t2", delta });
    if (!text.startsWith("streammiss")) emit("text.ended", { ...base, assistantMessageID: `asst-${sessionID}`, textID: "t2", text: STREAMED_ANSWER });
    emit("step.ended", { ...base, assistantMessageID: `asst-${sessionID}`, finish: "stop", cost: 0, tokens: { input: 1000, output: 1200, reasoning: 0, cache: { read: 0, write: 0 } } });
  };
  const droppedOnce = new Set<string>();
  const dropped = new Set<string>();
  const turn = (sessionID: string) => {
    const prompt = prompts.get(sessionID) ?? "";
    const userMessage = { id: `input-${sessionID}`, type: "user", time: { created: 1 }, text: prompt };
    const done = (text: string, extra: Record<string, unknown> = {}) =>
      ({ id: `asst-${sessionID}`, type: "assistant", time: { created: 2, completed: 3 }, agent: "build", model: MODEL, content: [{ type: "text", id: "t", text }], ...extra });
    if (dropped.has(sessionID)) return [userMessage];
    if (prompt.startsWith("allowed-command")) {
      state.executedOperations.add(sessionID);
      return [userMessage, done("ALLOWED_COMMAND_EXECUTED")];
    }
    if (prompt.startsWith("permok") || ["once", "always"].includes(permissionReplies.get(sessionID) ?? "")) {
      state.executedOperations.add(sessionID);
      return [userMessage, done(`Answer: ${prompt}\nPROTECTED_OPERATION_EXECUTED`)];
    }
    if (permissionReplies.get(sessionID) === "reject") {
      return [userMessage, { ...done(""), time: { created: 2 }, content: [{ type: "tool", tool: "read" }] }];
    }
    if (prompt.startsWith("perm") || prompt.startsWith("ask")) {
      return [userMessage, { ...done(""), time: { created: 2 }, content: [{ type: "tool", tool: "read" }] }];
    }
    if (prompt.startsWith("stream") && !prompt.startsWith("streamslow")) return [userMessage, done(STREAMED_ANSWER)];
    if (prompt.startsWith("slow") || prompt.startsWith("streamslow")) {
      return interrupted.has(sessionID)
        ? [userMessage, done("partial", { finish: "error", error: { type: "unknown", message: "Provider turn interrupted" } })]
        : [userMessage];
    }
    if (prompt.startsWith("boom")) {
      return [userMessage, done("", { finish: "error", error: { type: "unknown", message: "HTTP transport failed" } })];
    }
    return [userMessage, done(`Answer: ${prompt}`)];
  };
  const client = {
    v2: {
      session: {
        create: vi.fn(async (body: { location: { directory: string } }) => {
          await alive();
          const id = `ses_${++sessions}`;
          if (id === "ses_1" && options.createGate) await options.createGate.opened;
          calls.push(`create:${id}:${body.location.directory}`);
          return result({ data: { id } });
        }),
        prompt: vi.fn(async (parameters: { sessionID: string; prompt: { text: string } }) => {
          await alive();
          const { sessionID } = parameters;
          const text = parameters.prompt.text;
          prompts.set(sessionID, text);
          calls.push(`prompt:${sessionID}`);
          if (text.startsWith("drop") && !droppedOnce.has(text)) {
            droppedOnce.add(text);
            dropped.add(sessionID);
          }
          if (text.startsWith("perm")) {
            pendingPermissions.add(sessionID);
            const ids = new Set<string>();
            for (let index = 1; index <= (options.permissionRequestCount ?? 1); index++) {
              const requestID = index === 1 ? `per_${sessionID}` : `per_${sessionID}_${index}`;
              ids.add(requestID);
              state.monitor?.onPermissionAsked?.({
                sessionID,
                requestID,
                action: "external_directory",
                resourceCount: 1,
                resources: [`/outside/${options.permissionOperation ?? "resource"}/harmless-target`],
                save: options.permissionSave ?? [],
              });
            }
            pendingPermissionIDs.set(sessionID, ids);
          }
          if (text.startsWith("stream")) streamEvents(sessionID, text);
          if (text.startsWith("ask")) {
            const question = { sessionID, requestID: `que_${sessionID}`, questions: [{ question: "Which language?", options: [{ label: "Rust" }] }] };
            state.monitor?.onQuestionAsked?.(question);
            state.monitor?.onQuestionRejected?.(question, !text.startsWith("askfail"));
          }
          return result({ data: { id: `input-${sessionID}` } });
        }),
        active: vi.fn(async () => {
          await alive();
          const running = [...prompts.keys()].filter((id) => /^(slow|streamslow)/u.test(prompts.get(id) ?? "") && !interrupted.has(id));
          const active = [...new Set([...running, ...pendingPermissions])];
          return result({ data: Object.fromEntries(active.map((id) => [id, { type: "running" }])) });
        }),
        messages: vi.fn(async (parameters: { sessionID: string }) => {
          await alive();
          return result({ data: turn(parameters.sessionID), cursor: {} });
        }),
        interrupt: vi.fn(async (parameters: { sessionID: string }) => {
          await alive();
          calls.push(`interrupt:${parameters.sessionID}`);
          interrupted.add(parameters.sessionID);
          pendingPermissions.delete(parameters.sessionID);
          pendingPermissionIDs.delete(parameters.sessionID);
          return result(undefined, 204);
        }),
        get: vi.fn(async (parameters: { sessionID: string }) => {
          await alive();
          return deleted.has(parameters.sessionID)
            ? failedResult({ _tag: "SessionNotFoundError", message: "not found" }, 404)
            : result({ data: { id: parameters.sessionID } });
        }),
        permission: {
          reply: vi.fn(async (parameters: { sessionID: string; requestID: string; reply: string }) => {
            await alive();
            calls.push(`permission:${parameters.requestID}:${parameters.reply}`);
            if (options.permissionReplyFails) throw new TypeError("fetch failed");
            permissionReplies.set(parameters.sessionID, parameters.reply);
            const ids = pendingPermissionIDs.get(parameters.sessionID) ?? new Set();
            const resolvedIDs = parameters.reply === "reject" ? [...ids] : [parameters.requestID];
            for (const requestID of resolvedIDs) {
              state.monitor?.onPermissionReplied?.(parameters.sessionID, requestID);
              ids.delete(requestID);
            }
            if (ids.size === 0) {
              pendingPermissionIDs.delete(parameters.sessionID);
              pendingPermissions.delete(parameters.sessionID);
            }
            return result(undefined, 204);
          }),
        },
      },
    },
    session: {
      delete: vi.fn(async (parameters: { sessionID: string }) => {
        await alive();
        if (options.deleteGate) await options.deleteGate.opened;
        calls.push(`delete:${parameters.sessionID}`);
        deleted.add(parameters.sessionID);
        return result(true);
      }),
    },
  } as unknown as OpencodeClient;
  return { calls, client, state };
};

interface HarnessRunOptions extends FakeOptions {
  /** Drive readline as an interactive terminal (keypresses, Ctrl-C as `\x03`). */
  readonly terminal?: boolean;
  readonly launchFails?: boolean;
  /** The first launch waits for this gate, or rejects when its abort signal fires. */
  readonly launchGate?: ReturnType<typeof gate>;
  readonly monitorUnconfirmed?: boolean;
  readonly theme?: Theme;
  readonly gitSnapshots?: readonly GitSnapshotResult[];
  readonly gitDiff?: GitDiffDocument;
  readonly initialMemory?: ProjectMemoryLoadResult;
  readonly memorySaveResult?: ProjectMemoryWriteResult;
  readonly memoryClearResult?: ProjectMemoryWriteResult;
}

function fakeProjectMemoryStore(options: Pick<HarnessRunOptions, "initialMemory" | "memorySaveResult" | "memoryClearResult"> = {}) {
  let loadResult = options.initialMemory ?? { status: "missing" as const, memory: emptyProjectMemory() };
  const saved: ProjectMemory[] = [];
  const store: ProjectMemoryStore = {
    filePath: "/tmp/quoder-test-state/Quoder/context/project.json",
    load: vi.fn(async () => loadResult),
    save: vi.fn(async (memory) => {
      const result = options.memorySaveResult ?? { ok: true as const };
      if (result.ok) {
        saved.push(memory);
        loadResult = { status: "loaded", memory };
      }
      return result;
    }),
    clear: vi.fn(async () => {
      const result = options.memoryClearResult ?? { ok: true as const };
      if (result.ok) loadResult = { status: "loaded", memory: emptyProjectMemory() };
      return result;
    }),
  };
  return { store, saved, get currentLoadResult() { return loadResult; } };
}

const startHarness = (options: HarnessRunOptions = {}) => {
  const fake = fakeOpenCode(options);
  const memory = fakeProjectMemoryStore(options);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  const trace: HarnessTraceEvent[] = [];
  const exits: Array<() => void> = [];
  const launchOptions: AuthenticatedServerOptions[] = [];
  let gitSnapshotIndex = 0;
  const gitCaptures: string[] = [];
  const defaultGitSnapshot: GitSnapshotResult = {
    kind: "available",
    root: PROJECT.root,
    head: "0123456789abcdef0123456789abcdef01234567",
    branch: "main",
    branchState: "attached",
    paths: [],
    untrackedPaths: [],
    trackedDiff: { files: 0, additions: 0, deletions: 0, binaryFiles: 0 },
  };
  const counts = { launched: 0, closed: 0, monitorsStopped: 0 };
  const harness = new Harness(
    {
      project: PROJECT,
      model: MODEL,
      input,
      output,
      terminal: options.terminal ?? false,
      ...(options.theme === undefined ? {} : { theme: options.theme, columns: () => 60 }),
    },
    {
      launchServer: vi.fn(async (launch: AuthenticatedServerOptions) => {
        launchOptions.push(launch);
        if (options.launchFails) throw new Error("startup failed");
        if (launchOptions.length === 1 && options.launchGate) {
          await Promise.race([
            options.launchGate.opened,
            new Promise<never>((_resolve, reject) => {
              launch.signal?.addEventListener("abort", () => reject(new Error("launch aborted")), { once: true });
            }),
          ]);
        }
        counts.launched++;
        fake.state.dead = false;
        return {
          url: "http://127.0.0.1:4096",
          close: vi.fn(async () => {
            counts.closed++;
          }),
          exited: new Promise<void>((resolveExit) => exits.push(resolveExit)),
        };
      }),
      createClient: vi.fn(() => fake.client),
      createProjectMemoryStore: vi.fn(() => memory.store),
      startMonitor: vi.fn(async (monitorOptions: EventMonitorOptions) => {
        fake.state.monitor = monitorOptions;
        return {
          confirmed: !options.monitorUnconfirmed,
          waitForPermissionAsked: async () => "timeout" as const,
          stop: vi.fn(async () => {
            counts.monitorsStopped++;
          }),
        };
      }),
      trace: (event) => trace.push(event),
      captureGitSnapshot: vi.fn(async (root: string) => {
        fake.calls.push(`git:capture:${gitSnapshotIndex}`);
        gitCaptures.push(root);
        const snapshots = options.gitSnapshots ?? [defaultGitSnapshot];
        const snapshot = snapshots[Math.min(gitSnapshotIndex, snapshots.length - 1)] ?? defaultGitSnapshot;
        gitSnapshotIndex++;
        return snapshot;
      }),
      ...(options.gitDiff === undefined ? {} : { captureGitDiff: vi.fn(async () => options.gitDiff!) }),
      noResponseTimeoutMs: 300,
      ...(options.permissionDecisionsEnabled === undefined
        ? {}
        : { permissionDecisionsEnabled: options.permissionDecisionsEnabled }),
    },
  );
  const finished = harness.run();
  return { harness, finished, input, output: () => text, trace, calls: fake.calls, fake, exits, counts, launchOptions, gitCaptures, memory };
};

const sessionsCreated = (trace: readonly HarnessTraceEvent[]) =>
  trace.flatMap((event) => (event.event === "session.created" ? [event.sessionID] : []));
const sessionsDeleted = (trace: readonly HarnessTraceEvent[]) =>
  trace.flatMap((event) => (event.event === "session.deleted" && event.verified ? [event.sessionID] : []));

describe("quoder harness (Milestone 1)", () => {
  it("runs several prompts on one server in the project root, each in its own fresh session that is then deleted", async () => {
    const run = startHarness();
    run.input.write("first question\nsecond question\n");
    run.input.end();

    await expect(run.finished).resolves.toBe(0);

    expect(run.counts).toMatchObject({ launched: 1, closed: 1 });
    expect(run.launchOptions[0]?.cwd).toBe("/work/QuackTrack");
    expect(sessionsCreated(run.trace)).toEqual(["ses_1", "ses_2"]);
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1", "ses_2"]);
    expect(run.gitCaptures).toEqual([PROJECT.root, PROJECT.root, PROJECT.root, PROJECT.root]);
    expect(run.calls).toContain("create:ses_1:/work/QuackTrack");
    expect(run.output()).toContain("QuackTrack ❯ ");
    expect(run.output()).toContain("Answer: first question");
    expect(run.output()).toContain("Answer: second question");
    expect(run.trace.at(-1)).toEqual({ event: "server.stopped" });
  });

  it.each([
    ["answered", "plain answer", false],
    ["permission-rejected", "perm denied", false],
    ["failed", "boom failed", false],
    ["cancelled", "slow stop", true],
  ] as const)("captures post-prompt Git state after a %s outcome", async (_outcome, prompt, cancel) => {
    const run = startHarness();
    if (cancel) {
      run.input.write(`${prompt}\n`);
      await vi.waitFor(() => expect(run.calls).toContain("prompt:ses_1"));
      run.harness.interrupt();
      run.input.end();
    } else {
      run.input.end(`${prompt}\n`);
    }

    await expect(run.finished).resolves.toBe(0);

    expect(run.gitCaptures).toEqual([PROJECT.root, PROJECT.root]);
    expect(run.output()).toContain("Git changes observed: none");
    expect(run.calls.indexOf("git:capture:0")).toBeLessThan(run.calls.indexOf("prompt:ses_1"));
    expect(run.calls.indexOf("git:capture:1")).toBeGreaterThan(run.calls.indexOf("delete:ses_1"));
  });

  it("keeps prompt execution working when both Git captures fail", async () => {
    const unavailable: GitSnapshotResult = { kind: "unavailable", root: PROJECT.root, reason: "command-failed" };
    const run = startHarness({ gitSnapshots: [unavailable] });
    run.input.end("answer despite Git failure\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Answer: answer despite Git failure");
    expect(run.output()).toContain("Git state unavailable after the prompt: Git inspection failed.");
    expect(run.gitCaptures).toEqual([PROJECT.root, PROJECT.root]);
  });

  it("summarizes status changes observed across one prompt and keeps pre-existing paths separate", async () => {
    const before = gitSnapshot([
      { path: "baseline.ts", indexStatus: ".", worktreeStatus: "M", submoduleStatus: "N...", kind: "tracked" },
    ]);
    const after = gitSnapshot([
      { path: "baseline.ts", indexStatus: ".", worktreeStatus: "M", submoduleStatus: "N...", kind: "tracked" },
      { path: "new.ts", indexStatus: "?", worktreeStatus: "?", submoduleStatus: "N...", kind: "untracked" },
    ], 1);
    const run = startHarness({ gitSnapshots: [before, after] });
    run.input.end("answer with changes\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Git changes observed: 1 path (1 added)");
    expect(run.output()).toContain("new.ts");
    expect(run.output()).toContain("Pre-existing changes: 1 file");
    expect(run.output()).toContain("baseline.ts");
    expect(run.output()).toContain("Final tracked diff: 1 tracked file (+2 -1)");
  });

  it("offers a paged TTY diff viewer and returns to the continue choice", async () => {
    const before = gitSnapshot();
    const after = gitSnapshot([{ path: "new.ts", indexStatus: "?", worktreeStatus: "?", submoduleStatus: "N...", kind: "untracked" }]);
    const run = startHarness({
      terminal: true,
      gitSnapshots: [before, after],
      gitDiff: { kind: "available", text: `${"diff line\n".repeat(45)}`, truncated: false, omittedBytes: undefined },
    });
    run.input.write("show changes\r");
    await vi.waitFor(() => expect(run.output()).toContain("View diff [v] / Continue [Enter]"));
    run.input.write("v");
    await vi.waitFor(() => expect(run.output()).toContain("Diff 1/2 [n]ext"));
    run.input.write("n");
    await vi.waitFor(() => expect(run.output()).toContain("Diff 2/2 [n]ext"));
    run.input.write("p");
    await vi.waitFor(() => expect(run.output()).toContain("Diff 1/2 [n]ext"));
    run.input.write("q");
    await vi.waitFor(() => expect(run.output()).toContain("View diff [v] / Continue [Enter]"));
    run.input.write("\r\u0004");
    await expect(run.finished).resolves.toBe(0);
    expect(run.output()).toContain("diff line");
  });

  it("prints the sanitized diff automatically in piped mode", async () => {
    const before = gitSnapshot();
    const after = gitSnapshot([{ path: "new.ts", indexStatus: "?", worktreeStatus: "?", submoduleStatus: "N...", kind: "untracked" }]);
    const run = startHarness({
      gitSnapshots: [before, after],
      gitDiff: { kind: "available", text: "diff\u001b[31mred\u001b[0m\n", truncated: true, omittedBytes: 123 },
    });
    run.input.end("show changes\n");
    await expect(run.finished).resolves.toBe(0);
    expect(run.output()).toContain("diffred");
    expect(run.output()).toContain("123 bytes omitted");
    expect(run.output()).not.toContain("\u001b[31m");
  });

  it("does not offer an empty diff choice for a clean TTY repository", async () => {
    const clean = gitSnapshot();
    const run = startHarness({ terminal: true, gitSnapshots: [clean, clean] });
    run.input.write("no changes\r");
    await vi.waitFor(() => expect(run.output()).toContain("Repository state: clean"));
    expect(run.output()).not.toContain("View diff [v]");
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
  });

  it("keeps Ctrl-C exit behavior while waiting at the diff choice", async () => {
    const before = gitSnapshot();
    const after = gitSnapshot([{ path: "new.ts", indexStatus: "?", worktreeStatus: "?", submoduleStatus: "N...", kind: "untracked" }]);
    const run = startHarness({ terminal: true, gitSnapshots: [before, after] });
    run.input.write("show changes\r");
    await vi.waitFor(() => expect(run.output()).toContain("View diff [v] / Continue [Enter]"));
    run.input.write("\u0003");
    await expect(run.finished).resolves.toBe(0);
  });

  it("handles /help, unknown commands, blank lines, and /exit without creating sessions", async () => {
    const run = startHarness();
    run.input.write("/help\n\n/model qwen\n/exit\nnever run\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("/exit          Leave Quoder");
    expect(run.output()).toContain("Unknown command.");
    expect(sessionsCreated(run.trace)).toEqual([]);
    expect(run.counts.closed).toBe(1);
  });

  it("discloses local project memory at startup and documents its sensitive-data controls", async () => {
    const run = startHarness();
    run.input.end("/memory help\n/exit\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Project context memory is stored locally");
    expect(run.output()).toContain("automatic previous-result summary on");
    expect(run.output()).toContain("does not detect or redact secrets");
    expect(run.output()).toContain("/memory auto off");
    expect(sessionsCreated(run.trace)).toEqual([]);
  });

  it("supports inspecting, setting, appending, removing, toggling, and clearing memory without starting sessions", async () => {
    const run = startHarness();
    run.input.end([
      "/memory",
      "/memory objective Add safe CSV import",
      "/memory task Validate headers",
      "/memory add decision Keep the parser dependency-free",
      "/memory add constraint Do not persist Git diffs",
      "/memory add issue Add malformed-row coverage",
      "/memory remove decision 1",
      "/memory auto off",
      "/memory clear task",
      "/memory clear issues",
      "/memory show",
      "/exit",
    ].join("\n"));

    await expect(run.finished).resolves.toBe(0);

    expect(run.memory.saved).toHaveLength(9);
    expect(run.memory.currentLoadResult).toMatchObject({
      status: "loaded",
      memory: {
        objective: "Add safe CSV import",
        task: null,
        decisions: [],
        constraints: ["Do not persist Git diffs"],
        unresolvedIssues: [],
        automaticSummary: false,
      },
    });
    expect(run.output()).toContain("Project memory");
    expect(run.output()).toContain("Constraint 1 saved.");
    expect(run.output()).toContain("Decision 1 removed.");
    expect(run.output()).toContain("Task cleared.");
    expect(sessionsCreated(run.trace)).toEqual([]);
  });

  it("requires explicit whole-memory reset before changing corrupt saved state", async () => {
    const run = startHarness({ initialMemory: { status: "unavailable", reason: "corrupt" } });
    run.input.end("/memory show\n/memory objective Should not save\n/memory clear\n/memory show\n/exit\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("saved project memory is malformed");
    expect(run.output()).toContain("use /memory clear to reset or retry");
    expect(run.memory.store.save).not.toHaveBeenCalled();
    expect(run.memory.store.clear).toHaveBeenCalledTimes(1);
    expect(run.memory.currentLoadResult).toMatchObject({ status: "loaded", memory: emptyProjectMemory() });
    expect(sessionsCreated(run.trace)).toEqual([]);
  });

  it("supports clearing each memory category and resetting all fields to defaults", async () => {
    const initial = {
      ...emptyProjectMemory(),
      objective: "Objective",
      task: "Task",
      decisions: ["Decision"],
      constraints: ["Constraint"],
      unresolvedIssues: ["Issue"],
      previousExecution: {
        requestExcerpt: "Request",
        responseExcerpt: "Response",
        requestTruncated: false,
        responseTruncated: false,
      },
      automaticSummary: false,
    };
    const run = startHarness({ initialMemory: { status: "loaded", memory: initial } });
    run.input.end([
      "/memory remove constraint 1",
      "/memory remove issue 1",
      "/memory auto on",
      "/memory clear objective",
      "/memory clear decisions",
      "/memory clear constraints",
      "/memory clear summary",
      "/memory clear task",
      "/memory clear",
      "/memory show",
      "/exit",
    ].join("\n"));

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Constraint 1 removed.");
    expect(run.output()).toContain("Issue 1 removed.");
    expect(run.output()).toContain("Automatic previous-result summaries enabled.");
    expect(run.output()).toContain("Objective cleared.");
    expect(run.output()).toContain("Decisions cleared.");
    expect(run.output()).toContain("Constraints cleared.");
    expect(run.output()).toContain("Previous summary cleared.");
    expect(run.memory.store.clear).toHaveBeenCalledTimes(1);
    expect(run.memory.currentLoadResult).toEqual({ status: "loaded", memory: emptyProjectMemory() });
  });

  it("does not claim a memory update was saved when storage rejects it", async () => {
    const original = { ...emptyProjectMemory(), objective: "Previously saved" };
    const run = startHarness({
      initialMemory: { status: "loaded", memory: original },
      memorySaveResult: { ok: false, reason: "io-error" },
    });
    run.input.end("/memory objective New value\n/memory show\n/exit\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Could not save project memory: project memory could not be accessed. No changes were saved.");
    expect(run.output()).toContain("Objective: Previously saved");
    expect(run.output()).not.toContain("Objective saved.");
    expect(run.memory.saved).toEqual([]);
    expect(sessionsCreated(run.trace)).toEqual([]);
  });

  it("continues prompts when memory cannot be loaded or reset", async () => {
    const run = startHarness({
      initialMemory: { status: "unavailable", reason: "io-error" },
      memoryClearResult: { ok: false, reason: "io-error" },
    });
    run.input.end("/memory clear\nordinary prompt despite memory error\n/exit\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("project memory could not be accessed");
    expect(run.output()).toContain("Answer: ordinary prompt despite memory error");
    expect(run.memory.saved).toEqual([]);
    expect(sessionsCreated(run.trace)).toEqual(["ses_1"]);
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1"]);
  });

  it("rejects empty, oversized, and out-of-range memory commands", async () => {
    const run = startHarness();
    run.input.end([
      "/memory objective",
      "/memory add decision",
      `/memory task ${"🙂".repeat(501)}`,
      "/memory remove issue 0",
      "/memory typo",
      "/exit",
    ].join("\n"));

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Memory values cannot be empty");
    expect(run.output()).toContain("Memory entries cannot be empty");
    expect(run.output()).toContain("exceeds 500 Unicode characters");
    expect(run.output()).toContain("memory item number does not exist");
    expect(run.output()).toContain("Unknown memory command");
    expect(run.memory.saved).toEqual([]);
    expect(sessionsCreated(run.trace)).toEqual([]);
  });

  it("sanitizes terminal control sequences in saved memory when showing it", async () => {
    const run = startHarness({
      initialMemory: {
        status: "loaded",
        memory: { ...emptyProjectMemory(), objective: "\u001b[31munsafe\u001b[0m" },
      },
    });
    run.input.end("/memory show\n/exit\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Objective: unsafe");
    expect(run.output()).not.toContain("\u001b[31m");
    expect(sessionsCreated(run.trace)).toEqual([]);
  });

  it("handles memory commands from a TTY without changing cancellation behavior", async () => {
    const run = startHarness({ terminal: true });
    run.input.write("/memory task Keep persistent state\r");
    await vi.waitFor(() => expect(run.output()).toContain("Task saved."));
    run.input.write("slow stop\r");
    await vi.waitFor(() => expect(run.calls).toContain("prompt:ses_1"));
    run.harness.interrupt();
    run.input.write("\u0004");

    await expect(run.finished).resolves.toBe(0);

    expect(run.memory.currentLoadResult).toMatchObject({ status: "loaded", memory: { task: "Keep persistent state" } });
    expect(run.output()).toContain("Execution cancelled");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1"]);
  });

  it.each([
    ["a blank line", "\n"],
    ["/help", "/help\n"],
    ["an unknown command", "/nope\n"],
  ])("processes %s queued behind a prompt, then the next prompt, and exits at EOF", async (_name, queued) => {
    const run = startHarness();
    run.input.end(`first\n${queued}second\n`);

    await expect(run.finished).resolves.toBe(0);

    expect(run.output().indexOf("Answer: first")).toBeLessThan(run.output().indexOf("Answer: second"));
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1", "ses_2"]);
    expect(run.counts.closed).toBe(1);
  });

  it("honours /exit queued behind a prompt, even after input has ended", async () => {
    const run = startHarness();
    run.input.end("first\n/exit\nnever run\n");

    await expect(run.finished).resolves.toBe(0);

    expect(sessionsCreated(run.trace)).toEqual(["ses_1"]);
    expect(run.output()).not.toContain("Answer: never run");
    expect(run.counts.closed).toBe(1);
  });

  it("rejects permission requests, never approving them, and reports why the turn ended", async () => {
    const run = startHarness();
    run.input.end("perm read a file outside\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.calls).toContain("permission:per_ses_1:reject");
    expect(run.calls.filter((call) => call.startsWith("permission:") && !call.endsWith(":reject"))).toEqual([]);
    expect(run.output()).toContain("OpenCode asked for permission (external_directory, 1 resource).");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1"]);
  });

  it("reports a rejected permission even when the turn still answers", async () => {
    const run = startHarness();
    run.input.end("permok try something\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Note: OpenCode asked for permission (external_directory, 1 resource); Quoder did not grant it.");
    expect(run.output()).toContain("Answer: permok try something");
  });

  it("stops the prompt and replaces the server when a permission cannot be rejected", async () => {
    const run = startHarness({ permissionReplyFails: true });
    run.input.end("perm read a file outside\nafterwards\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Quoder could not confirm OpenCode's permission decision");
    expect(run.counts.launched).toBe(2);
    expect(run.output()).toContain("Answer: afterwards");
  });

  it("shows a rejected question so the developer can answer it next", async () => {
    const run = startHarness();
    run.input.end("ask me something\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("  Which language? (Rust)");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1"]);
  });

  it("reports a model step error and continues with the next prompt", async () => {
    const run = startHarness();
    run.input.end("boom\nafter the error\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("The prompt did not complete: HTTP transport failed");
    expect(run.output()).toContain("Answer: after the error");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1", "ses_2"]);
  });

  it("Ctrl-C cancels the running prompt, deletes its session, and keeps the harness running", async () => {
    const run = startHarness();
    run.input.write("slow task\n");
    await vi.waitFor(() => expect(run.calls).toContain("prompt:ses_1"));

    run.harness.interrupt();
    await vi.waitFor(() => expect(run.output()).toContain("Execution cancelled after"));
    run.input.end("next prompt\n");

    await expect(run.finished).resolves.toBe(0);
    expect(run.calls).toContain("interrupt:ses_1");
    expect(run.output()).toContain("Cancelling OpenCode execution");
    expect(run.output()).toContain("Answer: next prompt");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1", "ses_2"]);
  });

  it("Ctrl-C while the session is being created cancels without running the prompt, and deletes the session", async () => {
    const createGate = gate();
    const run = startHarness({ createGate });
    run.input.write("slow task\n");
    await vi.waitFor(() => expect(run.output()).toContain("Starting fresh OpenCode session"));

    run.harness.interrupt();
    createGate.release();
    await vi.waitFor(() => expect(run.output()).toContain("Execution cancelled after"));
    run.input.end();

    await expect(run.finished).resolves.toBe(0);
    expect(run.calls).not.toContain("prompt:ses_1");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1"]);
  });

  it("Ctrl-C at an idle prompt leaves Quoder and stops the server", async () => {
    const run = startHarness();
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.harness.interrupt();

    await expect(run.finished).resolves.toBe(0);
    expect(run.counts.closed).toBe(1);
  });

  it("SIGTERM during a prompt cancels it, deletes the session while the server is still up, and exits 143", async () => {
    const run = startHarness();
    run.input.write("slow task\nqueued prompt\n");
    await vi.waitFor(() => expect(run.calls).toContain("prompt:ses_1"));

    run.harness.terminate(143);

    await expect(run.finished).resolves.toBe(143);
    expect(run.calls).toContain("interrupt:ses_1");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1"]);
    expect(sessionsCreated(run.trace)).toEqual(["ses_1"]);
    expect(run.counts.closed).toBe(1);
  });

  it.each([
    ["SIGTERM", (harness: Harness) => harness.terminate(143), 143],
    ["Ctrl-C", (harness: Harness) => harness.interrupt(), 0],
  ])("%s during startup abandons the launch and leaves no server running", async (_name, signal, code) => {
    const launchGate = gate();
    const run = startHarness({ launchGate });
    await vi.waitFor(() => expect(run.launchOptions).toHaveLength(1));

    signal(run.harness);

    await expect(run.finished).resolves.toBe(code);
    expect(run.counts.launched).toBe(run.counts.closed);
    expect(run.output()).not.toContain("Ready.");
  });

  it("closes a server that finishes launching after an exit was requested", async () => {
    const launchGate = gate();
    const run = startHarness({ launchGate });
    await vi.waitFor(() => expect(run.launchOptions).toHaveLength(1));
    // The fake ignores the abort here by opening the gate first, as a launch that completes anyway.
    launchGate.release();
    run.harness.terminate(143);

    await expect(run.finished).resolves.toBe(143);
    expect(run.counts.launched).toBe(run.counts.closed);
  });

  it("starts a new server for the next prompt after the server stops unexpectedly between prompts", async () => {
    const run = startHarness();
    run.input.write("before\n");
    await vi.waitFor(() => expect(run.output()).toContain("Answer: before"));

    run.exits[0]?.();
    await vi.waitFor(() => expect(run.output()).toContain("The OpenCode server stopped unexpectedly"));
    run.input.end("after\n");

    await expect(run.finished).resolves.toBe(0);
    expect(run.counts.launched).toBe(2);
    expect(run.trace.map((event) => event.event)).toContain("server.lost");
    expect(run.output()).toContain("Answer: after");
  });

  it("stops a prompt when the server dies mid-turn, warns, and deletes the session on the next server", async () => {
    const run = startHarness();
    run.input.write("slow task\n");
    await vi.waitFor(() => expect(run.calls).toContain("prompt:ses_1"));

    run.fake.state.dead = true;
    run.exits[0]?.();
    await vi.waitFor(() => expect(run.output()).toContain("Warning: the OpenCode session could not be verified as deleted."));
    run.input.end("after\n");

    await expect(run.finished).resolves.toBe(0);
    expect(run.output()).toContain("The OpenCode server stopped unexpectedly, so the prompt was stopped.");
    expect(run.output()).toContain("Deleted 1 earlier OpenCode session(s)");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1", "ses_2"]);
    expect(run.counts.launched).toBe(2);
  });

  it("stops a prompt when the event monitor is lost and replaces the server before the next prompt", async () => {
    const run = startHarness();
    run.input.write("slow task\n");
    await vi.waitFor(() => expect(run.calls).toContain("prompt:ses_1"));

    run.fake.state.monitor?.onEnded?.();
    await vi.waitFor(() => expect(run.output()).toContain("lost its connection to OpenCode's events"));
    run.input.end("after\n");

    await expect(run.finished).resolves.toBe(0);
    expect(run.calls).toContain("interrupt:ses_1");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1", "ses_2"]);
    expect(run.counts).toMatchObject({ launched: 2, closed: 2 });
  });

  it("stops the prompt and replaces the server when a question cannot be rejected", async () => {
    const run = startHarness();
    run.input.end("askfail me something\nafterwards\n");

    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("Quoder could not reject the model's question.");
    expect(run.counts.launched).toBe(2);
    expect(run.output()).toContain("Answer: afterwards");
  });

  it("reports one notice when the event stream drops before the server exits at idle", async () => {
    const run = startHarness();
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.fake.state.monitor?.onEnded?.();
    run.exits[0]?.();
    run.input.end();

    await expect(run.finished).resolves.toBe(0);
    expect(run.output()).toContain("lost its connection to OpenCode's events");
    expect(run.output()).not.toContain("The OpenCode server stopped unexpectedly");
  });

  it("treats an unconfirmed event monitor as a failed start", async () => {
    const run = startHarness({ monitorUnconfirmed: true });

    await expect(run.finished).resolves.toBe(1);
    expect(run.output()).toContain("Could not start the OpenCode server.");
    expect(run.counts.launched).toBe(run.counts.closed);
  });

  it("exits with status 1 when the server cannot start", async () => {
    const run = startHarness({ launchFails: true });

    await expect(run.finished).resolves.toBe(1);
    expect(run.output()).toContain("Could not start the OpenCode server.");
    expect(sessionsCreated(run.trace)).toEqual([]);
  });
});

describe("quoder harness in an interactive terminal", () => {
  // The CLI enables decisions; this covers the off configuration that embedders and the
  // non-interactive paths still rely on.
  it("denies requests when the permission decision gate is not enabled", async () => {
    const run = startHarness({ terminal: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    run.input.write("perm read outside\r");

    await vi.waitFor(() => expect(run.calls).toContain("permission:per_ses_1:reject"));
    expect(run.output()).toContain("Interactive permission decisions are off in this harness configuration");
    expect(run.output()).not.toContain("[A] Allow once");
    await vi.waitFor(() => expect(run.output()).toContain("OpenCode asked for permission"));
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
  });

  it("waits for an explicit Allow once key before the permission request resolves", async () => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.input.write("perm read outside\r");
    await vi.waitFor(() => expect(run.output()).toContain("OpenCode requests permission"));
    expect(run.output()).toContain("[P] Allow for project (unavailable)");
    expect(run.output()).toContain("/outside/resource");
    run.input.write("a");

    await vi.waitFor(() => expect(run.calls).toContain("permission:per_ses_1:once"));
    await vi.waitFor(() => expect(run.output()).toContain("Answer: perm read outside"));
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
    expect(run.calls.filter((call) => call.startsWith("permission:"))).toEqual(["permission:per_ses_1:once"]);
    expect(run.fake.state.executedOperations.has("ses_1")).toBe(true);
  });

  it("executes a command configured as allowed without asking for permission", async () => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    run.input.write("allowed-command harmless\r");
    await vi.waitFor(() => expect(run.output()).toContain("ALLOWED_COMMAND_EXECUTED"));

    expect(run.calls.filter((call) => call.startsWith("permission:"))).toEqual([]);
    expect(run.fake.state.executedOperations.has("ses_1")).toBe(true);
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
  });

  it("shows exact save patterns and permits project approval only when patterns exist", async () => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true, permissionSave: ["/outside/**"] });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.input.write("perm read outside\r");
    await vi.waitFor(() => expect(run.output()).toContain("/outside/**"));
    run.input.write("p");

    await vi.waitFor(() => expect(run.calls).toContain("permission:per_ses_1:always"));
    await vi.waitFor(() => expect(run.output()).toContain("Answer: perm read outside"));
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
  });

  it("queues simultaneous requests and clears native sibling rejections", async () => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true, permissionRequestCount: 2 });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    run.input.write("perm read outside\r");
    await vi.waitFor(() => expect(run.output()).toContain("OpenCode requests permission (1 of 2)"));

    run.input.write("d");
    await vi.waitFor(() => expect(run.calls).toContain("permission:per_ses_1:reject"));
    await vi.waitFor(() => expect(run.output()).toContain("Permission reply sent to OpenCode"));
    expect(run.calls.filter((call) => call.startsWith("permission:"))).toEqual(["permission:per_ses_1:reject"]);

    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
  });

  it("keeps project approval unavailable when OpenCode supplies no save patterns", async () => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.input.write("perm read outside\r");
    await vi.waitFor(() => expect(run.output()).toContain("OpenCode requests permission"));
    run.input.write("p");
    await vi.waitFor(() => expect(run.output()).toContain("Allow for project is unavailable"));
    expect(run.calls.filter((call) => call.startsWith("permission:"))).toEqual([]);
    run.input.write("d");
    await vi.waitFor(() => expect(run.calls).toContain("permission:per_ses_1:reject"));
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
    expect(run.fake.state.executedOperations.has("ses_1")).toBe(false);
  });

  it.each(["read", "edit"] as const)("asks before an outside-project %s and blocks it after denial", async (operation) => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true, permissionOperation: operation });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    run.input.write(`perm ${operation} outside\r`);
    await vi.waitFor(() => expect(run.output()).toContain(`/outside/${operation}/harmless-target`));
    run.input.write("d");
    await vi.waitFor(() => expect(run.calls).toContain("permission:per_ses_1:reject"));
    await vi.waitFor(() => expect(run.output()).toContain("requested operation did not complete"));

    expect(run.fake.state.executedOperations.has("ses_1")).toBe(false);
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
  });

  it("cancels a pending permission prompt without sending an approval", async () => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    run.input.write("perm read outside\r");
    await vi.waitFor(() => expect(run.output()).toContain("OpenCode requests permission"));

    run.input.write("\u0003");
    await vi.waitFor(() => expect(run.output()).toContain("Execution cancelled after"));
    run.input.write("\u0003");
    await expect(run.finished).resolves.toBe(0);

    expect(run.calls.filter((call) => call.startsWith("permission:"))).toEqual([]);
    expect(run.calls).toContain("interrupt:ses_1");
  });

  it("treats EOF during a permission prompt as cancellation without approving", async () => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    run.input.write("perm read outside\r");
    await vi.waitFor(() => expect(run.output()).toContain("OpenCode requests permission"));

    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);

    expect(run.calls.filter((call) => call.startsWith("permission:"))).toEqual([]);
    expect(run.calls).toContain("interrupt:ses_1");
  });

  it("stops the prompt when an explicit permission reply cannot be confirmed", async () => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true, permissionReplyFails: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    run.input.write("perm read outside\r");
    await vi.waitFor(() => expect(run.output()).toContain("OpenCode requests permission"));
    run.input.write("a");

    await vi.waitFor(() => expect(run.output()).toContain("could not confirm OpenCode's permission decision"));
    run.input.end();
    await expect(run.finished).resolves.toBe(0);

    expect(run.calls.filter((call) => call.startsWith("permission:"))).toEqual(["permission:per_ses_1:once"]);
  });

  it("drops a permission request resolved natively before a developer decision", async () => {
    const run = startHarness({ terminal: true, permissionDecisionsEnabled: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    run.input.write("perm read outside\r");
    await vi.waitFor(() => expect(run.output()).toContain("OpenCode requests permission"));

    run.fake.state.resolvePermission("ses_1");
    run.fake.state.monitor?.onPermissionReplied?.("ses_1", "per_ses_1");
    await vi.waitFor(() => expect(run.output()).toContain("resolved the permission request before Quoder replied"));
    expect(run.calls.filter((call) => call.startsWith("permission:"))).toEqual([]);

    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
  });

  it("refuses typing while busy, cancels on Ctrl-C, hints on a second Ctrl-C, and exits on Ctrl-C when idle", async () => {
    const deleteGate = gate();
    const run = startHarness({ terminal: true, deleteGate });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.input.write("slow task\r");
    await vi.waitFor(() => expect(run.calls).toContain("prompt:ses_1"));
    run.input.write("another prompt\r");
    await vi.waitFor(() => expect(run.output()).toContain("Quoder is still running the previous prompt"));

    run.input.write("\u0003");
    await vi.waitFor(() => expect(run.output()).toContain("Cancelling OpenCode execution"));
    run.input.write("\u0003");
    await vi.waitFor(() => expect(run.output()).toContain("Still cleaning up the cancelled prompt"));
    deleteGate.release();
    await vi.waitFor(() => expect(run.output()).toContain("Execution cancelled after"));

    run.input.write("\u0003");
    await expect(run.finished).resolves.toBe(0);
    expect(run.calls).toContain("interrupt:ses_1");
    expect(run.calls).not.toContain("prompt:ses_2");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1"]);
    expect(run.counts.closed).toBe(1);
  });

  it("exits on Ctrl-D at an empty prompt", async () => {
    const run = startHarness({ terminal: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.input.write("\u0004");

    await expect(run.finished).resolves.toBe(0);
    expect(run.counts.closed).toBe(1);
  });

  it("redraws the prompt after a notice shown while idle", async () => {
    const run = startHarness({ terminal: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.exits[0]?.();
    await vi.waitFor(() => expect(run.output()).toContain("The OpenCode server stopped unexpectedly"));

    const afterNotice = run.output().split("The OpenCode server stopped unexpectedly")[1] ?? "";
    expect(afterNotice).toContain("QuackTrack ❯ ");
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
  });
});

describe("quoder harness live view (Milestone 2)", () => {
  const occurrences = (text: string, part: string) => text.split(part).length - 1;

  it("streams text and tool activity in order, then shows the final status without repeating the answer", async () => {
    const run = startHarness();
    run.input.write("stream please\n");
    run.input.end();
    await expect(run.finished).resolves.toBe(0);

    const output = run.output();
    const order = ["Reading the file.", "✓ ● Read   notes.txt  2 lines", "Streamed answer done.", "✓ Done in"].map((part) => output.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(occurrences(output, "Streamed answer done.")).toBe(1);
    expect(output).toMatch(/✓ Done in \d+\.\ds · 1 tool · 1\.2k tokens/u);
    // Piped output carries no cursor control and no colour.
    expect(output).not.toContain("\u001b");
    const events = run.trace.map((event) => event.event);
    expect(events.indexOf("stream.first-text")).toBeGreaterThan(-1);
    expect(events.indexOf("stream.first-text")).toBeLessThan(events.indexOf("prompt.completed"));
    expect(run.trace).toContainEqual({ event: "activity.tool", tool: "read" });
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1"]);
  });

  it("prints the full answer when the stream missed part of it", async () => {
    const run = startHarness();
    run.input.write("streammiss please\n");
    run.input.end();
    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("(The streamed answer was incomplete; the full answer follows.)");
    expect(run.output()).toContain("Streamed answer done.");
  });

  it("prints an answer that was not streamed at all", async () => {
    const run = startHarness();
    run.input.write("plain question\n");
    run.input.end();
    await expect(run.finished).resolves.toBe(0);

    expect(occurrences(run.output(), "Answer: plain question")).toBe(1);
    expect(run.output()).not.toContain("incomplete");
  });

  it("cancels mid-stream: unfinished tools are marked cancelled and the harness stays active", async () => {
    const run = startHarness();
    run.input.write("streamslow work\nafter cancel\n");
    await vi.waitFor(() => expect(run.output()).toContain("✓ ● Read   notes.txt"));

    run.harness.interrupt();
    await vi.waitFor(() => expect(run.output()).toContain("Execution cancelled after"));
    run.input.end();
    await expect(run.finished).resolves.toBe(0);

    const output = run.output();
    expect(output).toContain("Cancelling OpenCode execution…");
    expect(output).toContain("– $ Run    sleep 60  cancelled");
    expect(output).toContain("Harness session remains active.");
    expect(output.indexOf("Cancelling OpenCode execution")).toBeLessThan(output.indexOf("– $ Run    sleep 60"));
    expect(run.calls).toContain("interrupt:ses_1");
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1", "ses_2"]);
    expect(output).toContain("Answer: after cancel");
  });

  it("draws an animated, erasable status line and colour on an interactive terminal", async () => {
    const run = startHarness({ terminal: true, theme: createTheme(true) });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack"));
    run.input.write("streamslow work\r");
    await vi.waitFor(() => expect(run.output()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u));
    await vi.waitFor(() => expect(run.output()).toContain("Running sleep 60"));

    run.input.write("\u0003");
    await vi.waitFor(() => expect(run.output()).toContain("Execution cancelled after"));
    run.input.write("\u0003");
    await expect(run.finished).resolves.toBe(0);

    const output = run.output();
    expect(output).toContain("\r\u001b[2K");
    expect(output).toContain("\u001b[1m\u001b[36mQuackTrack\u001b[39m\u001b[22m");
    // Status frames never exceed the terminal width (60 columns here).
    const frames = output.split("\r\u001b[2K").map((frame) => frame.split("\n")[0] ?? "");
    for (const frame of frames) expect([...frame.replace(/\u001b\[[0-9;]*m/gu, "")].length).toBeLessThanOrEqual(60);
  });
});

describe("multi-line prompts in an interactive terminal", () => {
  const promptTexts = (run: ReturnType<typeof startHarness>) =>
    (run.fake.client.v2.session.prompt as unknown as { mock: { calls: Array<[{ prompt: { text: string } }]> } }).mock.calls.map(
      ([parameters]) => parameters.prompt.text,
    );

  it("Shift+Return starts a new line under a continuation prompt; Return sends all lines as one prompt", async () => {
    const run = startHarness({ terminal: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.input.write("first line\u001b[13;2u");  // Shift+Return as iTerm2 reports it in the kitty protocol
    await vi.waitFor(() => expect(run.output()).toContain("           … "));
    run.input.write("second line\u001b\rthird line\r");
    await vi.waitFor(() => expect(run.output()).toContain("✓ Done in"));
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);

    expect(promptTexts(run)).toEqual(["first line\nsecond line\nthird line"]);
    // The kitty keyboard protocol is requested at start and popped at exit.
    expect(run.output()).toContain("\u001b[>1u");
    expect(run.output().lastIndexOf("\u001b[<u")).toBeGreaterThan(run.output().indexOf("\u001b[>1u"));
    expect(sessionsCreated(run.trace)).toHaveLength(1);
  });

  it("Ctrl-C at a continuation line discards the unfinished prompt and keeps Quoder running", async () => {
    const run = startHarness({ terminal: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.input.write("draft\u001b[13;2umore");
    // Readline positions the cursor after the prompt before echoing typed text.
    await vi.waitFor(() => expect(run.output()).toMatch(/ … (?:\u001b\[\d+G)?more/u));
    run.input.write("\u001b[99;5u"); // Ctrl+C as the kitty protocol encodes it
    run.input.write("real prompt\r");
    await vi.waitFor(() => expect(run.output()).toContain("✓ Done in"));
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);

    expect(promptTexts(run)).toEqual(["real prompt"]);
  });

  it("stays in step after keys readline does not turn into a line (review cycle 1)", async () => {
    const run = startHarness({ terminal: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    // Kitty Ctrl+J continues; kitty Esc right before Return must not swallow that Return.
    run.input.write("one\u001b[106;5utwo\u001b[27u\r");
    await vi.waitFor(() => expect(run.output()).toContain("✓ Done in"));
    // Afterwards Shift+Return still continues and Return still submits.
    run.input.write("three\u001b[13;2ufour\r");
    await vi.waitFor(() => expect(promptTexts(run)).toHaveLength(2));
    await vi.waitFor(() => expect(run.output().split("✓ Done in")).toHaveLength(3));
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);

    expect(promptTexts(run)).toEqual(["one\ntwo", "three\nfour"]);
  });

  it("sends a bracketed paste of several lines as one prompt once Return is pressed", async () => {
    const run = startHarness({ terminal: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));

    run.input.write("\u001b[200~line one\rline two\u001b[201~");
    await vi.waitFor(() => expect(run.output()).toMatch(/ … (?:\u001b\[\d+G)?line two/u));
    expect(promptTexts(run)).toEqual([]);
    run.input.write("\r");
    await vi.waitFor(() => expect(run.output()).toContain("✓ Done in"));
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);

    expect(promptTexts(run)).toEqual(["line one\nline two"]);
    expect(run.output()).toContain("\u001b[?2004h");
    expect(run.output()).toContain("\u001b[?2004l");
  });

  it("removes its process exit hook when it shuts down", async () => {
    const before = process.listenerCount("exit");
    const run = startHarness({ terminal: true });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    expect(process.listenerCount("exit")).toBe(before + 1);
    run.input.write("\u0004");
    await expect(run.finished).resolves.toBe(0);
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("treats each piped line as its own prompt", async () => {
    const run = startHarness();
    run.input.write("one\ntwo\n");
    run.input.end();
    await expect(run.finished).resolves.toBe(0);

    expect(promptTexts(run)).toEqual(["one", "two"]);
  });
});

describe("harness messages while the status line is shown (review cycle 1)", () => {
  /**
   * Status frames that were committed to the scrollback: a frame (text after an erase that starts
   * with the spinner) must be erased again before anything else, so it may never contain a newline.
   */
  const committedFrames = (output: string) =>
    output
      .split("\r\u001b[2K")
      .slice(1)
      .filter((frame) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u.test(frame) && frame.includes("\n"));

  it("erases the status line before Quoder's own messages", async () => {
    const deleteGate = gate();
    const run = startHarness({ terminal: true, deleteGate });
    await vi.waitFor(() => expect(run.output()).toContain("QuackTrack ❯ "));
    run.input.write("slow work\r");
    await vi.waitFor(() => expect(run.calls).toContain("prompt:ses_1"));
    await vi.waitFor(() => expect(run.output()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /u));

    run.input.write("typed while busy\r");
    await vi.waitFor(() => expect(run.output()).toContain("still running the previous prompt"));
    run.input.write("\u0003");
    await vi.waitFor(() => expect(run.calls).toContain("interrupt:ses_1"));
    await new Promise((resolvePause) => setTimeout(resolvePause, 150));
    run.input.write("\u0003");
    await vi.waitFor(() => expect(run.output()).toContain("Still cleaning up the cancelled prompt"));
    deleteGate.release();
    await vi.waitFor(() => expect(run.output()).toContain("Execution cancelled after"));
    run.input.write("\u0003");
    await expect(run.finished).resolves.toBe(0);

    expect(committedFrames(run.output())).toEqual([]);
    // Typing while busy is neither echoed nor run.
    expect(run.output()).not.toContain("typed while busy");
    expect(run.calls.filter((call) => call.startsWith("prompt:"))).toEqual(["prompt:ses_1"]);
  });
});

describe("prompts OpenCode drops (Milestone 2 QA)", () => {
  it("sends a dropped prompt again in a fresh session, says so, and deletes both sessions", async () => {
    const run = startHarness();
    run.input.write("drop this one\nnext\n");
    run.input.end();
    await expect(run.finished).resolves.toBe(0);

    expect(run.output()).toContain("OpenCode did not start on the prompt; sending it again in a fresh session…");
    expect(run.output()).toContain("Answer: drop this one");
    expect(run.output()).toContain("Answer: next");
    expect(sessionsCreated(run.trace)).toEqual(["ses_1", "ses_2", "ses_3"]);
    expect(sessionsDeleted(run.trace)).toEqual(["ses_1", "ses_2", "ses_3"]);
    const events = run.trace.map((event) => event.event);
    expect(events.filter((event) => event === "prompt.started")).toHaveLength(2);
    expect(events.filter((event) => event === "prompt.retried")).toHaveLength(1);
    expect(events.filter((event) => event === "prompt.completed")).toHaveLength(2);
    expect(run.gitCaptures).toHaveLength(4);
    expect(run.calls.indexOf("git:capture:1")).toBeGreaterThan(run.calls.indexOf("delete:ses_2"));
    expect(run.calls.indexOf("git:capture:1")).toBeLessThan(run.calls.indexOf("git:capture:2"));
  });
});
