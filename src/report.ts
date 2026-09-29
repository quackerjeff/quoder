import {
  CAPABILITY_NAMES,
  type CapabilityName,
  type CapabilityResult,
  type CapabilityStatus,
} from "./capabilities.js";

export interface CapabilityReport {
  readonly results: readonly CapabilityResult[];
  readonly verdict: CapabilityStatus;
}

const group3NotImplemented = (contract: string): never => {
  throw new Error(`Group 3 implementation absent: ${contract}`);
};

export function buildCapabilityReport(
  _results: ReadonlyMap<CapabilityName, CapabilityResult>,
): CapabilityReport {
  return group3NotImplemented("buildCapabilityReport");
}

export function renderCapabilityReport(_report: CapabilityReport): string {
  return group3NotImplemented("renderCapabilityReport");
}

// This reference makes the required ordered matrix part of the runtime contract.
export const REQUIRED_CAPABILITIES = CAPABILITY_NAMES;
