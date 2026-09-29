import { describe, expect, it, vi } from "vitest";

import { CAPABILITY_NAMES } from "../../src/capabilities.js";
import {
  LIVE_PROBE_TIMEOUT_MS,
  runLiveProbe,
  type LiveProbeDependencies,
  type LiveProbeDriver,
  type LiveProbeEvidence,
  type LiveProbeEnvironment,
} from "../../src/live-probe.js";

const environment: LiveProbeEnvironment = {
  root: "/tmp/quoder-live-probe-test",
  repository: "/tmp/quoder-live-probe-test/repository",
  outside: "/tmp/quoder-live-probe-test/permission-target",
};

const passingEvidence: LiveProbeEvidence = {
  sessionIDs: ["session-1", "session-2"],
  projectPaths: [environment.repository, `${environment.repository}/hello.txt`],
  finalResponse: "TOKEN_STORED",
  structuredEventObserved: true,
  permissionRequestID: "permission-1",
  helloContent: "Hello from OpenCode\n",
  cancellationPassed: true,
  deletedSessionIDs: ["session-2", "session-1"],
  isolationResponse: "NO_PRIOR_SESSION",
  nonce: "private-nonce",
};

const dependenciesWith = (
  driver: LiveProbeDriver,
): LiveProbeDependencies => ({
  createEnvironment: vi.fn().mockResolvedValue(environment),
  createDriver: vi.fn().mockResolvedValue(driver),
  removeEnvironment: vi.fn().mockResolvedValue(undefined),
});

describe("live probe smoke behavior", () => {
  it("prints the nine-row report once and exits zero only for a complete pass", async () => {
    const dependencies = dependenciesWith({
      run: vi.fn().mockResolvedValue(passingEvidence),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(0);
    for (const capability of CAPABILITY_NAMES) {
      expect(outcome.output.match(new RegExp(`^${capability}: PASS$`, "gm"))).toHaveLength(1);
    }
    expect(outcome.output.match(/^Capability Verdict: PASS$/gm)).toHaveLength(1);
  });

  it("reports every capability as failed and exits nonzero when the runtime is unavailable", async () => {
    const removeEnvironment = vi.fn().mockResolvedValue(undefined);
    const dependencies: LiveProbeDependencies = {
      createEnvironment: vi.fn().mockResolvedValue(environment),
      createDriver: vi.fn().mockRejectedValue(new Error("runtime unavailable")),
      removeEnvironment,
    };

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.results).toHaveLength(9);
    expect(outcome.report.results.every(({ status }) => status === "FAIL")).toBe(true);
    expect(removeEnvironment).toHaveBeenCalledWith(environment);
  });

  it("closes the runtime and removes the disposable repository after a probe error", async () => {
    const driver: LiveProbeDriver = {
      run: vi.fn().mockRejectedValue(new Error("probe timed out")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const dependencies = dependenciesWith(driver);

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(driver.close).toHaveBeenCalledOnce();
    expect(dependencies.removeEnvironment).toHaveBeenCalledWith(environment);
  });

  it("forces a failed report when runtime cleanup fails after successful evidence", async () => {
    const dependencies = dependenciesWith({
      run: vi.fn().mockResolvedValue(passingEvidence),
      close: vi.fn().mockRejectedValue(new Error("server remained active")),
    });

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.verdict).toBe("FAIL");
    expect(outcome.report.results.every(({ status }) => status === "FAIL")).toBe(true);
    expect(outcome.report.results[0]?.evidence).toContain(
      "driver cleanup failed: server remained active",
    );
  });

  it("forces a failed report when temporary-environment cleanup fails", async () => {
    const dependencies = dependenciesWith({
      run: vi.fn().mockResolvedValue(passingEvidence),
      close: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(dependencies.removeEnvironment).mockRejectedValue(
      new Error("temporary repository remained"),
    );

    const outcome = await runLiveProbe(dependencies);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.verdict).toBe("FAIL");
    expect(outcome.report.results.every(({ status }) => status === "FAIL")).toBe(true);
    expect(outcome.report.results[0]?.evidence).toContain(
      "environment cleanup failed: temporary repository remained",
    );
  });

  it("uses a finite live-operation timeout", () => {
    expect(LIVE_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(LIVE_PROBE_TIMEOUT_MS)).toBe(true);
  });
});
