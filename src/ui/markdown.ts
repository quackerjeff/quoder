import { Lexer, type Token, type Tokens } from "marked";

import { sanitizeForTerminal } from "../harness/terminal-text.js";
import { highlightLines } from "./highlight.js";
import { PLAIN_THEME, type Theme } from "./style.js";

/**
 * Terminal Markdown. `marked` is used only as a lexer; Quoder renders the tokens itself with theme
 * roles. Model text is sanitized twice: before lexing, and again in every string of the token tree
 * after lexing, because the lexer decodes character references (`&#27;` becomes ESC). Only Quoder's
 * own styling adds escape sequences. Lines are not wrapped: the terminal wraps them.
 */

const GUTTER = "│ ";
const RULE_WIDTH = 40;

/**
 * Nesting limits. Each inline level wraps its content in another `styleText` call, which rescans the
 * whole inner string, so deep emphasis (`*` × 3000 around a word) cost seconds of CPU on the event
 * loop and blocked Ctrl-C; deep block nesting overflowed the stack. Content nested deeper than these
 * limits is shown as its (sanitized) source text.
 */
const MAX_INLINE_DEPTH = 8;
const MAX_BLOCK_DEPTH = 16;

/**
 * Removes trailing newlines in linear time. (`/\n+$/` is quadratic in V8 on a long run of newlines
 * that is not at the end of the string: 200 KB took 14 s on the main thread; security review cycle 5.)
 */
export const trimTrailingNewlines = (text: string): string => {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  return end === text.length ? text : text.slice(0, end);
};

const plainSource = (token: Token): string => trimTrailingNewlines(token.raw);

/**
 * Rendering budget. Model text is untrusted and rendering is synchronous on the event loop, where
 * a slow render blocks Ctrl-C and a huge one floods the terminal or exhausts memory (security review
 * cycle 3). A chunk over any of these limits is shown as sanitized plain text instead:
 * - `marked`'s emphasis tokenizer is quadratic in `*`/`_`/`~` delimiters (2,000 cost 170 ms, 4,000
 *   cost 660 ms), so at most 1,000 per chunk outside code fences (about 45 ms at worst);
 * - a table is lexed and padded cell by cell, so at most 64 columns and 10,000 cells;
 * - a chunk is at most 128 KB;
 * - rendered output may be at most 10 times its source (plus 4 KB), a backstop against amplification.
 */
export const RENDER_BUDGET = {
  maxSource: 128 * 1024,
  maxEmphasisDelimiters: 1_000,
  maxTableColumns: 64,
  maxTableCells: 10_000,
  maxExpansion: 10,
  /** Longest link URL shown, and widest table column. */
  maxHref: 200,
  maxCellWidth: 120,
} as const;

/** Whether a chunk is too costly to lex and render; counts outside code fences only. */
function exceedsRenderBudget(source: string): boolean {
  if (source.length > RENDER_BUDGET.maxSource) return true;
  let delimiters = 0;
  let tableLines = 0;
  let widestTable = 0;
  let fence: string | undefined;
  for (const line of source.split("\n")) {
    const marker = /^[ \t]*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    for (const character of line) if (character === "*" || character === "_" || character === "~") delimiters++;
    const pipes = line.split("|").length - 1;
    if (pipes > 0) {
      tableLines++;
      widestTable = Math.max(widestTable, pipes);
    }
  }
  return (
    delimiters > RENDER_BUDGET.maxEmphasisDelimiters ||
    widestTable > RENDER_BUDGET.maxTableColumns ||
    tableLines * widestTable > RENDER_BUDGET.maxTableCells
  );
}

/** Cuts text to `max` code points with "…"; the work is O(max), however long the text is. */
const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let kept = "";
  let count = 0;
  for (const character of text) {
    if (count === max - 1) return `${kept}…`;
    kept += character;
    count++;
  }
  return text;
};

