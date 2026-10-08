import { describe, expect, it } from "vitest";

import { narrowStreamEvent } from "../../src/harness/stream-events.js";

const base = { timestamp: 1, sessionID: "ses_1", assistantMessageID: "msg_1" };
const narrow = (type: string, data: unknown) => narrowStreamEvent({ type: `session.next.${type}`, data });

describe("narrowing OpenCode display events", () => {
  it("narrows the verified 1.18.33 payloads", () => {
    expect(narrow("step.started", { ...base, agent: "build", model: {} })).toEqual({ kind: "step-started", sessionID: "ses_1", messageID: "msg_1" });
    expect(
      narrow("step.ended", { ...base, finish: "stop", cost: 0, tokens: { input: 3616, output: 141, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ).toEqual({ kind: "step-ended", sessionID: "ses_1", messageID: "msg_1", tokens: { input: 3616, output: 141, reasoning: 0 } });
    expect(narrow("text.delta", { ...base, textID: "t1", delta: "Hel" })).toEqual({
      kind: "text-delta",
      sessionID: "ses_1",
      messageID: "msg_1",
      textID: "t1",
      delta: "Hel",
    });
    expect(narrow("text.ended", { ...base, textID: "t1", text: "Hello" })).toMatchObject({ kind: "text-ended", text: "Hello" });
    expect(narrow("reasoning.delta", { ...base, reasoningID: "r1", delta: "hmm" })).toMatchObject({ kind: "reasoning-delta", delta: "hmm" });
    expect(narrow("reasoning.ended", { ...base, reasoningID: "r1", text: "hmm" })).toMatchObject({ kind: "reasoning-ended" });
    expect(narrow("tool.input.started", { ...base, callID: "c1", name: "bash" })).toEqual({
      kind: "tool-preparing",
      sessionID: "ses_1",
      callID: "c1",
      tool: "bash",
    });
    expect(narrow("tool.called", { ...base, callID: "c1", tool: "bash", input: { command: "ls" }, provider: { executed: false } })).toEqual({
      kind: "tool-called",
      sessionID: "ses_1",
      callID: "c1",
      tool: "bash",
      input: { command: "ls" },
    });
    expect(
      narrow("tool.success", {
        ...base,
        callID: "c1",
        structured: { exit: 0, truncated: false },
        content: [{ type: "text", text: "a\n" }, { type: "image", data: "x" }, { type: "text", text: "b" }],
        outputPaths: [],
      }),
    ).toEqual({ kind: "tool-succeeded", sessionID: "ses_1", callID: "c1", structured: { exit: 0, truncated: false }, output: "a\n\nb" });
    expect(narrow("tool.failed", { ...base, callID: "c1", error: { type: "unknown", message: "no match" } })).toEqual({
      kind: "tool-failed",
      sessionID: "ses_1",
      callID: "c1",
      message: "no match",
    });
    expect(narrow("step.failed", { ...base, error: { type: "unknown", message: "PROVIDER_PAYLOAD_SECRET" } })).toEqual({
      kind: "step-failed",
      sessionID: "ses_1",
      message: "OpenCode reported a failed model step",
    });
    expect(narrow("retried", { timestamp: 1, sessionID: "ses_1", attempt: 2, error: { message: "PROVIDER_PAYLOAD_SECRET", isRetryable: true } })).toEqual({
      kind: "retried",
      sessionID: "ses_1",
      attempt: 2,
      message: "OpenCode is retrying the request",
    });
    expect(JSON.stringify(narrow("step.failed", { ...base, error: { message: "PROVIDER_PAYLOAD_SECRET" } }))).not.toContain("PROVIDER_PAYLOAD_SECRET");
    expect(JSON.stringify(narrow("retried", { ...base, error: { message: "PROVIDER_PAYLOAD_SECRET" } }))).not.toContain("PROVIDER_PAYLOAD_SECRET");
  });

  it("ignores events that are not display events", () => {
    expect(narrowStreamEvent({ type: "permission.v2.asked", data: { sessionID: "ses_1" } })).toBeUndefined();
    expect(narrow("prompted", { ...base, messageID: "m" })).toBeUndefined();
    expect(narrow("tool.input.delta", { ...base, callID: "c1", delta: "{" })).toBeUndefined();
  });

  it.each([
    ["a non-object payload", "text.delta", "oops"],
    ["an array payload", "text.delta", []],
    ["a missing session", "text.delta", { assistantMessageID: "m", textID: "t", delta: "x" }],
    ["a non-string delta", "text.delta", { ...base, textID: "t", delta: 5 }],
    ["a missing text ID", "text.ended", { ...base, text: "x" }],
    ["a missing call ID", "tool.called", { ...base, tool: "bash", input: {} }],
    ["a missing tool name", "tool.called", { ...base, callID: "c" }],
    ["a missing message ID", "step.started", { timestamp: 1, sessionID: "ses_1" }],
  ])("drops %s", (_name, type, data) => {
    expect(narrow(type, data)).toBeUndefined();
  });

  it("tolerates malformed optional fields", () => {
    expect(narrow("tool.called", { ...base, callID: "c1", tool: "bash", input: "ls" })).toMatchObject({ input: {} });
    expect(narrow("tool.success", { ...base, callID: "c1", structured: null, content: "x" })).toMatchObject({ structured: {}, output: "" });
    expect(narrow("tool.failed", { ...base, callID: "c1", error: 42 })).toMatchObject({ message: "unknown error" });
    expect(narrow("step.ended", { ...base, tokens: { input: -1, output: "9", reasoning: Number.NaN } })).toMatchObject({
      tokens: {},
    });
    expect(narrow("step.ended", { ...base })).toEqual({ kind: "step-ended", sessionID: "ses_1", messageID: "msg_1" });
  });

  it("preserves reported zero and omits absent or malformed usage fields", () => {
    expect(narrow("step.ended", { ...base, tokens: { input: 0, output: 12, reasoning: "bad" } })).toEqual({
      kind: "step-ended", sessionID: "ses_1", messageID: "msg_1", tokens: { input: 0, output: 12 },
    });
    expect(narrow("step.ended", { ...base, tokens: { cache: { read: 20 } } })).toEqual({
      kind: "step-ended", sessionID: "ses_1", messageID: "msg_1", tokens: {},
    });
  });
});
