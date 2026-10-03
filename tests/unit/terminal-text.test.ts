import { describe, expect, it } from "vitest";

import { sanitizeForTerminal, sanitizeLine } from "../../src/harness/terminal-text.js";

describe("terminal sanitizing of untrusted model text", () => {
  it.each([
    ["CSI colours", "\u001b[31mred\u001b[0m text", "red text"],
    ["cursor movement and erase", "a\u001b[2Jb\u001b[10;5Hc\u001b[K", "abc"],
    ["OSC title terminated by BEL", "\u001b]0;pwned\u0007title", "title"],
    ["OSC 8 hyperlink terminated by ST", "\u001b]8;;https://evil.example\u001b\\click\u001b]8;;\u001b\\", "click"],
    ["8-bit CSI", "x\u009b31my", "xy"],
    ["bare ESC and other ESC sequences", "a\u001bcb\u001b7c", "abc"],
    ["C0 and C1 controls, BEL, DEL", "a\u0000b\u0007c\u0008d\u007fe\u0085f", "abcdef"],
    ["bidirectional overrides", "safe‮gnirts‬ ⁦x⁩", "safegnirts x"],
  ])("removes %s", (_name, input, expected) => {
    expect(sanitizeForTerminal(input)).toBe(expected);
  });

  it("keeps newlines, tabs, and ordinary Unicode, and normalizes carriage returns", () => {
    expect(sanitizeForTerminal("line 1\r\nline\t2\rline 3 — ✓ ünïcode 日本")).toBe("line 1\nline\t2\nline 3 — ✓ ünïcode 日本");
  });

  it("collapses whitespace and shortens single-line summaries", () => {
    expect(sanitizeLine("  a\n\tb   c  ")).toBe("a b c");
    expect(sanitizeLine("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
