/**
 * Live acceptance check for Milestones 1 and 2. Runs the built `quoder` CLI as a subprocess from a
 * disposable project directory (with a seeded file), submits four prompts through stdin in one
 * harness process, and verifies from the harness trace:
 * - Milestone 1: one OpenCode server, a fresh session per prompt, every session deleted (verified
 *   404), a clean exit, and no residual server;
 * - Milestone 2: text streamed before each answered prompt completed, tool activity shown while the
 *   model read the seeded file, and a SIGINT (Ctrl-C) during the third prompt cancelled it without
 *   ending the harness, so the fourth prompt still answered. The OpenCode server is a
 * direct child of the CLI process; this script tracks exactly those children by parent PID and
 * terminates any still running at the end, so a failed or timed-out run never leaves one behind.
 *
 * Requires explicit authorization: it contacts the configured model. Output is credential-safe:
 * only fixed row names, counts, and outcome kinds are printed, never model text.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { packagePath } from "../src/package-root.js";

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT_MS = 420_000;
/** Cancel the third prompt once it streams text, or after this long if it has not. */
const CANCEL_FALLBACK_MS = 15_000;
const SERVER_COMMAND = "opencode serve --pure --hostname=127.0.0.1 --port=0";
const TRACK_INTERVAL_MS = 500;
const SEED_FILE = "notes.txt";
const PROMPTS = [
  "Reply with exactly QUODER_ONE and nothing else. Do not use any tools and do not ask any questions.",
  `Use your read tool to read ${SEED_FILE} in this project, then reply with exactly the first word of that file and nothing else. Do not ask any questions.`,
  "Write a detailed essay of at least 2000 words about the history of mutual exclusion in computing. Do not use any tools and do not ask any questions.",
  "Reply with exactly QUODER_AFTER and nothing else. Do not use any tools and do not ask any questions.",
];
const EXPECTED_OUTCOMES = ["answered", "answered", "cancelled", "answered"];
const CANCELLED_PROMPT = 2;
const TOOL_PROMPT = 1;

interface TraceEntry {
  readonly event: string;
  readonly sessionID?: string;
  readonly verified?: boolean;
  readonly outcome?: string;
  readonly tool?: string;
}

const readTrace = async (path: string): Promise<TraceEntry[]> =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TraceEntry];
      } catch {
        return []; // A line still being appended.
      }
    });

/**
 * Per-prompt view of the trace: each `prompt.started` starts the next prompt. A prompt OpenCode
 * dropped is retried in a second session (`prompt.retried`), so a prompt may own two sessions.
 */
interface PromptTrace {
  sessionIDs: string[];
  retried: boolean;
  streamedBeforeCompletion: boolean;
  tools: string[];
  outcome?: string;
}

