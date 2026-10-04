import { Lexer, type Token, type Tokens } from "marked";

import { sanitizeForTerminal } from "../harness/terminal-text.js";
import { highlightLines } from "./highlight.js";
import { PLAIN_THEME, type Theme } from "./style.js";

/**
 * Terminal Markdown. `marked` is used only as a lexer; Quoder renders the tokens itself with theme
 * roles. Source text is sanitized before lexing, so no escape sequence from the model survives.
 * Lines are not wrapped: the terminal wraps them.
 */

const GUTTER = "│ ";
const RULE_WIDTH = 40;

const inline = (tokens: readonly Token[] | undefined, fallback: string, theme: Theme): string =>
  tokens === undefined ? fallback : tokens.map((token) => inlineToken(token, theme)).join("");

function inlineToken(token: Token, theme: Theme): string {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      return inline(text.tokens, text.text, theme);
    }
    case "escape":
    case "html":
      return (token as Tokens.Escape).text;
    case "strong":
      return theme.paint("strong", inline((token as Tokens.Strong).tokens, (token as Tokens.Strong).text, theme));
    case "em":
      return theme.paint("emphasis", inline((token as Tokens.Em).tokens, (token as Tokens.Em).text, theme));
    case "del":
      return theme.paint("strike", inline((token as Tokens.Del).tokens, (token as Tokens.Del).text, theme));
    case "codespan":
      return theme.paint("code", (token as Tokens.Codespan).text);
    case "br":
      return "\n";
    case "link": {
      const link = token as Tokens.Link;
      const label = inline(link.tokens, link.text, theme);
      if (link.text === link.href || link.autolink === true) return theme.paint("link", link.href);
      return `${theme.paint("link", label)} ${theme.paint("dim", `(${link.href})`)}`;
    }
    case "image":
      return theme.paint("dim", `[image: ${(token as Tokens.Image).text}]`);
    case "checkbox":
      return "";
    default:
      return token.raw;
  }
}

const indent = (text: string, first: string, rest: string): string =>
  text
    .split("\n")
    .map((line, index) => (index === 0 ? first : rest) + line)
    .join("\n");

function renderCode(code: Tokens.Code, theme: Theme): string {
  const language = code.lang?.trim().split(/\s+/u)[0] || undefined;
  const lines = highlightLines(code.text, language, theme).map((line) => theme.paint("dim", GUTTER) + line);
  return [...(language === undefined ? [] : [theme.paint("dim", `┌ ${language}`)]), ...lines].join("\n");
}

function renderList(list: Tokens.List, theme: Theme): string {
  const start = typeof list.start === "number" ? list.start : 1;
  const markers = list.items.map((item, index) => {
    const bullet = list.ordered ? `${start + index}.` : "•";
    return item.task ? `${bullet} ${item.checked === true ? "☑" : "☐"}` : bullet;
  });
  const width = Math.max(...markers.map((marker) => marker.length));
  return list.items
    .map((item, index) => {
      const body = renderBlocks(item.tokens.filter((token) => token.type !== "checkbox"), theme).join(item.loose ? "\n\n" : "\n");
      const marker = (markers[index] ?? "").padEnd(width);
      return indent(body, `${theme.paint("accent", marker)} `, " ".repeat(width + 1));
    })
    .join(list.loose ? "\n\n" : "\n");
}

function renderTable(table: Tokens.Table, theme: Theme): string {
  const rows = [table.header, ...table.rows];
  const plain = rows.map((row) => row.map((cell) => inline(cell.tokens, cell.text, PLAIN_THEME)));
  const styled = rows.map((row, rowIndex) =>
    row.map((cell) => {
      const text = inline(cell.tokens, cell.text, theme);
      return rowIndex === 0 ? theme.paint("strong", text) : text;
    }),
  );
  const columns = table.header.length;
  const widths = Array.from({ length: columns }, (_unused, column) => Math.max(...plain.map((row) => row[column]?.length ?? 0)));
  const separator = theme.paint("dim", " │ ");
  const line = (rowIndex: number): string =>
    widths
      .map((width, column) => {
        const pad = " ".repeat(Math.max(0, width - (plain[rowIndex]?.[column]?.length ?? 0)));
        const text = styled[rowIndex]?.[column] ?? "";
        return table.align[column] === "right" ? pad + text : text + pad;
      })
      .join(separator)
      .trimEnd();
  const rule = theme.paint("dim", widths.map((width) => "─".repeat(width)).join("─┼─"));
  return [line(0), rule, ...rows.slice(1).map((_row, index) => line(index + 1))].join("\n");
}

