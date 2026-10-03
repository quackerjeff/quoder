import { describe, expect, it, vi } from "vitest";

import {
  ENVIRONMENT_DISCOVERY_TIMEOUT_MS,
  ENVIRONMENT_INFERENCE_TIMEOUT_MS,
  ENVIRONMENT_ROW_NAMES,
  ENVIRONMENT_RUN_TIMEOUT_MS,
  parseProviderConfiguration,
  runEnvironmentPreflight,
  type EnvironmentPreflightDependencies,
  type ProviderConfiguration,
} from "../../src/environment-preflight.js";

const configuration: ProviderConfiguration = {
  baseURL: new URL("https://example.invalid/v1"),
  headers: { Authorization: "secret-token" },
  configuredModels: new Set(["qwen3-coder:30b"]),
};

const passingDependencies = (): EnvironmentPreflightDependencies => ({
  verifyPinnedDependencies: vi.fn().mockResolvedValue(undefined),
  loadProviderConfiguration: vi.fn().mockResolvedValue(configuration),
  discoverModels: vi.fn().mockResolvedValue({ modelIDs: new Set(["qwen3-coder:30b"]) }),
  runDirectInference: vi.fn().mockResolvedValue(undefined),
  discoverOpenCodeModel: vi.fn().mockResolvedValue(undefined),
  runOpenCodeInference: vi.fn().mockResolvedValue(undefined),
  cleanup: vi.fn().mockResolvedValue(undefined),
});

const verifyContract = (output: string): void => {
  for (const name of ENVIRONMENT_ROW_NAMES) {
    expect(output.match(new RegExp(`^${name}: (?:PASS|FAIL) - `, "gm"))).toHaveLength(1);
  }
  expect(output.match(/^Environment Readiness: (?:PASS|FAIL)$/gm)).toHaveLength(1);
  expect(output.trim().split("\n")).toHaveLength(9);
};

