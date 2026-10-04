#!/usr/bin/env node
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createOpencodeClient, type ModelRef } from "@opencode-ai/sdk/v2";

import { Harness, type HarnessTraceEvent } from "./harness/repl.js";
import { resolveProject } from "./harness/project.js";
import { launchAuthenticatedOpenCodeServer } from "./opencode-server.js";
import { colorEnabled, createTheme } from "./ui/style.js";
import { packagePath } from "./package-root.js";

export const DEFAULT_MODEL: ModelRef = { providerID: "ollama", id: "glm-4.7-flash:latest" };

const USAGE = [
  "Usage: quoder [--model provider/model] [--no-color]",
  "",
  "Starts the Quoder harness in the current project. Each prompt runs in a fresh",
  "OpenCode session that is deleted afterwards.",
  "",
  `  --model provider/model   OpenCode model to bind (default: ${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.id})`,
  "  --no-color               Disable colour (NO_COLOR is also honoured)",
  "  --help                   Show this help",
  "  --version                Show the Quoder version",
].join("\n");

export type CliArguments =
  | { readonly kind: "run"; readonly model: ModelRef; readonly noColor: boolean }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string };

export function parseArguments(args: readonly string[]): CliArguments {
  let model = DEFAULT_MODEL;
  let noColor = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument === "--version") return { kind: "version" };
    if (argument === "--no-color") {
      noColor = true;
      continue;
    }
    if (argument === "--model" || argument?.startsWith("--model=")) {
      const value = argument === "--model" ? args[++index] : argument.slice("--model=".length);
      const separator = value?.indexOf("/") ?? -1;
      if (value === undefined || separator <= 0 || separator === value.length - 1) {
        return { kind: "error", message: "--model expects provider/model, for example ollama/glm-4.7-flash:latest" };
      }
      model = { providerID: value.slice(0, separator), id: value.slice(separator + 1) };
      continue;
    }
    return { kind: "error", message: `Unknown argument: ${argument ?? ""}` };
  }
  return { kind: "run", model, noColor };
}

/** QUODER_TRACE_FILE receives one JSON line per harness trace event (diagnostics and acceptance). */
const traceWriter = (path: string | undefined): ((event: HarnessTraceEvent) => void) | undefined =>
  path === undefined || path === ""
    ? undefined
    : (event) => appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "version") {
    const manifest: unknown = JSON.parse(readFileSync(packagePath("package.json"), "utf8"));
    process.stdout.write(`quoder ${String(Reflect.get(manifest as object, "version"))}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  const project = await resolveProject(process.cwd());
  const trace = traceWriter(process.env.QUODER_TRACE_FILE);
  const harness = new Harness(
    {
      project,
      model: parsed.model,
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
      theme: createTheme(colorEnabled({ isTTY: process.stdout.isTTY === true, env: process.env, noColorFlag: parsed.noColor })),
      columns: () => process.stdout.columns,
    },
    {
      launchServer: (options) => launchAuthenticatedOpenCodeServer(options),
      createClient: (baseUrl, authorization) => createOpencodeClient({ baseUrl, headers: { Authorization: authorization } }),
      ...(trace === undefined ? {} : { trace }),
    },
  );
  // A closed output pipe (for example `quoder | head`) ends Quoder through its orderly shutdown
  // instead of crashing on EPIPE and leaving the server behind; 141 is the conventional SIGPIPE code.
  const outputClosed = (): void => harness.terminate(141);
  process.stdout.on("error", outputClosed);
  process.stderr.on("error", outputClosed);
  // In a TTY readline reports Ctrl-C itself; these cover piped input and external signals.
  process.on("SIGINT", () => harness.interrupt());
  // Conventional 128 + signal exit codes, so supervisors can tell a signalled exit apart.
  process.on("SIGTERM", () => harness.terminate(143));
  process.on("SIGHUP", () => harness.terminate(129));
  return harness.run();
}

/** True when run as a program, including through the `npm link` symlink; false when imported. */
const isEntryPoint = (): boolean => {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryPoint()) {
  main().then(
    (code) => process.exit(code),
    () => {
      process.stderr.write("Quoder stopped because of an unexpected error.\n");
      process.exit(1);
    },
  );
}
