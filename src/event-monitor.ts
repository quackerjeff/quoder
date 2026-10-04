import type { V2Event } from "@opencode-ai/sdk/v2";

import type { OpenCodeAdapter } from "./opencode-adapter.js";

export const EVENT_MONITOR_CONNECT_TIMEOUT_MS = 10_000;

export type PermissionObservation = "observed" | "timeout" | "monitor-ended";

/** A `question.v2.asked` raised by one of the caller's sessions. Its content is model-controlled. */
export interface QuestionAsked {
  readonly sessionID: string;
  readonly requestID: string;
  readonly questions: unknown;
}

/** A `permission.v2.asked` raised by one of the caller's sessions. */
export interface PermissionAsked {
  readonly sessionID: string;
  readonly requestID: string;
  readonly action: string | undefined;
  readonly resourceCount: number;
}

export interface EventMonitorOptions {
  readonly adapter: OpenCodeAdapter;
  /** Only events for sessions this returns true for are acted on or recorded. */
  readonly isOwnSession: (sessionID: string) => boolean;
  /** Bounds the global subscription; it ends earlier when the monitor is stopped. */
  readonly subscriptionTimeoutMs: number;
  readonly connectTimeoutMs?: number;
  /** Receives fixed, credential-safe journal markers only. */
  readonly onProgress?: (marker: string) => void;
  /** Called synchronously when a question arrives, before it is rejected. */
  readonly onQuestionAsked?: (question: QuestionAsked) => void;
  /** Called after a question has been rejected (`rejected`) or the rejection failed. */
  readonly onQuestionRejected?: (question: QuestionAsked, rejected: boolean) => void;
  /** Called when the subscription ends for any reason other than `stop()`. */
  readonly onEnded?: () => void;
  /** Called synchronously with each `session.next.*` event (raw) of an own session, for display. */
  readonly onSessionEvent?: (event: { readonly type: string; readonly data: unknown }) => void;
  /** Called after a permission request has been recorded; the caller decides how to reply. */
  readonly onPermissionAsked?: (permission: PermissionAsked) => void;
}

export interface EventMonitor {
  /** Whether the server confirmed the subscription (`server.connected`) before it returned. */
  readonly confirmed: boolean;
  /** Settles once this session's `permission.v2.asked` for `requestID` is observed, or not. */
  waitForPermissionAsked(sessionID: string, requestID: string, timeoutMs: number): Promise<PermissionObservation>;
  stop(): Promise<void>;
}

const eventSessionID = (event: V2Event): string | undefined => {
  const value = Reflect.get(event.data, "sessionID");
  return typeof value === "string" ? value : undefined;
};

/**
 * One global subscription, opened before any session exists and connected for the caller's whole
 * run, observes the caller's own sessions:
 * - The 1.18.33 `build` agent allows the interactive `question` tool, which blocks until answered
 *   and is not a permission request. Unattended sessions reject every question they raise
 *   (verified live on 2026-10-03); this is not a permission decision.
 * - `permission.v2.asked` is not durable and a late subscriber misses it (observed in the
 *   2026-10-03 authoritative run), so asked permissions are recorded here, before any request
 *   exists, and callers wait on the record.
 */
