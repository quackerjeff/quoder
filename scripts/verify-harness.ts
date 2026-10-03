/**
 * Milestone 1 live acceptance check. Runs the built `quoder` CLI as a subprocess from a disposable
 * project directory, submits two prompts through stdin in one harness process, and verifies the
 * exit criterion from the harness trace: one OpenCode server, a fresh session per prompt, every
 * session deleted (verified 404), a clean exit, and no residual server. The OpenCode server is a
 * direct child of the CLI process; this script tracks exactly those children by parent PID and
 * terminates any still running at the end, so a failed or timed-out run never leaves one behind.
 *
 * Requires explicit authorization: it contacts the configured model. Output is credential-safe:
 * only fixed row names, counts, and outcome kinds are printed, never model text.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { packagePath } from "../src/package-root.js";

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT_MS = 300_000;
const SERVER_COMMAND = "opencode serve --pure --hostname=127.0.0.1 --port=0";
const TRACK_INTERVAL_MS = 500;
const PROMPTS = [
  "Reply with exactly QUODER_ONE and nothing else. Do not use any tools and do not ask any questions.",
  "Reply with exactly QUODER_TWO and nothing else. Do not use any tools and do not ask any questions.",
];

interface TraceEntry {
  readonly event: string;
  readonly sessionID?: string;
  readonly verified?: boolean;
  readonly outcome?: string;
}

/** PIDs of OpenCode servers whose parent is `parentPID`. */
const serverChildren = async (parentPID: number): Promise<number[]> => {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="]);
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null || Number(match[2]) !== parentPID || !match[3]?.includes(SERVER_COMMAND)) return [];
    return [Number(match[1])];
  });
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** True only while `pid` is still an OpenCode server process (guards against PID reuse). */
const isTrackedServer = async (pid: number): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.includes(SERVER_COMMAND);
  } catch {
    return false;
  }
};

/** Terminates tracked servers that are still running; returns how many had to be stopped. */
const stopResidualServers = async (pids: Iterable<number>): Promise<number> => {
  const residual: number[] = [];
  for (const pid of pids) if (isAlive(pid) && (await isTrackedServer(pid))) residual.push(pid);
  for (const pid of residual) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (residual.some(isAlive) && Date.now() < deadline) {
    await new Promise((resolvePause) => setTimeout(resolvePause, 100));
  }
  for (const pid of residual.filter(isAlive)) if (await isTrackedServer(pid)) process.kill(pid, "SIGKILL");
  return residual.length;
};

const row = (name: string, pass: boolean, evidence: string): boolean => {
  process.stdout.write(`${name}: ${pass ? "PASS" : "FAIL"} - ${evidence}\n`);
  return pass;
};

async function main(): Promise<number> {
  const project = await mkdtemp(join(tmpdir(), "quoder-harness-acceptance-"));
  const tracePath = join(project, "quoder-trace.jsonl");
  const trackedServers = new Set<number>();
  try {
    const child = spawn(process.execPath, [packagePath("dist", "cli.js")], {
      cwd: project,
      env: { ...process.env, QUODER_TRACE_FILE: tracePath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    const tracker = setInterval(() => {
      if (child.pid === undefined) return;
      void serverChildren(child.pid).then(
        (pids) => pids.forEach((pid) => trackedServers.add(pid)),
        () => undefined,
      );
    }, TRACK_INTERVAL_MS);
    child.stdin.on("error", () => undefined);
    child.stdin.end(PROMPTS.map((prompt) => `${prompt}\n`).join(""));
    const exitCode = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }, RUN_TIMEOUT_MS);
      child.once("error", () => {
        clearTimeout(timer);
        resolveExit(null);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
    clearInterval(tracker);
    const residual = await stopResidualServers(trackedServers);
    const trace: TraceEntry[] = (await readFile(tracePath, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as TraceEntry);
    const count = (event: string) => trace.filter((entry) => entry.event === event).length;
    const created = trace.flatMap((entry) => (entry.event === "session.created" && entry.sessionID ? [entry.sessionID] : []));
    const deleted = trace.flatMap((entry) => (entry.event === "session.deleted" && entry.verified === true && entry.sessionID ? [entry.sessionID] : []));
    const outcomes = trace.flatMap((entry) => (entry.event === "prompt.completed" && entry.outcome ? [entry.outcome] : []));

    const results = [
      row("Harness launch and exit", exitCode === 0, `exit code ${String(exitCode)}`),
      row("Single OpenCode server", count("server.started") === 1 && count("server.lost") === 0, `${count("server.started")} started, ${count("server.lost")} lost`),
      row("Fresh session per prompt", created.length === PROMPTS.length && new Set(created).size === created.length, `${created.length} sessions, ${new Set(created).size} distinct`),
      row("Prompts completed", outcomes.length === PROMPTS.length && outcomes.every((outcome) => outcome === "answered"), `outcomes: ${outcomes.join(", ") || "none"}`),
      row("Session deletion", created.length > 0 && created.every((id) => deleted.includes(id)), `${deleted.length} of ${created.length} verified deleted`),
      row("Server cleanup", count("server.stopped") === 1 && residual === 0, `stopped ${count("server.stopped")}, ${trackedServers.size} tracked, ${residual} left running`),
    ];
    // Informational only: exact replies depend on the model, not on the harness.
    const exact = ["QUODER_ONE", "QUODER_TWO"].filter((sentinel) => stdout.includes(sentinel)).length;
    process.stdout.write(`Model replies (informational): ${exact} of ${PROMPTS.length} exact\n`);
    const met = results.every(Boolean);
    process.stdout.write(`Milestone 1 Exit Criterion: ${met ? "MET" : "NOT MET"}\n`);
    return met ? 0 : 1;
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stdout.write("Milestone 1 Exit Criterion: NOT MET\n");
    process.exitCode = 1;
  },
);
