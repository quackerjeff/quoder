import { describe, expect, it } from "vitest";

import { displayPath, renderActivity, runningLabel, summarizeCall, summarizeResult } from "../../src/harness/activity.js";
import { PLAIN_THEME, createTheme } from "../../src/ui/style.js";

const ROOT = "/work/QuackTrack";
const ok = (structured: Record<string, unknown> = {}, output = "") => ({ kind: "succeeded" as const, structured, output });
const line = (tool: string, input: Record<string, unknown>, outcome = ok()) =>
  renderActivity(summarizeResult(tool, input, ROOT, outcome), PLAIN_THEME);

describe("project-relative paths", () => {
  it.each([
    ["/work/QuackTrack/src/import.rs", "src/import.rs"],
    ["/work/QuackTrack", "."],
    ["src/import.rs", "src/import.rs"],
    ["/etc/hosts", "/etc/hosts"],
    ["/work/QuackTrack-other/x", "/work/QuackTrack-other/x"],
    ["/work/QuackTrack/..foo", "..foo"],
  ])("shows %s as %s", (path, expected) => {
    expect(displayPath(path, ROOT)).toBe(expected);
  });
});

describe("tool activity lines (verified 1.18.33 shapes)", () => {
  it("read: the path and line count", () => {
    expect(line("read", { path: "/work/QuackTrack/notes.txt" }, ok({ content: "alpha\nbeta\n", mime: "text/plain" }))).toBe(
      "✓ ● Read   notes.txt  2 lines",
    );
  });

  it("edit: additions and deletions summed across files", () => {
    expect(
      line(
        "edit",
        { path: "src/import.rs", oldString: "a", newString: "b" },
        ok({ files: [{ file: "src/import.rs", additions: 12, deletions: 3 }, { file: "x", additions: 1, deletions: "?" }], replacements: 2 }),
      ),
    ).toBe("✓ ✎ Edit   src/import.rs  +13 −3");
  });

  it("write: new or overwritten, with line count", () => {
    expect(line("write", { path: "new.txt", content: "hello" }, ok({ existed: false }))).toBe("✓ + Write  new.txt  new file · 1 line");
    expect(line("write", { path: "a.txt", content: "1\n2\n" }, ok({ existed: true }))).toBe("✓ + Write  a.txt  overwritten · 2 lines");
  });

  it("bash: the command, exit code and last output line; a non-zero exit is a warning", () => {
    expect(line("bash", { command: "cargo test" }, ok({ exit: 0, truncated: false }, "running\n47 tests passed\n\n"))).toBe(
      "✓ $ Run    cargo test  exit 0 · 47 tests passed",
    );
    expect(
      line("bash", { command: "ls /nonexistent" }, ok({ exit: 1 }, "ls: /nonexistent: No such file or directory")),
    ).toBe("! $ Run    ls /nonexistent  exit 1 · ls: /nonexistent: No such file or directory");
    expect(line("bash", { command: "true" }, ok({ exit: 0 }))).toBe("✓ $ Run    true  exit 0");
    expect(line("bash", { command: "echo hi" }, ok({}, "hi"))).toBe("✓ $ Run    echo hi  hi");
  });

  it("grep and glob: pattern, scope and counts", () => {
    expect(line("grep", { pattern: "fn import", path: "/work/QuackTrack/src" }, ok({ value: [{}, {}] }))).toBe(
      '✓ ⌕ Search "fn import" in src  2 matches',
    );
    expect(line("grep", { pattern: "alpha", path: "." }, ok({ value: [{}] }))).toBe('✓ ⌕ Search "alpha"  1 match');
    expect(line("glob", { pattern: "*.txt" }, ok({ value: [{ path: "a", type: "file" }] }))).toBe("✓ ⌕ Find   *.txt  1 file");
  });

  it("other bundled tools and unknown tools", () => {
    expect(line("list", {})).toBe("✓ ▤ List   .");
    expect(line("webfetch", { url: "https://example.com" })).toBe("✓ ↓ Fetch  https://example.com");
    expect(line("task", { description: "Investigate the failing test" })).toBe("✓ ◆ Task   Investigate the failing test");
    expect(line("todowrite", { todos: [1, 2, 3] })).toBe("✓ ☐ Todos  3 items");
    expect(line("mystery", { anything: 1 })).toBe("✓ · mystery");
  });

  it("failed and cancelled calls", () => {
    expect(line("edit", { path: "notes.txt" }, { kind: "failed", message: "oldString not found\nin file" } as never)).toBe(
      "✗ ✎ Edit   notes.txt  oldString not found in file",
    );
    expect(line("bash", { command: "sleep 60" }, { kind: "cancelled" } as never)).toBe("– $ Run    sleep 60  cancelled");
  });

  it("falls back when fields are missing or malformed", () => {
    expect(line("read", { path: 7 }, ok({ content: 3 }))).toBe("✓ ● Read");
    expect(line("bash", {}, ok({ exit: "0" }))).toBe("✓ $ Run");
    expect(line("grep", {}, ok({ value: "x" }))).toBe("✓ ⌕ Search");
  });
});

describe("untrusted text in activity lines", () => {
  it("sanitizes and collapses commands, paths and output before styling", () => {
    const rendered = line(
      "bash",
      { command: "echo \u001b]52;c;cGF3bmVk\u0007hi\nrm -rf x" },
      ok({ exit: 0 }, "done\u001b[2J‮"),
    );
    expect(rendered).toBe("✓ $ Run    echo hi rm -rf x  exit 0 · done");
    expect(line("mystery\u001b[31m", {})).toBe("✓ · mystery");
  });

  it("truncates long subjects and details", () => {
    const rendered = summarizeResult("bash", { command: "x".repeat(300) }, ROOT, ok({ exit: 0 }, "y".repeat(300)));
    expect(rendered.subject).toHaveLength(80);
    expect(rendered.subject.endsWith("…")).toBe(true);
    expect(rendered.detail).toBe(`exit 0 · ${"y".repeat(79)}…`);
  });

  it("styles only Quoder's own structure when colour is on", () => {
    const rendered = renderActivity(summarizeResult("read", { path: "a.ts" }, ROOT, ok()), createTheme(true));
    expect(rendered).toContain("\u001b[36ma.ts\u001b[39m");
    expect(rendered).toContain("\u001b[32m✓\u001b[39m");
  });
});

describe("status-line label for running tools", () => {
  it("names one tool and counts several", () => {
    expect(runningLabel([])).toBeUndefined();
    expect(runningLabel([summarizeCall("bash", { command: "cargo test" }, ROOT)])).toBe("Running cargo test");
    expect(runningLabel([summarizeCall("todowrite", {}, ROOT)])).toBe("Updating todos");
    expect(runningLabel([summarizeCall("read", { path: "a" }, ROOT), summarizeCall("bash", { command: "ls" }, ROOT)])).toBe(
      "Running 2 tools",
    );
  });
});
