import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveView, fitColumns, type LiveViewOptions } from "../../src/harness/live-view.js";
import type { PromptResult } from "../../src/harness/session-runner.js";
import type { StreamEvent } from "../../src/harness/stream-events.js";
import { PLAIN_THEME } from "../../src/ui/style.js";

const S = "ses_1";
const answered = (text: string): PromptResult => ({
  sessionID: S,
  outcome: { kind: "answered", text },
  rejectedPermissions: [],
  rejectedQuestions: [],
  sessionDeleted: true,
  elapsedMs: 1_000,
});
const cancelled: PromptResult = { ...answered(""), outcome: { kind: "cancelled" } };

const view = (overrides: Partial<LiveViewOptions> = {}) => {
  let output = "";
  const live = new LiveView({
    theme: PLAIN_THEME,
    write: (text) => {
      output += text;
    },
    root: "/work/QuackTrack",
    modelLabel: "glm-4.7-flash:latest",
    statusLine: false,
    ...overrides,
  });
  live.setSession(S);
  return { live, output: () => output };
};

const text = (delta: string, textID = "t1", messageID = "m1"): StreamEvent => ({ kind: "text-delta", sessionID: S, messageID, textID, delta });

afterEach(() => {
  vi.useRealTimers();
});

describe("live view", () => {
  it("ignores events for other sessions and after it has finished", () => {
    const { live, output } = view();
    live.handle({ ...text("other\n\n"), sessionID: "ses_other" } as StreamEvent);
    expect(output()).toBe("");
    live.handle({ kind: "step-started", sessionID: S, messageID: "m1" });
    live.handle(text("Hello\n\n"));
    live.finish(answered("Hello"));
    live.handle(text("late\n\n"));
    expect(output()).toBe("Hello\n");
  });

  it("counts tools and output tokens across steps", () => {
    const { live } = view();
    live.handle({ kind: "tool-called", sessionID: S, callID: "c1", tool: "read", input: { path: "a" } });
    live.handle({ kind: "tool-succeeded", sessionID: S, callID: "c1", structured: {}, output: "" });
    live.handle({ kind: "step-ended", sessionID: S, messageID: "m1", tokens: { input: 10, output: 40, reasoning: 0 } });
    live.handle({ kind: "step-ended", sessionID: S, messageID: "m2", tokens: { input: 10, output: 2, reasoning: 0 } });
    expect(live.finish(answered("x"))).toEqual({ tools: 1, outputTokens: 42 });
  });

  it("shows a failed tool, a failed step and a retry as warnings, but no step failure while cancelling", () => {
    const { live, output } = view();
    live.handle({ kind: "tool-called", sessionID: S, callID: "c1", tool: "edit", input: { path: "a.ts" } });
    live.handle({ kind: "tool-failed", sessionID: S, callID: "c1", message: "oldString not found" });
    live.handle({ kind: "retried", sessionID: S, attempt: 2, message: "HTTP 502" });
    live.handle({ kind: "step-failed", sessionID: S, message: "boom" });
    live.cancelling();
    live.handle({ kind: "step-failed", sessionID: S, message: "Provider turn interrupted" });
    live.finish(cancelled);
    expect(output()).toBe(
      [
        "✗ ✎ Edit   a.ts  oldString not found",
        "! Retrying (attempt 2): HTTP 502",
        "! Step failed: boom",
        "Cancelling OpenCode execution…",
        "",
      ].join("\n"),
    );
  });

  it("flushes a slow paragraph's complete lines after an idle interval", () => {
    vi.useFakeTimers();
    const { live, output } = view({ idleFlushMs: 400 });
    live.handle(text("first line\nsecond"));
    expect(output()).toBe("");
    vi.advanceTimersByTime(400);
    expect(output()).toBe("first line\n");
    live.handle(text(" line\n\n"));
    expect(output()).toBe("first line\nsecond line\n");
    live.finish(answered("first line\nsecond line"));
  });

  it("finalizes open text at the end, and does not repeat a streamed answer", () => {
    const { live, output } = view();
    live.handle({ kind: "step-started", sessionID: S, messageID: "m1" });
    live.handle(text("The **answer**"));
    live.finish(answered("The **answer**"));
    expect(output()).toBe("The answer\n");
  });

  it("compares only the final step's text with the answer", () => {
    const { live, output } = view();
    live.handle({ kind: "step-started", sessionID: S, messageID: "m1" });
    live.handle(text("Looking.\n\n", "t1", "m1"));
    live.handle({ kind: "step-started", sessionID: S, messageID: "m2" });
    live.handle(text("Final.", "t2", "m2"));
    live.finish(answered("Final."));
    expect(output()).toBe("Looking.\n\nFinal.\n");
  });

  it("renders a long unstreamed answer block by block, so formatting survives the budget", () => {
    const { live, output } = view();
    const answer = Array.from({ length: 300 }, (_unused, index) => `Paragraph **${index}** with _emphasis_.`).join("\n\n");
    live.finish(answered(answer));
    expect(output()).toContain("Paragraph 0 with emphasis.");
    expect(output()).not.toContain("**");
  });

  it("renders text blocks and the reconciled answer through the given renderer", () => {
    const rendered: string[] = [];
    const { live, output } = view({
      render: (source) => {
        rendered.push(source);
        return `<${source.trim()}>\n`;
      },
    });
    live.handle({ kind: "step-started", sessionID: S, messageID: "m1" });
    live.handle(text("Streamed.\n\n"));
    live.finish(answered("Different final answer."));
    expect(rendered).toEqual(["Streamed.\n\n", "Different final answer."]);
    expect(output()).toContain("<Streamed.>");
    expect(output()).toContain("<Different final answer.>");
  });

  it("sanitizes model text and tool details", () => {
    const { live, output } = view();
    live.handle(text("Hi \u001b]52;c;eA==\u0007there\n\n"));
    live.handle({ kind: "tool-called", sessionID: S, callID: "c1", tool: "bash", input: { command: "ls\u001b[2J" } });
    live.handle({ kind: "tool-succeeded", sessionID: S, callID: "c1", structured: { exit: 0 }, output: "ok\u009b31m" });
    live.finish(cancelled);
    expect(output()).toBe("Hi there\n\n✓ $ Run    ls  exit 0 · ok\n");
  });
});

