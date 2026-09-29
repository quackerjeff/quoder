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

const group3NotImplemented = (contract: string): never => {
  throw new Error(`Group 3 implementation absent: ${contract}`);
};

export function classifyEvent(_event: ProbeEvent): EventClassification {
  return group3NotImplemented("classifyEvent");
}

export function hasFreshSessionIDs(_sessionIDs: readonly string[]): boolean {
  return group3NotImplemented("hasFreshSessionIDs");
}

export function hasFinalModelResponse(_evidence: FinalResponseEvidence): boolean {
  return group3NotImplemented("hasFinalModelResponse");
}

export function hasExactHelloContent(_content: string): boolean {
  return group3NotImplemented("hasExactHelloContent");
}

export function isPathConfined(_repositoryRoot: string, _candidatePath: string): boolean {
  return group3NotImplemented("isPathConfined");
}

export function classifyIsolation(
  _expectedNonce: string,
  _response: string,
): IsolationClassification {
  return group3NotImplemented("classifyIsolation");
}

export function hasRealPermissionRequest(_events: readonly ProbeEvent[]): boolean {
  return group3NotImplemented("hasRealPermissionRequest");
}

export function cancellationPassed(_evidence: CancellationEvidence): boolean {
  return group3NotImplemented("cancellationPassed");
}

export function sessionDeletionPassed(
  _deleteAccepted: boolean,
  _postDeleteLookupStatus: number,
): boolean {
  return group3NotImplemented("sessionDeletionPassed");
}

export async function withSessionCleanup<T>(
  _cleanup: SessionCleanup,
  _sessionIDs: readonly string[],
  _operation: () => Promise<T>,
): Promise<T> {
  return group3NotImplemented("withSessionCleanup");
}
