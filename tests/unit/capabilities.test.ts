import { describe, expect, it, vi } from "vitest";

import {
  cancellationPassed,
  classifyEvent,
  classifyIsolation,
  hasFinalModelResponse,
  hasFreshSessionIDs,
  hasExactHelloContent,
  hasRealPermissionRequest,
  isPathConfined,
  sessionDeletionPassed,
  type ProbeEvent,
  withSessionCleanup,
} from "../../src/capabilities.js";

const event = (
  sequence: number,
  type: string,
  properties: Readonly<Record<string, unknown>> = {},
): ProbeEvent => ({ sequence, type, sessionID: "session-1", properties });

describe("fresh session creation", () => {
  it("requires two non-empty, unique session identifiers", () => {
    expect(hasFreshSessionIDs(["session-1", "session-2"])).toBe(true);
    expect(hasFreshSessionIDs(["session-1", "session-1"])).toBe(false);
    expect(hasFreshSessionIDs(["session-1", ""])).toBe(false);
  });
});

describe("local model invocation", () => {
  it("requires a non-empty final assistant response correlated to the admitted input", () => {
    expect(
      hasFinalModelResponse({
        admittedInputID: "input-1",
        responseInputID: "input-1",
        assistantText: "TOKEN_STORED",
      }),
    ).toBe(true);
    expect(
      hasFinalModelResponse({
        admittedInputID: "input-1",
        responseInputID: "input-2",
        assistantText: "TOKEN_STORED",
      }),
    ).toBe(false);
  });
});

describe("probe event classification", () => {
  it("recognizes structured execution, permission, fixture-start, and completion events", () => {
    expect(classifyEvent(event(1, "tool.started"))).toMatchObject({ structuredExecution: true });
    expect(classifyEvent(event(2, "permission.v2.asked"))).toMatchObject({ permissionRequest: true });
    expect(classifyEvent(event(3, "permission.asked"))).toMatchObject({ permissionRequest: false });
    expect(classifyEvent(event(3, "fixture.started"))).toMatchObject({ fixtureStarted: true });
    expect(classifyEvent(event(5, "fixture.completed"))).toMatchObject({ normalCompletion: true });
  });

  it("does not treat arbitrary diagnostics as structured evidence", () => {
    expect(classifyEvent(event(1, "diagnostic.text", { text: "permission.asked" }))).toEqual({
      structuredExecution: false,
      permissionRequest: false,
      fixtureStarted: false,
      normalCompletion: false,
    });
  });
});

describe("file modification evidence", () => {
  it.each(["Hello from OpenCode", "Hello from OpenCode\n"])(
    "accepts exact hello.txt content with at most one trailing newline",
    (content) => expect(hasExactHelloContent(content)).toBe(true),
  );

  it.each([" Hello from OpenCode", "Hello from OpenCode\n\n", "Hello from OpenCode!", ""])(
    "rejects non-exact hello.txt content %#",
    (content) => expect(hasExactHelloContent(content)).toBe(false),
  );
});

describe("project-directory confinement", () => {
  it("accepts the repository root and descendants", () => {
    expect(isPathConfined("/tmp/probe/repo", "/tmp/probe/repo")).toBe(true);
    expect(isPathConfined("/tmp/probe/repo", "/tmp/probe/repo/hello.txt")).toBe(true);
  });

  it("rejects parent traversal and prefix-confusable sibling paths", () => {
    expect(isPathConfined("/tmp/probe/repo", "/tmp/probe/repo/../outside.txt")).toBe(false);
    expect(isPathConfined("/tmp/probe/repo", "/tmp/probe/repository/hello.txt")).toBe(false);
  });
});

describe("session isolation", () => {
  const nonce = "b2f178642db248b68f1472c5db989bad";

  it("passes only the exact no-prior-session sentinel", () => {
    expect(classifyIsolation(nonce, "NO_PRIOR_SESSION")).toEqual({
      status: "PASS",
      reason: "no-prior-session",
    });
  });

  it("fails when the prior session nonce is disclosed", () => {
    expect(classifyIsolation(nonce, nonce)).toEqual({ status: "FAIL", reason: "nonce-leaked" });
  });

  it("fails inconclusive or decorated responses", () => {
    expect(classifyIsolation(nonce, "I cannot remember.")).toEqual({
      status: "FAIL",
      reason: "unexpected-response",
    });
    expect(classifyIsolation(nonce, "NO_PRIOR_SESSION\nextra")).toEqual({
      status: "FAIL",
      reason: "unexpected-response",
    });
  });
});

describe("permission evidence", () => {
  it("requires a structured OpenCode permission-request event", () => {
    expect(hasRealPermissionRequest([event(1, "permission.v2.asked", { id: "permission-1" })])).toBe(
      true,
    );
    expect(hasRealPermissionRequest([event(1, "diagnostic.text", { text: "permission.asked" })])).toBe(
      false,
    );
  });
});

describe("cancellation evidence", () => {
  it("passes after start, interrupt, interrupted-tool terminal event, process termination, and no late completion", () => {
    expect(
      cancellationPassed({
        fixtureStartedAtSequence: 2,
        interruptRequestedAtSequence: 3,
        terminalAtSequence: 5,
        fixtureTerminated: true,
        events: [event(2, "session.next.tool.called"), event(5, "session.next.tool.failed")],
      }),
    ).toBe(true);
  });

  it("fails without an observed start, terminal event, or terminated fixture", () => {
    expect(
      cancellationPassed({
        fixtureStartedAtSequence: 0,
        interruptRequestedAtSequence: 3,
        terminalAtSequence: 0,
        fixtureTerminated: false,
        events: [],
      }),
    ).toBe(false);
  });

  it("fails when normal completion occurs after interruption", () => {
    expect(
      cancellationPassed({
        fixtureStartedAtSequence: 2,
        interruptRequestedAtSequence: 3,
        terminalAtSequence: 5,
        fixtureTerminated: true,
        events: [
          event(2, "session.next.tool.called"),
          event(4, "fixture.completed"),
          event(5, "session.next.tool.failed"),
        ],
      }),
    ).toBe(false);
  });
});

describe("session cleanup", () => {
  it("deletes every session after success", async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);

    await expect(
      withSessionCleanup({ deleteSession }, ["session-1", "session-2"], async () => "done"),
    ).resolves.toBe("done");
    expect(deleteSession.mock.calls).toEqual([["session-2"], ["session-1"]]);
  });

  it("deletes every session after an operation error", async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);

    await expect(
      withSessionCleanup({ deleteSession }, ["session-1"], async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");
    expect(deleteSession).toHaveBeenCalledWith("session-1");
  });

  it("deletes every session after cancellation is reported as an error", async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const cancellation = Object.assign(new Error("cancelled"), { name: "AbortError" });

    await expect(
      withSessionCleanup({ deleteSession }, ["session-1"], async () => {
        throw cancellation;
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(deleteSession).toHaveBeenCalledWith("session-1");
  });
});

describe("session deletion evidence", () => {
  it("requires an accepted compatibility delete and a Core V2 404 lookup", () => {
    expect(sessionDeletionPassed(true, 404)).toBe(true);
    expect(sessionDeletionPassed(false, 404)).toBe(false);
    expect(sessionDeletionPassed(true, 200)).toBe(false);
  });
});
