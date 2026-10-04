import { describe, expect, it } from "vitest";

import { highlightLines, isHighlightable } from "../../src/ui/highlight.js";
import { MarkdownStream, renderMarkdown } from "../../src/ui/markdown.js";
import { PLAIN_THEME, createTheme } from "../../src/ui/style.js";

const COLOR = createTheme(true);
/** Every escape sequence in coloured output must be one of Quoder's own SGR sequences. */
const onlySgr = (text: string): boolean => [...text.matchAll(/\u001b/gu)].every((match) => /^\u001b\[[0-9;]*m/u.test(text.slice(match.index)));

const SAMPLE = [
  "# Mutex",
  "",
  "A **mutex** guards _shared_ state, see [docs](https://x.dev) and `lock()`.",
  "",
  "- one",
  "- two",
  "  1. nested",
  "",
  "> quoted *text*",
  "",
  "| Name | Count |",
  "|------|------:|",
  "| a    | 12 |",
  "",
  "```ts",
  "const m = 1; // hi",
  "```",
  "",
  "---",
  "Done.",
].join("\n");

describe("terminal Markdown rendering", () => {
  it("renders the common block and inline constructs as readable plain text", () => {
    expect(renderMarkdown(SAMPLE, PLAIN_THEME)).toBe(
      [
        "Mutex",
        "",
        "A mutex guards shared state, see docs (https://x.dev) and lock().",
        "",
        "• one",
        "• two",
        "  1. nested",
        "",
        "│ quoted text",
        "",
        "Name │ Count",
        "─────┼──────",
        "a    │    12",
        "",
        "┌ ts",
        "│ const m = 1; // hi",
        "",
        "─".repeat(40),
        "",
        "Done.",
        "",
      ].join("\n"),
    );
  });

  it("renders task lists, loose ordered lists, autolinks, images and breaks", () => {
    expect(renderMarkdown("- [x] done\n- [ ] todo", PLAIN_THEME)).toBe("• ☑ done\n• ☐ todo\n");
    expect(renderMarkdown("3. three\n\n4. four", PLAIN_THEME)).toBe("3. three\n\n4. four\n");
    expect(renderMarkdown("see <https://x.dev> ![logo](a.png)", PLAIN_THEME)).toBe("see https://x.dev [image: logo]\n");
    expect(renderMarkdown("a  \nb ~~gone~~", PLAIN_THEME)).toBe("a\nb gone\n");
  });

  it("keeps literal angle brackets, entities and escaped markers", () => {
    expect(renderMarkdown("Array<string> &amp; \\*not em\\*", PLAIN_THEME)).toBe("Array<string> &amp; *not em*\n");
  });

  it("styles with theme roles when colour is on", () => {
    const rendered = renderMarkdown("# Title\n\n**bold** `code`", COLOR);
    expect(rendered).toContain("\u001b[1m\u001b[35mTitle\u001b[39m\u001b[22m");
    expect(rendered).toContain("\u001b[1mbold\u001b[22m");
    expect(rendered).toContain("\u001b[33mcode\u001b[39m");
    expect(onlySgr(rendered)).toBe(true);
  });

  it("removes escape sequences from model text, in prose and in code", () => {
    const hostile = "Hi \u001b]52;c;cGF3bmVk\u0007there \u001b[2J‮\n\n```ts\nconst a = '\u001b[31mx'; \u009b31m\n```";
    expect(renderMarkdown(hostile, PLAIN_THEME)).toBe("Hi there \n\n┌ ts\n│ const a = 'x'; \n");
    expect(renderMarkdown(hostile, PLAIN_THEME)).not.toContain("\u001b");
    expect(onlySgr(renderMarkdown(hostile, COLOR))).toBe(true);
  });
});

describe("syntax highlighting", () => {
  it("highlights registered fence languages and decodes entities", () => {
    expect(isHighlightable("ts")).toBe(true);
    expect(isHighlightable("klingon")).toBe(false);
    const [line] = highlightLines('const a = "x<y" && b > 1;', "ts", COLOR);
    expect(line).toContain("\u001b[35mconst\u001b[39m");
    expect(line).toContain('\u001b[32m"x<y"\u001b[39m');
    expect(line).toContain("&& b >");
  });

  it("styles each line of a multi-line token on its own", () => {
    const lines = highlightLines("/* one\ntwo */\nlet x;", "ts", COLOR);
    expect(lines).toHaveLength(3);
    expect(lines[0]?.startsWith("\u001b[90m")).toBe(true);
    expect(lines[1]?.startsWith("\u001b[90m")).toBe(true);
    expect(lines[0]?.endsWith("\u001b[39m")).toBe(true);
  });

  it("leaves code plain without colour or without a known language", () => {
    expect(highlightLines("const a = 1;\nlet b;", "ts", PLAIN_THEME)).toEqual(["const a = 1;", "let b;"]);
    expect(highlightLines("plain\u001b[31m text", "klingon", COLOR)).toEqual(["plain text"]);
    expect(highlightLines("x", undefined, COLOR)).toEqual(["x"]);
  });
});

describe("streamed Markdown", () => {
  const collect = (theme = PLAIN_THEME) => {
    const writes: string[] = [];
    const stream = new MarkdownStream(theme, (text) => writes.push(text));
    return { stream, writes, output: () => writes.join("") };
  };

  it("prints a paragraph only once it is complete", () => {
    const { stream, writes } = collect();
    stream.push("Hello wor");
    stream.push("ld\nsecond line\n");
    expect(writes).toEqual([]);
    stream.push("\nNext");
    expect(writes).toEqual(["Hello world\nsecond line\n"]);
    stream.end();
    expect(writes).toEqual(["Hello world\nsecond line\n", "\nNext\n"]);
  });

  it("prints a heading as soon as its line ends", () => {
    const { stream, writes } = collect();
    stream.push("## Plan\nFirst");
    expect(writes).toEqual(["Plan\n"]);
  });

  it("holds a code fence until it closes, even on an idle flush", () => {
    const { stream, writes } = collect();
    stream.push("```ts\nconst a = 1;\n\nlet b;\n");
    stream.flushLines();
    expect(writes).toEqual([]);
    stream.push("```\n");
    expect(writes).toEqual(["┌ ts\n│ const a = 1;\n│ \n│ let b;\n"]);
  });

  it("does not close a fence on a shorter or different fence", () => {
    const { stream, writes } = collect();
    stream.push("````md\n```\n~~~~\n");
    expect(writes).toEqual([]);
    stream.push("````\n");
    expect(writes).toEqual(["┌ md\n│ ```\n│ ~~~~\n"]);
  });

  it("flushes the complete lines of a slow paragraph and continues it without a gap", () => {
    const { stream, output } = collect();
    stream.push("Intro.\n\nline one\nline tw");
    stream.flushLines();
    expect(output()).toBe("Intro.\n\nline one\n");
    stream.push("o\n\nNext");
    stream.end();
    expect(output()).toBe("Intro.\n\nline one\nline two\n\nNext\n");
  });

  it("produces the same output whatever the delta size", () => {
    for (const size of [1, 3, 7, 64]) {
      const { stream, output } = collect(COLOR);
      for (let index = 0; index < SAMPLE.length; index += size) stream.push(SAMPLE.slice(index, index + size));
      expect(stream.end(SAMPLE)).toBe(true);
      expect(output()).toBe(renderMarkdown(SAMPLE, COLOR));
    }
  });

  it("renders an unclosed fence at the end", () => {
    const { stream, output } = collect();
    stream.push("```py\nprint(1)\n");
    stream.end();
    expect(output()).toBe("┌ py\n│ print(1)\n");
  });

  it("completes a missed tail from the full text, and reports text that does not match", () => {
    const tail = collect();
    tail.stream.push("Hello");
    expect(tail.stream.end("Hello world")).toBe(true);
    expect(tail.output()).toBe("Hello world\n");
    expect(tail.stream.seen).toBe("Hello world");

    const mismatch = collect();
    mismatch.stream.push("Helo");
    expect(mismatch.stream.end("Hello world")).toBe(false);
    expect(mismatch.output()).toBe("Helo\n");
  });

  it("prints nothing for whitespace-only text", () => {
    const { stream, writes } = collect();
    stream.push("\n\n  \n");
    stream.end();
    expect(writes).toEqual([]);
  });
});
