import { PLAIN_THEME, type Theme } from "../ui/style.js";
import { GIT_DIFF_PAGE_LINES, MAX_GIT_DIFF_BYTES, type GitDiffDocument, type GitDiffResult } from "./git-diff.js";
import type { GitComparison, GitDiffStats, GitFailureKind, GitPathChange } from "./git-state.js";
import type { TurnStats } from "./live-view.js";
import type { PromptResult, RejectedPermission, TurnOutcome } from "./session-runner.js";
import { sanitizeForTerminal, sanitizeLine } from "./terminal-text.js";
import { formatOperationalFailure } from "./operational-log.js";
import type { MemoryUnavailableReason, ProjectMemory } from "./project-memory.js";
import type { ExecutionHistoryRecord, ExecutionHistorySummary, HistoryUnavailableReason } from "./execution-history.js";
import type { OpenCodeAgentOption, OpenCodeModelOption } from "../opencode-adapter.js";

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const describePermission = ({ action, resourceCount }: RejectedPermission): string => {
  const name = action === undefined ? "a permission" : sanitizeLine(action, 60);
  return `${name}, ${resourceCount === 1 ? "1 resource" : `${resourceCount} resources`}`;
};

/** Rejections the outcome itself does not already describe (for example alongside an answer). */
const notes = (result: PromptResult): string[] => {
  const lines: string[] = [];
  if (result.outcome.kind !== "permission-rejected") {
    for (const permission of result.rejectedPermissions) {
      lines.push(`Note: OpenCode asked for permission (${describePermission(permission)}); Quoder did not grant it.`);
    }
  }
  if (result.outcome.kind !== "question-rejected") {
    for (const { question } of result.rejectedQuestions) {
      lines.push(`Note: the model asked "${sanitizeLine(question, 120)}"; Quoder did not answer it.`);
    }
  }
  return lines;
};

/** Why a turn ended without an answer; the answer itself is shown by the live view. */
const describeOutcome = (outcome: TurnOutcome, theme: Theme): string | undefined => {
  switch (outcome.kind) {
    case "answered":
    case "cancelled":
      return undefined;
    case "permission-rejected":
      return theme.paint(
        "warning",
        [
          `OpenCode asked for permission (${describePermission(outcome)}).`,
          "The permission request was rejected; the requested operation did not complete.",
        ].join("\n"),
      );
    case "question-rejected": {
      const lines = outcome.questions.map(({ question, options }) => {
        const choices = options.length > 0 ? ` (${options.map((option) => sanitizeLine(option, 60)).join(" / ")})` : "";
        return `  ${theme.paint("strong", sanitizeLine(question))}${theme.paint("dim", choices)}`;
      });
      return [
        theme.paint("warning", "The model asked a question, which Quoder cannot answer interactively yet:"),
        ...(lines.length > 0 ? lines : ["  (no question text was provided)"]),
        "Answer it in your next prompt.",
      ].join("\n");
    }
    case "failed":
      return theme.paint("error", formatOperationalFailure(outcome.category ?? "OpenCode"));
  }
};

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const GIT_SUMMARY_PATH_LIMIT = 100;

const failureDescription = (reason: GitFailureKind): string => {
  switch (reason) {
    case "not-repository": return "project is not a Git repository";
    case "timed-out": return "Git inspection timed out";
    case "output-limit": return "Git inspection exceeded its output limit";
    case "command-failed": return "Git inspection failed";
  }
};

const pathDescription = (path: string): string => sanitizeLine(path, 140) || "(empty path)";

const changeCounts = (changes: readonly GitPathChange[]): string[] => {
  const kinds: readonly [GitPathChange["kind"], string][] = [
    ["added", "added"],
    ["modified", "modified"],
    ["deleted", "deleted"],
    ["renamed", "renamed"],
    ["unmerged", "unmerged"],
  ];
  return kinds.flatMap(([kind, label]) => {
    const total = changes.filter((change) => change.kind === kind).length;
    return total === 0 ? [] : [`${total} ${label}`];
  });
};

const statsLine = (label: string, stats: GitDiffStats): string => {
  const totals = stats.additions === undefined || stats.deletions === undefined
    ? "line totals unavailable"
    : `+${stats.additions} -${stats.deletions}`;
  const binary = stats.binaryFiles === 0 ? "" : `, ${count(stats.binaryFiles, "binary file")}`;
  return `${label}: ${count(stats.files, "tracked file")} (${totals}${binary})`;
};