export async function startEventMonitor(options: EventMonitorOptions): Promise<EventMonitor> {
  const onProgress = options.onProgress ?? (() => undefined);
  const controller = new AbortController();
  const stream = await options.adapter.globalEvents({
    timeoutMs: options.subscriptionTimeoutMs,
    signal: controller.signal,
  });
  const askedPermissions = new Set<string>();
  const waiters = new Set<() => void>();
  const pendingRejections = new Set<Promise<void>>();
  let ended = false;
  let confirmConnected: () => void = () => undefined;
  const connected = new Promise<void>((resolveConnected) => {
    confirmConnected = resolveConnected;
  });
  const permissionKey = (sessionID: string, requestID: string): string => `${sessionID}\u0000${requestID}`;
  const monitor = (async () => {
    for await (const event of stream) {
      // The 1.18.33 server sends `server.connected` first, once the subscription is registered.
      if (event.type === "server.connected") {
        confirmConnected();
        continue;
      }
      if (event.type.startsWith("session.next.") && options.onSessionEvent !== undefined) {
        const sessionID = eventSessionID(event);
        if (sessionID !== undefined && options.isOwnSession(sessionID)) {
          try {
            options.onSessionEvent({ type: event.type, data: event.data });
          } catch {
            // A display callback must never end the monitor.
          }
        }
        continue;
      }
      if (event.type !== "question.v2.asked" && event.type !== "permission.v2.asked") continue;
      const sessionID = eventSessionID(event);
      const requestID = Reflect.get(event.data, "id");
      if (sessionID === undefined || typeof requestID !== "string") continue;
      if (!options.isOwnSession(sessionID)) continue;
      if (event.type === "permission.v2.asked") {
        askedPermissions.add(permissionKey(sessionID, requestID));
        for (const wake of waiters) wake();
        const action = Reflect.get(event.data, "action");
        const resources = Reflect.get(event.data, "resources");
        try {
          options.onPermissionAsked?.({
            sessionID,
            requestID,
            action: typeof action === "string" ? action : undefined,
            resourceCount: Array.isArray(resources) ? resources.length : 0,
          });
        } catch {
          // A reporting callback must never end the monitor.
        }
        continue;
      }
      // Rejections run concurrently so a slow one cannot delay recording a permission event.
      onProgress("question.rejected");
      const question: QuestionAsked = { sessionID, requestID, questions: Reflect.get(event.data, "questions") };
      try {
        options.onQuestionAsked?.(question);
      } catch {
        // A reporting callback must never stop the monitor from rejecting the question.
      }
      const rejection = options.adapter.rejectQuestion(sessionID, requestID).then(
        () => options.onQuestionRejected?.(question, true),
        () => {
          onProgress("question.reject.failed");
          options.onQuestionRejected?.(question, false);
        },
      );
      pendingRejections.add(rejection);
      void rejection.finally(() => pendingRejections.delete(rejection)).catch(() => undefined);
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      ended = true;
      confirmConnected();
      for (const wake of waiters) wake();
      // Without the monitor, later questions block and asked permissions go unobserved.
      if (!controller.signal.aborted) {
        onProgress("event.monitor.ended");
        try {
          options.onEnded?.();
        } catch {
          // Reporting only.
        }
      }
    });
  // The SDK connects lazily on the first read, which the loop above has already issued; waiting
  // for the server's confirmation makes the subscription provably live before any request exists.
  let connectTimer: NodeJS.Timeout | undefined;
  const confirmed = await Promise.race([
    connected.then(() => !ended),
    new Promise<boolean>((resolveTimeout) => {
      connectTimer = setTimeout(
        () => resolveTimeout(false),
        options.connectTimeoutMs ?? EVENT_MONITOR_CONNECT_TIMEOUT_MS,
      );
    }),
  ]);
  clearTimeout(connectTimer);
  if (!confirmed) onProgress("event.monitor.unconfirmed");
  return {
    confirmed,
    waitForPermissionAsked: (sessionID, requestID, timeoutMs) => {
      const key = permissionKey(sessionID, requestID);
      if (askedPermissions.has(key)) return Promise.resolve("observed");
      if (ended) return Promise.resolve("monitor-ended");
      return new Promise<PermissionObservation>((resolveObservation) => {
        const finish = (observation: PermissionObservation) => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolveObservation(observation);
        };
        const wake = () => {
          if (askedPermissions.has(key)) finish("observed");
          else if (ended) finish("monitor-ended");
        };
        const timer = setTimeout(() => finish("timeout"), timeoutMs);
        waiters.add(wake);
      });
    },
    stop: async () => {
      controller.abort();
      await monitor;
      await Promise.allSettled([...pendingRejections]);
    },
  };
}
