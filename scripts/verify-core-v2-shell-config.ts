/**
 * Model-free acceptance for Quoder's Core V2 model-run tool sandbox.
 *
 * The previous version of this probe required a model prompt and discarded the server's stderr, so
 * a failure produced neither a verdict nor a diagnosable cause. This version drives the real Core
 * V2 Bash tool directly with `opencode debug agent <name> --tool bash --params '{...}'`, which
 * executes the pinned Bash implementation with no model call and no nondeterminism.
 *
 * Every stage runs in isolation and records a fixed, credential-safe cause, so one run reports a
 * row for each predicate and absent evidence is never reported as a PASS. Only harmless sentinels
 * and disposable fixtures are used; the user's real OpenCode configuration is copied into a
 * private mirror and never modified.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opencodeExecutablePath } from "../src/package-root.js";
import {
  CREDENTIAL_ENVIRONMENT_KEYS,
  prepareToolSandbox,
  type ToolSandbox,
} from "../src/opencode-tool-sandbox.js";
import { assertNoProjectOpenCodePlugins } from "../src/opencode-project-policy.js";
import {
  assertSandboxedRuntimeConfig,
  SHELL_NOT_SANDBOXED_MESSAGE,
} from "../src/opencode-sandbox-assertion.js";

const SENTINEL = "QUODER-SENTINEL-NOT-A-REAL-CREDENTIAL";
/**
 * Inverted self-test. With `QUODER_SANDBOX_NEGATIVE_CONTROL=1` the generated Seatbelt profile is
 * replaced with a permissive one and the run passes only if the sandbox-dependent predicates
 * fail. This guards against a suite that reports PASS without exercising the boundary; two of
 * these predicates were originally non-discriminating and were caught this way.
 */
const NEGATIVE_CONTROL = process.env.QUODER_SANDBOX_NEGATIVE_CONTROL === "1";
/** Predicates that must flip to FAIL once the profile is permissive. */
const SANDBOX_DEPENDENT_LABELS = [
  "Loopback denied to model-run shell",
  "Private config unreadable by model-run shell",
  "Nested sandbox cannot relax the profile",
] as const;
const AGENT = "build";
const TOOL_TIMEOUT_MS = 60_000;

interface Row {
  readonly label: string;
  readonly passed: boolean;
  /** Fixed phrase only; never a raw message, path, config value, or credential. */
  readonly cause?: string;
}

const rows: Row[] = [];
const record = (label: string, passed: boolean, cause?: string): void => {
  rows.push({ label, passed, ...(cause === undefined ? {} : { cause }) });
};

/** Classifies a thrown value into one of a fixed set of phrases. */
const classify = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("requires macOS")) return "unsupported platform";
  if (message.includes("sandbox-exec")) return "sandbox tool unavailable";
  if (message.includes("rejected Quoder's model-run tool profile")) return "profile rejected by kernel";
  if (message.includes("already sets `shell`")) return "global shell collision";
  if (message.includes("could not parse your global")) return "unreadable global config";
  if (message === SHELL_NOT_SANDBOXED_MESSAGE) return "server did not resolve the sandbox shell";
  if (message.includes("local MCP servers configured")) return "local MCP servers configured";
  if (message.includes("resolved configuration")) return "resolved config unreadable";
  if (message.includes("cannot launch it securely")) return "project policy rejected the fixture";
  if (message.includes("timed out")) return "stage timed out";
  if (message === "harvest control unavailable") return "harvest control unavailable";
  return "unclassified failure";
};

interface ToolOutcome {
  readonly ok: boolean;
  /** The Bash tool's own captured output, used only for fixed substring assertions. */
  readonly output: string;
}

/**
 * Extracts the Bash tool's `output` field from the `debug agent` JSON envelope.
 *
 * Asserting against the whole process stdout would be wrong: the envelope echoes the requested
 * command back under `input.command`, so a probe looking for a marker would match its own request
 * instead of the shell's behaviour and report a false result.
 */