/** Formats observed Git state after the prompt; names and failure details are untrusted display text. */
export function formatGitSummary(comparison: GitComparison, theme: Theme = PLAIN_THEME): string {
  if (comparison.kind === "unavailable") {
    if (comparison.before.kind === "unavailable" && comparison.after.kind === "unavailable" &&
      comparison.before.reason === "not-repository" && comparison.after.reason === "not-repository") {
      return `${theme.paint("dim", "Repository state unavailable: project is not a Git repository.")}\n`;
    }
    const endpoint = comparison.after.kind === "unavailable" ? "after the prompt" : "before the prompt";
    const failure = comparison.after.kind === "unavailable" ? comparison.after : comparison.before;
    const detail = failure.kind === "unavailable" ? failureDescription(failure.reason) : "snapshots could not be compared";
    return `${theme.paint("warning", `Git state unavailable ${endpoint}: ${detail}. No before/after delta is reported.`)}\n`;
  }

  const lines: string[] = [];
  const { observedChanges, preExistingPaths, resolvedPaths, before, after } = comparison;
  if (observedChanges.length === 0) {
    lines.push("Git changes observed: none");
  } else {
    const categories = changeCounts(observedChanges);
    lines.push(`Git changes observed: ${count(observedChanges.length, "path")}${categories.length === 0 ? "" : ` (${categories.join(", ")})`}`);
  }

  for (const change of observedChanges.slice(0, GIT_SUMMARY_PATH_LIMIT)) {
    const renamedFrom = change.previousPath === undefined ? "" : ` (from ${pathDescription(change.previousPath)})`;
    lines.push(`  ${change.kind.padEnd(8)} ${pathDescription(change.path)}${renamedFrom}`);
  }
  if (observedChanges.length > GIT_SUMMARY_PATH_LIMIT) {
    lines.push(`  … ${count(observedChanges.length - GIT_SUMMARY_PATH_LIMIT, "more path")}`);
  }

  if (preExistingPaths.length > 0) {
    lines.push(`Pre-existing changes: ${count(preExistingPaths.length, "file")}`);
    for (const entry of preExistingPaths.slice(0, GIT_SUMMARY_PATH_LIMIT)) {
      const status = entry.statusChanged ? " (status changed during prompt)" : "";
      lines.push(`  ${pathDescription(entry.path)}${status}`);
    }
    if (preExistingPaths.length > GIT_SUMMARY_PATH_LIMIT) {
      lines.push(`  … ${count(preExistingPaths.length - GIT_SUMMARY_PATH_LIMIT, "more path")}`);
    }
  }

  if (resolvedPaths.length > 0) {
    lines.push(`Pre-existing changes cleared: ${count(resolvedPaths.length, "file")}`);
    for (const path of resolvedPaths.slice(0, GIT_SUMMARY_PATH_LIMIT)) lines.push(`  ${pathDescription(path)}`);
    if (resolvedPaths.length > GIT_SUMMARY_PATH_LIMIT) {
      lines.push(`  … ${count(resolvedPaths.length - GIT_SUMMARY_PATH_LIMIT, "more path")}`);
    }
  }

  if (comparison.headChanged) {
    const oldHead = sanitizeLine(before.kind === "available" ? before.head ?? "(unborn)" : "(unavailable)", 80);
    const newHead = sanitizeLine(after.kind === "available" ? after.head ?? "(unborn)" : "(unavailable)", 80);
    lines.push(`HEAD changed: ${oldHead} → ${newHead}`);
  }
  if (comparison.branchChanged && before.kind === "available" && after.kind === "available") {
    const branchName = (branch: string | undefined, state: "attached" | "detached" | "unborn") =>
      sanitizeLine(branch ?? `(${state})`, 120);
    lines.push(`Branch changed: ${branchName(before.branch, before.branchState)} → ${branchName(after.branch, after.branchState)}`);
  }

  if (after.kind === "available" && after.trackedDiff.files > 0) {
    lines.push(statsLine("Final tracked diff", after.trackedDiff));
  }
  if (comparison.committedDiff !== undefined && comparison.committedDiff.files > 0) {
    lines.push(statsLine("Committed tree change", comparison.committedDiff));
  }
  if (observedChanges.length === 0 && preExistingPaths.length === 0 && resolvedPaths.length === 0 &&
    !comparison.headChanged && !comparison.branchChanged) {
    lines.push("Repository state: clean");
  }
  return `${lines.map((line) => theme.paint("dim", line)).join("\n")}\n`;
}