const perPrompt = (trace: readonly TraceEntry[]): PromptTrace[] => {
  const prompts: PromptTrace[] = [];
  for (const entry of trace) {
    if (entry.event === "prompt.started") {
      prompts.push({ sessionIDs: [], retried: false, streamedBeforeCompletion: false, tools: [] });
      continue;
    }
    const current = prompts.at(-1);
    if (current === undefined || current.outcome !== undefined) continue;
    if (entry.event === "session.created" && entry.sessionID !== undefined) current.sessionIDs.push(entry.sessionID);
    if (entry.event === "prompt.retried") current.retried = true;
    if (entry.event === "stream.first-text") current.streamedBeforeCompletion = true;
    if (entry.event === "activity.tool" && entry.tool !== undefined) current.tools.push(entry.tool);
    if (entry.event === "prompt.completed" && entry.outcome !== undefined) current.outcome = entry.outcome;
  }
  return prompts;
};

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
  const project = await realpath(await mkdtemp(join(tmpdir(), "quoder-harness-acceptance-")));
  await writeFile(join(project, SEED_FILE), "QUODER_NOTES are the first words of this file.\n", "utf8");
  // Outside the project, so the model's tools never see it.
  const traceDirectory = await mkdtemp(join(tmpdir(), "quoder-harness-trace-"));
  const tracePath = join(traceDirectory, "quoder-trace.jsonl");
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
    // Ctrl-C for the third prompt: piped stdin means SIGINT reaches the CLI's own handler. It is
    // sent only while that prompt is provably running (started, with a session, not completed),
    // never when idle: once it streams text, or after a fallback measured from its latest session,
    // so a retry after a dropped first attempt restarts the clock.
    let cancelSent = false;
    let cancelTargetSeenAt: number | undefined;
    let cancelTargetSessions = 0;
    const canceller = setInterval(() => {
      if (cancelSent || child.pid === undefined) return;
      void readTrace(tracePath).then((trace) => {
        const prompts = perPrompt(trace);
        const target = prompts[CANCELLED_PROMPT];
        if (cancelSent || prompts.length !== CANCELLED_PROMPT + 1 || target === undefined || target.outcome !== undefined) return;
        if (target.sessionIDs.length === 0) return;
        if (target.sessionIDs.length !== cancelTargetSessions) {
          cancelTargetSessions = target.sessionIDs.length;
          cancelTargetSeenAt = Date.now();
        }
        cancelTargetSeenAt ??= Date.now();
        if (target.streamedBeforeCompletion || Date.now() - cancelTargetSeenAt >= CANCEL_FALLBACK_MS) {
          cancelSent = true;
          child.kill("SIGINT");
        }
      });
    }, 250);
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
    clearInterval(canceller);
    const residual = await stopResidualServers(trackedServers);
    const trace = await readTrace(tracePath);
    const prompts = perPrompt(trace);
    const count = (event: string) => trace.filter((entry) => entry.event === event).length;
    const created = trace.flatMap((entry) => (entry.event === "session.created" && entry.sessionID ? [entry.sessionID] : []));
    const deleted = trace.flatMap((entry) => (entry.event === "session.deleted" && entry.verified === true && entry.sessionID ? [entry.sessionID] : []));
    const outcomes = trace.flatMap((entry) => (entry.event === "prompt.completed" && entry.outcome ? [entry.outcome] : []));

    const results = [
      row("Harness launch and exit", exitCode === 0, `exit code ${String(exitCode)}`),
      row("Single OpenCode server", count("server.started") === 1 && count("server.lost") === 0, `${count("server.started")} started, ${count("server.lost")} lost`),
      row(
        "Fresh session per prompt",
        prompts.length === PROMPTS.length &&
          prompts.every((prompt) => prompt.sessionIDs.length === (prompt.retried ? 2 : 1)) &&
          new Set(created).size === created.length,
        `${prompts.length} prompts, ${created.length} sessions, ${new Set(created).size} distinct, ${prompts.filter((prompt) => prompt.retried).length} retried after OpenCode dropped the prompt`,
      ),
      row(
        "Prompts completed",
        outcomes.length === PROMPTS.length && outcomes.every((outcome, index) => outcome === EXPECTED_OUTCOMES[index]),
        `outcomes: ${outcomes.join(", ") || "none"} (expected ${EXPECTED_OUTCOMES.join(", ")})`,
      ),
      row("Session deletion", created.length > 0 && created.every((id) => deleted.includes(id)), `${deleted.length} of ${created.length} verified deleted`),
      row("Server cleanup", count("server.stopped") === 1 && residual === 0, `stopped ${count("server.stopped")}, ${trackedServers.size} tracked, ${residual} left running`),
    ];
    const answered = prompts.filter((prompt) => prompt.outcome === "answered");
    const streamed = answered.filter((prompt) => prompt.streamedBeforeCompletion).length;
    const toolNames = prompts[TOOL_PROMPT]?.tools ?? [];
    const cancelled = prompts[CANCELLED_PROMPT];
    const after = prompts[CANCELLED_PROMPT + 1];
    const cancelledDeleted = cancelled !== undefined && cancelled.sessionIDs.length > 0 && cancelled.sessionIDs.every((id) => deleted.includes(id));
    const milestone2 = [
      row("Streamed before completion", answered.length > 0 && streamed === answered.length, `${streamed} of ${answered.length} answered prompts streamed text before completing`),
      row("Tool activity observed", toolNames.length > 0, `prompt ${TOOL_PROMPT + 1} tools: ${toolNames.join(", ") || "none"}`),
      row(
        "Cancel and continue",
        cancelSent &&
          cancelled?.outcome === "cancelled" &&
          cancelledDeleted &&
          after?.outcome === "answered",
        `SIGINT ${cancelSent ? "sent" : "not sent"}; prompt ${CANCELLED_PROMPT + 1} ${cancelled?.outcome ?? "missing"}, ` +
          `session ${cancelledDeleted ? "verified deleted" : "not verified deleted"}; ` +
          `next prompt ${after?.outcome ?? "missing"}`,
      ),
    ];
    // Informational only: exact replies depend on the model, not on the harness.
    const exact = ["QUODER_ONE", "QUODER_NOTES", "QUODER_AFTER"].filter((sentinel) => stdout.includes(sentinel)).length;
    process.stdout.write(`Model replies (informational): ${exact} of 3 exact\n`);
    const m1 = results.every(Boolean);
    const m2 = m1 && milestone2.every(Boolean);
    process.stdout.write(`Milestone 1 Exit Criterion: ${m1 ? "MET" : "NOT MET"}\n`);
    process.stdout.write(`Milestone 2 Exit Criterion: ${m2 ? "MET" : "NOT MET"}\n`);
    return m2 ? 0 : 1;
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(traceDirectory, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stdout.write("Milestone 1 Exit Criterion: NOT MET\nMilestone 2 Exit Criterion: NOT MET\n");
    process.exitCode = 1;
  },
);
