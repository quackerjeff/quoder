import { describe, expect, it, vi } from "vitest";

import {
  launchSandboxedOpenCodeServer,
  type SandboxedServerDependencies,
  validateOpenCodeLaunchInputs,
} from "../../src/opencode-server.js";
import { SHELL_NOT_SANDBOXED_MESSAGE } from "../../src/opencode-sandbox-assertion.js";
import type { ToolSandbox } from "../../src/opencode-tool-sandbox.js";

const SHELL = "/private/var/folders/x/quoder-tool-sandbox-abc/quoder-model-shell";

const makeSandbox = (remove = vi.fn(async () => undefined)): ToolSandbox => ({
  configDirectory: "/private/var/folders/x/quoder-tool-sandbox-abc/opencode-config",
  shellCommand: SHELL,
  profilePath: "/private/var/folders/x/quoder-tool-sandbox-abc/model-tools.sb",
  deniedReadSubpaths: ["/private/var/folders/x/quoder-tool-sandbox-abc"],
  remove,
});

const deps = (overrides: Partial<SandboxedServerDependencies> = {}): SandboxedServerDependencies => ({
  prepareSandbox: async () => makeSandbox(),
  launch: async () => ({ url: "http://127.0.0.1:4096", close: async () => undefined }),
  assertRuntimeConfig: async () => undefined,
  readRuntimeConfig: async () => ({ shell: SHELL }),
  ...overrides,
}) as SandboxedServerDependencies;

const options = { username: "quoder", password: "secret", cwd: "/tmp/project" };

describe("OpenCode startup input validation", () => {
  it("accepts a usable pinned executable and the launch overlay shape Quoder consumes", () => {
    expect(validateOpenCodeLaunchInputs({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ["trusted"] }) }, process.execPath))
      .toBeUndefined();
  });

  it.each([
    ["malformed JSON", "{secret-inline-value"],
    ["invalid plugin list", JSON.stringify({ plugin: ["ok", 42] })],
  ])("reports %s without returning inline configuration", (_label, value) => {
    const result = validateOpenCodeLaunchInputs({ OPENCODE_CONFIG_CONTENT: value }, process.execPath);
    expect(result).toBe("inline-config-invalid");
    expect(String(result)).not.toContain("secret-inline-value");
  });

  it("detects a missing launch executable without exposing its path", () => {
    expect(validateOpenCodeLaunchInputs({}, "/private/path/to/missing-opencode")).toBe("executable-unavailable");
  });
});

describe("launchSandboxedOpenCodeServer", () => {
  it("passes the prepared sandbox to the launcher", async () => {
    const launch = vi.fn(async () => ({ url: "http://127.0.0.1:4096", close: async () => undefined }));
    await launchSandboxedOpenCodeServer(options, deps({ launch }));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      toolSandbox: expect.objectContaining({ shellCommand: SHELL }),
    }));
  });

  it("removes the sandbox when the server is closed", async () => {
    const remove = vi.fn(async () => undefined);
    const launched = await launchSandboxedOpenCodeServer(options, deps({
      prepareSandbox: async () => makeSandbox(remove),
    }));
    expect(remove).not.toHaveBeenCalled();
    await launched.close();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("removes the sandbox when the launch fails", async () => {
    const remove = vi.fn(async () => undefined);
    await expect(launchSandboxedOpenCodeServer(options, deps({
      prepareSandbox: async () => makeSandbox(remove),
      launch: async () => { throw new Error("startup failed"); },
    }))).rejects.toThrow("startup failed");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("terminates the server and removes the sandbox when the assertion fails", async () => {
    const remove = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    await expect(launchSandboxedOpenCodeServer(options, deps({
      prepareSandbox: async () => makeSandbox(remove),
      launch: async () => ({ url: "http://127.0.0.1:4096", close }),
      assertRuntimeConfig: async () => { throw new Error(SHELL_NOT_SANDBOXED_MESSAGE); },
    }))).rejects.toThrow(SHELL_NOT_SANDBOXED_MESSAGE);
    expect(close).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("asserts against the live server using the sandbox's own shell command", async () => {
    const assertRuntimeConfig = vi.fn(async () => undefined);
    await launchSandboxedOpenCodeServer(options, deps({ assertRuntimeConfig }));
    expect(assertRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ readConfig: expect.any(Function) }),
      { shellCommand: SHELL },
    );
  });

  it("reads the resolved config from the launched URL with basic auth", async () => {
    const readRuntimeConfig = vi.fn(async () => ({ shell: SHELL }));
    await launchSandboxedOpenCodeServer(options, deps({
      readRuntimeConfig,
      assertRuntimeConfig: async (reader) => { await reader.readConfig(); },
    }));
    expect(readRuntimeConfig).toHaveBeenCalledWith(
      "http://127.0.0.1:4096",
      `Basic ${Buffer.from("quoder:secret", "utf8").toString("base64")}`,
    );
  });

  it("still removes the sandbox when closing the server throws", async () => {
    const remove = vi.fn(async () => undefined);
    const launched = await launchSandboxedOpenCodeServer(options, deps({
      prepareSandbox: async () => makeSandbox(remove),
      launch: async () => ({ url: "http://127.0.0.1:4096", close: async () => { throw new Error("stuck"); } }),
    }));
    await expect(launched.close()).rejects.toThrow("stuck");
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
