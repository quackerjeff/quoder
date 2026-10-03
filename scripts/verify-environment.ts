import { runEnvironmentPreflight } from "../src/environment-preflight.js";

const outcome = await runEnvironmentPreflight();
process.stdout.write(`${outcome.output}\n`);
process.exitCode = outcome.exitCode;