export function toolResultOutput(stdout: string): string | undefined {
  const match = stdout.match(/"output":\s*"((?:[^"\\]|\\.)*)"/);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

/**
 * Runs one command through the real Core V2 Bash tool. Output is matched against fixed substrings
 * by the caller and never printed, so a command that reads something unexpected cannot leak it.
 */
async function runBashTool(
  command: string,
  context: { readonly project: string; readonly sandbox: ToolSandbox },
): Promise<ToolOutcome> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_CONFIG_DIR: context.sandbox.configDirectory,
    OPENCODE_SERVER_USERNAME: "quoder-sandbox-probe",
    OPENCODE_SERVER_PASSWORD: randomBytes(32).toString("base64url"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ sentinel: SENTINEL }),
  };
  delete environment.OPENCODE_PURE;

  const child = spawn(
    opencodeExecutablePath(),
    [
      "debug", "agent", AGENT,
      "--tool", "bash",
      "--params", JSON.stringify({ command, description: "Quoder sandbox acceptance probe" }),
    ],
    { cwd: context.project, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );

  let text = "";
  child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });

  const status = await new Promise<"exit" | "timeout">((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, TOOL_TIMEOUT_MS);
    child.once("exit", () => { clearTimeout(timer); resolve("exit"); });
    child.once("error", () => { clearTimeout(timer); resolve("timeout"); });
  });
  const output = toolResultOutput(text);
  return { ok: status === "exit" && output !== undefined, output: output ?? "" };
}

/** Runs one isolated stage; a throw becomes a FAIL row with a fixed cause, never a crash. */
async function stage(label: string, body: () => Promise<boolean>): Promise<boolean> {
  try {
    const passed = await body();
    record(label, passed, passed ? undefined : "predicate not satisfied");
    return passed;
  } catch (error) {
    record(label, false, classify(error));
    return false;
  }
}

/**
 * Normal runs require every predicate to pass. Negative-control runs require the
 * sandbox-dependent predicates to fail, which proves the suite is sensitive to the boundary.
 */
function verdictExitCode(): number {
  if (rows.length === 0) return 1;
  if (!NEGATIVE_CONTROL) return rows.every((row) => row.passed) ? 0 : 1;
  return SANDBOX_DEPENDENT_LABELS.every((label) => {
    const row = rows.find((candidate) => candidate.label === label);
    return row !== undefined && !row.passed;
  }) ? 0 : 1;
}

