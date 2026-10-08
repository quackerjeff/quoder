import { randomBytes } from "node:crypto";
import type { ModelRef, SessionMessagesResponse } from "@opencode-ai/sdk/v2";

import type { PermissionAsked, QuestionAsked } from "../event-monitor.js";
import type { OperationalFailureCategory } from "./operational-log.js";
import type { OwnedSessionLedger } from "./owned-session-ledger.js";
import {
  finalAssistantResponseText,
  hasAssistantResponseAfter,
  type OpenCodeAdapter,
} from "../opencode-adapter.js";

export const TURN_POLL_INTERVAL_MS = 250;
/**
 * How long an admitted prompt's session may sit idle with no assistant message before the prompt
 * counts as dropped. OpenCode 1.18.33 intermittently drops the first prompt on a fresh server: it is
 * admitted, then the session goes idle and the model never runs (2 of 5 fresh servers in Milestone 2
 * QA). An admitted run is registered as active at once, so idle without a response is not a slow
 * model; a dropped prompt is retried once in a fresh session.
 */
export const NO_RESPONSE_TIMEOUT_MS = 5_000;
const NOT_STARTED = "OpenCode did not start a response";

export interface QuestionSummary {
  readonly question: string;
  readonly options: readonly string[];
}

/** Why a turn ended. Model-controlled strings are raw here; the formatter sanitizes them. */
export type TurnOutcome =
  | { readonly kind: "answered"; readonly text: string }
  | { readonly kind: "permission-rejected"; readonly action: string | undefined; readonly resourceCount: number }
  | { readonly kind: "question-rejected"; readonly questions: readonly QuestionSummary[] }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string; readonly category?: OperationalFailureCategory };

export interface RejectedPermission {
  readonly action: string | undefined;
  readonly resourceCount: number;
}

const PROVIDER_FAILURE_NAMES = new Set([
  "ProviderAuthError",
  "MessageOutputLengthError",
  "StructuredOutputError",
  "ContextOverflowError",
  "ContentFilterError",
  "APIError",
]);

const isReportedInferenceFailure = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const name = Reflect.get(error, "name") ?? Reflect.get(error, "_tag");
  return typeof name === "string" && PROVIDER_FAILURE_NAMES.has(name);
};

/**
 * Aborting a turn's cancel signal with a `StopRequest` reason stops it for a harness reason (for
 * example a lost server); the outcome is then `failed` with that message instead of `cancelled`.
 */
export interface StopRequest {
  readonly stopped: string;
}

const stopMessage = (reason: unknown): string | undefined => {
  const message = typeof reason === "object" && reason !== null ? Reflect.get(reason, "stopped") : undefined;
  return typeof message === "string" ? message : undefined;
};

const abortedOutcome = (signal: AbortSignal): TurnOutcome => {
  const message = stopMessage(signal.reason);
  return message === undefined ? { kind: "cancelled" } : { kind: "failed", reason: message, category: "OpenCode" };
};

export interface PromptResult {
  readonly sessionID: string | undefined;
  readonly outcome: TurnOutcome;
  /** Every permission request rejected during the turn, reported even when the turn answered. */
  readonly rejectedPermissions: readonly RejectedPermission[];
  /** Every question rejected during the turn, reported even when the turn answered. */
  readonly rejectedQuestions: readonly QuestionSummary[];
  /** False when the session could not be deleted or its deletion could not be verified. */
  readonly sessionDeleted: boolean;
  readonly elapsedMs: number;
}

/**
 * Records what the event monitor saw for each session the harness owns. Only sessions registered
 * here are acted on by the monitor.
 */
export class SessionTracker {
  readonly #sessions = new Map<string, { permissions: PermissionAsked[]; questions: QuestionAsked[] }>();
  readonly #owners = new Map<string, string>();

  register(sessionID: string): void {
    this.#sessions.set(sessionID, { permissions: [], questions: [] });
    this.#owners.set(sessionID, sessionID);
  }

