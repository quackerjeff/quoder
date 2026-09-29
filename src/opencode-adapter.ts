import {
  createOpencodeClient,
  type ModelRef,
  type OpencodeClient,
  type PermissionV2Reply,
  type SessionInputAdmitted,
  type SessionMessagesResponse,
  type SessionV2Info,
  type V2SessionEventsResponse,
} from "@opencode-ai/sdk/v2";

export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

export interface AdapterDiagnostic {
  readonly operation: string;
  readonly status?: number;
  readonly errorTag?: string;
  readonly message: string;
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
  readonly client?: OpencodeClient;
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

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#client =
      options.client ?? createOpencodeClient(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl });
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive finite number");
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
    reply: PermissionV2Reply = "once",
  ): Promise<void> {
    await this.#request("reply to permission request", (signal) =>
      this.#client.v2.session.permission.reply({ sessionID, requestID, reply }, { signal }),
    );
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.#request("interrupt session", (signal) =>
      this.#client.v2.session.interrupt({ sessionID }, { signal }),
    );
  }

  async waitUntilIdle(sessionID: string): Promise<void> {
    await this.#request("wait for session", (signal) =>
      this.#client.v2.session.wait({ sessionID }, { signal }),
    );
  }

  async messages(sessionID: string): Promise<SessionMessagesResponse> {
    const result = await this.#request("list session messages", (signal) =>
      this.#client.v2.session.messages({ sessionID }, { signal }),
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
  ): Promise<T> {
    const result = await this.#requestAllowingError(operation, request);
    if (!result.response.ok || result.error !== undefined) {
      throw this.#toError(operation, result.error, result.response.status);
    }
    return result;
  }

  async #requestAllowingError<T extends ApiResult<unknown>>(
    operation: string,
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await request(controller.signal);
    } catch (cause) {
      throw this.#toError(operation, cause);
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

  #toError(operation: string, cause: unknown, status?: number): OpenCodeAdapterError {
    const timedOut = cause instanceof Error && cause.name === "AbortError";
    const causeErrorTag = errorTag(cause);
    return new OpenCodeAdapterError(
      {
        operation,
        ...(status === undefined ? {} : { status }),
        ...(causeErrorTag === undefined ? {} : { errorTag: causeErrorTag }),
        message: timedOut ? `timed out after ${this.#timeoutMs}ms` : safeErrorMessage(cause),
      },
      { cause },
    );
  }
}
