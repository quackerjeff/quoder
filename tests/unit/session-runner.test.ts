import { describe, expect, it, vi } from "vitest";

import { SessionTracker, runPrompt, summarizeQuestions } from "../../src/harness/session-runner.js";
import { formatResult } from "../../src/harness/format.js";
import type { OpenCodeAdapter } from "../../src/opencode-adapter.js";
import type { OwnedSessionLedger } from "../../src/harness/owned-session-ledger.js";

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
  /** Per-session messages, overriding `messages` (for example a dropped first session). */
  readonly messagesBySession?: Readonly<Record<string, unknown[]>>;
  /** Number of `isActive` polls that report running before idle. */
  readonly runningPolls?: number;
  /** Stays running until interrupted. */
  readonly runsUntilInterrupted?: boolean;
  readonly promptFails?: boolean;
  readonly deleteFails?: boolean;
  readonly createFails?: boolean;
  readonly deleteFailsFor?: string;
}

const fakeAdapter = (turn: FakeTurn) => {
  const calls: string[] = [];
  let sessions = 0;
  let polls = 0;
  let interrupted = false;
  const adapter = {
    createSession: vi.fn(async (options: { directory: string; id?: string; model: unknown; agent: string }) => {
      calls.push(`create:${options.directory}`);
      if (turn.createFails) throw new Error("create session: unavailable");
      return { id: `ses_${++sessions}` };
    }),
    prompt: vi.fn(async (sessionID: string) => {
      calls.push(`prompt:${sessionID}`);
      if (turn.promptFails) throw new Error("submit prompt: rejected");
      return { id: "input-1" };
    }),
    isActive: vi.fn(async (_sessionID: string) => {
      polls++;
      if (turn.runsUntilInterrupted) return !interrupted;
      return polls <= (turn.runningPolls ?? 0);
    }),
    messages: vi.fn(async (sessionID: string) => ({ data: turn.messagesBySession?.[sessionID] ?? turn.messages, cursor: {} })),
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
      if (turn.deleteFailsFor === sessionID) throw new Error("verify session deletion: not confirmed");
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

describe("session tree ownership", () => {
  it("associates child sessions with one execution and excludes unrelated sessions", () => {
    const tracker = new SessionTracker();
    tracker.register("parent");

    expect(tracker.registerChild("child", "parent")).toBe(true);
    expect(tracker.registerChild("grandchild", "child")).toBe(true);
    expect(tracker.registerChild("unrelated", "unknown-parent")).toBe(false);
    expect(tracker.owns("grandchild")).toBe(true);
    expect(tracker.owns("unrelated")).toBe(false);

    tracker.notePermission({ sessionID: "child", requestID: "p-child", action: "bash", resourceCount: 1, resources: ["/tmp/x"], save: [] });
    tracker.noteQuestion({ sessionID: "grandchild", requestID: "q-grandchild", questions: [] });
    expect(tracker.permissions("parent")).toHaveLength(1);
    expect(tracker.questions("parent")).toHaveLength(1);

    tracker.unregister("parent");
    expect(tracker.owns("parent")).toBe(false);
    expect(tracker.owns("child")).toBe(false);
    expect(tracker.owns("grandchild")).toBe(false);
  });
});

describe("one prompt in one fresh OpenCode session", () => {
  it("reports a failed ownership-ledger prepare as sanitized local state without creating a session", async () => {
    const { adapter, raw } = fakeAdapter({ messages: [] });
    const secret = "private ledger contents";
    const ledger: OwnedSessionLedger = {
      list: vi.fn(async () => ({ status: "available" as const, records: [] })),
      prepare: vi.fn(async () => { throw new Error(secret); }),
      markCreated: vi.fn(async () => undefined),
      markAmbiguous: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, { ownedSessionLedger: ledger });
    const output = formatResult(result);

    expect(result.outcome).toMatchObject({ kind: "failed", category: "Local state" });
    expect(output).toContain("Local state:");
    expect(output).not.toContain(secret);
    expect(raw.createSession).not.toHaveBeenCalled();
    expect(ledger.markAmbiguous).not.toHaveBeenCalled();
    expect(ledger.remove).not.toHaveBeenCalled();
  });

  it("reports a failed ownership-ledger markCreated as local state and preserves uncertain ownership", async () => {
    const { adapter, calls, raw } = fakeAdapter({ messages: [], deleteFails: true });
    raw.createSession.mockImplementation(async (options) => ({ id: options.id! }));
    const secret = "private ledger contents";
    const ledger: OwnedSessionLedger = {
      list: vi.fn(async () => ({ status: "available" as const, records: [] })),
      prepare: vi.fn(async () => undefined),
      markCreated: vi.fn(async () => { throw new Error(secret); }),
      markAmbiguous: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, { ownedSessionLedger: ledger });
    const output = formatResult(result);

    expect(result.outcome).toMatchObject({ kind: "failed", category: "Local state" });
    expect(output).toContain("Local state:");
    expect(output).not.toContain(secret);
    expect(result.sessionDeleted).toBe(false);
    expect(calls.some((call) => call.startsWith("interrupt:"))).toBe(true);
    expect(calls.some((call) => call.startsWith("delete:"))).toBe(true);
    expect(ledger.remove).not.toHaveBeenCalled();
  });

  it("persists the exact random intent before create and retires it only after verified deletion", async () => {
    const { adapter, calls, raw } = fakeAdapter({ messages: [user("input-1"), assistant("Done.")] });
    const order: string[] = [];
    raw.createSession.mockImplementation(async (options) => {
      order.push(`create:${options.id}`);
      return { id: options.id! };
    });
    const ledger: OwnedSessionLedger = {
      list: vi.fn(async () => ({ status: "available" as const, records: [] })),
      prepare: vi.fn(async (id) => { order.push(`intent:${id}`); }),
      markCreated: vi.fn(async (id) => { order.push(`created:${id}`); }),
      markAmbiguous: vi.fn(async (id) => { order.push(`ambiguous:${id}`); }),
      remove: vi.fn(async (id) => { order.push(`remove:${id}`); }),
    };

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, { ownedSessionLedger: ledger });

    expect(result.sessionDeleted).toBe(true);
    expect(order).toHaveLength(4);
    const id = order[0]?.slice("intent:".length);
    expect(id).toMatch(/^ses_[a-f0-9]{24}$/u);
    expect(order).toEqual([`intent:${id}`, `create:${id}`, `created:${id}`, `remove:${id}`]);
  });

  it("quarantines a conflicting or ambiguous create result and never deletes its candidate ID", async () => {
    const { adapter, calls, raw } = fakeAdapter({ messages: [] });
    raw.createSession.mockRejectedValueOnce(new Error("session ID conflict"));
    const states: string[] = [];
    const ledger: OwnedSessionLedger = {
      list: vi.fn(async () => ({ status: "available" as const, records: [] })),
      prepare: vi.fn(async (id) => { states.push(`intent:${id}`); }),
      markCreated: vi.fn(async (id) => { states.push(`created:${id}`); }),
      markAmbiguous: vi.fn(async (id) => { states.push(`ambiguous:${id}`); }),
      remove: vi.fn(async (id) => { states.push(`remove:${id}`); }),
    };

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, { ownedSessionLedger: ledger });

    expect(result.outcome.kind).toBe("failed");
    expect(states[0]).toMatch(/^intent:ses_[a-f0-9]{24}$/u);
    expect(states[1]).toBe(states[0]?.replace("intent:", "ambiguous:"));
    expect(states).toHaveLength(2);
    expect(calls.some((call) => call.startsWith("delete:"))).toBe(false);
  });

  it("reports a failed ambiguous-state ledger write as local state and leaves the intent unconfirmed", async () => {
    const { adapter, calls, raw } = fakeAdapter({ messages: [] });
    raw.createSession.mockRejectedValue(new Error("session create outcome is ambiguous"));
    let persistedState: "intent" | "ambiguous" = "intent";
    const ledger: OwnedSessionLedger = {
      list: vi.fn(async () => ({ status: "available" as const, records: [] })),
      prepare: vi.fn(async () => { persistedState = "intent"; }),
      markCreated: vi.fn(async () => undefined),
      markAmbiguous: vi.fn(async () => { throw new Error("ledger write failed"); }),
      remove: vi.fn(async () => undefined),
    };

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, { ownedSessionLedger: ledger });

    expect(result.outcome).toMatchObject({ kind: "failed", category: "Local state" });
    expect(ledger.markAmbiguous).toHaveBeenCalledTimes(1);
    expect(persistedState).toBe("intent");
    expect(calls.some((call) => call.startsWith("delete:"))).toBe(false);
    expect(ledger.remove).not.toHaveBeenCalled();
  });

  it("keeps a ledger intent when session deletion cannot be verified", async () => {
    const { adapter, raw } = fakeAdapter({ messages: [user("input-1"), assistant("Done.")], deleteFails: true });
    raw.createSession.mockImplementation(async (options) => ({ id: options.id! }));
    const removed: string[] = [];
    const ledger: OwnedSessionLedger = {
      list: vi.fn(async () => ({ status: "available" as const, records: [] })),
      prepare: vi.fn(async () => undefined),
      markCreated: vi.fn(async () => undefined),
      markAmbiguous: vi.fn(async () => undefined),
      remove: vi.fn(async (id) => { removed.push(id); }),
    };

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, { ownedSessionLedger: ledger });

    expect(result.sessionDeleted).toBe(false);
    expect(removed).toEqual([]);
  });

  it("answers, then deletes the session it created, binding the model and project directory", async () => {
    const { adapter, calls, raw } = fakeAdapter({ messages: [user("input-1"), assistant("Done.")], runningPolls: 2 });
    const tracker = new SessionTracker();

    const result = await run(adapter, tracker);

    expect(result).toMatchObject({ sessionID: "ses_1", outcome: { kind: "answered", text: "Done." }, sessionDeleted: true });
    expect(raw.createSession).toHaveBeenCalledWith({ directory: "/work/QuackTrack", model: MODEL, agent: "build" });
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

  it("binds a selected agent to every fresh session attempt", async () => {
    const { adapter, raw } = fakeAdapter({ messages: [user("input-1"), assistant("Done.")] });

    await run(adapter, new SessionTracker(), new AbortController().signal, { agent: "reviewer" });

    expect(raw.createSession).toHaveBeenCalledWith({ directory: "/work/QuackTrack", model: MODEL, agent: "reviewer" });
  });

  it("reports a rejected permission as the reason the turn ended", async () => {
    const { adapter } = fakeAdapter({
      messages: [user("input-1"), { ...assistant(""), time: { created: 2 }, content: [{ type: "tool", tool: "read" }] }],
    });
    const tracker = new SessionTracker();
    const original = tracker.register.bind(tracker);
    vi.spyOn(tracker, "register").mockImplementation((sessionID) => {
      original(sessionID);
      tracker.notePermission({ sessionID, requestID: "per_1", action: "external_directory", resourceCount: 1, resources: ["/outside"], save: [] });
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

    await expect(run(adapter)).resolves.toMatchObject({ outcome: { kind: "failed", category: "OpenCode", reason: "OpenCode reported a session failure" } });
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

    expect(result.outcome).toEqual({ kind: "failed", reason: "submit prompt: rejected", category: "OpenCode" });
    expect(calls).toEqual(["create:/work/QuackTrack", "prompt:ses_1", "interrupt:ses_1", "idle:ses_1", "delete:ses_1"]);
  });

  it("settles a possibly running session before deleting it when polling fails mid-turn", async () => {
    const { adapter, calls, raw } = fakeAdapter({ messages: [user("input-1")], runningPolls: 5 });
    raw.isActive.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("list active sessions: timed out after 30000ms"));

    const result = await run(adapter);

    expect(result.outcome).toEqual({ kind: "failed", reason: "list active sessions: timed out after 30000ms", category: "OpenCode" });
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
      tracker.notePermission({ sessionID, requestID: "per_1", action: "external_directory", resourceCount: 1, resources: ["/outside"], save: [] });
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

  it("sends a dropped prompt once more in a fresh session, and fails if that is dropped too", async () => {
    let clock = 0;
    const { adapter, calls } = fakeAdapter({ messages: [user("input-1")] });
    let retries = 0;

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, {
      noResponseTimeoutMs: 1_000,
      now: () => (clock += 400),
      onRetry: () => retries++,
    });

    expect(result.outcome).toEqual({ kind: "failed", reason: "OpenCode did not start a response", category: "OpenCode" });
    expect(retries).toBe(1);
    expect(calls).toEqual([
      "create:/work/QuackTrack", "prompt:ses_1", "interrupt:ses_1", "idle:ses_1", "delete:ses_1",
      "create:/work/QuackTrack", "prompt:ses_2", "interrupt:ses_2", "idle:ses_2", "delete:ses_2",
    ]);
    expect(result).toMatchObject({ sessionID: "ses_2", sessionDeleted: true });
  });

  it("answers from the second session when OpenCode dropped the first (Milestone 2 QA)", async () => {
    let clock = 0;
    const { adapter, calls } = fakeAdapter({
      messages: [user("input-1"), assistant("Done.")],
      messagesBySession: { ses_1: [user("input-1")] },
    });

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, {
      noResponseTimeoutMs: 1_000,
      now: () => (clock += 400),
    });

    expect(result).toMatchObject({ sessionID: "ses_2", outcome: { kind: "answered", text: "Done." }, sessionDeleted: true });
    expect(calls.filter((call) => call.startsWith("delete:"))).toEqual(["delete:ses_1", "delete:ses_2"]);
  });

  it("does not retry when the dropped session could not be verified as deleted", async () => {
    let clock = 0;
    const { adapter, calls } = fakeAdapter({ messages: [user("input-1")], deleteFailsFor: "ses_1" });

    const result = await run(adapter, new SessionTracker(), new AbortController().signal, {
      noResponseTimeoutMs: 1_000,
      now: () => (clock += 400),
    });

    expect(result).toMatchObject({ sessionID: "ses_1", sessionDeleted: false, outcome: { kind: "failed" } });
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
  });

  it("does not retry when cancelled while waiting for a response", async () => {
    let clock = 0;
    const cancel = new AbortController();
    const { adapter, calls } = fakeAdapter({ messages: [user("input-1")] });

    const result = await run(adapter, new SessionTracker(), cancel.signal, {
      noResponseTimeoutMs: 1_000,
      now: () => {
        clock += 400;
        if (clock > 1_000) cancel.abort();
        return clock;
      },
    });

    expect(result.outcome).toEqual({ kind: "cancelled" });
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
  });

});

describe("cancelling around a retry (review cycle 5)", () => {
  const dropFirst = (extra: Partial<FakeTurn> = {}) =>
    fakeAdapter({ messages: [user("input-1"), assistant("Done.")], messagesBySession: { ses_1: [user("input-1")] }, ...extra });

  it("reports a Ctrl-C pressed while the dropped session is cleaned up, and does not retry", async () => {
    let clock = 0;
    const cancel = new AbortController();
    const { adapter, calls, raw } = dropFirst();
    raw.deleteSession.mockImplementationOnce(async (sessionID: string) => {
      calls.push(`delete:${sessionID}`);
      cancel.abort();
    });
    let retries = 0;

    const result = await run(adapter, new SessionTracker(), cancel.signal, {
      noResponseTimeoutMs: 1_000,
      now: () => (clock += 400),
      onRetry: () => retries++,
    });

    expect(result).toMatchObject({ sessionID: "ses_1", outcome: { kind: "cancelled" }, sessionDeleted: true });
    expect(retries).toBe(0);
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
  });

  it.each([
    ["Ctrl-C", undefined, { kind: "cancelled" }],
    ["a harness stop", { stopped: "Server lost." }, { kind: "failed", reason: "Server lost." }],
  ])("stops the retried turn on %s and still deletes its session", async (_name, reason, outcome) => {
    let clock = 0;
    const cancel = new AbortController();
    const tracker = new SessionTracker();
    const { adapter, calls, raw } = dropFirst({ runsUntilInterrupted: false });
    // The retried session keeps running until it is stopped.
    raw.isActive.mockImplementation(async (sessionID: string) => sessionID === "ses_2" && !calls.includes("interrupt:ses_2"));

    const pending = run(adapter, tracker, cancel.signal, { noResponseTimeoutMs: 1_000, now: () => (clock += 400), pollIntervalMs: 5 });
    await vi.waitFor(() => expect(calls).toContain("prompt:ses_2"));
    cancel.abort(reason);
    const result = await pending;

    expect(result).toMatchObject({ sessionID: "ses_2", outcome, sessionDeleted: true });
    expect(calls.slice(-3)).toEqual(["interrupt:ses_2", "idle:ses_2", "delete:ses_2"]);
    expect(tracker.owns("ses_1") || tracker.owns("ses_2")).toBe(false);
  });

  it("still settles and deletes the second session when cancelled while it is being created", async () => {
    let clock = 0;
    const cancel = new AbortController();
    const { adapter, calls, raw } = dropFirst();
    const create = raw.createSession.getMockImplementation();
    raw.createSession.mockImplementation(async (options: { directory: string; model: unknown; agent: string }) => {
      const session = await create!(options);
      if (session.id === "ses_2") cancel.abort();
      return session;
    });

    const result = await run(adapter, new SessionTracker(), cancel.signal, { noResponseTimeoutMs: 1_000, now: () => (clock += 400) });

    expect(result).toMatchObject({ sessionID: "ses_2", outcome: { kind: "cancelled" }, sessionDeleted: true });
    expect(calls).not.toContain("prompt:ses_2");
    expect(calls.slice(-3)).toEqual(["interrupt:ses_2", "idle:ses_2", "delete:ses_2"]);
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