describe("environment readiness preflight", () => {
  it("emits exactly eight passing rows and one passing verdict", async () => {
    const dependencies = passingDependencies();

    const outcome = await runEnvironmentPreflight(dependencies);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.readiness).toBe("PASS");
    expect(outcome.rows.map(({ name }) => name)).toEqual(ENVIRONMENT_ROW_NAMES);
    expect(outcome.rows.every(({ status }) => status === "PASS")).toBe(true);
    verifyContract(outcome.output);
    expect(dependencies.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ["absent", new Error("ENOENT: /private/config")],
    ["malformed", new SyntaxError("credential secret-token near offset 4")],
  ])("fails closed for %s provider configuration without leaking diagnostics", async (_name, failure) => {
    const dependencies = passingDependencies();
    vi.mocked(dependencies.loadProviderConfiguration).mockRejectedValue(failure);

    const outcome = await runEnvironmentPreflight(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.rows.find(({ name }) => name === "Provider configuration")?.status).toBe("FAIL");
    expect(outcome.output).not.toContain("secret-token");
    expect(outcome.output).not.toContain("/private/config");
    expect(dependencies.discoverModels).not.toHaveBeenCalled();
    expect(dependencies.cleanup).toHaveBeenCalledOnce();
    verifyContract(outcome.output);
  });

  it("reports an unreachable endpoint and skips dependent model work", async () => {
    const dependencies = passingDependencies();
    vi.mocked(dependencies.discoverModels).mockRejectedValue(new Error("ECONNREFUSED secret"));

    const outcome = await runEnvironmentPreflight(dependencies);

    expect(outcome.rows.find(({ name }) => name === "Endpoint reachability")?.status).toBe("FAIL");
    expect(outcome.rows.find(({ name }) => name === "Model discovery")?.evidence).toBe("prerequisite check failed");
    expect(dependencies.runDirectInference).not.toHaveBeenCalled();
    expect(outcome.output).not.toContain("ECONNREFUSED");
  });

  it("reports a missing model without attempting inference", async () => {
    const dependencies = passingDependencies();
    vi.mocked(dependencies.discoverModels).mockResolvedValue({ modelIDs: new Set(["other-model"]) });

    const outcome = await runEnvironmentPreflight(dependencies);

    expect(outcome.rows.find(({ name }) => name === "Endpoint reachability")?.status).toBe("PASS");
    expect(outcome.rows.find(({ name }) => name === "Model discovery")?.status).toBe("FAIL");
    expect(dependencies.runDirectInference).not.toHaveBeenCalled();
    expect(dependencies.discoverOpenCodeModel).not.toHaveBeenCalled();
  });

  it("reports direct-inference failure and does not attempt OpenCode inference", async () => {
    const dependencies = passingDependencies();
    vi.mocked(dependencies.runDirectInference).mockRejectedValue(new Error("raw model response secret"));

    const outcome = await runEnvironmentPreflight(dependencies);

    expect(outcome.rows.find(({ name }) => name === "Direct inference")?.status).toBe("FAIL");
    expect(outcome.rows.find(({ name }) => name === "OpenCode model discovery")?.status).toBe("PASS");
    expect(outcome.rows.find(({ name }) => name === "OpenCode inference")?.status).toBe("FAIL");
    expect(dependencies.runOpenCodeInference).not.toHaveBeenCalled();
    expect(outcome.output).not.toContain("raw model response");
  });

  it("distinguishes OpenCode discovery and inference failures", async () => {
    const discoveryDependencies = passingDependencies();
    vi.mocked(discoveryDependencies.discoverOpenCodeModel).mockRejectedValue(new Error("cli stderr secret"));

    const discoveryOutcome = await runEnvironmentPreflight(discoveryDependencies);

    expect(discoveryOutcome.rows.find(({ name }) => name === "OpenCode model discovery")?.status).toBe("FAIL");
    expect(discoveryDependencies.runOpenCodeInference).not.toHaveBeenCalled();
    expect(discoveryOutcome.output).not.toContain("cli stderr");

    const inferenceDependencies = passingDependencies();
    vi.mocked(inferenceDependencies.runOpenCodeInference).mockRejectedValue(new Error("server diagnostic secret"));

    const inferenceOutcome = await runEnvironmentPreflight(inferenceDependencies);

    expect(inferenceOutcome.rows.find(({ name }) => name === "OpenCode model discovery")?.status).toBe("PASS");
    expect(inferenceOutcome.rows.find(({ name }) => name === "OpenCode inference")?.status).toBe("FAIL");
    expect(inferenceOutcome.output).not.toContain("server diagnostic");
  });

  it("enforces a finite stage deadline and still cleans up", async () => {
    const dependencies = passingDependencies();
    vi.mocked(dependencies.discoverModels).mockImplementation(
      async (_configuration, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted with secret")), { once: true });
      }),
    );

    const started = Date.now();
    const outcome = await runEnvironmentPreflight(dependencies, {
      discoveryTimeoutMs: 10,
      inferenceTimeoutMs: 20,
      runTimeoutMs: 40,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.rows.find(({ name }) => name === "Endpoint reachability")?.evidence).toBe("finite deadline exceeded");
    expect(outcome.rows.find(({ name }) => name === "Cleanup")?.status).toBe("PASS");
    expect(dependencies.cleanup).toHaveBeenCalledOnce();
    expect(outcome.output).not.toContain("secret");
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("enforces the whole-run deadline and still cleans up", async () => {
    const dependencies = passingDependencies();
    vi.mocked(dependencies.discoverModels).mockImplementation(
      async (_configuration, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("whole run aborted")), { once: true });
      }),
    );

    const started = Date.now();
    const outcome = await runEnvironmentPreflight(dependencies, {
      discoveryTimeoutMs: 100,
      inferenceTimeoutMs: 100,
      runTimeoutMs: 10,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.rows.find(({ name }) => name === "Endpoint reachability")?.evidence).toBe("finite deadline exceeded");
    expect(outcome.rows.find(({ name }) => name === "Cleanup")?.status).toBe("PASS");
    expect(dependencies.cleanup).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("returns conservatively when an operation never settles", async () => {
    const dependencies = passingDependencies();
    vi.mocked(dependencies.runOpenCodeInference).mockImplementation(
      async () => new Promise<void>(() => undefined),
    );
    const started = Date.now();
    const outcome = await runEnvironmentPreflight(dependencies, {
      discoveryTimeoutMs: 100,
      inferenceTimeoutMs: 10,
      runTimeoutMs: 50,
    });

    expect(outcome.rows.find(({ name }) => name === "OpenCode inference")?.evidence).toBe("finite deadline exceeded");
    expect(outcome.rows.find(({ name }) => name === "Cleanup")?.status).toBe("FAIL");
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("rejects a post-deadline ownership acquisition attempt", async () => {
    const dependencies = passingDependencies();
    let attemptOwnership: (() => boolean) | undefined;
    vi.mocked(dependencies.runOpenCodeInference).mockImplementation(
      async (_signal, ownership) => new Promise<void>(() => {
        attemptOwnership = () => ownership.accept();
      }),
    );

    const outcome = await runEnvironmentPreflight(dependencies, {
      discoveryTimeoutMs: 100,
      inferenceTimeoutMs: 10,
      runTimeoutMs: 50,
    });

    expect(attemptOwnership?.()).toBe(false);
    expect(outcome.rows.find(({ name }) => name === "Cleanup")?.status).toBe("FAIL");
  });

  it("observes a late rejection during bounded post-abort settlement", async () => {
    const dependencies = passingDependencies();
    vi.mocked(dependencies.runOpenCodeInference).mockImplementation(
      async (signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => reject(new Error("late secret rejection")), 1);
        }, { once: true });
      }),
    );

    const outcome = await runEnvironmentPreflight(dependencies, {
      discoveryTimeoutMs: 100,
      inferenceTimeoutMs: 20,
      runTimeoutMs: 100,
    });

    expect(outcome.rows.find(({ name }) => name === "OpenCode inference")?.evidence).toBe("finite deadline exceeded");
    expect(outcome.rows.find(({ name }) => name === "Cleanup")?.status).toBe("PASS");
    expect(outcome.output).not.toContain("late secret rejection");
  });

  it("reports owned-resource cleanup failure", async () => {
    const dependencies = passingDependencies();
    vi.mocked(dependencies.cleanup).mockRejectedValue(new Error("/tmp/private-resource secret"));

    const outcome = await runEnvironmentPreflight(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.rows.find(({ name }) => name === "Cleanup")?.status).toBe("FAIL");
    expect(outcome.output).not.toContain("private-resource");
    expect(outcome.output).not.toContain("secret");
  });

  it("publishes the approved 10/60/180-second limits", () => {
    expect(ENVIRONMENT_DISCOVERY_TIMEOUT_MS).toBe(10_000);
    expect(ENVIRONMENT_INFERENCE_TIMEOUT_MS).toBe(60_000);
    expect(ENVIRONMENT_RUN_TIMEOUT_MS).toBe(180_000);
  });
});