describe("live view status line", () => {
  const statusView = (columns = 60) => {
    vi.useFakeTimers();
    let clock = 0;
    return view({ statusLine: true, columns: () => columns, now: () => (clock += 50), frameMs: 100 });
  };

  it("shows the phase, elapsed time and model, and erases itself before permanent output", () => {
    const { live, output } = statusView();
    live.handle({ kind: "step-started", sessionID: S, messageID: "m1" });
    expect(output()).toContain("Thinking… ");
    expect(output()).toContain("glm-4.7-flash:latest");
    live.handle({ kind: "tool-called", sessionID: S, callID: "c1", tool: "bash", input: { command: "cargo test" } });
    expect(output()).toContain("Running cargo test…");
    live.handle({ kind: "tool-succeeded", sessionID: S, callID: "c1", structured: { exit: 0 }, output: "" });
    expect(output()).toContain("\r\u001b[2K✓ $ Run    cargo test  exit 0\n");
    live.finish(answered(""));
    expect(output().endsWith("\r\u001b[2K")).toBe(true);
  });

  it("counts several running tools", () => {
    const { live, output } = statusView();
    live.handle({ kind: "tool-called", sessionID: S, callID: "c1", tool: "read", input: { path: "a" } });
    live.handle({ kind: "tool-called", sessionID: S, callID: "c2", tool: "read", input: { path: "b" } });
    expect(output()).toContain("Running 2 tools…");
    live.finish(cancelled);
  });

  it("shows a reasoning preview and keeps every frame within the terminal width", () => {
    const { live, output } = statusView(70);
    live.handle({ kind: "reasoning-delta", sessionID: S, reasoningID: "r1", delta: "considering \u001b[31mthe options ".repeat(5) });
    vi.advanceTimersByTime(300);
    const frames = output().split("\r\u001b[2K").filter((frame) => frame !== "");
    expect(frames.some((frame) => frame.includes("· considering"))).toBe(true);
    for (const frame of frames) expect([...frame].length).toBeLessThanOrEqual(69);
    expect(output()).not.toContain("\u001b[31m");
    live.finish(cancelled);
  });

  it("animates the spinner and stops when finished", () => {
    const { live, output } = statusView();
    vi.advanceTimersByTime(250);
    const frames = output().split("\r\u001b[2K").filter((frame) => frame !== "").map((frame) => frame[0]);
    expect(new Set(frames).size).toBeGreaterThan(1);
    live.finish(cancelled);
    const length = output().length;
    vi.advanceTimersByTime(1_000);
    expect(output().length).toBe(length);
  });
});

describe("status line pacing and width (review cycle 1)", () => {
  it("does not redraw or advance the spinner on every streamed delta", () => {
    vi.useFakeTimers();
    let output = "";
    const live = new LiveView({
      theme: PLAIN_THEME,
      write: (text) => {
        output += text;
      },
      root: "/work/QuackTrack",
      modelLabel: "glm",
      statusLine: true,
      columns: () => 80,
    });
    live.setSession(S);
    live.handle({ kind: "step-started", sessionID: S, messageID: "m1" });
    const framesBefore = output.split("\r\u001b[2K").length;
    for (let index = 0; index < 50; index++) live.handle(text("word "));
    // One redraw for the change of phase to Writing, none for the other 49 deltas.
    expect(output.split("\r\u001b[2K").length - framesBefore).toBe(1);
    const spinners = new Set(output.split("\r\u001b[2K").filter((frame) => frame !== "").map((frame) => frame[0]));
    expect(spinners.size).toBe(1);
    live.finish(cancelled);
  });

  it("fits wide characters by display columns", () => {
    expect(fitColumns("abc", 3)).toBe("abc");
    expect(fitColumns("abcd", 3)).toBe("ab…");
    expect(fitColumns("漢字漢字", 8)).toBe("漢字漢字");
    expect(fitColumns("漢字漢字", 7)).toBe("漢字漢…");
    expect(fitColumns("ab🙂🙂", 5)).toBe("ab🙂…");
  });
});
