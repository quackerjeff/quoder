import { describe, expect, it } from "vitest";

import { formatGitSummary, formatResult } from "../../src/harness/format.js";
import { compareGitSnapshots, type GitSnapshot } from "../../src/harness/git-state.js";
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

describe("Git change summary formatting", () => {
  const snapshot = (paths: GitSnapshot["paths"], trackedFiles = 0): GitSnapshot => ({
    kind: "available",
    root: "/work/project",
    head: "0123456789abcdef0123456789abcdef01234567",
    branch: "main",
    branchState: "attached",
    paths,
    untrackedPaths: paths.filter(({ kind }) => kind === "untracked").map(({ path }) => path),
    trackedDiff: { files: trackedFiles, additions: trackedFiles === 0 ? 0 : 3, deletions: trackedFiles === 0 ? 0 : 2, binaryFiles: 0 },
  });

  it("shows status transitions separately from pre-existing paths and sanitizes path text", async () => {
    const before = snapshot([
      { path: "baseline.ts", indexStatus: ".", worktreeStatus: "M", submoduleStatus: "N...", kind: "tracked" },
    ]);
    const after = snapshot([
      { path: "baseline.ts", indexStatus: ".", worktreeStatus: "M", submoduleStatus: "N...", kind: "tracked" },
      { path: "new\u001b[2J\tfile.ts", indexStatus: "?", worktreeStatus: "?", submoduleStatus: "N...", kind: "untracked" },
    ], 1);
    const formatted = formatGitSummary(await compareGitSnapshots(before, after));

    expect(formatted).toContain("Git changes observed: 1 path (1 added)");
    expect(formatted).toContain("new file.ts");
    expect(formatted).toContain("Pre-existing changes: 1 file");
    expect(formatted).toContain("baseline.ts");
    expect(formatted).toContain("Final tracked diff: 1 tracked file (+3 -2)");
    expect(formatted).not.toMatch(/[\u001b\u0000-\u0008\u000b-\u001f]/u);
  });

  it("reports a clean repository without an empty diff prompt", async () => {
    const clean = snapshot([]);
    expect(formatGitSummary(await compareGitSnapshots(clean, clean))).toBe(
      "Git changes observed: none\nRepository state: clean\n",
    );
  });

  it("reports non-repository and inspection failures as unavailable", async () => {
    const noRepository = { kind: "unavailable", root: "/tmp/project", reason: "not-repository" } as const;
    const outputLimit = { kind: "unavailable", root: "/tmp/project", reason: "output-limit" } as const;
    expect(formatGitSummary(await compareGitSnapshots(noRepository, noRepository))).toContain(
      "Repository state unavailable: project is not a Git repository.",
    );
    expect(formatGitSummary(await compareGitSnapshots(snapshot([]), outputLimit))).toContain(
      "Git state unavailable after the prompt: Git inspection exceeded its output limit.",
    );
  });

  it("sanitizes repository-provided branch and HEAD values", async () => {
    const before = snapshot([]);
    const after = { ...snapshot([]), head: "bad\u001b[2Jhash", branch: "main\u202e" };
    const formatted = formatGitSummary(await compareGitSnapshots(before, after));

    expect(formatted).toContain("HEAD changed: 0123456789abcdef0123456789abcdef01234567 → badhash");
    expect(formatted).toContain("Branch changed: main → main");
    expect(formatted).not.toMatch(/[\u001b\u0000-\u0008\u000b-\u001f\u202a-\u202e]/u);
  });
});