const inline = (tokens: readonly Token[] | undefined, fallback: string, theme: Theme, depth = 0): string =>
  tokens === undefined ? fallback : tokens.map((token) => inlineToken(token, theme, depth)).join("");

function inlineToken(token: Token, theme: Theme, depth: number): string {
  if (depth >= MAX_INLINE_DEPTH) return plainSource(token);
  const next = depth + 1;
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      return inline(text.tokens, text.text, theme, next);
    }
    case "escape":
    case "html":
      return (token as Tokens.Escape).text;
    case "strong":
      return theme.paint("strong", inline((token as Tokens.Strong).tokens, (token as Tokens.Strong).text, theme, next));
    case "em":
      return theme.paint("emphasis", inline((token as Tokens.Em).tokens, (token as Tokens.Em).text, theme, next));
    case "del":
      return theme.paint("strike", inline((token as Tokens.Del).tokens, (token as Tokens.Del).text, theme, next));
    case "codespan":
      return theme.paint("code", (token as Tokens.Codespan).text);
    case "br":
      return "\n";
    case "link": {
      const link = token as Tokens.Link;
      const label = inline(link.tokens, link.text, theme, next);
      const href = truncate(link.href, RENDER_BUDGET.maxHref);
      if (link.text === link.href || link.autolink === true) return theme.paint("link", href);
      return `${theme.paint("link", label)} ${theme.paint("dim", `(${href})`)}`;
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
    .map((line, index) => {
      const prefix = index === 0 ? first : rest;
      // A blank line gets no trailing whitespace; a visible prefix such as a quote gutter is kept.
      return line === "" && prefix.trim() === "" ? "" : prefix + line;
    })
    .join("\n");

function renderCode(code: Tokens.Code, theme: Theme): string {
  const language = code.lang?.trim().split(/\s+/u)[0] || undefined;
  const lines = highlightLines(code.text, language, theme).map((line) => theme.paint("dim", GUTTER) + line);
  return [...(language === undefined ? [] : [theme.paint("dim", `┌ ${language}`)]), ...lines].join("\n");
}

function renderList(list: Tokens.List, theme: Theme, depth: number): string {
  const start = typeof list.start === "number" ? list.start : 1;
  const markers = list.items.map((item, index) => {
    const bullet = list.ordered ? `${start + index}.` : "•";
    return item.task ? `${bullet} ${item.checked === true ? "☑" : "☐"}` : bullet;
  });
  const width = Math.max(...markers.map((marker) => marker.length));
  return list.items
    .map((item, index) => {
      const body = renderBlocks(item.tokens.filter((token) => token.type !== "checkbox"), theme, depth + 1).join(item.loose ? "\n\n" : "\n");
      const marker = (markers[index] ?? "").padEnd(width);
      return indent(body, `${theme.paint("accent", marker)} `, " ".repeat(width + 1));
    })
    .join(list.loose ? "\n\n" : "\n");
}

function renderTable(table: Tokens.Table, theme: Theme): string {
  const rows = [table.header, ...table.rows];
  // A cell wider than the column limit is shown truncated and unstyled.
  const plain = rows.map((row) => row.map((cell) => inline(cell.tokens, cell.text, PLAIN_THEME)));
  const styled = rows.map((row, rowIndex) =>
    row.map((cell, column) => {
      const full = plain[rowIndex]?.[column] ?? "";
      const text = [...full].length > RENDER_BUDGET.maxCellWidth ? truncate(full, RENDER_BUDGET.maxCellWidth) : inline(cell.tokens, cell.text, theme);
      return rowIndex === 0 ? theme.paint("strong", text) : text;
    }),
  );
  for (const row of plain) row.forEach((cell, column) => (row[column] = truncate(cell, RENDER_BUDGET.maxCellWidth)));
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

function renderBlock(token: Token, theme: Theme, depth: number): string | undefined {
  if (depth >= MAX_BLOCK_DEPTH) return plainSource(token);
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
      return indent(renderBlocks((token as Tokens.Blockquote).tokens, theme, depth + 1).join("\n\n"), theme.paint("dim", GUTTER), theme.paint("dim", GUTTER));
    case "list":
      return renderList(token as Tokens.List, theme, depth);
    case "table":
      return renderTable(token as Tokens.Table, theme);
    case "hr":
      return theme.paint("dim", "─".repeat(RULE_WIDTH));
    case "html":
      return trimTrailingNewlines((token as Tokens.HTML).text);
    default:
      return trimTrailingNewlines(token.raw);
  }
}

function renderBlocks(tokens: readonly Token[], theme: Theme, depth = 0): string[] {
  return tokens.flatMap((token) => {
    const rendered = renderBlock(token, theme, depth);
    return rendered === undefined ? [] : [rendered];
  });
}

/**
 * Sanitizes every string in a token tree, in place. The lexer decodes numeric character references
 * in text (`&#27;`, `&#x9b;`, `&#x202E;`), so text that was clean before lexing may not be after it;
 * cleaning the whole tree is one choke point for every token type, present or future.
 */
function sanitizeTokens(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const field = record[key];
    if (typeof field === "string") record[key] = sanitizeForTerminal(field);
    else sanitizeTokens(field, seen);
  }
}