function renderBlock(token: Token, theme: Theme): string | undefined {
  switch (token.type) {
    case "space":
    case "def":
      return undefined;
    case "heading": {
      const heading = token as Tokens.Heading;
      return theme.paint("heading", inline(heading.tokens, heading.text, theme));
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return inline(paragraph.tokens, paragraph.text, theme);
    }
    case "text": {
      const text = token as Tokens.Text;
      return inline(text.tokens, text.text, theme);
    }
    case "code":
      return renderCode(token as Tokens.Code, theme);
    case "blockquote":
      return indent(renderBlocks((token as Tokens.Blockquote).tokens, theme).join("\n\n"), theme.paint("dim", GUTTER), theme.paint("dim", GUTTER));
    case "list":
      return renderList(token as Tokens.List, theme);
    case "table":
      return renderTable(token as Tokens.Table, theme);
    case "hr":
      return theme.paint("dim", "─".repeat(RULE_WIDTH));
    case "html":
      return (token as Tokens.HTML).text.replace(/\n+$/u, "");
    default:
      return token.raw.replace(/\n+$/u, "");
  }
}

function renderBlocks(tokens: readonly Token[], theme: Theme): string[] {
  return tokens.flatMap((token) => {
    const rendered = renderBlock(token, theme);
    return rendered === undefined ? [] : [rendered];
  });
}

/** Renders complete Markdown source: blocks separated by a blank line, ending with a newline. */
export function renderMarkdown(source: string, theme: Theme): string {
  const blocks = renderBlocks(Lexer.lex(sanitizeForTerminal(source), { gfm: true }), theme);
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

interface Fence {
  readonly char: string;
  readonly length: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^`]*)$/u;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const STANDALONE_BLOCK = /^ {0,3}(?:#{1,6}(?:[ \t].*)?|(?:[-*_][ \t]*){3,})$/u;

interface Scan {
  /** Length of the prefix made of complete blocks. */
  readonly complete: number;
  /** Length of the prefix made of complete lines outside a code fence (for an idle flush). */
  readonly completeLines: number;
}

/**
 * Finds block boundaries in streamed source: after a blank line outside a fence, after a closing
 * fence, and after a standalone heading or rule line. A code fence stays pending until it closes.
 */
function scan(source: string): Scan {
  let fence: Fence | undefined;
  let complete = 0;
  let completeLines = 0;
  let offset = 0;
  for (;;) {
    const newline = source.indexOf("\n", offset);
    if (newline === -1) break;
    const line = source.slice(offset, newline);
    const end = newline + 1;
    offset = end;
    if (fence !== undefined) {
      const close = FENCE_CLOSE.exec(line);
      if (close?.[1] !== undefined && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = undefined;
        complete = end;
        completeLines = end;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open?.[1] !== undefined && !(open[1][0] === "`" && (open[2] ?? "").includes("`"))) {
      fence = { char: open[1][0] ?? "`", length: open[1].length };
      continue;
    }
    completeLines = end;
    if (line.trim() === "" || STANDALONE_BLOCK.test(line)) complete = end;
  }
  return { complete, completeLines };
}

/**
 * Streams Markdown: text arrives in small deltas, and each block is printed once it is complete. An
 * idle caller may flush the complete lines of an unfinished paragraph so slow output never looks
 * stalled; code fences always wait for their closing fence (or the end).
 */
export class MarkdownStream {
  readonly #theme: Theme;
  readonly #write: (text: string) => void;
  #seen = "";
  #pending = "";
  #wroteAny = false;
  /** True after an idle flush: the next output continues the same block, without a blank line. */
  #continuing = false;

  constructor(theme: Theme, write: (text: string) => void) {
    this.#theme = theme;
    this.#write = write;
  }

  /** All raw source received so far. */
  get seen(): string {
    return this.#seen;
  }

  push(delta: string): void {
    this.#seen += delta;
    this.#pending += delta;
    const { complete } = scan(this.#pending);
    if (complete > 0) this.#emit(complete);
  }

  /** Prints the complete lines of an unfinished block (outside a code fence). */
  flushLines(): void {
    const { completeLines } = scan(this.#pending);
    if (completeLines > 0) {
      this.#emit(completeLines);
      this.#continuing = true;
    }
  }

  /**
   * Finalizes the stream. With the block's full text (from `text.ended`), a missing tail is rendered
   * first. Returns false when the full text does not extend what was streamed; the caller then
   * decides how to show the authoritative text.
   */
  end(fullText?: string): boolean {
    let consistent = true;
    if (fullText !== undefined && fullText !== this.#seen) {
      if (fullText.startsWith(this.#seen)) this.push(fullText.slice(this.#seen.length));
      else consistent = false;
    }
    if (this.#pending !== "") this.#emit(this.#pending.length);
    return consistent;
  }

  #emit(length: number): void {
    const chunk = this.#pending.slice(0, length);
    this.#pending = this.#pending.slice(length);
    const startsWithGap = /^[ \t]*\n/u.test(chunk);
    const rendered = renderMarkdown(chunk, this.#theme);
    if (rendered === "") {
      if (startsWithGap) this.#continuing = false;
      return;
    }
    const gap = this.#wroteAny && (!this.#continuing || startsWithGap) ? "\n" : "";
    this.#write(gap + rendered);
    this.#wroteAny = true;
    this.#continuing = false;
  }
}
