import { isAbsolute, relative, resolve } from "node:path";

export const CAPABILITY_NAMES = [
  "Fresh session creation",
  "Project directory",
  "Local model invocation",
  "Streaming events",
  "Permission handling",
  "File modification",
  "Cancellation",
  "Session deletion",
  "Session isolation",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export type CapabilityStatus = "PASS" | "FAIL";

export interface CapabilityResult {
  readonly capability: CapabilityName;
  readonly status: CapabilityStatus;
  readonly evidence: readonly string[];
}

export interface ProbeEvent {
  readonly sequence: number;
  readonly type: string;
  readonly sessionID: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

export interface EventClassification {
  readonly structuredExecution: boolean;
  readonly permissionRequest: boolean;
  readonly fixtureStarted: boolean;
  readonly terminalIdle: boolean;
  readonly normalCompletion: boolean;
}

export interface CancellationEvidence {
  readonly fixtureStartedAtSequence: number;
  readonly interruptRequestedAtSequence: number;
  readonly terminalIdleAtSequence: number;
  readonly fixtureTerminated: boolean;
  readonly events: readonly ProbeEvent[];
}

export interface FinalResponseEvidence {
  readonly admittedInputID: string;
  readonly responseInputID: string;
  readonly assistantText: string;
}

export interface SessionCleanup {
  deleteSession(sessionID: string): Promise<void>;
}

export type IsolationClassification =
  | { readonly status: "PASS"; readonly reason: "no-prior-session" }
  | { readonly status: "FAIL"; readonly reason: "nonce-leaked" | "unexpected-response" };

export function classifyEvent(event: ProbeEvent): EventClassification {
  return {
    structuredExecution: event.type === "tool.started",
    permissionRequest: event.type === "permission.v2.asked",
    fixtureStarted: event.type === "fixture.started",
    terminalIdle: event.type === "session.idle",
    normalCompletion: event.type === "fixture.completed",
  };
}

export function hasFreshSessionIDs(sessionIDs: readonly string[]): boolean {
  return (
    sessionIDs.length >= 2 &&
    sessionIDs.every((sessionID) => sessionID.trim().length > 0) &&
    new Set(sessionIDs).size === sessionIDs.length
  );
}

export function hasFinalModelResponse(evidence: FinalResponseEvidence): boolean {
  return (
    evidence.admittedInputID.length > 0 &&
    evidence.admittedInputID === evidence.responseInputID &&
    evidence.assistantText.trim().length > 0
  );
}

export function hasExactHelloContent(content: string): boolean {
  return content === "Hello from OpenCode" || content === "Hello from OpenCode\n";
}

export function isPathConfined(repositoryRoot: string, candidatePath: string): boolean {
  const root = resolve(repositoryRoot);
  const candidate = resolve(candidatePath);
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export function classifyIsolation(
  expectedNonce: string,
  response: string,
): IsolationClassification {
  if (response.includes(expectedNonce)) {
    return { status: "FAIL", reason: "nonce-leaked" };
  }
  return response === "NO_PRIOR_SESSION"
    ? { status: "PASS", reason: "no-prior-session" }
    : { status: "FAIL", reason: "unexpected-response" };
}

export function hasRealPermissionRequest(events: readonly ProbeEvent[]): boolean {
  return events.some(
    (event) =>
      classifyEvent(event).permissionRequest &&
      typeof event.properties?.id === "string" &&
      event.properties.id.length > 0,
  );
}

export function cancellationPassed(evidence: CancellationEvidence): boolean {
  const ordered =
    evidence.fixtureStartedAtSequence > 0 &&
    evidence.fixtureStartedAtSequence < evidence.interruptRequestedAtSequence &&
    evidence.interruptRequestedAtSequence < evidence.terminalIdleAtSequence;
  const lateCompletion = evidence.events.some(
    (event) =>
      event.sequence > evidence.interruptRequestedAtSequence &&
      classifyEvent(event).normalCompletion,
  );
  return ordered && evidence.fixtureTerminated && !lateCompletion;
}

export function sessionDeletionPassed(
  deleteAccepted: boolean,
  postDeleteLookupStatus: number,
): boolean {
  return deleteAccepted && postDeleteLookupStatus === 404;
}

export async function withSessionCleanup<T>(
  cleanup: SessionCleanup,
  sessionIDs: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const sessionID of [...sessionIDs].reverse()) {
      try {
        await cleanup.deleteSession(sessionID);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0 && operationError === undefined) {
      throw new AggregateError(cleanupErrors, "Session cleanup failed");
    }
  }
}