/** Renders complete Markdown source: blocks separated by a blank line, ending with a newline. */
/** Markdown source shown as sanitized plain text: the fallback whenever formatting is not safe. */
export function plainMarkdown(source: string): string {
  const text = trimTrailingNewlines(sanitizeForTerminal(source));
  return text.trim() === "" ? "" : `${text}\n`;
}

/** Renders one chunk of Markdown; the isolated renderer (`isolated-render.ts`) has this shape. */
export type MarkdownRenderer = (source: string, theme: Theme) => string;

export function renderMarkdown(source: string, theme: Theme): string {
  const clean = sanitizeForTerminal(source);
  const plain = (): string => plainMarkdown(clean);
  // Over budget, or a rendering failure (for example nesting deep enough to overflow the lexer's
  // stack): the sanitized text is shown plain, so model text is never dropped and never ends the
  // harness.
  if (exceedsRenderBudget(clean)) return plain();
  try {
    const tokens = Lexer.lex(clean, { gfm: true });
    sanitizeTokens(tokens);
    const blocks = renderBlocks(tokens, theme);
    const rendered = blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
    return rendered.length > clean.length * RENDER_BUDGET.maxExpansion + 4096 ? plain() : rendered;
  } catch {
    return plain();
  }
}

interface Fence {
  readonly char: string;
  readonly length: number;
}

/**
 * A fence-opening line: up to three spaces of indentation (any, inside a list, where a nested item's
 * fence is indented further), then three or more backticks or tildes. A backtick fence's info string
 * may not contain a backtick. Checked without an end-anchored regex: `~{3,}` followed by `[^`]*$`
 * backtracks quadratically on a long tilde run ending in a backtick (security review cycle 6).
 */
