import hljs from "highlight.js/lib/common";

import { sanitizeForTerminal } from "../harness/terminal-text.js";
import type { StyleRole, Theme } from "./style.js";

/**
 * Syntax highlighting for fenced code blocks. Uses highlight.js's common bundle (a fixed set of
 * about 36 languages) and only the fence's own language: no automatic detection. highlight.js
 * returns HTML; its spans are mapped to theme roles and its entities decoded, and every text piece
 * is sanitized again before styling.
 *
 * Some grammars take super-linear time on crafted input (about 13 s for 80 KB of repeated C#
 * tokens), and highlighting runs on the event loop, where it would block Ctrl-C. Blocks over a
 * fixed budget are therefore shown plain.
 */

/** Largest block highlighted (worst case measured near 0.1–0.4 s at this size). */
export const HIGHLIGHT_MAX_CHARACTERS = 8_000;
/** Longest line highlighted; longer lines (minified code, crafted input) leave the block plain. */
export const HIGHLIGHT_MAX_LINE = 1_000;

const SCOPE_ROLES: Readonly<Record<string, StyleRole>> = {
  keyword: "codeKeyword",
  "selector-tag": "codeKeyword",
  name: "codeKeyword",
  tag: "codeKeyword",
  section: "codeKeyword",
  string: "codeString",
  regexp: "codeString",
  char: "codeString",
  number: "codeNumber",
  literal: "codeNumber",
  symbol: "codeNumber",
  comment: "codeComment",
  doc: "codeComment",
  quote: "codeComment",
  title: "codeTitle",
  attr: "codeTitle",
  attribute: "codeTitle",
  "selector-class": "codeTitle",
  "selector-id": "codeTitle",
  type: "codeType",
  built_in: "codeType",
  class: "codeType",
  meta: "codeMeta",
  "meta-keyword": "codeMeta",
  addition: "codeAddition",
  deletion: "codeDeletion",
};

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const decode = (html: string): string => html.replace(/&(?:amp|lt|gt|quot|#x27|#39);/gu, (entity) => ENTITIES[entity] ?? entity);

/** The role for a span's class list, e.g. `hljs-title function_` → codeTitle. */
const roleFor = (classes: string): StyleRole | undefined => {
  for (const name of classes.split(/\s+/u)) {
    if (!name.startsWith("hljs-")) continue;
    const scope = name.slice("hljs-".length);
    const role = SCOPE_ROLES[scope] ?? SCOPE_ROLES[scope.split(".")[0] ?? ""];
    if (role !== undefined) return role;
  }
  return undefined;
};

/** True when `language` (a fence info string's first word) has a registered grammar. */
export const isHighlightable = (language: string | undefined): language is string =>
  language !== undefined && language !== "" && hljs.getLanguage(language) !== undefined;

/**
 * Highlights code, returning one styled string per source line. Each line is styled on its own, so
 * a caller can prefix lines (a gutter) without breaking colours that span lines.
 */
export function highlightLines(code: string, language: string | undefined, theme: Theme): string[] {
  const clean = sanitizeForTerminal(code);
  const lines = clean.split("\n");
  const overBudget = clean.length > HIGHLIGHT_MAX_CHARACTERS || lines.some((line) => line.length > HIGHLIGHT_MAX_LINE);
  if (!theme.color || !isHighlightable(language) || overBudget) return lines;
  let html: string;
  try {
    html = hljs.highlight(clean, { language, ignoreIllegals: true }).value;
  } catch {
    return clean.split("\n");
  }
  const styled: string[] = [""];
  const roles: (StyleRole | undefined)[] = [];
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/gu)) {
    if (match[1] !== undefined) {
      // Nested spans inherit the nearest styled ancestor when they have no role of their own.
      roles.push(roleFor(match[1]) ?? roles.at(-1));
      continue;
    }
    if (match[2] === undefined) {
      roles.pop();
      continue;
    }
    const role = roles.at(-1);
    const pieces = sanitizeForTerminal(decode(match[2])).split("\n");
    pieces.forEach((piece, index) => {
      if (index > 0) styled.push("");
      styled[styled.length - 1] += role === undefined ? piece : theme.paint(role, piece);
    });
  }
  return styled;
}
