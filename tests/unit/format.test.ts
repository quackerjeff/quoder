import { describe, expect, it } from "vitest";

import { formatResult } from "../../src/harness/format.js";
import type { PromptResult, TurnOutcome } from "../../src/harness/session-runner.js";

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
  it("shows a sanitized answer and the elapsed time", () => {
    expect(formatResult(result({ kind: "answered", text: "\u001b]0;pwned\u0007Hello\r\nworld" }))).toBe(
      "Hello\nworld\n\nCompleted in 2.3s.\n",
    );
  });

  it("explains a rejected permission without granting anything", () => {
    const text = formatResult(result({ kind: "permission-rejected", action: "external_directory", resourceCount: 1 }));
    expect(text).toContain("OpenCode asked for permission (external_directory, 1 resource).");
    expect(text).toContain("the request was not granted and the turn ended");
    expect(text).not.toContain("Completed in");
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

  it("reports cancellation, failures, and an unverified deletion", () => {
    expect(formatResult(result({ kind: "cancelled" }))).toBe("Execution cancelled.\n");
    expect(formatResult(result({ kind: "failed", reason: "Provider turn\ninterrupted\u0007" }))).toBe(
      "The prompt did not complete: Provider turn interrupted\n",
    );
    expect(formatResult(result({ kind: "cancelled" }, { sessionDeleted: false }))).toContain(
      "Warning: the OpenCode session could not be verified as deleted.",
    );
  });
});

describe("rejections reported alongside other outcomes", () => {
  it("notes rejected permissions and questions before an answer, sanitized", () => {
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
      "Done.",
      "",
      "Completed in 2.3s.",
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