const FENCE_RUN = /^([ \t]*)(`{3,}|~{3,})/u;
function fenceOpening(line: string, inList: boolean): Fence | undefined {
  const match = FENCE_RUN.exec(line);
  const run = match?.[2];
  if (match === null || run === undefined) return undefined;
  if (!inList && !/^ {0,3}$/u.test(match[1] ?? "")) return undefined;
  const char = run[0] ?? "`";
  if (char === "`" && line.includes("`", match[0].length)) return undefined;
  return { char, length: run.length };
}
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u;
/** A line that could turn the lines above it into something else: a table row or a setext underline. */
const RETROACTIVE_LINE = /^ {0,3}(?:\||=+[ \t]*$|-+[ \t]*$)/u;
const STANDALONE_BLOCK = /^ {0,3}(?:#{1,6}(?:[ \t].*)?|(?:[-*_][ \t]*){3,})$/u;

interface Scan {
  /** Length of the prefix made of complete blocks. */
  readonly complete: number;
  /** The end of each complete block, in order (the last equals `complete`). */
  readonly boundaries: readonly number[];
  /** Length of the prefix made of complete lines outside a code fence (for an idle flush). */
  readonly completeLines: number;
  /** True when the unfinished block contains a table row, which must not be split by a flush. */
  readonly table: boolean;
  /** Start of the last complete line outside a fence, and of the line before it. */
  readonly lastLineStart: number;
  readonly previousLineStart: number;
  /** In a list, the start of the item still being written: a flush must not cut into it. */
  readonly openItemStart: number | undefined;
}

const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/u;
const indentOf = (line: string): number => (/^[ \t]*/u.exec(line)?.[0] ?? "").replace(/\t/gu, "    ").length;

/**
 * Finds block boundaries in streamed source: after a blank line outside a fence, after a closing
 * fence, and after a standalone heading or rule line. A code fence stays pending until it closes.
 * Inside a list a blank line may be followed by more of the same item (an indented paragraph or
 * code fence), so it is a boundary only once the next line shows the item has ended: a new item at
 * the list's own indentation, or a line that is not indented.
 */
function scan(source: string): Scan {
  let fence: Fence | undefined;
  let complete = 0;
  let completeLines = 0;
  let lastLineStart = 0;
  let previousLineStart = 0;
  let table = false;
  let inList = false;
  let listIndent = 0;
  let openItemStart: number | undefined;
  let blockStarted = false;
  /** The end of a blank line inside a list: a boundary unless the item continues after it. */
  let listBlank: number | undefined;
  let offset = 0;
  const boundaries: number[] = [];
  const endBlock = (at: number): void => {
    if (at > complete) boundaries.push(at);
    complete = at;
    table = false;
    inList = false;
    openItemStart = undefined;
    blockStarted = false;
  };
  for (;;) {
    const newline = source.indexOf("\n", offset);
    if (newline === -1) break;
    const lineStart = offset;
    const line = source.slice(offset, newline);
    const end = newline + 1;
    offset = end;
    if (fence !== undefined) {
      const close = FENCE_CLOSE.exec(line);
      if (close?.[1] !== undefined && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = undefined;
        completeLines = end;
        previousLineStart = lastLineStart;
        lastLineStart = lineStart;
        if (!inList) endBlock(end);
      }
      continue;
    }
    const blank = line.trim() === "";
    if (listBlank !== undefined && !blank) {
      // Only content indented past the list's markers (a paragraph, fence or nested item) continues
      // the item; a new item at the list's level, or anything less indented, ends the block.
      if (indentOf(line) <= listIndent) endBlock(listBlank);
      listBlank = undefined;
    }
    const standalone = STANDALONE_BLOCK.test(line);
    if (!blockStarted && !blank) blockStarted = true;
    // A list may start anywhere in a block, for example right after an intro line.
    if (!inList && !standalone && LIST_ITEM.test(line)) {
      inList = true;
      listIndent = indentOf(line);
    }
    // The outermost open item: a flush must not separate it from its nested content.
    if (inList && LIST_ITEM.test(line) && indentOf(line) <= listIndent) openItemStart = lineStart;
    const opening = fenceOpening(line, inList);
    if (opening !== undefined) {
      fence = opening;
      continue;
    }
    completeLines = end;
    previousLineStart = lastLineStart;
    lastLineStart = lineStart;
    table ||= /^ {0,3}\|/u.test(line);
    if (blank) {
      if (inList) listBlank ??= end;
      else endBlock(end);
    } else if (standalone && !inList) {
      endBlock(end);
    }
  }
  // The unfinished next line already shows whether the item continues once it has a visible character.
  const tail = source.slice(offset);
  if (listBlank !== undefined && fence === undefined && /\S/u.test(tail) && indentOf(tail) <= listIndent) endBlock(listBlank);
  return { complete, boundaries, completeLines, table, lastLineStart, previousLineStart, openItemStart };
}

/**
 * Streams Markdown: text arrives in small deltas, and each block is printed once it is complete. An
 * idle caller may flush the complete lines of an unfinished paragraph so slow output never looks
 * stalled; code fences always wait for their closing fence (or the end).
 */
/**
 * Total rendering time one stream (one text block, or one reconciled answer) may spend. Each chunk
 * is already bounded by the isolated renderer's deadline; this bounds the sum, so many slow chunks
 * cannot add up to a long freeze.
 */
export const STREAM_RENDER_BUDGET_MS = 1_000;

export interface MarkdownStreamOptions {
  /** Renders each completed chunk; defaults to in-process `renderMarkdown`. */
  readonly render?: MarkdownRenderer;
  readonly budgetMs?: number;
  readonly now?: () => number;
}

export class MarkdownStream {
  readonly #theme: Theme;
  readonly #write: (text: string) => void;
  #seen = "";
  #pending = "";
  #wroteAny = false;
  /** True after an idle flush: the next output continues the same block, without a blank line. */
  #continuing = false;

  readonly #render: MarkdownRenderer;
  readonly #budgetMs: number;
  readonly #now: () => number;
  /** Time spent rendering this stream so far; past the budget the rest is shown plain. */
  #spentMs = 0;

  constructor(theme: Theme, write: (text: string) => void, options: MarkdownStreamOptions = {}) {
    this.#theme = theme;
    this.#write = write;
    this.#render = options.render ?? renderMarkdown;
    this.#budgetMs = options.budgetMs ?? STREAM_RENDER_BUDGET_MS;
    this.#now = options.now ?? (() => performance.now());
  }

  /** All raw source received so far. */
  get seen(): string {
    return this.#seen;
  }

  push(delta: string): void {
    this.#seen += delta;
    this.#pending += delta;
    // Each complete block is rendered on its own, so the rendering budget applies per block even
    // when one push completes many.
    let consumed = 0;
    for (const boundary of scan(this.#pending).boundaries) {
      this.#emit(boundary - consumed);
      consumed = boundary;
    }
  }

  /**
   * Prints the complete lines of an unfinished block (outside a code fence). Nothing is flushed that
   * a later line could still change: a table, a line that may gain a setext underline, or a list
   * item that is still being written.
   */
  flushLines(): void {
    const { completeLines, table, lastLineStart, previousLineStart, openItemStart } = scan(this.#pending);
    if (table) return;
    const tail = this.#pending.slice(completeLines);
    if (tail !== "" && RETROACTIVE_LINE.test(tail)) return;
    // Stalled right after a line break: the last line could still gain a setext underline, and if
    // it is an `===` underline itself, it must stay with the line it underlines.
    const lastLine = this.#pending.slice(lastLineStart, completeLines);
    let upTo = tail !== "" ? completeLines : /^ {0,3}=+[ \t]*\n?$/u.test(lastLine) ? previousLineStart : lastLineStart;
    // In a list, the open item may still gain indented content (for example a code fence).
    if (openItemStart !== undefined) upTo = Math.min(upTo, openItemStart);
    if (upTo > 0) {
      this.#emit(upTo);
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

  #renderChunk(chunk: string): string {
    if (this.#spentMs >= this.#budgetMs) return plainMarkdown(chunk);
    const started = this.#now();
    try {
      return this.#render(chunk, this.#theme);
    } catch {
      return plainMarkdown(chunk);
    } finally {
      this.#spentMs += this.#now() - started;
    }
  }

  #emit(length: number): void {
    const chunk = this.#pending.slice(0, length);
    this.#pending = this.#pending.slice(length);
    // A heading or rule after a flushed paragraph starts a new block, so it keeps its blank line.
    const startsWithGap = /^[ \t]*\n/u.test(chunk) || STANDALONE_BLOCK.test(chunk.split("\n", 1)[0] ?? "");
    const rendered = this.#renderChunk(chunk);
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
