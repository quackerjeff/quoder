import type { V2Event } from "@opencode-ai/sdk/v2";
import { describe, expect, it, vi } from "vitest";

import { startEventMonitor, type EventMonitorOptions } from "../../src/event-monitor.js";
import type { OpenCodeAdapter } from "../../src/opencode-adapter.js";

/** A fake global stream: `server.connected` first, then pushed events until aborted or ended. */
const channel = () => {
  const queue: V2Event[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(event: V2Event): void {
      queue.push(event);
      wake?.();
    },
    end(): void {
      closed = true;
      wake?.();
    },
    async *stream(signal: AbortSignal): AsyncGenerator<V2Event, void, unknown> {
      yield { id: "connected", type: "server.connected", data: {} } as unknown as V2Event;
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (signal.aborted || closed) return;
        await new Promise<void>((resolveWake) => {
          wake = resolveWake;
          signal.addEventListener("abort", () => resolveWake(), { once: true });
        });
        wake = undefined;
      }
    },
  };
};

const event = (type: string, data: Record<string, unknown>) => ({ id: `${type}-${String(data.id)}`, type, data }) as unknown as V2Event;
const settle = () => new Promise((resolveTick) => setTimeout(resolveTick, 10));

const monitorWith = async (overrides: Partial<EventMonitorOptions> = {}, rejectQuestion = vi.fn().mockResolvedValue(undefined)) => {
  const events = channel();
  const adapter = {
    globalEvents: vi.fn(async (options: { signal: AbortSignal }) => events.stream(options.signal)),
    rejectQuestion,
  } as unknown as OpenCodeAdapter;
  const progress: string[] = [];
  const monitor = await startEventMonitor({
    adapter,
    isOwnSession: (sessionID) => sessionID === "own",
    subscriptionTimeoutMs: 60_000,
    onProgress: (marker) => progress.push(marker),
    ...overrides,
  });
  return { events, monitor, progress, rejectQuestion };
};

describe("shared run-long event monitor", () => {
  it("reports asked permissions for its own sessions only, with action and resource count", async () => {
    const asked = vi.fn();
    const { events, monitor } = await monitorWith({ onPermissionAsked: asked });

    events.push(event("permission.v2.asked", { id: "p-own", sessionID: "own", action: "external_directory", resources: ["/a", "/b"] }));
    events.push(event("permission.v2.asked", { id: "p-other", sessionID: "other", action: "bash", resources: [] }));
    await settle();

    expect(asked).toHaveBeenCalledOnce();
    expect(asked).toHaveBeenCalledWith({ sessionID: "own", requestID: "p-own", action: "external_directory", resourceCount: 2 });
    await expect(monitor.waitForPermissionAsked("own", "p-own", 50)).resolves.toBe("observed");
    await expect(monitor.waitForPermissionAsked("other", "p-other", 20)).resolves.toBe("timeout");
    await monitor.stop();
  });

  it("rejects its own sessions' questions and reports the outcome with the question content", async () => {
    const reported = vi.fn();
    const { events, monitor, progress, rejectQuestion } = await monitorWith({ onQuestionRejected: reported });
    const questions = [{ question: "Which language?", header: "Language", options: [{ label: "Rust" }] }];

    events.push(event("question.v2.asked", { id: "q-own", sessionID: "own", questions }));
    events.push(event("question.v2.asked", { id: "q-other", sessionID: "other", questions }));
    await settle();

    expect(rejectQuestion).toHaveBeenCalledOnce();
    expect(rejectQuestion).toHaveBeenCalledWith("own", "q-own");
    expect(reported).toHaveBeenCalledWith({ sessionID: "own", requestID: "q-own", questions }, true);
    expect(progress).toEqual(["question.rejected"]);
    await monitor.stop();
  });

  it("reports a failed rejection without an unhandled rejection, even if the callback throws", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const reported = vi.fn(() => {
        throw new Error("journal write failed");
      });
      const { events, monitor, progress } = await monitorWith(
        { onQuestionRejected: reported },
        vi.fn().mockRejectedValue(new Error("reject failed")),
      );

      events.push(event("question.v2.asked", { id: "q-own", sessionID: "own", questions: [] }));
      await settle();
      await monitor.stop();
      await settle();

      expect(reported).toHaveBeenCalledWith(expect.objectContaining({ requestID: "q-own" }), false);
      expect(progress).toEqual(["question.rejected", "question.reject.failed"]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("journals an unexpected end and settles permission waits as monitor-ended", async () => {
    const { events, monitor, progress } = await monitorWith();

    const wait = monitor.waitForPermissionAsked("own", "p-late", 60_000);
    events.end();

    await expect(wait).resolves.toBe("monitor-ended");
    expect(progress).toContain("event.monitor.ended");
    await monitor.stop();
  });
});

describe("monitor reporting for the harness", () => {
  it("reports a question when it arrives, before rejecting it", async () => {
    const order: string[] = [];
    const rejectQuestion = vi.fn(async () => {
      order.push("rejected");
    });
    const { events, monitor } = await monitorWith(
      { onQuestionAsked: () => order.push("asked"), onQuestionRejected: () => order.push("reported") },
      rejectQuestion,
    );

    events.push(event("question.v2.asked", { id: "q-own", sessionID: "own", questions: [] }));
    await settle();

    expect(order).toEqual(["asked", "rejected", "reported"]);
    await monitor.stop();
  });

  it("calls onEnded for an unexpected end, but not for stop()", async () => {
    const endedEarly = vi.fn();
    const first = await monitorWith({ onEnded: endedEarly });
    first.events.end();
    await settle();
    expect(endedEarly).toHaveBeenCalledOnce();

    const endedOnStop = vi.fn();
    const second = await monitorWith({ onEnded: endedOnStop });
    await second.monitor.stop();
    expect(endedOnStop).not.toHaveBeenCalled();
  });

  it("reports whether the server confirmed the subscription", async () => {
    const { monitor } = await monitorWith();
    expect(monitor.confirmed).toBe(true);
    await monitor.stop();

    const adapter = {
      globalEvents: vi.fn(async (options: { signal: AbortSignal }) => (async function* () {
        await new Promise<void>((resolveAbort) => options.signal.addEventListener("abort", () => resolveAbort(), { once: true }));
      })()),
      rejectQuestion: vi.fn(),
    } as unknown as OpenCodeAdapter;
    const progress: string[] = [];
    const silent = await startEventMonitor({
      adapter,
      isOwnSession: () => true,
      subscriptionTimeoutMs: 60_000,
      connectTimeoutMs: 20,
      onProgress: (marker) => progress.push(marker),
    });
    expect(silent.confirmed).toBe(false);
    expect(progress).toEqual(["event.monitor.unconfirmed"]);
    await silent.stop();
  });

  it("keeps monitoring when a reporting callback throws", async () => {
    const asked = vi.fn(() => {
      throw new Error("reporting failed");
    });
    const { events, monitor } = await monitorWith({ onPermissionAsked: asked, onQuestionAsked: asked });

    events.push(event("permission.v2.asked", { id: "p1", sessionID: "own", action: "bash", resources: [] }));
    events.push(event("question.v2.asked", { id: "q1", sessionID: "own", questions: [] }));
    await settle();

    await expect(monitor.waitForPermissionAsked("own", "p1", 50)).resolves.toBe("observed");
    expect(asked).toHaveBeenCalledTimes(2);
    await monitor.stop();
  });
});
