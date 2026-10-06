import {
  createOpencodeClient,
  type ModelRef,
  type OpencodeClient,
  type V2Event,
  type PermissionV2Reply,
  type SessionInputAdmitted,
  type SessionMessagesResponse,
  type SessionV2Info,
  type V2SessionEventsResponse,
} from "@opencode-ai/sdk/v2";

export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_POLL_INTERVAL_MS = 250;

export interface AdapterDiagnostic {
  readonly operation: string;
  readonly status?: number;
  readonly errorTag?: string;
  readonly message: string;
  readonly timedOut?: boolean;
}

export class OpenCodeAdapterError extends Error {
  readonly diagnostic: AdapterDiagnostic;

  constructor(diagnostic: AdapterDiagnostic, options?: ErrorOptions) {
    super(`${diagnostic.operation}: ${diagnostic.message}`, options);
    this.name = "OpenCodeAdapterError";
    this.diagnostic = diagnostic;
  }
}

export interface OpenCodeAdapterOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly idlePollIntervalMs?: number;
  readonly client?: OpencodeClient;
}

export interface WaitUntilIdleOptions {
  /**
   * When set, idle also requires an assistant message after this admitted input, so a
   * session whose run has not yet been scheduled is never mistaken for a completed one.
   * Omit it only when execution is already known to have started, for example after an
   * interrupted tool's terminal event has been observed.
   */
  readonly afterInputID?: string;
}

export interface CreateSessionOptions {
  readonly directory: string;
  readonly agent?: string;
  readonly model?: ModelRef;
}

export interface CreatePermissionOptions {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly agent?: string;
}

type ApiResult<T> = {
  readonly data: T | undefined;
  readonly error: unknown | undefined;
  readonly response: Response;
};

const errorTag = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const value = Reflect.get(error, "_tag") ?? Reflect.get(error, "name");
  return typeof value === "string" ? value : undefined;
};

type AssistantMessage = Extract<SessionMessagesResponse["data"][number], { type: "assistant" }>;

/**
 * Assistant messages in the admitted input's turn: after that user input in the ascending
 * list and before any later user input. OpenCode 1.18.33 appends one per model step.
 */
const assistantMessagesInTurn = (
  messages: SessionMessagesResponse,
  admittedInputID: string,
): AssistantMessage[] => {
  const inputIndex = messages.data.findIndex(
    (message) => message.type === "user" && message.id === admittedInputID,
  );
  if (inputIndex < 0) return [];
  const turn: AssistantMessage[] = [];
  for (const message of messages.data.slice(inputIndex + 1)) {
    if (message.type === "user") break;
    if (message.type === "assistant") turn.push(message);
  }
  return turn;
};

export const hasAssistantResponseAfter = (
  messages: SessionMessagesResponse,
  admittedInputID: string,
): boolean => assistantMessagesInTurn(messages, admittedInputID).length > 0;

/**
 * The turn's final result: the text of its last assistant message, which must have completed
 * without error. Earlier step messages (for example tool calls) are intermediate and never the result.
 */
export const finalAssistantResponseText = (
  messages: SessionMessagesResponse,
  admittedInputID: string,
): string | undefined => {
  const final = assistantMessagesInTurn(messages, admittedInputID).at(-1);
  if (final?.time.completed === undefined || final.finish === "error" || final.error !== undefined) {
    return undefined;
  }
  return final.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
};

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return message;
  }
  return "OpenCode request failed";
};

