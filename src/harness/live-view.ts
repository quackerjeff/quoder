import { MarkdownStream, renderMarkdown } from "../ui/markdown.js";
import type { Theme } from "../ui/style.js";
import { renderActivity, runningLabel, summarizeCall, summarizeResult, type ToolCall, type ToolOutcome } from "./activity.js";
import type { PromptResult } from "./session-runner.js";
import type { StreamEvent } from "./stream-events.js";
import { sanitizeLine } from "./terminal-text.js";

/** Totals for the final status line. */
export interface TurnStats {
  readonly tools: number;
  readonly outputTokens: number;
}

export interface LiveViewOptions {
  readonly theme: Theme;
  readonly write: (text: string) => void;
  /** Project root, for project-relative paths in activity lines. */
  readonly root: string;
  /** Shown in the status line, e.g. `glm-4.7-flash:latest`. */
  readonly modelLabel: string;
  /** Draw the animated status line (interactive terminals only; never when piped). */
  readonly statusLine: boolean;
  /** Terminal width; the status line is truncated to one less, so it never wraps. */
  readonly columns?: () => number | undefined;
  readonly onFirstText?: () => void;
  readonly onToolFinished?: (tool: string) => void;
  readonly now?: () => number;
  readonly frameMs?: number;
  readonly idleFlushMs?: number;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\u001b[2K";
const DEFAULT_COLUMNS = 80;
const PREVIEW_LENGTH = 200;

interface TextBlock {
  readonly messageID: string;
  readonly stream: MarkdownStream;
  ended: boolean;
}

interface RunningTool {
  readonly tool: string;
  input: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Shows one prompt's OpenCode activity as it happens (FR-6): streamed Markdown text, one line per
 * finished tool, and, on an interactive terminal, an animated status line that is erased before
 * any permanent output. Streaming is display only: the session runner still decides completion, and
 * `finish` makes sure the authoritative final answer is shown in full.
 */
export class LiveView {
  readonly #options: LiveViewOptions;
  readonly #now: () => number;
  readonly #started: number;
  readonly #blocks = new Map<string, TextBlock>();
  readonly #tools = new Map<string, RunningTool>();
  #sessionID: string | undefined;
  #finalMessageID: string | undefined;
  #phase = "Starting session";
  #reasoning = "";
  #toolCount = 0;
  #outputTokens = 0;
  #sawText = false;
  #cancelling = false;
  #finished = false;
  #frame = 0;
  #statusShown = false;
  /** What the last permanent output was, so text and tool lines are separated by a blank line. */
  #lastKind: "text" | "tool" | "note" | undefined;
  /** The text stream that wrote last. */
  #current: MarkdownStream | undefined;
  #ticker: NodeJS.Timeout | undefined;
  #idleFlush: NodeJS.Timeout | undefined;

  constructor(options: LiveViewOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#started = this.#now();
    if (options.statusLine) {
      this.#ticker = setInterval(() => this.#drawStatus(), options.frameMs ?? 100);
      this.#ticker.unref();
      this.#drawStatus();
    }
  }

  /** Events are shown only for this session. */
  setSession(sessionID: string): void {
    this.#sessionID = sessionID;
    this.#phase = "Waiting for the model";
  }

  handle(event: StreamEvent): void {
    if (this.#finished || event.sessionID !== this.#sessionID) return;
    switch (event.kind) {
      case "step-started":
        this.#finalMessageID = event.messageID;
        this.#reasoning = "";
        this.#phase = "Thinking";
        break;
      case "step-ended":
        this.#outputTokens += event.tokens?.output ?? 0;
        break;
      case "step-failed":
        if (!this.#cancelling) this.#permanent(`${this.#paint("warning", `! Step failed: ${sanitizeLine(event.message, 120)}`)}\n`);
        break;
      case "retried":
        this.#permanent(`${this.#paint("warning", `! Retrying (attempt ${event.attempt}): ${sanitizeLine(event.message, 120)}`)}\n`);
        break;
      case "reasoning-delta":
        this.#reasoning = (this.#reasoning + event.delta).slice(-PREVIEW_LENGTH);
        this.#phase = "Thinking";
        break;
      case "reasoning-ended":
        this.#reasoning = "";
        break;
      case "text-delta":
        this.#text(event.textID, event.messageID).stream.push(event.delta);
        this.#reasoning = "";
        this.#phase = "Writing";
        if (!this.#sawText) {
          this.#sawText = true;
          this.#options.onFirstText?.();
        }
        this.#armIdleFlush();
        break;
      case "text-ended": {
        const block = this.#text(event.textID, event.messageID);
        if (!block.ended) {
          block.ended = true;
          // A mismatch is resolved in `finish`, against the authoritative final answer.
          block.stream.end(event.text);
        }
        break;
      }
      case "tool-preparing":
        if (!this.#tools.has(event.callID)) this.#tools.set(event.callID, { tool: event.tool, input: undefined });
        this.#phase = `Preparing ${sanitizeLine(event.tool, 20)}`;
        break;
      case "tool-called": {
        const running = this.#tools.get(event.callID);
        if (running === undefined) this.#tools.set(event.callID, { tool: event.tool, input: event.input });
        else running.input = event.input;
        this.#phase = this.#runningPhase();
        break;
      }
      case "tool-succeeded":
        this.#finishTool(event.callID, { kind: "succeeded", structured: event.structured, output: event.output });
        break;
      case "tool-failed":
        this.#finishTool(event.callID, { kind: "failed", message: event.message });
        break;
    }
    this.#drawStatus();
  }

  /** Ctrl-C was pressed: say so at once; `finish` reports the outcome. */
  cancelling(): void {
    if (this.#finished) return;
    this.#cancelling = true;
    this.#phase = "Cancelling";
    this.#permanent(`${this.#paint("warning", "Cancelling OpenCode execution…")}\n`);
  }

  /**
   * Ends the view: open text is flushed, tools that never finished are marked cancelled, and an
   * answer that was not streamed in full is printed from the authoritative final text.
   */
  finish(result?: PromptResult): TurnStats {
    if (this.#finished) return this.#stats();
    this.#stopTimers();
    for (const block of this.#blocks.values()) {
      if (block.ended) continue;
      block.ended = true;
      block.stream.end();
    }
    for (const [callID] of this.#tools) this.#finishTool(callID, { kind: "cancelled" });
    if (result?.outcome.kind === "answered") this.#reconcile(result.outcome.text);
    this.#clearStatus();
    this.#finished = true;
    return this.#stats();
  }

  #reconcile(finalText: string): void {
    const streamed = [...this.#blocks.values()]
      .filter((block) => block.messageID === this.#finalMessageID)
      .map((block) => block.stream.seen)
      .join("")
      .trim();
    if (streamed === finalText.trim()) return;
    const rendered = renderMarkdown(finalText, this.#options.theme);
    const gap = this.#lastKind === undefined ? "" : "\n";
    if (streamed !== "") {
      this.#permanent(`${gap}${this.#paint("dim", "(The streamed answer was incomplete; the full answer follows.)")}\n\n${rendered}`, "text");
    } else {
      this.#permanent(`${gap}${rendered}`, "text");
    }
  }

  #stats(): TurnStats {
    return { tools: this.#toolCount, outputTokens: this.#outputTokens };
  }

  #text(textID: string, messageID: string): TextBlock {
    let block = this.#blocks.get(textID);
    if (block === undefined) {
      const stream = new MarkdownStream(this.#options.theme, (text) => {
        // A new text block starts after a blank line, unless the same block is continuing.
        const separate = this.#lastKind !== undefined && (this.#lastKind !== "text" || this.#current !== stream);
        this.#current = stream;
        this.#permanent(`${separate && !text.startsWith("\n") ? "\n" : ""}${text}`, "text");
      });
      block = { messageID, stream, ended: false };
      this.#blocks.set(textID, block);
    }
    return block;
  }

  #finishTool(callID: string, outcome: ToolOutcome): void {
    const running = this.#tools.get(callID);
    if (running === undefined) return;
    this.#tools.delete(callID);
    // Text written before the call belongs above its line.
    for (const block of this.#blocks.values()) if (!block.ended) block.stream.flushLines();
    const line = summarizeResult(running.tool, running.input ?? {}, this.#options.root, outcome);
    this.#permanent(`${this.#lastKind === "text" ? "\n" : ""}${renderActivity(line, this.#options.theme)}\n`, "tool");
    this.#toolCount++;
    this.#options.onToolFinished?.(sanitizeLine(running.tool, 40));
    this.#phase = this.#tools.size > 0 ? this.#runningPhase() : "Thinking";
  }

  #runningPhase(): string {
    const calls: ToolCall[] = [...this.#tools.values()].map(({ tool, input }) => summarizeCall(tool, input ?? {}, this.#options.root));
    return runningLabel(calls) ?? "Thinking";
  }

  #armIdleFlush(): void {
    if (this.#idleFlush !== undefined) clearTimeout(this.#idleFlush);
    this.#idleFlush = setTimeout(() => {
      this.#idleFlush = undefined;
      for (const block of this.#blocks.values()) if (!block.ended) block.stream.flushLines();
      this.#drawStatus();
    }, this.#options.idleFlushMs ?? 400);
    this.#idleFlush.unref();
  }

  #stopTimers(): void {
    if (this.#ticker !== undefined) clearInterval(this.#ticker);
    if (this.#idleFlush !== undefined) clearTimeout(this.#idleFlush);
    this.#ticker = undefined;
    this.#idleFlush = undefined;
  }

  /** Permanent output: the status line is erased first and drawn again on the next frame. */
  #permanent(text: string, kind: "text" | "tool" | "note" = "note"): void {
    if (text === "") return;
    this.#clearStatus();
    this.#options.write(text);
    this.#lastKind = kind;
  }

  #clearStatus(): void {
    if (!this.#statusShown) return;
    this.#options.write(CLEAR_LINE);
    this.#statusShown = false;
  }

  #drawStatus(): void {
    if (!this.#options.statusLine || this.#finished) return;
    const width = Math.max(10, (this.#options.columns?.() ?? DEFAULT_COLUMNS) - 1);
    const elapsed = `${((this.#now() - this.#started) / 1000).toFixed(1)}s`;
    const spinner = SPINNER[this.#frame++ % SPINNER.length] ?? "·";
    const head = `${this.#phase}… ${elapsed} · ${this.#options.modelLabel}`;
    const preview = this.#reasoning === "" ? "" : ` · ${sanitizeLine(this.#reasoning, PREVIEW_LENGTH)}`;
    // Plain text is truncated to the width before styling, so the line never wraps.
    const plain = `${head}${preview}`;
    const room = width - 2;
    const fitted = [...plain].length > room ? `${[...plain].slice(0, Math.max(0, room - 1)).join("")}…` : plain;
    const headPart = fitted.slice(0, Math.min(fitted.length, head.length));
    const rest = fitted.slice(headPart.length);
    this.#options.write(`${CLEAR_LINE}${this.#paint("accent", spinner)} ${this.#paint("dim", headPart)}${rest === "" ? "" : this.#paint("quote", rest)}`);
    this.#statusShown = true;
  }

  #paint(role: Parameters<Theme["paint"]>[0], text: string): string {
    return this.#options.theme.paint(role, text);
  }
}
