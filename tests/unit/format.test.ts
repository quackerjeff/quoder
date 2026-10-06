import { describe, expect, it } from "vitest";

import { formatResult } from "../../src/harness/format.js";
import type { PromptResult, TurnOutcome } from "../../src/harness/session-runner.js";
import { createTheme } from "../../src/ui/style.js";

const result = (outcome: TurnOutcome, overrides: Partial<PromptResult> = {}): PromptResult => ({
  sessionID: "ses_1",
  outcome,
  rejectedPermissions: [],
  rejectedQuestions: [],
  sessionDeleted: true,
  elapsedMs: 2_345,
  ...overrides,
});

describe("prompt result formatting", () => {
  it("ends an answered turn with a status line; the answer itself is shown by the live view", () => {
    expect(formatResult(result({ kind: "answered", text: "Hello" }))).toBe("✓ Done in 2.3s\n");
    expect(formatResult(result({ kind: "answered", text: "Hello" }), undefined, { tools: 4, outputTokens: 12_345 })).toBe(
      "✓ Done in 2.3s · 4 tools · 12.3k tokens\n",
    );
    expect(formatResult(result({ kind: "answered", text: "Hello" }), undefined, { tools: 1, outputTokens: 0 })).toBe(
      "✓ Done in 2.3s · 1 tool\n",
    );
  });

  it("explains a rejected permission without granting anything", () => {
    const text = formatResult(result({ kind: "permission-rejected", action: "external_directory", resourceCount: 1 }));
    expect(text).toContain("OpenCode asked for permission (external_directory, 1 resource).");
    expect(text).toContain("The permission request was rejected; the requested operation did not complete");
    expect(text).toContain("! Stopped after 2.3s");
  });

  it("shows sanitized question text and options so the developer can answer next", () => {
    const text = formatResult(result({
      kind: "question-rejected",
      questions: [{ question: "Which \u001b[31mlanguage\u001b[0m?", options: ["Rust", "Type‮Script"] }],
    }));
    expect(text).toContain("  Which language? (Rust / TypeScript)");
    expect(text).toContain("Answer it in your next prompt.");
    expect(text).not.toMatch(/[\u001b‮]/u);
  });

  it("reports cancellation (FR-12), failures, and an unverified deletion", () => {
    expect(formatResult(result({ kind: "cancelled" }))).toBe("– Execution cancelled after 2.3s. Harness session remains active.\n");
    expect(formatResult(result({ kind: "failed", reason: "Provider turn\ninterrupted\u0007" }))).toBe(
      "The prompt did not complete: Provider turn interrupted\n\n✗ Failed after 2.3s\n",
    );
    expect(formatResult(result({ kind: "cancelled" }, { sessionDeleted: false }))).toContain(
      "Warning: the OpenCode session could not be verified as deleted.",
    );
  });

  it("colours with theme roles and keeps model text free of escape sequences", () => {
    const text = formatResult(result({ kind: "failed", reason: "bad\u001b]0;x\u0007" }), createTheme(true));
    expect(text).toBe("\u001b[31mThe prompt did not complete: bad\u001b[39m\n\n\u001b[31m✗ Failed after 2.3s\u001b[39m\n");
  });
});

describe("rejections reported alongside other outcomes", () => {
  it("notes rejected permissions and questions before the status line, sanitized", () => {
    const text = formatResult(result(
      { kind: "answered", text: "Done." },
      {
        rejectedPermissions: [{ action: "external_directory", resourceCount: 2 }],
        rejectedQuestions: [{ question: "Proceed\u001b[2J?", options: [] }],
      },
    ));
    expect(text).toBe([
      "Note: OpenCode asked for permission (external_directory, 2 resources); Quoder did not grant it.",
      'Note: the model asked "Proceed?"; Quoder did not answer it.',
      "",
      "✓ Done in 2.3s",
      "",
    ].join("\n"));
  });

  it("does not repeat what the outcome already describes", () => {
    const text = formatResult(result(
      { kind: "permission-rejected", action: "external_directory", resourceCount: 1 },
      { rejectedPermissions: [{ action: "external_directory", resourceCount: 1 }] },
    ));
    expect(text).not.toContain("Note:");
  });
});
