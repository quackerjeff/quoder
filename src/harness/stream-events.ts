/**
 * The display event model: OpenCode's `session.next.*` events, narrowed from untrusted payloads into
 * a small typed union. It holds no presentation, so a later full-screen TUI can consume it as is.
 *
 * Shapes verified live against OpenCode 1.18.33 (spec 2026-10-03-milestone-2-streaming-ui, Group 1).
 * Strings stay raw here; whoever displays them sanitizes them.
 */

export interface TokenUsage {
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
}

export type StreamEvent =
  | { readonly kind: "step-started"; readonly sessionID: string; readonly messageID: string }
  | { readonly kind: "step-ended"; readonly sessionID: string; readonly messageID: string; readonly tokens?: TokenUsage }
  | { readonly kind: "step-failed"; readonly sessionID: string; readonly message: string }
  | { readonly kind: "retried"; readonly sessionID: string; readonly attempt: number; readonly message: string }
  | { readonly kind: "text-delta"; readonly sessionID: string; readonly messageID: string; readonly textID: string; readonly delta: string }
  | { readonly kind: "text-ended"; readonly sessionID: string; readonly messageID: string; readonly textID: string; readonly text: string }
  | { readonly kind: "reasoning-delta"; readonly sessionID: string; readonly reasoningID: string; readonly delta: string }
  | { readonly kind: "reasoning-ended"; readonly sessionID: string; readonly reasoningID: string }
  | { readonly kind: "tool-preparing"; readonly sessionID: string; readonly callID: string; readonly tool: string }
  | {
      readonly kind: "tool-called";
      readonly sessionID: string;
      readonly callID: string;
      readonly tool: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "tool-succeeded";
      readonly sessionID: string;
      readonly callID: string;
      readonly structured: Readonly<Record<string, unknown>>;
      /** The tool's text content parts, joined with newlines (for example bash output). */
      readonly output: string;
    }
  | { readonly kind: "tool-failed"; readonly sessionID: string; readonly callID: string; readonly message: string };

/** A raw global-stream item as the 1.18.33 SDK yields it at runtime. */
export interface RawEvent {
  readonly type: string;
  readonly data: unknown;
}

export const SESSION_EVENT_PREFIX = "session.next.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const count = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};

const errorMessage = (value: unknown): string => (isRecord(value) && text(value, "message")) || "unknown error";

const tokenUsage = (value: unknown): TokenUsage | undefined => {
  if (!isRecord(value)) return undefined;
  const input = count(value, "input");
  const output = count(value, "output");
  const reasoning = count(value, "reasoning");
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
};

const contentText = (value: unknown): string =>
  Array.isArray(value)
    ? value.flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n")
    : "";

/**
 * Narrows one global-stream item. Returns undefined for anything that is not a well-formed display
 * event, so a malformed or unknown payload is dropped rather than thrown.
 */
export function narrowStreamEvent(event: RawEvent): StreamEvent | undefined {
  if (!event.type.startsWith(SESSION_EVENT_PREFIX) || !isRecord(event.data)) return undefined;
  const data = event.data;
  const sessionID = text(data, "sessionID");
  if (sessionID === undefined) return undefined;
  const messageID = text(data, "assistantMessageID");
  const callID = text(data, "callID");
  switch (event.type.slice(SESSION_EVENT_PREFIX.length)) {
    case "step.started":
      return messageID === undefined ? undefined : { kind: "step-started", sessionID, messageID };
    case "step.ended": {
      if (messageID === undefined) return undefined;
      const tokens = tokenUsage(data.tokens);
      return tokens === undefined ? { kind: "step-ended", sessionID, messageID } : { kind: "step-ended", sessionID, messageID, tokens };
    }
    case "step.failed":
      return { kind: "step-failed", sessionID, message: errorMessage(data.error) };
    case "retried":
      return { kind: "retried", sessionID, attempt: count(data, "attempt") ?? 0, message: errorMessage(data.error) };
    case "text.delta": {
      const textID = text(data, "textID");
      const delta = text(data, "delta");
      return messageID === undefined || textID === undefined || delta === undefined
        ? undefined
        : { kind: "text-delta", sessionID, messageID, textID, delta };
    }
    case "text.ended": {
      const textID = text(data, "textID");
      const full = text(data, "text");
      return messageID === undefined || textID === undefined || full === undefined
        ? undefined
        : { kind: "text-ended", sessionID, messageID, textID, text: full };
    }
    case "reasoning.delta": {
      const reasoningID = text(data, "reasoningID");
      const delta = text(data, "delta");
      return reasoningID === undefined || delta === undefined ? undefined : { kind: "reasoning-delta", sessionID, reasoningID, delta };
    }
    case "reasoning.ended": {
      const reasoningID = text(data, "reasoningID");
      return reasoningID === undefined ? undefined : { kind: "reasoning-ended", sessionID, reasoningID };
    }
    case "tool.input.started": {
      const tool = text(data, "name");
      return callID === undefined || tool === undefined ? undefined : { kind: "tool-preparing", sessionID, callID, tool };
    }
    case "tool.called": {
      const tool = text(data, "tool");
      return callID === undefined || tool === undefined
        ? undefined
        : { kind: "tool-called", sessionID, callID, tool, input: isRecord(data.input) ? data.input : {} };
    }
    case "tool.success":
      return callID === undefined
        ? undefined
        : {
            kind: "tool-succeeded",
            sessionID,
            callID,
            structured: isRecord(data.structured) ? data.structured : {},
            output: contentText(data.content),
          };
    case "tool.failed":
      return callID === undefined ? undefined : { kind: "tool-failed", sessionID, callID, message: errorMessage(data.error) };
    default:
      return undefined;
  }
}
