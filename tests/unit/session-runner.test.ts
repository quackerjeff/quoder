import { describe, expect, it, vi } from "vitest";

import { SessionTracker, runPrompt, summarizeQuestions } from "../../src/harness/session-runner.js";
import type { OpenCodeAdapter } from "../../src/opencode-adapter.js";

const MODEL = { providerID: "ollama", id: "glm-4.7-flash:latest" };

const user = (id: string) => ({ id, type: "user", time: { created: 1 }, text: "prompt" });
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  id: `assistant-${text}`,
  type: "assistant",
  time: { created: 2, completed: 3 },
  agent: "build",
  model: MODEL,
  content: [{ type: "text", id: "t", text }],
  ...extra,
});

interface FakeTurn {
  /** Messages returned once the session is idle. */
  readonly messages: unknown[];
  /** Number of `isActive` polls that report running before idle. */
  readonly runningPolls?: number;
  /** Stays running until interrupted. */
  readonly runsUntilInterrupted?: boolean;
  readonly promptFails?: boolean;
  readonly deleteFails?: boolean;
  readonly createFails?: boolean;
}

const fakeAdapter = (turn: FakeTurn) => {
  const calls: string[] = [];
  let sessions = 0;
  let polls = 0;
  let interrupted = false;
  const adapter = {
    createSession: vi.fn(async (options: { directory: string; model: unknown }) => {
      calls.push(`create:${options.directory}`);
      if (turn.createFails) throw new Error("create session: unavailable");
      return { id: `ses_${++sessions}` };
    }),
    prompt: vi.fn(async (sessionID: string) => {
      calls.push(`prompt:${sessionID}`);
      if (turn.promptFails) throw new Error("submit prompt: rejected");
      return { id: "input-1" };
    }),
    isActive: vi.fn(async () => {
      polls++;
      if (turn.runsUntilInterrupted) return !interrupted;
      return polls <= (turn.runningPolls ?? 0);
    }),
    messages: vi.fn(async () => ({ data: turn.messages, cursor: {} })),
    interrupt: vi.fn(async (sessionID: string) => {
      calls.push(`interrupt:${sessionID}`);
      interrupted = true;
    }),
    waitUntilIdle: vi.fn(async (sessionID: string) => {
      calls.push(`idle:${sessionID}`);
    }),
    deleteSession: vi.fn(async (sessionID: string) => {
      calls.push(`delete:${sessionID}`);
      if (turn.deleteFails) throw new Error("verify session deletion: not confirmed");
    }),
  };
  return { adapter: adapter as unknown as OpenCodeAdapter, calls, raw: adapter };
};

const run = (adapter: OpenCodeAdapter, tracker = new SessionTracker(), cancel = new AbortController().signal, extra = {}) =>
  runPrompt({
    adapter,
    tracker,
    directory: "/work/QuackTrack",
    model: MODEL,
    prompt: "Add validation",
    cancel,
    pollIntervalMs: 1,
    ...extra,
  });

