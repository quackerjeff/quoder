import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { LIVE_PROBE_RUN_TIMEOUT_MS, type LiveProbeProgress } from "./live-probe.js";

export const DEFAULT_LIVE_JOURNAL_PATH = resolve(".live-build", "verify-live.journal.jsonl");

export function liveRunTimeoutFromEnvironment(value: string | undefined): number {
  if (value === undefined) return LIVE_PROBE_RUN_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("QUODER_LIVE_TIMEOUT_MS must be a positive finite number");
  }
  return timeoutMs;
}

export function createLiveRunJournal(
  path = DEFAULT_LIVE_JOURNAL_PATH,
  writeDiagnostic: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): { readonly path: string; readonly progress: LiveProbeProgress; finish(exitCode: number): void } {
  mkdirSync(dirname(path), { recursive: true });
  const record = (event: string): void => {
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), event });
    appendFileSync(path, `${entry}\n`, { encoding: "utf8", flush: true });
    writeDiagnostic(`[verify:live] ${entry}`);
  };
  writeFileSync(path, "", { encoding: "utf8", flush: true });
  record("process.start");
  return {
    path,
    progress: (stage) => record(`stage.${stage}`),
    finish: (exitCode) => record(`process.finish.exit-${exitCode}`),
  };
}