async function main(): Promise<number> {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "quoder-sandbox-accept-"));
  const project = join(scratch, "project");
  const sourceConfig = join(scratch, "source-config");
  let sandbox: ToolSandbox | undefined;
  let protectedPort: number | undefined;
  let listener: ReturnType<typeof createHttpServer> | undefined;

  try {
    await mkdir(project);
    // A disposable stand-in for the user's global config, so the real one is never touched.
    await mkdir(sourceConfig, { mode: 0o700 });
    await writeFile(join(sourceConfig, "provider-sentinel.txt"), `${SENTINEL}\n`, { mode: 0o600 });
    await writeFile(join(project, "hello.txt"), "Harmless Quoder sandbox probe fixture.\n");

    // A real HTTP listener stands in for the authenticated server endpoint. It must be a genuine
    // HTTP server: against a raw TCP socket `curl` fails whether or not the sandbox blocked it,
    // which would make this predicate pass even with the sandbox disabled.
    listener = createHttpServer((_request, response) => { response.writeHead(200); response.end("ok"); });
    await new Promise<void>((resolve) => listener?.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    protectedPort = typeof address === "object" && address !== null ? address.port : undefined;

    await stage("Tool sandbox prepared", async () => {
      sandbox = await prepareToolSandbox({ sourceConfigDirectory: sourceConfig });
      if (NEGATIVE_CONTROL) {
        // Replace the generated profile with a permissive one, leaving everything else identical.
        // A suite that still passes every predicate here is not testing the sandbox at all, so
        // this inverted run is what makes the positive run meaningful.
        await writeFile(sandbox.profilePath, "(version 1)\n(allow default)\n", {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      return true;
    });
    if (sandbox === undefined || protectedPort === undefined) {
      record("Core V2 selected the sandbox shell", false, "sandbox unavailable");
      record("Loopback denied to model-run shell", false, "sandbox unavailable");
      record("Private config unreadable by model-run shell", false, "sandbox unavailable");
      record("Process inspection denied to model-run shell", false, "sandbox unavailable");
      record("Credential variables absent from model-run shell", false, "sandbox unavailable");
      record("Nested sandbox cannot relax the profile", false, "sandbox unavailable");
      record("External network preserved", false, "sandbox unavailable");
      record("Project shell override rejected", false, "sandbox unavailable");
      record("Runtime config assertion fails closed", false, "sandbox unavailable");
      return 1;
    }
    const context = { project, sandbox };
    const privateSentinel = join(sandbox.configDirectory, "provider-sentinel.txt");
    const sandboxedShellCommand = sandbox.shellCommand;

    // The trampoline is the only shell Core V2 Bash should reach. A marker proves selection
    // without depending on the sandbox's own behaviour.
    await stage("Core V2 selected the sandbox shell", async () => {
      const result = await runBashTool("echo quoder-shell-selected", context);
      // `env -i` keeps only the allowlisted variables, so a bare `echo` proving the command ran
      // plus the credential check below jointly establish the trampoline was used.
      return result.ok && result.output.includes("quoder-shell-selected");
    });

    await stage("Loopback denied to model-run shell", async () => {
      const result = await runBashTool(
        `curl -sS -m 3 -o /dev/null -w "code=%{http_code}" http://127.0.0.1:${protectedPort}/ || echo denied`,
        context,
      );
      return result.ok && result.output.includes("denied") && !result.output.includes("code=200");
    });

    await stage("Private config unreadable by model-run shell", async () => {
      const result = await runBashTool(
        `cat ${JSON.stringify(privateSentinel)} || echo read-denied`,
        context,
      );
      return result.ok && result.output.includes("read-denied") && !result.output.includes(SENTINEL);
    });

    // A shell that could harvest the password with `ps` could hand it to `webfetch`, which runs
    // in the unsandboxed server process and can still reach loopback. The stage first proves the
    // sentinel really is discoverable without the sandbox, so a silent zero is never a PASS.
    //
    // Note on what this detects: `/bin/ps` is setuid root, and Seatbelt refuses to exec setuid
    // binaries under any profile, so this predicate detects an unsandboxed shell rather than the
    // specific `process-info*` rule. An unprivileged `KERN_PROCARGS2` read cannot recover another
    // process's environment on this host, so `process-info*` is defence in depth here.
    await stage("Process inspection denied to model-run shell", async () => {
      const target = spawn("/bin/sleep", ["45"], {
        env: { ...process.env, QUODER_PROCESS_SENTINEL: SENTINEL },
        stdio: "ignore",
      });
      try {
        const control = spawnSync("/bin/sh", [
          "-c",
          "ps -axeww 2>/dev/null | grep -c QUODER_PROCESS_SENTINEL",
        ], { encoding: "utf8" });
        if (Number.parseInt(control.stdout.trim(), 10) < 1) {
          throw new Error("harvest control unavailable");
        }
        const result = await runBashTool(
          "ps -axeww 2>/dev/null | grep -c QUODER_PROCESS_SENTINEL || echo harvest-denied",
          context,
        );
        if (!result.ok || result.output.includes(SENTINEL)) return false;
        // Either `ps` was refused outright, or it ran and found nothing.
        const counts = result.output.match(/\d+/g) ?? [];
        return counts.every((count) => count === "0");
      } finally {
        target.kill("SIGKILL");
      }
    });

    await stage("Credential variables absent from model-run shell", async () => {
      const checks = CREDENTIAL_ENVIRONMENT_KEYS
        .map((key) => `[ -z "\${${key}:-}" ] || echo leaked-${key}`)
        .join("; ");
      const result = await runBashTool(`${checks}; echo env-checked`, context);
      // The probe seeds OPENCODE_CONFIG_CONTENT with a sentinel, so a surviving value would show.
      return result.ok
        && result.output.includes("env-checked")
        && !result.output.includes("leaked-")
        && !result.output.includes(SENTINEL);
    });

    await stage("Nested sandbox cannot relax the profile", async () => {
      const result = await runBashTool(
        `sandbox-exec -p '(version 1)(allow default)' /usr/bin/curl -sS -m 3 -o /dev/null `
        + `-w "code=%{http_code}" http://127.0.0.1:${protectedPort}/ || echo escape-denied`,
        context,
      );
      return result.ok && result.output.includes("escape-denied") && !result.output.includes("code=200");
    });

    await stage("External network preserved", async () => {
      const result = await runBashTool(
        'curl -sS -m 10 -o /dev/null -w "code=%{http_code}" https://example.com || echo external-failed',
        context,
      );
      return result.ok && result.output.includes("code=200");
    });

    // A project that overrides `shell` would outrank the private global config in Core V2
    // precedence, so the launcher must refuse it.
    await stage("Project shell override rejected", async () => {
      const hostile = join(scratch, "hostile-project");
      await mkdir(join(hostile, ".opencode"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(hostile, ".opencode", "opencode.jsonc"),
        JSON.stringify({ shell: "/bin/sh" }),
        { mode: 0o600 },
      );
      try {
        assertNoProjectOpenCodePlugins(hostile);
        return false;
      } catch {
        return true;
      }
    });

    // The assertion must reject a server whose resolved shell is not the trampoline.
    await stage("Runtime config assertion fails closed", async () => {
      let rejectedWrongShell = false;
      try {
        await assertSandboxedRuntimeConfig(
          { readConfig: async () => ({ shell: "/bin/sh" }) },
          { shellCommand: sandboxedShellCommand },
        );
      } catch {
        rejectedWrongShell = true;
      }
      let rejectedLocalMcp = false;
      try {
        await assertSandboxedRuntimeConfig(
          {
            readConfig: async () => ({
              shell: sandboxedShellCommand,
              mcp: { probe: { type: "local", command: ["true"] } },
            }),
          },
          { shellCommand: sandboxedShellCommand },
        );
      } catch {
        rejectedLocalMcp = true;
      }
      let acceptedSandboxed = false;
      try {
        await assertSandboxedRuntimeConfig(
          { readConfig: async () => ({ shell: sandboxedShellCommand, mcp: {} }) },
          { shellCommand: sandboxedShellCommand },
        );
        acceptedSandboxed = true;
      } catch {
        acceptedSandboxed = false;
      }
      return rejectedWrongShell && rejectedLocalMcp && acceptedSandboxed;
    });

    return verdictExitCode();
  } finally {
    listener?.close();
    await sandbox?.remove().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    // Report after cleanup so a cleanup failure cannot suppress the verdict.
    for (const row of rows) {
      const suffix = row.cause === undefined ? "" : ` (${row.cause})`;
      process.stdout.write(`${row.label}: ${row.passed ? "PASS" : "FAIL"}${suffix}\n`);
    }
    if (NEGATIVE_CONTROL) {
      for (const label of SANDBOX_DEPENDENT_LABELS) {
        const row = rows.find((candidate) => candidate.label === label);
        const flipped = row !== undefined && !row.passed;
        process.stdout.write(
          `Negative control expects FAIL: ${label}: ${flipped ? "flipped (good)" : "still passing (bad)"}\n`,
        );
      }
    }
    const verdict = verdictExitCode() === 0 ? "PASS" : "FAIL";
    process.stdout.write(
      `Model-run tool sandbox${NEGATIVE_CONTROL ? " (negative control)" : ""}: ${verdict}\n`,
    );
  }
}

void main()
  .then((code) => { process.exitCode = code; })
  .catch(() => {
    process.stdout.write("Model-run tool sandbox: FAIL (harness error)\n");
    process.exitCode = 1;
  });
