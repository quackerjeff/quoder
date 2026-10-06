import { describe, expect, it } from "vitest";

import {
  assertSandboxedRuntimeConfig,
  CONFIG_UNREADABLE_MESSAGE,
  LOCAL_MCP_PRESENT_MESSAGE,
  localMcpServerIds,
  SHELL_NOT_SANDBOXED_MESSAGE,
} from "../../src/opencode-sandbox-assertion.js";

const SHELL = "/private/var/folders/x/quoder-tool-sandbox-abc/quoder-model-shell";

describe("localMcpServerIds", () => {
  it("reports local servers, which spawn unsandboxed children", () => {
    expect(localMcpServerIds({
      mcp: {
        helper: { type: "local", command: ["helper"] },
        hosted: { type: "remote", url: "https://example.com" },
      },
    })).toEqual(["helper"]);
  });

  it("reports nothing when no MCP servers are configured", () => {
    expect(localMcpServerIds({})).toEqual([]);
    expect(localMcpServerIds({ mcp: {} })).toEqual([]);
  });
});

describe("assertSandboxedRuntimeConfig", () => {
  it("accepts a server that resolved the sandbox shell", async () => {
    await expect(assertSandboxedRuntimeConfig(
      { readConfig: async () => ({ shell: SHELL, mcp: {} }) },
      { shellCommand: SHELL },
    )).resolves.toBeUndefined();
  });

  it("accepts an SDK response envelope", async () => {
    await expect(assertSandboxedRuntimeConfig(
      { readConfig: async () => ({ data: { shell: SHELL } }) },
      { shellCommand: SHELL },
    )).resolves.toBeUndefined();
  });

  it("rejects a server whose shell is not the sandbox trampoline", async () => {
    await expect(assertSandboxedRuntimeConfig(
      { readConfig: async () => ({ shell: "/bin/sh" }) },
      { shellCommand: SHELL },
    )).rejects.toThrow(SHELL_NOT_SANDBOXED_MESSAGE);
  });

  it("rejects a server with no shell configured at all", async () => {
    await expect(assertSandboxedRuntimeConfig(
      { readConfig: async () => ({}) },
      { shellCommand: SHELL },
    )).rejects.toThrow(SHELL_NOT_SANDBOXED_MESSAGE);
  });

  it("rejects configured local MCP servers, which inherit the server environment", async () => {
    await expect(assertSandboxedRuntimeConfig(
      {
        readConfig: async () => ({
          shell: SHELL,
          mcp: { helper: { type: "local", command: ["helper"] } },
        }),
      },
      { shellCommand: SHELL },
    )).rejects.toThrow(LOCAL_MCP_PRESENT_MESSAGE);
  });

  it("allows remote MCP servers, which spawn no local process", async () => {
    await expect(assertSandboxedRuntimeConfig(
      {
        readConfig: async () => ({
          shell: SHELL,
          mcp: { hosted: { type: "remote", url: "https://example.com" } },
        }),
      },
      { shellCommand: SHELL },
    )).resolves.toBeUndefined();
  });

  it("fails closed when the config cannot be read", async () => {
    await expect(assertSandboxedRuntimeConfig(
      { readConfig: async () => { throw new Error("boom"); } },
      { shellCommand: SHELL },
    )).rejects.toThrow(CONFIG_UNREADABLE_MESSAGE);
  });

  it("fails closed on a non-object config", async () => {
    for (const value of [null, "text", 42, []]) {
      await expect(assertSandboxedRuntimeConfig(
        { readConfig: async () => value },
        { shellCommand: SHELL },
      )).rejects.toThrow(CONFIG_UNREADABLE_MESSAGE);
    }
  });

  it("never includes configuration contents in the failure message", async () => {
    const secret = "sk-do-not-leak-this-value";
    await expect(assertSandboxedRuntimeConfig(
      { readConfig: async () => { throw new Error(`provider key ${secret}`); } },
      { shellCommand: SHELL },
    )).rejects.toThrow(/^(?!.*sk-do-not-leak)/s);
  });
});