export class OpenCodeAdapter {
  readonly #client: OpencodeClient;
  readonly #timeoutMs: number;
  readonly #idlePollIntervalMs: number;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#client =
      options.client ?? createOpencodeClient(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl });
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive finite number");
    }
    this.#idlePollIntervalMs = options.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS;
    if (!Number.isFinite(this.#idlePollIntervalMs) || this.#idlePollIntervalMs <= 0) {
      throw new RangeError("idlePollIntervalMs must be a positive finite number");
    }
  }

  async createSession(options: CreateSessionOptions): Promise<SessionV2Info> {
    const result = await this.#request("create session", (signal) =>
      this.#client.v2.session.create(
        {
          agent: options.agent ?? "build",
          location: { directory: options.directory },
          ...(options.model === undefined ? {} : { model: options.model }),
        },
        { signal },
      ),
    );
    return this.#requiredData<{ data: SessionV2Info }>(result).data;
  }

  async prompt(sessionID: string, text: string): Promise<SessionInputAdmitted> {
    const result = await this.#request("submit prompt", (signal) =>
      this.#client.v2.session.prompt({ sessionID, prompt: { text } }, { signal }),
    );
    return this.#requiredData<{ data: SessionInputAdmitted }>(result).data;
  }

  async events(
    sessionID: string,
    after?: string,
  ): Promise<AsyncGenerator<V2SessionEventsResponse, void, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const result = await this.#client.v2.session.events(
        after === undefined ? { sessionID } : { sessionID, after },
        { signal: controller.signal, sseMaxRetryAttempts: 0 },
      );
      const stream = result.stream;
      return (async function* timedStream() {
        try {
          yield* stream;
        } finally {
          clearTimeout(timeout);
          controller.abort();
        }
      })();
    } catch (cause) {
      clearTimeout(timeout);
      throw this.#toError("subscribe to events", cause);
    }
  }

  /**
   * Subscribes to the global event stream. `timeoutMs` bounds the subscription (default: the
   * adapter timeout); aborting `signal` ends it early, even while a read is pending.
   */
  async globalEvents(
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<AsyncGenerator<V2Event, void, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.#timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
      const result = await this.#client.v2.event.subscribe({
        signal: controller.signal,
        sseMaxRetryAttempts: 0,
      });
      const stream = result.stream;
      return (async function* timedStream() {
        try {
          yield* stream;
        } finally {
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", abort);
          controller.abort();
        }
      })();
    } catch (cause) {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      throw this.#toError("subscribe to global events", cause);
    }
  }

  async createPermission(options: CreatePermissionOptions): Promise<{ id: string; effect: string }> {
    const result = await this.#request("create permission request", (signal) =>
      this.#client.v2.session.permission.create(
        {
          sessionID: options.sessionID,
          action: options.action,
          resources: [...options.resources],
          save: [],
          ...(options.agent === undefined ? {} : { agent: options.agent }),
        },
        { signal },
      ),
    );
    return this.#requiredData<{ data: { id: string; effect: string } }>(result).data;
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    reply: PermissionV2Reply,
  ): Promise<void> {
    await this.#request("reply to permission request", (signal) =>
      this.#client.v2.session.permission.reply({ sessionID, requestID, reply }, { signal }),
    );
  }

  /** Rejects a pending interactive question so an unattended session cannot block on it. */
  async rejectQuestion(sessionID: string, requestID: string): Promise<void> {
    await this.#request("reject question request", (signal) =>
      this.#client.v2.session.question.reject({ sessionID, requestID }, { signal }),
    );
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.#request("interrupt session", (signal) =>
      this.#client.v2.session.interrupt({ sessionID }, { signal }),
    );
  }

  async isActive(sessionID: string, timeoutMs = this.#timeoutMs): Promise<boolean> {
    const result = await this.#request(
      "list active sessions",
      (signal) => this.#client.v2.session.active({ signal }),
      timeoutMs,
    );
    return Object.hasOwn(this.#requiredData<{ data: Record<string, unknown> }>(result).data, sessionID);
  }

  /**
   * OpenCode 1.18.33 stubs Core V2 `session.wait` as an unconditional 503, so idle is
   * observed by polling the supported active-session route within this adapter's deadline.
   */
  async waitUntilIdle(sessionID: string, options: WaitUntilIdleOptions = {}): Promise<void> {
    const deadline = Date.now() + this.#timeoutMs;
    const timedOut = (cause?: unknown) => new OpenCodeAdapterError(
      { operation: "wait for session", message: `timed out after ${this.#timeoutMs}ms`, timedOut: true },
      cause === undefined ? undefined : { cause },
    );
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      try {
        if (!(await this.isActive(sessionID, remainingMs))) {
          if (options.afterInputID === undefined) return;
          const messages = await this.messages(sessionID, Math.max(1, deadline - Date.now()));
          if (hasAssistantResponseAfter(messages, options.afterInputID)) return;
        }
      } catch (error) {
        // Each poll is bounded by the remaining wait, so a poll timeout is the wait's own deadline.
        if (error instanceof OpenCodeAdapterError && error.diagnostic.timedOut === true) {
          throw timedOut(error);
        }
        throw error;
      }
      const delayMs = Math.min(this.#idlePollIntervalMs, deadline - Date.now());
      if (delayMs <= 0) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    throw timedOut();
  }

  async messages(sessionID: string, timeoutMs = this.#timeoutMs): Promise<SessionMessagesResponse> {
    const result = await this.#request(
      "list session messages",
      (signal) => this.#client.v2.session.messages({ sessionID, order: "asc" }, { signal }),
      timeoutMs,
    );
    return this.#requiredData<SessionMessagesResponse>(result);
  }

  async deleteSession(sessionID: string): Promise<void> {
    const deletion = await this.#request("delete session", (signal) =>
      this.#client.session.delete({ sessionID }, { signal }),
    );
    if (deletion.data !== true) {
      throw new OpenCodeAdapterError({
        operation: "delete session",
        status: deletion.response.status,
        message: "legacy compatibility endpoint did not accept deletion",
      });
    }

    const lookup = await this.#requestAllowingError("verify session deletion", (signal) =>
      this.#client.v2.session.get({ sessionID }, { signal }),
    );
    const lookupErrorTag = errorTag(lookup.error);
    if (lookup.response.status !== 404 || lookupErrorTag !== "SessionNotFoundError") {
      throw new OpenCodeAdapterError({
        operation: "verify session deletion",
        status: lookup.response.status,
        ...(lookupErrorTag === undefined ? {} : { errorTag: lookupErrorTag }),
        message: "Core V2 lookup did not confirm deletion",
      });
    }
  }

  async #request<T extends ApiResult<unknown>>(
    operation: string,
    request: (signal: AbortSignal) => Promise<T>,
    timeoutMs = this.#timeoutMs,
  ): Promise<T> {
    const result = await this.#requestAllowingError(operation, request, timeoutMs);
    if (!result.response.ok || result.error !== undefined) {
      throw this.#toError(operation, result.error, result.response.status, timeoutMs);
    }
    return result;
  }

  async #requestAllowingError<T extends ApiResult<unknown>>(
    operation: string,
    request: (signal: AbortSignal) => Promise<T>,
    timeoutMs = this.#timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await request(controller.signal);
    } catch (cause) {
      throw this.#toError(operation, cause, undefined, timeoutMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  #requiredData<T>(result: ApiResult<T>): T {
    if (result.data === undefined) {
      throw new OpenCodeAdapterError({
        operation: "decode OpenCode response",
        status: result.response.status,
        message: "successful response did not contain expected data",
      });
    }
    return result.data;
  }

  #toError(
    operation: string,
    cause: unknown,
    status?: number,
    timeoutMs = this.#timeoutMs,
  ): OpenCodeAdapterError {
    const timedOut = cause instanceof Error && cause.name === "AbortError";
    const causeErrorTag = errorTag(cause);
    return new OpenCodeAdapterError(
      {
        operation,
        ...(status === undefined ? {} : { status }),
        ...(causeErrorTag === undefined ? {} : { errorTag: causeErrorTag }),
        message: timedOut ? `timed out after ${timeoutMs}ms` : safeErrorMessage(cause),
        ...(timedOut ? { timedOut: true } : {}),
      },
      { cause },
    );
  }
}
