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

const describeOutcome = (outcome: TurnOutcome): string => {
  switch (outcome.kind) {
    case "answered":
      return sanitizeForTerminal(outcome.text);
    case "permission-rejected": {
      return [
        `OpenCode asked for permission (${describePermission(outcome)}).`,
        "Quoder cannot grant permissions interactively yet, so the request was not granted and the turn ended.",
      ].join("\n");
    }
    case "question-rejected": {
      const lines = outcome.questions.map(({ question, options }) => {
        const choices = options.length > 0 ? ` (${options.map((option) => sanitizeLine(option, 60)).join(" / ")})` : "";
        return `  ${sanitizeLine(question)}${choices}`;
      });
      return [
        "The model asked a question, which Quoder cannot answer interactively yet:",
        ...(lines.length > 0 ? lines : ["  (no question text was provided)"]),
        "Answer it in your next prompt.",
      ].join("\n");
    }
    case "cancelled":
      return "Execution cancelled.";
    case "failed":
      return `The prompt did not complete: ${sanitizeLine(outcome.reason)}`;
  }
};

export function formatResult(result: PromptResult): string {
  const extra = notes(result);
  const lines = [...extra, ...(extra.length > 0 ? [""] : []), describeOutcome(result.outcome), ""];
  if (result.outcome.kind === "answered") lines.push(`Completed in ${seconds(result.elapsedMs)}.`);
  if (!result.sessionDeleted) {
    lines.push("Warning: the OpenCode session could not be verified as deleted.");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export const HELP_TEXT = [
  "Each prompt runs in a fresh OpenCode session that is deleted afterwards.",
  "",
  "  /help   Show this help",
  "  /exit   Leave Quoder (Ctrl-D also works)",
  "",
  "Ctrl-C cancels a running prompt; at an empty prompt it leaves Quoder.",
].join("\n");