  /** Registers a session only when its reported parent already belongs to this execution tree. */
  registerChild(sessionID: string, parentID: string | undefined): boolean {
    if (parentID === undefined) return false;
    const owner = this.#owners.get(parentID);
    if (owner === undefined) return false;
    if (!this.#sessions.has(sessionID)) this.#sessions.set(sessionID, { permissions: [], questions: [] });
    this.#owners.set(sessionID, owner);
    return true;
  }

  unregister(sessionID: string): void {
    for (const [candidate, owner] of this.#owners) {
      if (owner === sessionID) {
        this.#owners.delete(candidate);
        this.#sessions.delete(candidate);
      }
    }
  }

  owns(sessionID: string): boolean {
    return this.#owners.has(sessionID);
  }

  notePermission(permission: PermissionAsked): void {
    this.#sessions.get(permission.sessionID)?.permissions.push(permission);
  }

  noteQuestion(question: QuestionAsked): void {
    this.#sessions.get(question.sessionID)?.questions.push(question);
  }

  permissions(sessionID: string): readonly PermissionAsked[] {
    return [...this.#sessions]
      .filter(([candidate]) => this.#owners.get(candidate) === sessionID)
      .flatMap(([, state]) => state.permissions);
  }

  questions(sessionID: string): readonly QuestionAsked[] {
    return [...this.#sessions]
      .filter(([candidate]) => this.#owners.get(candidate) === sessionID)
      .flatMap(([, state]) => state.questions);
  }
}

export const summarizeQuestions = (raw: unknown): QuestionSummary[] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): QuestionSummary[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const question = Reflect.get(entry, "question");
    if (typeof question !== "string") return [];
    const options = Reflect.get(entry, "options");
    const labels = Array.isArray(options)
      ? options.flatMap((option) => {
        const label = typeof option === "object" && option !== null ? Reflect.get(option, "label") : undefined;
        return typeof label === "string" ? [label] : [];
      })
      : [];
    return [{ question, options: labels }];
  });
};

type AssistantMessage = Extract<SessionMessagesResponse["data"][number], { type: "assistant" }>;

const lastAssistantInTurn = (
  messages: SessionMessagesResponse,
  inputID: string,
): AssistantMessage | undefined => {
  const index = messages.data.findIndex((message) => message.type === "user" && message.id === inputID);
  if (index < 0) return undefined;
  let last: AssistantMessage | undefined;
  for (const message of messages.data.slice(index + 1)) {
    if (message.type === "user") break;
    if (message.type === "assistant") last = message;
  }
  return last;
};

/** Settles after `ms`, or immediately when `signal` aborts. Never rejects. */
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolvePause) => {
    if (signal.aborted) {
      resolvePause();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolvePause();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export interface RunPromptOptions {
  readonly adapter: OpenCodeAdapter;
  readonly tracker: SessionTracker;
  /** Durable intent is published before issuing the server create request. */
  readonly ownedSessionLedger?: OwnedSessionLedger;
  readonly directory: string;
  readonly model: ModelRef;
  /** OpenCode agent bound to each fresh attempt; defaults to the build agent. */
  readonly agent?: string;
  readonly prompt: string;
  /** Aborting cancels the turn: the session is interrupted, settled, and deleted. */
  readonly cancel: AbortSignal;
  readonly onSessionCreated?: (sessionID: string) => void;
  readonly onSessionDeleted?: (sessionID: string, verified: boolean) => void;
  /** Called when a dropped prompt is about to be sent again in a fresh session. */
  readonly onRetry?: () => void;
  readonly pollIntervalMs?: number;
  readonly noResponseTimeoutMs?: number;
  readonly now?: () => number;
}

interface Attempt {
  readonly sessionID: string | undefined;
  readonly outcome: TurnOutcome;
  /** The prompt was admitted but OpenCode never started a response. */
  readonly dropped: boolean;
  readonly rejectedPermissions: RejectedPermission[];
  readonly rejectedQuestions: QuestionSummary[];
  readonly sessionDeleted: boolean;
}

/**
 * Runs one developer prompt in a fresh OpenCode session (FR-3, FR-15). The session is always
 * deleted, and the deletion verified, whatever happened during the turn. A prompt OpenCode dropped
 * (admitted, never started) is sent once more in another fresh session; nothing ran in the first.
 */
export async function runPrompt(options: RunPromptOptions): Promise<PromptResult> {
  const now = options.now ?? Date.now;
  const started = now();
  if (options.cancel.aborted) {
    return {
      sessionID: undefined,
      outcome: abortedOutcome(options.cancel),
      rejectedPermissions: [],
      rejectedQuestions: [],
      sessionDeleted: true,
      elapsedMs: 0,
    };
  }
  let attempt = await runAttempt(options);
  // Retry only when the dropped session was verifiably deleted and the developer has not cancelled.
  if (attempt.dropped && options.cancel.aborted) {
    // Ctrl-C (or a harness stop) while the dropped session was being cleaned up: report that.
    attempt = { ...attempt, outcome: abortedOutcome(options.cancel) };
  } else if (attempt.dropped && attempt.sessionDeleted) {
    options.onRetry?.();
    attempt = await runAttempt(options);
  }
  const { dropped: _dropped, ...result } = attempt;
  return { ...result, elapsedMs: now() - started };
}

async function runAttempt(options: RunPromptOptions): Promise<Attempt> {
  let sessionID: string | undefined;
  let intendedSessionID: string | undefined;
  let createIssued = false;
  let outcome: TurnOutcome;
  let endedIdle = false;
  let dropped = false;
  let localStateFailure = false;
  try {
    if (options.ownedSessionLedger !== undefined) {
      intendedSessionID = `ses_${randomBytes(12).toString("hex")}`;
      try {
        await options.ownedSessionLedger.prepare(intendedSessionID);
      } catch {
        localStateFailure = true;
        throw new Error("Quoder could not prepare session ownership state");
      }
    }
    createIssued = true;
    const session = await options.adapter.createSession({
      directory: options.directory,
      ...(intendedSessionID === undefined ? {} : { id: intendedSessionID }),
      model: options.model,
      agent: options.agent ?? "build",
    });
    sessionID = session.id;
    if (intendedSessionID !== undefined && sessionID !== intendedSessionID) {
      sessionID = undefined;
      throw new Error("OpenCode returned a different session ID than Quoder requested");
    }
    if (intendedSessionID !== undefined) {
      try {
        await options.ownedSessionLedger?.markCreated(intendedSessionID);
      } catch {
        localStateFailure = true;
        throw new Error("Quoder could not update session ownership state");
      }
    }
    options.tracker.register(sessionID);
    options.onSessionCreated?.(sessionID);
    if (options.cancel.aborted) {
      outcome = abortedOutcome(options.cancel);
    } else {
      const turn = await runTurn(options, sessionID);
      outcome = turn.outcome;
      endedIdle = turn.endedIdle;
      dropped = turn.dropped;
    }
  } catch (error) {
    if (intendedSessionID !== undefined && createIssued && sessionID === undefined) {
      try {
        await options.ownedSessionLedger?.markAmbiguous(intendedSessionID);
      } catch {
        localStateFailure = true;
      }
    }
    outcome = options.cancel.aborted
      ? abortedOutcome(options.cancel)
      : localStateFailure
        ? { kind: "failed", reason: failureReason(error), category: "Local state" }
        : { kind: "failed", reason: failureReason(error), category: "OpenCode" };
  }
  let sessionDeleted = sessionID === undefined;
  let rejectedPermissions: RejectedPermission[] = [];
  let rejectedQuestions: QuestionSummary[] = [];
  if (sessionID !== undefined) {
    rejectedPermissions = options.tracker
      .permissions(sessionID)
      .map(({ action, resourceCount }) => ({ action, resourceCount }));
    rejectedQuestions = options.tracker.questions(sessionID).flatMap((question) => summarizeQuestions(question.questions));
    // A turn that did not end in an observed idle state may still be running: stop it first.
    if (!endedIdle) await settle(options.adapter, sessionID);
    try {
      await options.adapter.deleteSession(sessionID);
      sessionDeleted = true;
      if (intendedSessionID === sessionID) await options.ownedSessionLedger?.remove(sessionID).catch(() => undefined);
    } catch {
      sessionDeleted = false;
    }
    options.onSessionDeleted?.(sessionID, sessionDeleted);
    options.tracker.unregister(sessionID);
  }
  return { sessionID, outcome, dropped, rejectedPermissions, rejectedQuestions, sessionDeleted };
}

async function runTurn(
  options: RunPromptOptions,
  sessionID: string,
): Promise<{ readonly outcome: TurnOutcome; readonly endedIdle: boolean; readonly dropped: boolean }> {
  const { adapter, cancel } = options;
  const admitted = await adapter.prompt(sessionID, options.prompt);
  const pollIntervalMs = options.pollIntervalMs ?? TURN_POLL_INTERVAL_MS;
  const noResponseTimeoutMs = options.noResponseTimeoutMs ?? NO_RESPONSE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let idleWithoutResponseSince: number | undefined;
  for (;;) {
    if (cancel.aborted) return { outcome: abortedOutcome(cancel), endedIdle: false, dropped: false };
    if (!(await adapter.isActive(sessionID))) {
      const messages = await adapter.messages(sessionID);
      if (hasAssistantResponseAfter(messages, admitted.id)) {
        return { outcome: classifyEndedTurn(options, sessionID, messages, admitted.id), endedIdle: true, dropped: false };
      }
      idleWithoutResponseSince ??= now();
      if (now() - idleWithoutResponseSince >= noResponseTimeoutMs) {
        return { outcome: { kind: "failed", reason: NOT_STARTED, category: "OpenCode" }, endedIdle: false, dropped: true };
      }
    } else {
      idleWithoutResponseSince = undefined;
    }
    await pause(pollIntervalMs, cancel);
  }
}

function classifyEndedTurn(
  options: RunPromptOptions,
  sessionID: string,
  messages: SessionMessagesResponse,
  inputID: string,
): TurnOutcome {
  const text = finalAssistantResponseText(messages, inputID);
  if (text !== undefined && text.length > 0) return { kind: "answered", text };
  // A rejected permission or question ends the turn without a final response (verified live).
  const permission = options.tracker.permissions(sessionID).at(-1);
  if (permission !== undefined) {
    return { kind: "permission-rejected", action: permission.action, resourceCount: permission.resourceCount };
  }
  const questions = options.tracker.questions(sessionID);
  if (questions.length > 0) {
    return { kind: "question-rejected", questions: questions.flatMap((question) => summarizeQuestions(question.questions)) };
  }
  const last = lastAssistantInTurn(messages, inputID);
  if (last?.error !== undefined) {
    return isReportedInferenceFailure(last.error)
      ? { kind: "failed", reason: "OpenCode reported an inference failure", category: "Provider/inference" }
      : { kind: "failed", reason: "OpenCode reported a session failure", category: "OpenCode" };
  }
  return {
    kind: "failed",
    reason: text === "" ? "The model returned an empty response" : "The turn ended without a final response",
    category: "OpenCode",
  };
}

/** Interrupt and wait (bounded by the adapter timeout) for the session to idle before deleting it. */
async function settle(adapter: OpenCodeAdapter, sessionID: string): Promise<void> {
  try {
    await adapter.interrupt(sessionID);
    await adapter.waitUntilIdle(sessionID);
  } catch {
    // Deletion below still runs; its verification decides what is reported.
  }
}

const failureReason = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : "OpenCode request failed";
