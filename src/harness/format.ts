import { PLAIN_THEME, type Theme } from "../ui/style.js";
import type { TurnStats } from "./live-view.js";
import type { PromptResult, RejectedPermission, TurnOutcome } from "./session-runner.js";
import { sanitizeLine } from "./terminal-text.js";

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
          "Quoder cannot grant permissions interactively yet, so the request was not granted and the turn ended.",
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
