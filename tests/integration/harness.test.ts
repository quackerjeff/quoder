import { PassThrough } from "node:stream";

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, expect, it, vi } from "vitest";

import type { EventMonitorOptions } from "../../src/event-monitor.js";
import { Harness, type HarnessTraceEvent } from "../../src/harness/repl.js";
import type { AuthenticatedServerOptions } from "../../src/opencode-server.js";
import { createTheme, type Theme } from "../../src/ui/style.js";

const MODEL = { providerID: "ollama", id: "glm-4.7-flash:latest" };
const PROJECT = { root: "/work/QuackTrack", name: "QuackTrack" };

const response = (status = 200): Response => new Response(null, { status });
const result = <T>(data: T, status = 200) => ({ data, error: undefined, response: response(status) });
const failedResult = (error: unknown, status: number) => ({ data: undefined, error, response: response(status) });

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
  /** Session deletion waits until this gate opens. */
  readonly deleteGate?: ReturnType<typeof gate>;
}

/**
 * A fake OpenCode behind the real adapter. Prompt text selects the scripted behaviour:
 * "perm…" raises a permission request (and ends the turn), "permok…" raises one and still answers,
 * "ask…" raises a question, "slow…" runs until interrupted, "boom…" ends with a step error;
 * "stream…" streams text and a read tool before answering ("streammiss…" drops part of the final
 * text from the stream; "streamslow…" streams, starts a bash tool, and runs until interrupted);
 * anything else is answered with "Answer: <prompt>". While `dead`, every call fails like a
 * stopped server.
 */
const fakeOpenCode = (options: FakeOptions = {}) => {
  const calls: string[] = [];
  const state = { dead: false, monitor: undefined as EventMonitorOptions | undefined };
  let sessions = 0;
  const prompts = new Map<string, string>();
  const interrupted = new Set<string>();
  const deleted = new Set<string>();
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
  const turn = (sessionID: string) => {
    const prompt = prompts.get(sessionID) ?? "";
    const userMessage = { id: `input-${sessionID}`, type: "user", time: { created: 1 }, text: prompt };
    const done = (text: string, extra: Record<string, unknown> = {}) =>
      ({ id: `asst-${sessionID}`, type: "assistant", time: { created: 2, completed: 3 }, agent: "build", model: MODEL, content: [{ type: "text", id: "t", text }], ...extra });
    if (prompt.startsWith("permok")) return [userMessage, done(`Answer: ${prompt}`)];
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
          if (text.startsWith("perm")) {
            state.monitor?.onPermissionAsked?.({ sessionID, requestID: `per_${sessionID}`, action: "external_directory", resourceCount: 1 });
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
          return result({ data: Object.fromEntries(running.map((id) => [id, { type: "running" }])) });
        }),
        messages: vi.fn(async (parameters: { sessionID: string }) => {
          await alive();
          return result({ data: turn(parameters.sessionID), cursor: {} });
        }),
        interrupt: vi.fn(async (parameters: { sessionID: string }) => {
          await alive();
          calls.push(`interrupt:${parameters.sessionID}`);
          interrupted.add(parameters.sessionID);
          return result(undefined, 204);
        }),
        get: vi.fn(async (parameters: { sessionID: string }) => {
          await alive();
          return deleted.has(parameters.sessionID)
            ? failedResult({ _tag: "SessionNotFoundError", message: "not found" }, 404)
            : result({ data: { id: parameters.sessionID } });
        }),
        permission: {
          reply: vi.fn(async (parameters: { requestID: string; reply: string }) => {
            await alive();
            calls.push(`permission:${parameters.requestID}:${parameters.reply}`);
            if (options.permissionReplyFails) throw new TypeError("fetch failed");
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
}

const startHarness = (options: HarnessRunOptions = {}) => {
  const fake = fakeOpenCode(options);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  const trace: HarnessTraceEvent[] = [];
  const exits: Array<() => void> = [];
  const launchOptions: AuthenticatedServerOptions[] = [];
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
    },
  );
  const finished = harness.run();
  return { harness, finished, input, output: () => text, trace, calls: fake.calls, fake, exits, counts, launchOptions };
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
    expect(run.calls).toContain("create:ses_1:/work/QuackTrack");
    expect(run.output()).toContain("QuackTrack ❯ ");
    expect(run.output()).toContain("Answer: first question");
    expect(run.output()).toContain("Answer: second question");
    expect(run.trace.at(-1)).toEqual({ event: "server.stopped" });
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

    expect(run.output()).toContain("Quoder could not reject OpenCode's permission request");
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
