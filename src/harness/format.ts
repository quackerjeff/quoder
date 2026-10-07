import { PLAIN_THEME, type Theme } from "../ui/style.js";
import { GIT_DIFF_PAGE_LINES, MAX_GIT_DIFF_BYTES, type GitDiffDocument, type GitDiffResult } from "./git-diff.js";
import type { GitComparison, GitDiffStats, GitFailureKind, GitPathChange } from "./git-state.js";
import type { TurnStats } from "./live-view.js";
import type { PromptResult, RejectedPermission, TurnOutcome } from "./session-runner.js";
import { sanitizeForTerminal, sanitizeLine } from "./terminal-text.js";

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
      return theme.paint("error", `The prompt did not complete: ${sanitizeLine(outcome.reason)}`);
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

/** The final status line, e.g. `✓ Done in 41.8s · 4 tools · 1.2k tokens`. */
const statusLine = (result: PromptResult, theme: Theme, stats: TurnStats | undefined): string => {
  const elapsed = seconds(result.elapsedMs);
  switch (result.outcome.kind) {
    case "answered": {
      const extra = stats === undefined ? [] : [count(stats.tools, "tool"), ...(stats.outputTokens > 0 ? [`${tokens(stats.outputTokens)} tokens`] : [])];
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

export const HELP_TEXT = [
  "Each prompt runs in a fresh OpenCode session that is deleted afterwards.",
  "",
  "  /help          Show this help",
  "  /exit          Leave Quoder (Ctrl-D also works)",
  "  Shift+Return   Start a new line; Return sends the prompt",
  "",
  "Ctrl-C cancels a running prompt or discards a multi-line prompt; at an empty prompt it leaves Quoder.",
  "Colour follows your terminal; set NO_COLOR or pass --no-color to turn it off.",
].join("\n");
