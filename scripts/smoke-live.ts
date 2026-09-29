import { runLiveProbe, type LiveProbeDependencies } from "../src/live-probe.js";

const dependencies: LiveProbeDependencies = {
  createEnvironment: async () => ({
    root: "/deliberately-unavailable/quoder-live-probe",
    repository: "/deliberately-unavailable/quoder-live-probe/repository",
    outside: "/deliberately-unavailable/quoder-live-probe/permission-target",
  }),
  createDriver: async () => {
    throw new Error("deliberately unavailable OpenCode runtime");
  },
  removeEnvironment: async () => undefined,
};

const outcome = await runLiveProbe(dependencies);
process.stdout.write(`${outcome.output}\n`);
if (outcome.exitCode !== 1 || outcome.report.results.some(({ status }) => status !== "FAIL")) {
  throw new Error("Unavailable-runtime smoke scenario did not fail conservatively");
}
