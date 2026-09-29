import { describe, expect, it } from "vitest";

import {
  CAPABILITY_NAMES,
  type CapabilityName,
  type CapabilityResult,
} from "../../src/capabilities.js";
import { buildCapabilityReport, renderCapabilityReport } from "../../src/report.js";

const resultsWith = (
  override: Partial<Record<CapabilityName, "PASS" | "FAIL">> = {},
): ReadonlyMap<CapabilityName, CapabilityResult> =>
  new Map(
    CAPABILITY_NAMES.map((capability) => [
      capability,
      {
        capability,
        status: override[capability] ?? "PASS",
        evidence: [`evidence for ${capability}`],
      },
    ]),
  );

describe("capability report aggregation", () => {
  it("defines all nine required outcomes in specification order", () => {
    expect(CAPABILITY_NAMES).toEqual([
      "Fresh session creation",
      "Project directory",
      "Local model invocation",
      "Streaming events",
      "Permission handling",
      "File modification",
      "Cancellation",
      "Session deletion",
      "Session isolation",
    ]);
  });

  it("passes only when all nine capabilities pass", () => {
    expect(buildCapabilityReport(resultsWith())).toMatchObject({ verdict: "PASS" });
    expect(buildCapabilityReport(resultsWith({ Cancellation: "FAIL" }))).toMatchObject({
      verdict: "FAIL",
    });
  });

  it("rejects a matrix with a missing capability", () => {
    const incomplete = new Map(resultsWith());
    incomplete.delete("Session deletion");

    expect(() => buildCapabilityReport(incomplete)).toThrow(/Session deletion/);
  });

  it("renders every capability exactly once plus one overall verdict", () => {
    const output = renderCapabilityReport(buildCapabilityReport(resultsWith()));

    for (const capability of CAPABILITY_NAMES) {
      expect(output.match(new RegExp(`^${capability}: PASS$`, "gm"))).toHaveLength(1);
    }
    expect(output.match(/^Capability Verdict: PASS$/gm)).toHaveLength(1);
  });
});
