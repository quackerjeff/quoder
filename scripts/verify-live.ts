import { runLiveProbe } from "../src/live-probe.js";

const outcome = await runLiveProbe();
process.stdout.write(`${outcome.output}\n`);
process.exitCode = outcome.exitCode;
