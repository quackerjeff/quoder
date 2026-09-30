import { runLiveProbe } from "../src/live-probe.js";
import {
  DEFAULT_LIVE_JOURNAL_PATH,
  createLiveRunJournal,
  liveRunTimeoutFromEnvironment,
} from "../src/live-observability.js";

const journal = createLiveRunJournal(
  process.env.QUODER_LIVE_JOURNAL_PATH ?? DEFAULT_LIVE_JOURNAL_PATH,
);
try {
  const outcome = await runLiveProbe(undefined, {
    timeoutMs: liveRunTimeoutFromEnvironment(process.env.QUODER_LIVE_TIMEOUT_MS),
    onProgress: journal.progress,
  });
  process.stdout.write(`${outcome.output}\n`);
  process.exitCode = outcome.exitCode;
  journal.finish(outcome.exitCode);
} catch (error) {
  journal.progress("process.error");
  journal.finish(1);
  throw error;
}
