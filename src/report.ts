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

export function buildCapabilityReport(
  results: ReadonlyMap<CapabilityName, CapabilityResult>,
): CapabilityReport {
  const orderedResults = CAPABILITY_NAMES.map((capability) => {
    const result = results.get(capability);
    if (result === undefined) {
      throw new Error(`Missing required capability result: ${capability}`);
    }
    if (result.capability !== capability) {
      throw new Error(`Capability result key does not match result: ${capability}`);
    }
    return result;
  });
  return {
    results: orderedResults,
    verdict: orderedResults.every(({ status }) => status === "PASS") ? "PASS" : "FAIL",
  };
}

export function renderCapabilityReport(report: CapabilityReport): string {
  return [
    ...report.results.map(({ capability, status }) => `${capability}: ${status}`),
    `Capability Verdict: ${report.verdict}`,
  ].join("\n");
}

// This reference makes the required ordered matrix part of the runtime contract.
export const REQUIRED_CAPABILITIES = CAPABILITY_NAMES;
