import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openOperationalLog, type OperationalLogEvent } from "../../src/harness/operational-log.js";

const roots: string[] = [];
const fixture = (): { root: string; project: string; outside: string } => {
  const root = mkdtempSync(join(tmpdir(), "quoder-operational-log-"));
  roots.push(root);
  const project = join(root, "project");
  const outside = join(root, "logs");
  mkdirSync(project);
  mkdirSync(outside);
  return { root, project, outside };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("opt-in operational JSONL logging", () => {
  it("writes only the allow-listed operational fields to an outside-project file", () => {
    const { project, outside } = fixture();
    const path = join(outside, "ops.jsonl");
    const opened = openOperationalLog(path, project);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    opened.logger.write({
      event: "prompt.completed",
      outcome: "failed",
      elapsedMs: 12.8,
      prompt: "PROMPT_SECRET",
      toolOutput: "TOOL_SECRET",
      providerPayload: "PAYLOAD_SECRET",
      rawError: "RAW_ERROR_SECRET",
      childStderr: "STDERR_SECRET",
      token: "CREDENTIAL_SECRET",
    } as unknown as OperationalLogEvent);
    opened.logger.write({
      event: "failure.reported",
      category: "CREDENTIAL_SECRET",
      prompt: "PROMPT_SECRET",
    } as unknown as OperationalLogEvent);
    opened.logger.write({
      event: "CREDENTIAL_SECRET",
      payload: "PROVIDER_PAYLOAD_SECRET",
    } as unknown as OperationalLogEvent);
    opened.logger.close();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: expect.any(String),
      event: "prompt.completed",
      outcome: "failed",
      elapsedMs: 12,
    });
    const serialized = lines.join("\n");
    for (const forbidden of ["PROMPT_SECRET", "TOOL_SECRET", "PAYLOAD_SECRET", "RAW_ERROR_SECRET", "STDERR_SECRET", "CREDENTIAL_SECRET"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(JSON.parse(lines[1]!)).toMatchObject({ event: "failure.reported", category: "OpenCode" });
  });

  it("rejects disabled, relative, project-contained, and symlink destinations", () => {
    const { root, project, outside } = fixture();
    expect(openOperationalLog(undefined, project)).toEqual({ ok: false });
    expect(openOperationalLog("relative.jsonl", project)).toEqual({ ok: false });
    expect(openOperationalLog(join(project, "ops.jsonl"), project)).toEqual({ ok: false });
    const target = join(outside, "target.jsonl");
    const symlink = join(outside, "link.jsonl");
    writeFileSync(target, "keep\n");
    symlinkSync(target, symlink);
    expect(openOperationalLog(symlink, project)).toEqual({ ok: false });
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(root).toBeDefined();
  });

  it("keeps write failures isolated from the caller", () => {
    const { project, outside } = fixture();
    const path = join(outside, "ops.jsonl");
    const opened = openOperationalLog(path, project);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.logger.close();
    expect(() => opened.logger.write({ event: "server.started" })).not.toThrow();
    expect(() => opened.logger.close()).not.toThrow();
  });
});