describe("one prompt in one fresh OpenCode session", () => {
  it("answers, then deletes the session it created, binding the model and project directory", async () => {
    const { adapter, calls, raw } = fakeAdapter({ messages: [user("input-1"), assistant("Done.")], runningPolls: 2 });
    const tracker = new SessionTracker();

    const result = await run(adapter, tracker);

    expect(result).toMatchObject({ sessionID: "ses_1", outcome: { kind: "answered", text: "Done." }, sessionDeleted: true });
    expect(raw.createSession).toHaveBeenCalledWith({ directory: "/work/QuackTrack", model: MODEL });
    expect(calls).toEqual(["create:/work/QuackTrack", "prompt:ses_1", "delete:ses_1"]);
    expect(tracker.owns("ses_1")).toBe(false);
  });

  it("uses a different session for every prompt", async () => {
    const { adapter, calls } = fakeAdapter({ messages: [user("input-1"), assistant("ok")] });

    const first = await run(adapter);
    const second = await run(adapter);

    expect([first.sessionID, second.sessionID]).toEqual(["ses_1", "ses_2"]);
    expect(calls.filter((call) => call.startsWith("delete:"))).toEqual(["delete:ses_1", "delete:ses_2"]);
  });

  it("reports a rejected permission as the reason the turn ended", async () => {
    const { adapter } = fakeAdapter({
      messages: [user("input-1"), { ...assistant(""), time: { created: 2 }, content: [{ type: "tool", tool: "read" }] }],
    });
    const tracker = new SessionTracker();
    const original = tracker.register.bind(tracker);
    vi.spyOn(tracker, "register").mockImplementation((sessionID) => {
      original(sessionID);
      tracker.notePermission({ sessionID, requestID: "per_1", action: "external_directory", resourceCount: 1 });
    });

    const result = await run(adapter, tracker);

    expect(result.outcome).toEqual({ kind: "permission-rejected", action: "external_directory", resourceCount: 1 });
    expect(result.sessionDeleted).toBe(true);
  });

  it("reports a rejected question with its text and options", async () => {
    const { adapter } = fakeAdapter({ messages: [user("input-1"), { ...assistant(""), time: { created: 2 } }] });
    const tracker = new SessionTracker();
    const original = tracker.register.bind(tracker);
    vi.spyOn(tracker, "register").mockImplementation((sessionID) => {
      original(sessionID);
      tracker.noteQuestion({
        sessionID,
        requestID: "que_1",
        questions: [{ question: "Which language?", header: "Language", options: [{ label: "Rust" }, { label: "Go" }] }],
      });
    });

    const result = await run(adapter, tracker);

    expect(result.outcome).toEqual({
      kind: "question-rejected",
      questions: [{ question: "Which language?", options: ["Rust", "Go"] }],
    });
  });

  it("reports a step error from the final assistant message", async () => {
    const { adapter } = fakeAdapter({
      messages: [user("input-1"), assistant("partial", { finish: "error", error: { type: "unknown", message: "HTTP transport failed" } })],
    });

    await expect(run(adapter)).resolves.toMatchObject({ outcome: { kind: "failed", reason: "HTTP transport failed" } });
  });

  it("reports an empty response as a failure, not an answer", async () => {
    const { adapter } = fakeAdapter({ messages: [user("input-1"), assistant("   ")] });

    await expect(run(adapter)).resolves.toMatchObject({
      outcome: { kind: "failed", reason: "The model returned an empty response" },
    });
  });

  it("cancels a running turn: interrupts, settles, and still deletes the session", async () => {
    const { adapter, calls } = fakeAdapter({ messages: [user("input-1")], runsUntilInterrupted: true });
    const cancel = new AbortController();
    const pending = run(adapter, new SessionTracker(), cancel.signal, { pollIntervalMs: 5 });
    await vi.waitFor(() => expect(calls).toContain("prompt:ses_1"));

    cancel.abort();
    const result = await pending;

    expect(result.outcome).toEqual({ kind: "cancelled" });
    expect(calls.slice(-3)).toEqual(["interrupt:ses_1", "idle:ses_1", "delete:ses_1"]);
    expect(result.sessionDeleted).toBe(true);
  });

  it("settles, then deletes the session when the prompt submission fails", async () => {
    const { adapter, calls } = fakeAdapter({ messages: [], promptFails: true });

    const result = await run(adapter);

    expect(result.outcome).toEqual({ kind: "failed", reason: "submit prompt: rejected" });
    expect(calls).toEqual(["create:/work/QuackTrack", "prompt:ses_1", "interrupt:ses_1", "idle:ses_1", "delete:ses_1"]);
  });

  it("settles a possibly running session before deleting it when polling fails mid-turn", async () => {
    const { adapter, calls, raw } = fakeAdapter({ messages: [user("input-1")], runningPolls: 5 });
    raw.isActive.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("list active sessions: timed out after 30000ms"));

    const result = await run(adapter);

    expect(result.outcome).toEqual({ kind: "failed", reason: "list active sessions: timed out after 30000ms" });
    expect(calls.slice(-3)).toEqual(["interrupt:ses_1", "idle:ses_1", "delete:ses_1"]);
  });

  it("does not interrupt a turn that ended idle", async () => {
    const { adapter, calls } = fakeAdapter({ messages: [user("input-1"), assistant("ok")] });

    await run(adapter);

    expect(calls.some((call) => call.startsWith("interrupt:"))).toBe(false);
  });

  it("creates no session when cancelled before it starts", async () => {
    const { adapter, calls } = fakeAdapter({ messages: [] });
    const cancel = new AbortController();
    cancel.abort();

    await expect(run(adapter, new SessionTracker(), cancel.signal)).resolves.toMatchObject({
      sessionID: undefined,
      outcome: { kind: "cancelled" },
      sessionDeleted: true,
    });
    expect(calls).toEqual([]);
  });

  it("reports a harness stop reason instead of a plain cancellation", async () => {
    const { adapter, calls } = fakeAdapter({ messages: [user("input-1")], runsUntilInterrupted: true });
    const cancel = new AbortController();
    const pending = run(adapter, new SessionTracker(), cancel.signal, { pollIntervalMs: 5 });
    await vi.waitFor(() => expect(calls).toContain("prompt:ses_1"));

    cancel.abort({ stopped: "The OpenCode server stopped unexpectedly, so the prompt was stopped." });

    await expect(pending).resolves.toMatchObject({
      outcome: { kind: "failed", reason: "The OpenCode server stopped unexpectedly, so the prompt was stopped." },
      sessionDeleted: true,
    });
  });

  it("carries rejected permissions and questions with an answered turn", async () => {
    const { adapter } = fakeAdapter({ messages: [user("input-1"), assistant("Done anyway.")] });
    const tracker = new SessionTracker();
    const original = tracker.register.bind(tracker);
    vi.spyOn(tracker, "register").mockImplementation((sessionID) => {
      original(sessionID);
      tracker.notePermission({ sessionID, requestID: "per_1", action: "external_directory", resourceCount: 1 });
      tracker.noteQuestion({ sessionID, requestID: "que_1", questions: [{ question: "Sure?", options: [] }] });
    });

    const result = await run(adapter, tracker);

    expect(result.outcome).toEqual({ kind: "answered", text: "Done anyway." });
    expect(result.rejectedPermissions).toEqual([{ action: "external_directory", resourceCount: 1 }]);
    expect(result.rejectedQuestions).toEqual([{ question: "Sure?", options: [] }]);
  });

  it("reports an unverified deletion", async () => {
    const { adapter } = fakeAdapter({ messages: [user("input-1"), assistant("ok")], deleteFails: true });

    await expect(run(adapter)).resolves.toMatchObject({ outcome: { kind: "answered" }, sessionDeleted: false });
  });

  it("fails without deleting anything when no session could be created", async () => {
    const { adapter, calls } = fakeAdapter({ messages: [], createFails: true });

    await expect(run(adapter)).resolves.toMatchObject({
      sessionID: undefined,
      outcome: { kind: "failed", reason: "create session: unavailable" },
      sessionDeleted: true,
    });
    expect(calls).toEqual(["create:/work/QuackTrack"]);
  });

  it("fails a turn that stays idle without any assistant message", async () => {
    let clock = 0;
    const { adapter, calls } = fakeAdapter({ messages: [user("input-1")] });

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, {
      noResponseTimeoutMs: 1_000,
      now: () => (clock += 400),
    });

    expect(result.outcome).toEqual({ kind: "failed", reason: "OpenCode did not start a response" });
    expect(calls.slice(-3)).toEqual(["interrupt:ses_1", "idle:ses_1", "delete:ses_1"]);
  });
});

describe("question summaries from untrusted payloads", () => {
  it("keeps only well-formed questions and option labels", () => {
    expect(summarizeQuestions([
      { question: "Q1", options: [{ label: "A" }, { nope: 1 }, "B"] },
      { header: "no question" },
      null,
      { question: "Q2" },
    ])).toEqual([{ question: "Q1", options: ["A"] }, { question: "Q2", options: [] }]);
    expect(summarizeQuestions("not an array")).toEqual([]);
  });
});