describe("provider configuration parsing", () => {
  it("accepts the approved JSONC shape without returning raw configuration", () => {
    const parsed = parseProviderConfiguration(`{
      // configured remote provider
      "provider": {
        "ollama": {
          "npm": "@ai-sdk/openai-compatible",
          "options": {
            "baseURL": "https://example.invalid/v1",
            "headers": { "Authorization": "secret-token", },
          },
          "models": { "qwen3-coder:30b": {}, },
        },
      },
    }`);

    expect(parsed.baseURL.href).toBe("https://example.invalid/v1");
    expect(parsed.configuredModels.has("qwen3-coder:30b")).toBe(true);
    expect(parsed.headers).toEqual({ Authorization: "secret-token" });
  });

  it("preserves comment-like and trailing-comma-like text inside header strings", () => {
    const parsed = parseProviderConfiguration(`{
      "provider": { "ollama": {
        "npm": "@ai-sdk/openai-compatible",
        "options": {
          "baseURL": "https://example.invalid/v1",
          "headers": { "Authorization": "Bearer value//part,}" },
        },
        "models": { "qwen3-coder:30b": {} },
      } },
    }`);

    expect(parsed.headers.Authorization).toBe("Bearer value//part,}");
  });

  it.each([
    ["{}"],
    ['{"provider":{"ollama":{"npm":"wrong","options":{},"models":{}}}}'],
    ['{"provider":{"ollama":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://localhost/v1","headers":{}},"models":{"qwen3-coder:30b":{}}}}}'],
  ])("rejects absent or malformed approved provider shape", (source) => {
    expect(() => parseProviderConfiguration(source)).toThrow();
  });
});
