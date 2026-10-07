import { describe, expect, it } from "vitest";

import { resolveAgentSelection, resolveModelSelection } from "../../src/harness/selection.js";

const models = [
  { providerID: "ollama", id: "glm-4.7-flash:latest", name: "GLM 4.7 Flash" },
  { providerID: "ollama", id: "qwen3-coder:30b", name: "Qwen 3 Coder" },
  { providerID: "cloud", id: "qwen-coder", name: "Qwen Coder" },
];

const agents = [{ id: "build" }, { id: "reviewer" }, { id: "reviewer-fast" }];

describe("model and agent selection", () => {
  it("matches full model references exactly and resolves unique case-insensitive shorthand", () => {
    expect(resolveModelSelection("OLLAMA/glm-4.7-flash:latest", models)).toEqual({
      kind: "selected",
      value: { providerID: "ollama", id: "glm-4.7-flash:latest" },
    });
    expect(resolveModelSelection("qwen3-coder", models)).toEqual({
      kind: "selected",
      value: { providerID: "ollama", id: "qwen3-coder:30b" },
    });
  });

  it("reports ambiguous and missing models without choosing an arbitrary match", () => {
    expect(resolveModelSelection("qwen", models)).toEqual({
      kind: "ambiguous",
      matches: [
        { providerID: "ollama", id: "qwen3-coder:30b" },
        { providerID: "cloud", id: "qwen-coder" },
      ],
    });
    expect(resolveModelSelection("missing", models)).toEqual({ kind: "missing" });
  });

  it("matches exact and unique partial agent IDs while reporting ambiguity", () => {
    expect(resolveAgentSelection("REVIEWER", agents)).toEqual({ kind: "selected", value: "reviewer" });
    expect(resolveAgentSelection("build", agents)).toEqual({ kind: "selected", value: "build" });
    expect(resolveAgentSelection("review", agents)).toEqual({
      kind: "ambiguous",
      matches: ["reviewer", "reviewer-fast"],
    });
    expect(resolveAgentSelection("unknown", agents)).toEqual({ kind: "missing" });
  });
});
