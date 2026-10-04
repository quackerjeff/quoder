import { describe, expect, it } from "vitest";

import { HIGHLIGHT_MAX_CHARACTERS, highlightLines, isHighlightable } from "../../src/ui/highlight.js";
import { MarkdownStream, RENDER_BUDGET, plainMarkdown, renderMarkdown, trimTrailingNewlines } from "../../src/ui/markdown.js";
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

  it("keeps a code fence indented inside a nested list together across a blank line (review cycle 1)", () => {
    const source = "1. Install:\n   - run this:\n\n     ```js\n     const a = 1;\n\n     const b = 2;\n     ```\n\n2. Done\n";
    for (const size of [1, 5, 64]) {
      const { stream, output } = collect();
      for (let index = 0; index < source.length; index += size) stream.push(source.slice(index, index + size));
      stream.end(source);
      expect(output()).not.toContain("```");
      expect(output()).toContain("│ const a = 1;\n");
    }
  });

  it("does not flush a table or a possible setext heading before it is complete (review cycle 1)", () => {
    const table = collect();
    table.stream.push("| a | b |\n|---|---|\n| 1 | 2");
    table.stream.flushLines();
    expect(table.output()).toBe("");
    table.stream.end();
    expect(table.output()).toBe("a │ b\n──┼──\n1 │ 2\n");

    const setext = collect();
    setext.stream.push("Title\n");
    setext.stream.flushLines();
    setext.stream.push("=");
    setext.stream.flushLines();
    expect(setext.output()).toBe("");
    setext.stream.push("==\n\nBody");
    setext.stream.end();
    expect(setext.output()).toBe("Title\n\nBody\n");
  });

  it("prints each item of a loose list as soon as it is complete (review cycle 2)", () => {
    const steps = Array.from({ length: 6 }, (_unused, index) => `${index + 1}. Step ${index + 1}\n\n   Explanation of step ${index + 1}.\n`).join("\n");
    const source = `${steps}\nThat's all.`;
    const { stream, writes, output } = collect();
    let firstWriteAt: number | undefined;
    for (let index = 0; index < source.length; index += 3) {
      stream.push(source.slice(index, index + 3));
      if (firstWriteAt === undefined && writes.length > 0) firstWriteAt = index;
    }
    stream.end(source);
    expect(firstWriteAt).toBeLessThan(source.indexOf("2. Step 2") + 3);
    expect(output()).toContain("1. Step 1\n\n   Explanation of step 1.\n\n2. Step 2");
    expect(output()).toContain("6. Step 6");
    expect(output()).not.toContain("1. Step 2");
  });

  it("does not break a nested fence when an idle flush happens inside the list (review cycle 2)", () => {
    const source = "1. Install:\n   - run this:\n\n     ```js\n     const a = 1;\n\n     const b = 2;\n     ```\n\n2. Done\n";
    for (const every of [1, 3, 5]) {
      const { stream, output } = collect();
      let count = 0;
      for (let index = 0; index < source.length; index += 2) {
        stream.push(source.slice(index, index + 2));
        if (++count % every === 0) stream.flushLines();
      }
      stream.end(source);
      expect(output()).not.toContain("```");
      expect(output()).toContain("│ const a = 1;\n");
      expect(output()).toContain("│ const b = 2;");
    }
  });

  it("treats a deeply indented fence outside a list as an indented code block (review cycle 2)", () => {
    const source = "Para\n\n    ```\n    code\n\nAfter\n";
    const { stream, output } = collect();
    for (const character of source) stream.push(character);
    stream.end(source);
    expect(output()).toBe(renderMarkdown(source, PLAIN_THEME));
  });

  it("flushes all but the last line when the stream stalls right after a line break (review cycle 2)", () => {
    const { stream, output } = collect();
    stream.push("first line\nsecond line\n");
    stream.flushLines();
    expect(output()).toBe("first line\n");
  });

  it("protects a list that follows an intro line in the same block (review cycle 3)", () => {
    const inputs = [
      "Do:\n- step\n  - sub:\n    ```py\n    a = 1\n\n    b = 2\n    ```\n- next\n",
      "Steps:\n1. Install:\n   - run this:\n\n     ```js\n     const a = 1;\n\n     const b = 2;\n     ```\n\n2. Done\n",
    ];
    for (const source of inputs) {
      for (const size of [1, 3, 1000]) {
        const { stream, output } = collect();
        for (let index = 0; index < source.length; index += size) stream.push(source.slice(index, index + size));
        stream.end(source);
        expect(output()).not.toContain("```");
        expect(output()).toMatch(/│ (?:a = 1|const a = 1;)\n/u);
        expect(output()).toMatch(/│ (?:b = 2|const b = 2;)/u);
      }
    }
  });

  it("keeps nested items nested when an idle flush happens inside a list (review cycle 3)", () => {
    const { stream, output } = collect();
    stream.push("- a\n  - a1\n");
    stream.flushLines();
    stream.push("  - a2\n- b\n\nend");
    stream.end();
    expect(output()).toContain("• a\n  • a1\n  • a2\n• b");
  });

  it("keeps a setext === underline with its text when the stream stalls after it (review cycle 3)", () => {
    const { stream, output } = collect();
    stream.push("Intro\n\nTitle\n=====\n");
    stream.flushLines();
    stream.push("\nBody");
    stream.end();
    expect(output()).toBe("Intro\n\nTitle\n\nBody\n");
  });

  it("keeps the blank line before a heading that follows a flushed paragraph (review cycle 1)", () => {
    const { stream, output } = collect();
    stream.push("intro line\nmore");
    stream.flushLines();
    stream.push(" text\n# Heading\n");
    stream.end();
    expect(output()).toBe("intro line\nmore text\n\nHeading\n");
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

describe("character references that decode to control characters (security review cycle 1)", () => {
  /** Any C0/C1 control other than newline and tab, ESC included, or a bidirectional control. */
  const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
  const REFERENCES = ["&#27;", "&#x1b;", "&#x1B;", "&#0027;", "&#155;", "&#x9b;", "&#7;", "&#x202E;", "&#8238;"];
  const contexts = (reference: string): string[] => [
    `para ${reference}[2J text`,
    `# heading ${reference}]0;title`,
    `Setext ${reference}\n===`,
    `- item ${reference}]52;c;eA==`,
    `1. step ${reference}[1A`,
    `> quote ${reference}[?2004l`,
    `**bold ${reference}** and *em ${reference}* and ~~del ${reference}~~`,
    `| a ${reference} | b |\n|---|---|\n| c ${reference} | d |`,
    `[label ${reference}](https://x.dev/${reference}) and ![alt ${reference}](x.png)`,
    `inline <b title="${reference}">html ${reference}</b>`,
    `<div>block ${reference}</div>`,
    `\`code ${reference}\` and \\${reference}`,
    `\`\`\`ts ${reference}\nconst a = "${reference}";\n\`\`\``,
  ];

  it.each(REFERENCES)("never emits a control character for %s, plain or coloured", (reference) => {
    for (const source of contexts(reference)) {
      for (const theme of [PLAIN_THEME, COLOR]) {
        const rendered = renderMarkdown(source, theme);
        // Quoder's own SGR colour sequences are the only escapes allowed.
        expect(rendered.replace(/\u001b\[[0-9;]*m/gu, "")).not.toMatch(UNSAFE);
        expect(onlySgr(rendered)).toBe(true);
      }
    }
  });

  it("is safe on the streamed path too, with references split across deltas", () => {
    const source = contexts("&#27;").join("\n\n");
    for (const size of [1, 2, 5]) {
      const writes: string[] = [];
      const stream = new MarkdownStream(COLOR, (text) => writes.push(text));
      for (let index = 0; index < source.length; index += size) {
        stream.push(source.slice(index, index + size));
        if (index % 7 === 0) stream.flushLines();
      }
      stream.end(source);
      const output = writes.join("");
      expect(output.replace(/\u001b\[[0-9;]*m/gu, "")).not.toMatch(UNSAFE);
    }
  });
});

describe("highlighting budget (security review cycle 1)", () => {
  it("shows a pathological block plain instead of blocking the event loop", () => {
    const code = "a ".repeat(30_000);
    const started = performance.now();
    const lines = highlightLines(code, "csharp", COLOR);
    expect(performance.now() - started).toBeLessThan(250);
    expect(lines.join("")).toBe(code);
    expect(lines.join("")).not.toContain("\u001b");
  });

  it("still highlights ordinary blocks under the budget", () => {
    const code = "const a = 1;\n".repeat(Math.floor(HIGHLIGHT_MAX_CHARACTERS / 20));
    expect(highlightLines(code, "ts", COLOR)[0]).toContain("\u001b[35mconst\u001b[39m");
  });

  it("leaves a block with a very long line plain", () => {
    expect(highlightLines(`const a = "${"x".repeat(2_000)}";`, "ts", COLOR)[0]).not.toContain("\u001b");
  });
});

describe("pathological nesting (security review cycle 2)", () => {
  it.each([
    // 2,000 markers nest about 1,000 levels: deep enough to be slow without the cap, but not so
    // deep that the uncapped renderer overflows the stack and falls back to plain text.
    ["emphasis", `${"*".repeat(2000)}a${"*".repeat(2000)}`],
    ["underscores", `${"_".repeat(2000)}a${"_".repeat(2000)}`],
    ["emphasis in a heading", `# ${"*".repeat(2000)}a${"*".repeat(2000)}`],
    ["emphasis in a link label", `[${"*".repeat(2000)}a${"*".repeat(2000)}](https://x.dev)`],
    ["emphasis too deep for the stack", `${"*".repeat(6000)}a${"*".repeat(6000)}`],
  ])("renders deeply nested %s in colour quickly and with output linear in input", (_name, source) => {
    const started = performance.now();
    const rendered = renderMarkdown(source, COLOR);
    expect(performance.now() - started).toBeLessThan(300);
    expect(rendered.length).toBeLessThan(source.length * 4);
    expect(rendered).toContain("a");
  });

  it("keeps rendering shallow emphasis normally", () => {
    expect(renderMarkdown("***bold italic*** and **b _i_**", PLAIN_THEME)).toBe("bold italic and b i\n");
  });

  it.each([
    ["nested bullets", `${"- ".repeat(2500)}deep`],
    ["nested numbers", `${"1. ".repeat(1500)}deep`],
    ["quoted lists", `${"> - ".repeat(1200)}deep`],
    ["nested quotes", `${"> ".repeat(6000)}deep`],
  ])("never throws or drops text for deeply nested %s", (_name, source) => {
    for (const theme of [PLAIN_THEME, COLOR]) {
      let rendered = "";
      expect(() => {
        rendered = renderMarkdown(source, theme);
      }).not.toThrow();
      expect(rendered).toContain("deep");
    }
    const writes: string[] = [];
    const stream = new MarkdownStream(COLOR, (text) => writes.push(text));
    for (let index = 0; index < source.length; index += 64) stream.push(source.slice(index, index + 64));
    expect(() => stream.end()).not.toThrow();
    expect(writes.join("")).toContain("deep");
  });
});

describe("rendering budget (security review cycle 3)", () => {
  const timed = (source: string) => {
    const started = performance.now();
    const rendered = renderMarkdown(source, COLOR);
    return { rendered, ms: performance.now() - started };
  };
  const streamed = (source: string, size = 8) => {
    let output = "";
    let slowest = 0;
    const stream = new MarkdownStream(COLOR, (text) => {
      output += text;
    });
    for (let index = 0; index < source.length; index += size) {
      const started = performance.now();
      stream.push(source.slice(index, index + size));
      slowest = Math.max(slowest, performance.now() - started);
    }
    stream.end();
    return { output, slowest };
  };

  it("does not lex a huge table cell by cell (4,000 columns × 4,000 rows)", () => {
    const columns = 4_000;
    const source = `${"|h".repeat(columns)}|\n${"|-".repeat(columns)}|\n${"|a|\n".repeat(columns)}`;
    const { rendered, ms } = timed(source);
    expect(ms).toBeLessThan(200);
    expect(rendered.length).toBeLessThan(source.length * 2);
    const { output, slowest } = streamed(source, 64);
    expect(slowest).toBeLessThan(200);
    expect(output.length).toBeLessThan(source.length * 2);
  });

  it("keeps output linear for a reference link used thousands of times", () => {
    const source = `[r]: <https://x.dev/${"p".repeat(10_000)}>\n\n${"[a][r] ".repeat(10_000)}`;
    const { rendered } = timed(source);
    expect(rendered.length).toBeLessThan(source.length * RENDER_BUDGET.maxExpansion + 4096);
    expect(streamed(source, 256).output.length).toBeLessThan(source.length * RENDER_BUDGET.maxExpansion + 4096);
  });

  it("caps the width of a table column so one long cell cannot pad every row", () => {
    const source = `| a | b |\n|---|---|\n| ${"x".repeat(10_000)} | y |\n${"| a | b |\n".repeat(10_000)}`;
    const { rendered, ms } = timed(source);
    expect(ms).toBeLessThan(500);
    expect(rendered.length).toBeLessThan(source.length * 4);
  });

  it.each([
    ["*a ", 13_000],
    ["*", 40_000],
    ["__", 20_000],
  ])("renders %s × %d (quadratic for the emphasis tokenizer) quickly", (unit, count) => {
    const source = `${unit.repeat(count)}a`;
    expect(timed(source).ms).toBeLessThan(200);
    expect(streamed(source).slowest).toBeLessThan(200);
  });

  it("shortens a long link URL", () => {
    const rendered = renderMarkdown(`[docs](https://x.dev/${"p".repeat(500)})`, PLAIN_THEME);
    expect(rendered).toContain("…)");
    expect(rendered.length).toBeLessThan(260);
  });

  it("still formats ordinary content, including code full of underscores", () => {
    const code = `\`\`\`py\n${"snake_case_name = other_name\n".repeat(400)}\`\`\``;
    expect(renderMarkdown(code, PLAIN_THEME).startsWith("┌ py\n│ snake_case_name")).toBe(true);
    expect(renderMarkdown("Some **bold** and _italic_ text.", PLAIN_THEME)).toBe("Some bold and italic text.\n");
    expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", PLAIN_THEME)).toBe("a │ b\n──┼──\n1 │ 2\n");
  });

  it("shows an over-budget chunk as sanitized plain text, never dropping it", () => {
    const source = `${"*a ".repeat(2_000)}\u001b]52;c;eA==\u0007end`;
    const rendered = renderMarkdown(source, COLOR);
    expect(rendered).toContain("end");
    expect(rendered).not.toContain("\u001b");
  });
});

describe("per-stream rendering time budget (security review cycle 4)", () => {
  it("shows the rest of a stream plain once its rendering budget is spent", () => {
    let clock = 0;
    const calls: string[] = [];
    const writes: string[] = [];
    const stream = new MarkdownStream(PLAIN_THEME, (text) => writes.push(text), {
      budgetMs: 1_000,
      now: () => clock,
      render: (source) => {
        calls.push(source);
        clock += 400; // each chunk "takes" 400 ms
        return `[${source.trim()}]\n`;
      },
    });
    stream.push("one\n\ntwo\n\nthree\n\n**four**\n\n");
    stream.end();
    expect(calls.map((call) => call.trim())).toEqual(["one", "two", "three"]);
    expect(writes.join("")).toBe("[one]\n\n[two]\n\n[three]\n\n**four**\n");
  });

  it("falls back to plain text if the renderer throws", () => {
    const writes: string[] = [];
    const stream = new MarkdownStream(PLAIN_THEME, (text) => writes.push(text), {
      render: () => {
        throw new Error("boom");
      },
    });
    stream.push("a \u001b[2Jb\n\n");
    expect(writes).toEqual(["a b\n"]);
  });
});

describe("linear plain-text fallback (security review cycle 5)", () => {
  it.each([
    ["newlines inside a fence", `\`\`\`\n${"\n".repeat(200_000)}\`\`\``],
    ["carriage returns", `a\n${"\r".repeat(200_000)}b\n`],
    ["trailing newlines", `text${"\n".repeat(200_000)}`],
  ])("shows %s as plain text in linear time", (_name, source) => {
    const started = performance.now();
    const output = plainMarkdown(source);
    expect(performance.now() - started).toBeLessThan(50);
    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);
  });

  it("trims only trailing newlines", () => {
    expect(trimTrailingNewlines("a\n\nb\n\n\n")).toBe("a\n\nb");
    expect(trimTrailingNewlines("a  \n")).toBe("a  ");
    expect(trimTrailingNewlines("\n\n")).toBe("");
    expect(trimTrailingNewlines("plain")).toBe("plain");
  });
});

describe("linear fence detection (security review cycle 6)", () => {
  it.each([
    ["a tilde run ending in a backtick", `${"~".repeat(200_000)}\`\nafter\n`],
    ["the same inside a list item", `- item\n  ${"~".repeat(200_000)}\`\nafter\n`],
    ["a backtick run with a backtick later", `${"\`".repeat(100_000)}x\`\nafter\n`],
  ])("scans %s on the main thread in linear time", (_name, source) => {
    const stream = new MarkdownStream(PLAIN_THEME, () => undefined, { render: (chunk) => plainMarkdown(chunk) });
    const started = performance.now();
    stream.push(source);
    stream.flushLines();
    stream.end(source);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("still recognizes fences as CommonMark does", () => {
    const fenced = (source: string) => {
      const writes: string[] = [];
      const stream = new MarkdownStream(PLAIN_THEME, (text) => writes.push(text));
      stream.push(source);
      return writes.join("");
    };
    // A tilde fence may have backticks in its info string; a backtick fence may not.
    expect(fenced("~~~ js `x`\ncode\n\nmore\n~~~\n")).toContain("│ code\n│ \n│ more");
    expect(fenced("```js` x\ntext\n\n")).toBe("```js` x\ntext\n");
    // Four spaces of indentation open no fence outside a list.
    expect(fenced("    ```\n    code\n\n")).not.toContain("┌");
  });
});