export interface FormattedGitDiffPage {
  readonly text: string;
  readonly page: number;
  readonly pages: number;
}

export function formatGitDiffFailure(result: Extract<GitDiffResult, { readonly kind: "unavailable" }>, theme: Theme = PLAIN_THEME): string {
  return `${theme.paint("warning", `Diff unavailable: ${failureDescription(result.reason)}.`)}\n`;
}

function gitDiffLines(document: GitDiffDocument): string[] {
  const lines = sanitizeForTerminal(document.text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function truncationNotice(document: GitDiffDocument): string {
  if (!document.truncated) return "";
  const omitted = document.omittedBytes === undefined ? "an unknown number of bytes" : `${document.omittedBytes} bytes`;
  return `[Diff truncated at ${MAX_GIT_DIFF_BYTES} bytes; ${omitted} omitted.]`;
}

export function formatGitDiffPage(document: GitDiffDocument, requestedPage: number): FormattedGitDiffPage {
  const lines = gitDiffLines(document);
  const displayLines = lines.length + (document.truncated ? 1 : 0);
  const pages = Math.max(1, Math.ceil(displayLines / GIT_DIFF_PAGE_LINES));
  const page = Math.max(0, Math.min(pages - 1, requestedPage));
  const content = lines.slice(page * GIT_DIFF_PAGE_LINES, (page + 1) * GIT_DIFF_PAGE_LINES);
  if (content.length === 0) content.push("No textual diff content is available.");
  if (page === pages - 1 && document.truncated) content.push(truncationNotice(document));
  return { text: `${content.join("\n")}\n`, page, pages };
}

export function formatGitDiff(document: GitDiffDocument): string {
  const safeText = sanitizeForTerminal(document.text);
  if (safeText === "") return "No textual diff content is available.\n";
  const text = safeText.endsWith("\n") ? safeText : `${safeText}\n`;
  return document.truncated ? `${text}${truncationNotice(document)}\n` : text;
}

/** The final status line, e.g. `✓ Done in 41.8s · 4 tools · 1.2k input tokens · 800 output tokens`. */
const statusLine = (result: PromptResult, theme: Theme, stats: TurnStats | undefined): string => {
  const elapsed = seconds(result.elapsedMs);
  switch (result.outcome.kind) {
    case "answered": {
      const extra = stats === undefined ? [] : [
        count(stats.tools, "tool"),
        ...(stats.inputTokens === undefined ? [] : [`${tokens(stats.inputTokens)} input tokens`]),
        ...(stats.outputTokens === undefined ? [] : [`${tokens(stats.outputTokens)} output tokens`]),
      ];
      return `${theme.paint("success", `✓ Done in ${elapsed}`)}${theme.paint("dim", extra.map((part) => ` · ${part}`).join(""))}`;
    }
    case "cancelled":
      return `${theme.paint("warning", `– Execution cancelled after ${elapsed}.`)} ${theme.paint("dim", "Harness session remains active.")}`;
    case "failed":
      return theme.paint("error", `✗ Failed after ${elapsed}`);
    case "permission-rejected":
    case "question-rejected":
      return theme.paint("warning", `! Stopped after ${elapsed}`);
  }
};

/** Everything after the live output: notes, why the turn ended, the status line, warnings. */
export function formatResult(result: PromptResult, theme: Theme = PLAIN_THEME, stats?: TurnStats): string {
  const lines = notes(result).map((note) => theme.paint("warning", note));
  const outcome = describeOutcome(result.outcome, theme);
  if (outcome !== undefined) lines.push(...(lines.length > 0 ? [""] : []), outcome);
  if (lines.length > 0) lines.push("");
  lines.push(statusLine(result, theme, stats));
  if (!result.sessionDeleted) lines.push(theme.paint("error", "Warning: the OpenCode session could not be verified as deleted."));
  return `${lines.join("\n")}\n`;
}

const formatMemoryValue = (value: string): string =>
  sanitizeForTerminal(value).split("\n").map((line) => `  ${line}`).join("\n");

const memoryFieldValue = (value: string | null): string => {
  if (value === null) return "(not set)";
  const safe = sanitizeForTerminal(value);
  return safe.includes("\n") ? `\n${formatMemoryValue(safe)}` : safe.replace(/\s+/gu, " ");
};

/** Displays developer-authored memory after escaping terminal control sequences. */
export function formatProjectMemory(memory: ProjectMemory, filePath: string, theme: Theme = PLAIN_THEME): string {
  const lines = [
    theme.paint("strong", "Project memory"),
    `Storage: ${sanitizeLine(filePath, 240)}`,
    `Automatic previous-result summary: ${memory.automaticSummary ? "on" : "off"}`,
    `Objective: ${memoryFieldValue(memory.objective)}`,
    `Task: ${memoryFieldValue(memory.task)}`,
  ];
  const addList = (label: string, values: readonly string[]): void => {
    lines.push(`${label}:`);
    if (values.length === 0) lines.push("  (none)");
    for (const [index, value] of values.entries()) {
      const safe = formatMemoryValue(value).replace(/^  /u, "");
      const [first = "", ...rest] = safe.split("\n");
      lines.push(`  ${index + 1}. ${first}`, ...rest.map((line) => `     ${line}`));
    }
  };
  addList("Decisions", memory.decisions);
  addList("Constraints", memory.constraints);
  addList("Unresolved issues", memory.unresolvedIssues);
  if (memory.previousExecution === null) {
    lines.push("Previous execution summary: (none)");
  } else {
    const request = formatMemoryValue(memory.previousExecution.requestExcerpt).replace(/^  /u, "");
    const response = formatMemoryValue(memory.previousExecution.responseExcerpt).replace(/^  /u, "");
    lines.push(
      "Previous execution summary (bounded excerpts; not verified facts):",
      `  Request${memory.previousExecution.requestTruncated ? " (truncated)" : ""}: ${request}`,
      `  Response${memory.previousExecution.responseTruncated ? " (truncated)" : ""}: ${response}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const memoryFailureText: Record<MemoryUnavailableReason, string> = {
  corrupt: "saved project memory is malformed",
  "unsupported-version": "saved project memory uses an unsupported version",
  "invalid-data": "project memory did not pass validation",
  oversized: "project memory exceeds the storage limit",
  "unsafe-path": "the project memory path is unsafe",
  "io-error": "project memory could not be accessed",
};

export function formatProjectMemoryFailure(reason: MemoryUnavailableReason, operation = "load"): string {
  return `Could not ${operation} project memory: ${memoryFailureText[reason]}.`;
}

const historyFailureText: Record<HistoryUnavailableReason, string> = {
  corrupt: "the stored record is malformed",
  "unsupported-version": "the stored data uses an unsupported version",
  "invalid-data": "the stored data did not pass validation",
  oversized: "the stored data exceeds the size limit",
  "unsafe-path": "the history path is unsafe",
  "io-error": "history storage could not be accessed",
};

export function formatExecutionHistoryFailure(reason: HistoryUnavailableReason): string {
  return `Execution history is unavailable: ${historyFailureText[reason]}.`;
}

export function formatLocalStateRecovery(area: "Project memory" | "Execution history" | "OpenCode session ownership", detail: string): string {
  return `Local state: ${area} is unavailable. ${detail} Its source was preserved unchanged. `
    + "Stop Quoder before inspecting or moving it, make a copy before manual edits, and consult docs/tech.md for the state location and schema.";
}

const historyStatus = (status: ExecutionHistorySummary["status"]): string =>
  status === "in-progress" ? "in progress / possibly interrupted" : status;

export function formatExecutionHistoryList(records: readonly ExecutionHistorySummary[], theme: Theme = PLAIN_THEME): string {
  if (records.length === 0) return "No execution history yet.\n";
  return `${theme.paint("strong", "Execution history (10 most recent)")}\n${records.map((record) =>
    `  ${record.id}  ${sanitizeForTerminal(record.startedAt)}  ${historyStatus(record.status)}`,
  ).join("\n")}\n`;
}

const historyValueLines = (value: string): string[] =>
  sanitizeForTerminal(value).split("\n").map((line) => `  ${line}`);

const historyField = (label: string, value: string | null): string[] =>
  value === null ? [`${label}: (unavailable)`] : [`${label}:`, ...historyValueLines(value)];

/** Full record view. Values are sanitized but never clipped; field labels remain separate from data. */
export function formatExecutionHistoryRecord(record: ExecutionHistoryRecord, theme: Theme = PLAIN_THEME): string {
  const lines = [
    theme.paint("strong", "Execution history record"),
    `ID: ${record.id}`,
    `Schema version: ${record.version}`,
    `Started: ${sanitizeForTerminal(record.startedAt)}`,
    `Finished: ${record.finishedAt === null ? "(in progress / possibly interrupted)" : sanitizeForTerminal(record.finishedAt)}`,
    `Duration: ${record.durationMs === null ? "(unavailable)" : `${record.durationMs} ms`}`,
    ...historyField("Project name", record.project.name),
    ...historyField("Project root", record.project.root),
    ...historyField("Branch", record.branch),
    ...historyField("Starting HEAD", record.startingHead),
    ...historyField("Model provider", record.model.providerID),
    ...historyField("Model ID", record.model.id),
    ...historyField("Agent", record.agent),
    `Status: ${historyStatus(record.status)}`,
    `Attempts: ${record.attempts}`,
    `Failure stage: ${record.failureStage ?? "(none)"}`,
    ...historyField("Developer prompt", record.prompt),
    ...historyField("Injected context", record.injectedContext),
    "Permission decisions:",
  ];
  if (record.permissionDecisions.length === 0) lines.push("  (none)");
  for (const [index, decision] of record.permissionDecisions.entries()) {
    lines.push(`  ${index + 1}. resources=${decision.resourceCount ?? "(unavailable)"}; reply=${decision.reply}; replied=${decision.replied}`);
    lines.push(...historyField("     action", decision.action));
  }
  lines.push("Commands:");
  if (record.commands.length === 0) lines.push("  (none)");
  for (const [index, command] of record.commands.entries()) {
    lines.push(`  ${index + 1}. status=${command.status}`, ...historyValueLines(command.command));
  }
  lines.push("Tool activity:");
  if (record.toolActivity.length === 0) lines.push("  (none)");
  for (const activity of record.toolActivity) {
    lines.push(`  status=${activity.status}`);
    lines.push(...historyField("  tool", activity.tool));
  }
  lines.push("Observed file changes:");
  if (record.filesChanged === null) lines.push("  (unavailable while run is in progress)");
  else if (record.filesChanged.status === "unavailable") {
    lines.push("  unavailable; reason:", ...historyValueLines(record.filesChanged.reason ?? "unknown").map((line) => `  ${line}`));
  }
  else if (record.filesChanged.paths.length === 0) lines.push("  (none observed)");
  else for (const change of record.filesChanged.paths) {
    lines.push(`  ${change.kind}:`);
    lines.push(...historyValueLines(change.path));
    if (change.previousPath !== null) lines.push("    previous path:", ...historyValueLines(change.previousPath).map((line) => `  ${line}`));
  }
  lines.push(...historyField(
    "Final response",
    record.finalResponse === null && record.status === "in-progress"
      ? "(unavailable while execution is in progress)"
      : record.finalResponse,
  ));
  return `${lines.join("\n")}\n`;
}

export const EXECUTION_HISTORY_HELP_TEXT = [
  "Execution history is stored locally outside the project and may contain verbatim prompts, context, commands, and responses.",
  "Quoder does not detect or redact secrets in these fields. Other processes running as your user may be able to read them.",
  "History is per project. The default retention is 100 completed records; set it from 1 to 1,000. In-progress runs are retained until they finish.",
  "Use clear controls to remove records. Stored records are not proof that a run authored observed Git changes.",
  "",
  "  /history                         List the ten most recent runs",
  "  /history <id>                    Show one complete record",
  "  /history retention               Show the completed-record limit",
  "  /history retention <count>       Set the completed-record limit (1–1,000)",
  "  /history clear <id>              Delete one run",
  "  /history clear all               Delete all runs for this project",
].join("\n");

export const PROJECT_MEMORY_HELP_TEXT = [
  "Project memory is stored locally outside the project. Other processes running as your user may be able to read it.",
  "Automatic summaries save bounded request/response excerpts verbatim; Quoder does not detect or redact secrets.",
  "Only the previous request excerpt is included in future prompts; the response excerpt stays local for `/memory show`.",
  "Saved fields and repository paths in context are shown as escaped, single-line data.",
  "Use `/memory auto off` to stop replacing the previous-result summary, and `/memory clear summary` to remove the current one.",
  "Objective/task fields allow 500 characters. Decisions, constraints, and issues allow 20 entries of 500 characters each.",
  "The saved document is limited to 32 KiB; injected context is capped at 4,096 characters.",
  "",
  "  /memory show                         Show saved project memory",
  "  /memory objective <text>            Set the objective",
  "  /memory task <text>                 Set the current task",
  "  /memory add decision <text>         Add a durable decision",
  "  /memory add constraint <text>       Add a project constraint",
  "  /memory add issue <text>            Add an unresolved issue",
  "  /memory remove <kind> <number>      Remove a decision, constraint, or issue",
  "  /memory auto on|off                 Enable or disable automatic summaries",
  "  /memory clear <field|category>      Clear one field/category/summary",
  "  /memory clear                       Clear all context memory",
].join("\n");

export const HELP_TEXT = [
  "Each prompt runs in a fresh OpenCode session that is deleted afterwards.",
  "",
  "  /help          Show this help",
  "  /memory help   Inspect or manage persistent project context",
  "  /memory        Inspect or manage persistent project context",
  "  /history help  Inspect or manage execution history",
  "  /history       List recent executions",
  "  /model        List configured models; /model <query> selects one",
  "  /agent        List available agents; /agent <query> selects one",
  "  /exit          Leave Quoder (Ctrl-D also works)",
  "  Shift+Return   Start a new line; Return sends the prompt",
  "",
  "Ctrl-C cancels a running prompt or discards a multi-line prompt; at an empty prompt it leaves Quoder.",
  "Colour follows your terminal; set NO_COLOR or pass --no-color to turn it off.",
].join("\n");

const modelReference = ({ providerID, id }: Pick<OpenCodeModelOption, "providerID" | "id">): string =>
  sanitizeLine(`${providerID}/${id}`, 180);

/** Formats the current selection and the project-scoped models that may be selected next. */
export function formatModelChoices(
  models: readonly OpenCodeModelOption[],
  current: { readonly providerID: string; readonly id: string },
  theme: Theme = PLAIN_THEME,
): string {
  const currentReference = modelReference(current);
  const sorted = [...models].sort((left, right) => modelReference(left).localeCompare(modelReference(right)));
  const currentListed = sorted.some((model) => modelReference(model) === currentReference);
  const lines = [
    theme.paint("strong", "Configured models"),
    `Current model: ${currentReference}${currentListed ? "" : " (not listed by OpenCode)"}`,
  ];
  if (sorted.length === 0) lines.push("  (no enabled models available)");
  else for (const model of sorted) {
    const reference = modelReference(model);
    const selected = reference === currentReference ? " (selected)" : "";
    lines.push(`  ${reference}${selected} — ${sanitizeLine(model.name, 120)}`);
  }
  lines.push("Use /model <provider/model-id> or a unique name fragment to select.");
  return `${lines.join("\n")}\n`;
}

/** Formats the current selection and the visible primary/general-purpose agents. */
export function formatAgentChoices(
  agents: readonly OpenCodeAgentOption[],
  current: string,
  theme: Theme = PLAIN_THEME,
): string {
  const sorted = [...agents].sort((left, right) => left.id.localeCompare(right.id));
  const lines = [theme.paint("strong", "Available agents"), `Current agent: ${sanitizeLine(current, 120)}`];
  if (sorted.length === 0) lines.push("  (no selectable agents available)");
  else for (const agent of sorted) {
    const id = sanitizeLine(agent.id, 120);
    lines.push(`  ${id}${agent.id === current ? " (selected)" : ""}`);
  }
  lines.push("Use /agent <id> or a unique ID fragment to select.");
  return `${lines.join("\n")}\n`;
}
