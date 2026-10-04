import { isAbsolute, relative, sep } from "node:path";

import type { Theme } from "../ui/style.js";
import { sanitizeLine } from "./terminal-text.js";

/**
 * One-line summaries of OpenCode tool calls. Every field shown comes from the model or a tool, so
 * each is sanitized and truncated here, before any styling. Shapes verified live against OpenCode
 * 1.18.33 (spec 2026-10-03-milestone-2-streaming-ui, Group 1); missing fields fall back to a
 * generic line.
 */

export type SubjectRole = "path" | "command" | "accent";

export interface ToolCall {
  readonly icon: string;
  /** Past-tense label for the permanent line, e.g. "Read". */
  readonly verb: string;
  /** Progressive label for the status line, e.g. "Reading". */
  readonly doing: string;
  readonly subject: string;
  readonly subjectRole: SubjectRole;
}

export type ActivityStatus = "ok" | "warning" | "error" | "cancelled";

export interface ActivityLine extends ToolCall {
  readonly status: ActivityStatus;
  readonly detail?: string;
}

export type ToolOutcome =
  | { readonly kind: "succeeded"; readonly structured: Readonly<Record<string, unknown>>; readonly output: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled" };

const SUBJECT_MAX = 80;
const DETAIL_MAX = 80;

const field = (input: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
};

/** A path relative to the project root when it lies inside it; otherwise unchanged. */
export const displayPath = (path: string, root: string): string => {
  if (!isAbsolute(path)) return path;
  const inside = relative(root, path);
  if (inside === "") return ".";
  return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? path : inside;
};

const call = (icon: string, verb: string, doing: string, subject: string, subjectRole: SubjectRole): ToolCall => ({
  icon,
  verb,
  doing,
  subject: sanitizeLine(subject, SUBJECT_MAX),
  subjectRole,
});

/** Summarizes a tool call from its name and (untrusted) input. */
export function summarizeCall(tool: string, input: Readonly<Record<string, unknown>>, root: string): ToolCall {
  const path = field(input, "path", "filePath");
  const shownPath = path === undefined ? "" : displayPath(path, root);
  switch (tool) {
    case "read":
      return call("●", "Read", "Reading", shownPath, "path");
    case "edit":
      return call("✎", "Edit", "Editing", shownPath, "path");
    case "write":
      return call("+", "Write", "Writing", shownPath, "path");
    case "list":
      return call("▤", "List", "Listing", path === undefined ? "." : shownPath, "path");
    case "bash":
      return call("$", "Run", "Running", field(input, "command") ?? "", "command");
    case "grep": {
      const pattern = field(input, "pattern");
      const scope = path === undefined || path === "." ? "" : ` in ${shownPath}`;
      return call("⌕", "Search", "Searching", pattern === undefined ? "" : `"${pattern}"${scope}`, "accent");
    }
    case "glob":
      return call("⌕", "Find", "Finding", field(input, "pattern") ?? "", "accent");
    case "webfetch":
      return call("↓", "Fetch", "Fetching", field(input, "url") ?? "", "path");
    case "task":
      return call("◆", "Task", "Delegating", field(input, "description", "prompt") ?? "", "accent");
    case "todowrite": {
      const todos = input.todos;
      return call("☐", "Todos", "Updating todos", Array.isArray(todos) ? `${todos.length} items` : "", "accent");
    }
    default:
      return call("·", sanitizeLine(tool, 20) || "tool", `Using ${sanitizeLine(tool, 20) || "a tool"}`, "", "accent");
  }
}

const lineCount = (text: string): number => (text === "" ? 0 : text.replace(/\n$/u, "").split("\n").length);

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const lastOutputLine = (output: string): string | undefined => {
  const lines = output.split("\n").map((line) => sanitizeLine(line, DETAIL_MAX)).filter((line) => line !== "");
  return lines.at(-1);
};

const successDetail = (tool: string, input: Readonly<Record<string, unknown>>, structured: Readonly<Record<string, unknown>>): string | undefined => {
  switch (tool) {
    case "read":
      return typeof structured.content === "string" ? plural(lineCount(structured.content), "line") : undefined;
    case "edit": {
      const files = Array.isArray(structured.files) ? structured.files : [];
      let additions = 0;
      let deletions = 0;
      for (const file of files) {
        if (typeof file !== "object" || file === null) continue;
        const added = Reflect.get(file, "additions");
        const deleted = Reflect.get(file, "deletions");
        if (typeof added === "number" && Number.isFinite(added)) additions += added;
        if (typeof deleted === "number" && Number.isFinite(deleted)) deletions += deleted;
      }
      return files.length === 0 ? undefined : `+${additions} −${deletions}`;
    }
    case "write": {
      const lines = typeof input.content === "string" ? plural(lineCount(input.content), "line") : undefined;
      const kind = structured.existed === true ? "overwritten" : structured.existed === false ? "new file" : undefined;
      return [kind, lines].filter((part) => part !== undefined).join(" · ") || undefined;
    }
    case "grep":
      return Array.isArray(structured.value) ? plural(structured.value.length, "match", "matches") : undefined;
    case "glob":
      return Array.isArray(structured.value) ? plural(structured.value.length, "file") : undefined;
    default:
      return undefined;
  }
};

/** Summarizes a finished tool call: its outcome, status, and a short detail. */
export function summarizeResult(tool: string, input: Readonly<Record<string, unknown>>, root: string, outcome: ToolOutcome): ActivityLine {
  const summary = summarizeCall(tool, input, root);
  if (outcome.kind === "cancelled") return { ...summary, status: "cancelled", detail: "cancelled" };
  if (outcome.kind === "failed") return { ...summary, status: "error", detail: sanitizeLine(outcome.message, DETAIL_MAX) || "failed" };
  if (tool === "bash") {
    const exit = outcome.structured.exit;
    const last = lastOutputLine(outcome.output);
    if (typeof exit !== "number") return { ...summary, status: "ok", ...(last === undefined ? {} : { detail: last }) };
    const detail = last === undefined ? `exit ${exit}` : `exit ${exit} · ${last}`;
    return { ...summary, status: exit === 0 ? "ok" : "warning", detail };
  }
  const detail = successDetail(tool, input, outcome.structured);
  return { ...summary, status: "ok", ...(detail === undefined ? {} : { detail }) };
}

const STATUS_ROLE = { ok: "success", warning: "warning", error: "error", cancelled: "dim" } as const;
const STATUS_MARK = { ok: "✓", warning: "!", error: "✗", cancelled: "–" } as const;

/** Renders a finished activity line, e.g. `✓ $ Run    cargo test  exit 0 · 47 passed`. */
export function renderActivity(line: ActivityLine, theme: Theme): string {
  const role = STATUS_ROLE[line.status];
  // Verbs are padded to align subjects; with no subject there is nothing to align.
  const verb = line.subject === "" ? line.verb : line.verb.padEnd(6);
  const head = `${theme.paint(role, STATUS_MARK[line.status])} ${theme.paint("tool", `${line.icon} ${verb}`)}`;
  const subject = line.subject === "" ? "" : ` ${theme.paint(line.subjectRole, line.subject)}`;
  const detailRole = line.status === "ok" ? "dim" : role;
  const detail = line.detail === undefined ? "" : `  ${theme.paint(detailRole, line.detail)}`;
  return `${head}${subject}${detail}`;
}

/** The status-line label for running tools: one tool by name, several by count. */
export function runningLabel(calls: readonly ToolCall[]): string | undefined {
  if (calls.length === 0) return undefined;
  if (calls.length > 1) return `Running ${calls.length} tools`;
  const [only] = calls;
  return only === undefined ? undefined : only.subject === "" ? only.doing : `${only.doing} ${only.subject}`;
}
