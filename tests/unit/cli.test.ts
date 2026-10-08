import { describe, expect, it } from "vitest";

import { DEFAULT_MODEL, parseArguments, startupConfigurationDiagnostic } from "../../src/cli.js";

describe("quoder command-line arguments", () => {
  it("defaults to the verified glm model", () => {
    expect(DEFAULT_MODEL).toEqual({ providerID: "ollama", id: "glm-4.7-flash:latest" });
    expect(parseArguments([])).toEqual({ kind: "run", model: DEFAULT_MODEL, noColor: false });
  });

  it("accepts --model provider/model in both forms, keeping colons and slashes in the model ID", () => {
    expect(parseArguments(["--model", "ollama/qwen3-coder:30b"])).toEqual({
      kind: "run",
      model: { providerID: "ollama", id: "qwen3-coder:30b" },
      noColor: false,
    });
    expect(parseArguments(["--model=lab/org/model:tag"])).toEqual({
      kind: "run",
      model: { providerID: "lab", id: "org/model:tag" },
      noColor: false,
    });
  });

  it("accepts --no-color with other options", () => {
    expect(parseArguments(["--no-color", "--model", "ollama/qwen3-coder:30b"])).toEqual({
      kind: "run",
      model: { providerID: "ollama", id: "qwen3-coder:30b" },
      noColor: true,
    });
  });

  it.each([[["--model"]], [["--model", "no-slash"]], [["--model", "/id"]], [["--model", "provider/"]]])(
    "rejects a malformed model %j",
    (args) => {
      expect(parseArguments(args)).toMatchObject({ kind: "error" });
    },
  );

  it("handles help, version, and unknown arguments", () => {
    expect(parseArguments(["--help"])).toEqual({ kind: "help" });
    expect(parseArguments(["-h"])).toEqual({ kind: "help" });
    expect(parseArguments(["--version"])).toEqual({ kind: "version" });
    expect(parseArguments(["--yolo"])).toEqual({ kind: "error", message: "Unknown argument: --yolo" });
  });

  it("reports launch-critical configuration failures with fixed sanitized diagnostics", () => {
    expect(startupConfigurationDiagnostic("inline-config-invalid")).toBe(
      "Configuration: OpenCode launch configuration is invalid. Correct OPENCODE_CONFIG_CONTENT JSON and its plugin list; no values are shown.",
    );
    expect(startupConfigurationDiagnostic("executable-unavailable")).toContain("Run `npm install` in Quoder");
    expect(startupConfigurationDiagnostic("inline-config-invalid")).not.toContain("secret");
  });
});
