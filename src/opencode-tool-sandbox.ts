import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

import { hasForbiddenProperty } from "./opencode-project-policy.js";

/**
 * The OS boundary that makes a leaked OpenCode server credential unusable by model-run tools.
 *
 * OpenCode 1.18.33 offers no way to keep the server password out of the server process: Core V2
 * reads it only from `OPENCODE_SERVER_PASSWORD` (`ServerAuth.Config`), and `opencode serve` has no
 * credential flag. Same-user process inspection can therefore recover it. Rather than hide the
 * secret, Quoder removes the capability to use it: every model-run shell runs under a macOS
 * Seatbelt profile that denies all loopback egress and reads of Quoder's private files. A Seatbelt
 * profile is applied at exec, inherited by descendants, and cannot be relaxed from inside.
 *
 * Core V2 Bash selects its shell from filesystem-backed `Config.entries()`, so the trampoline is
 * installed through a Quoder-owned private global config directory selected with
 * `OPENCODE_CONFIG_DIR`. The user's real configuration is mirrored into it and never mutated.
 */

/** Variables that must never reach a model-run shell, even though the profile makes them inert. */
export const CREDENTIAL_ENVIRONMENT_KEYS = [
  "OPENCODE_API_KEY",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONSOLE_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
] as const;

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const GLOBAL_CONFIG_NAME = "opencode.json";
const GLOBAL_CONFIG_NAMES = [GLOBAL_CONFIG_NAME, "opencode.jsonc"] as const;

export const UNSUPPORTED_PLATFORM_MESSAGE =
  "Quoder's model-run tool sandbox requires macOS; interactive permission grants stay disabled on this platform";
export const MISSING_SANDBOX_TOOL_MESSAGE =
  "Quoder's model-run tool sandbox requires /usr/bin/sandbox-exec; interactive permission grants stay disabled";
export const GLOBAL_SHELL_COLLISION_MESSAGE =
  "Your OpenCode configuration already sets `shell`; Quoder cannot install its model-run tool sandbox safely";
export const UNREADABLE_GLOBAL_CONFIG_MESSAGE =
  "Quoder could not parse your global OpenCode configuration, so it cannot install its model-run tool sandbox";
export const PROFILE_REJECTED_MESSAGE =
  "The macOS sandbox rejected Quoder's model-run tool profile; interactive permission grants stay disabled";

const quoteProfileString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export interface SeatbeltProfileInput {
  /**
   * Directories whose contents model-run tools must not read. These must already be
   * realpath-resolved: Seatbelt matches the kernel's resolved path, so a rule naming `/var/...`
   * silently fails to match `/private/var/...` and the denial is lost without any error.
   */
  readonly deniedReadSubpaths: readonly string[];
}

/**
 * Builds the model-run tool profile. Loopback is denied in full rather than per-port: the spec
 * requires no local-service exceptions until rule precedence and endpoint exclusion are proven,
 * and a blanket denial also removes any dependence on the server's port being known beforehand.
 *
 * Process inspection is denied because `webfetch` runs inside the unsandboxed server process: a
 * shell that could harvest the password with `ps -axeww` could hand it to `webfetch`, which can
 * still reach loopback. Verified on this host that `ps -axeww` otherwise exposes same-user
 * environments, and that it reports `Operation not permitted` under this profile.
 *
 * Two rules are deliberately narrow because the obvious broad versions break the shell:
 *  - `process-info*` must be re-allowed for `target self`, or HTTPS fails outright (name
 *    resolution and TLS need it) and `env -i` startups die with SIGTRAP.
 *  - No `network-inbound` denial: the system resolver binds a local socket, so denying it breaks
 *    DNS (`bind: Operation not permitted`). Reaching the server needs an outbound connection, so
 *    inbound loopback is outside this threat model.
 */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  const lines = [
    "(version 1)",
    ";; Quoder model-run tool sandbox. Deny-only; it never widens the inherited policy.",
    "(allow default)",
    ";; No route to Quoder's authenticated OpenCode server, so a leaked password is unusable.",
    '(deny network-outbound (remote ip "localhost:*"))',
    ";; No same-user process inspection, so the server environment cannot be harvested.",
    "(deny process-info*)",
    ";; Self-inspection must stay allowed; without it DNS and TLS fail inside the sandbox.",
    "(allow process-info* (target self))",
  ];
  for (const subpath of input.deniedReadSubpaths) {
    lines.push(`(deny file-read* (subpath ${quoteProfileString(subpath)}))`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Builds the trampoline Core V2 Bash executes instead of a bare shell. It replaces itself with the
 * sandboxed shell, so no descendant escapes the profile.
 *
 * Credentials are dropped with `env -u` rather than rebuilt with `env -i`. A wiped environment is
 * not survivable here: under a profile that denies `process-info*`, `env -i` makes the sandboxed
 * process die with SIGTRAP during dynamic-loader startup (verified: exit 133). `env -u` keeps the
 * inherited environment minus the named variables, which loads correctly. The Seatbelt profile,
 * not this list, is the security boundary; clearing these variables is defence in depth.
 */
export function buildShellTrampoline(input: {
  readonly profilePath: string;
  readonly shellPath: string;
  readonly clearedEnvironmentKeys?: readonly string[];
}): string {
  const cleared = input.clearedEnvironmentKeys ?? CREDENTIAL_ENVIRONMENT_KEYS;
  return [
    "#!/bin/sh",
    "# Quoder model-run tool trampoline. Generated per harness session; do not edit.",
    "exec /usr/bin/env \\",
    ...cleared.map((key) => `  -u ${key} \\`),
    `  ${SANDBOX_EXECUTABLE} -f ${JSON.stringify(input.profilePath)} \\`,
    `  ${JSON.stringify(input.shellPath)} "$@"`,
    "",
  ].join("\n");
}

export interface ToolSandbox {
  /** Value for `OPENCODE_CONFIG_DIR`: a private mirror of the user's global configuration. */
  readonly configDirectory: string;
  /** Value Core V2 Bash must resolve as its `shell`. */
  readonly shellCommand: string;
  readonly profilePath: string;
  /** Realpath-resolved subpaths the profile denies, reused by the runtime assertion and probe. */
  readonly deniedReadSubpaths: readonly string[];
  remove(): Promise<void>;
}

export interface PrepareToolSandboxOptions {
  /** Defaults to the real user global config directory; overridden in tests. */
  readonly sourceConfigDirectory?: string;
  /** Defaults to `/bin/sh`; the shell the trampoline hands the command to. */
  readonly shellPath?: string;
  /** Defaults to `process.platform`. */
  readonly platform?: string;
  /** Defaults to a real `sandbox-exec` load check, so a malformed profile fails closed. */
  readonly validateProfile?: (profilePath: string) => boolean;
  /** Defaults to a real filesystem check for `/usr/bin/sandbox-exec`. */
  readonly sandboxExecutableExists?: () => boolean;
}

const userConfigDirectory = (): string =>
  process.env.OPENCODE_CONFIG_DIR
  ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");

/** Confirms the kernel accepts the profile. A malformed profile must fail closed, not run free. */
const defaultValidateProfile = (profilePath: string): boolean => {
  const probe = spawnSync(SANDBOX_EXECUTABLE, ["-f", profilePath, "/usr/bin/true"], {
    stdio: "ignore",
    timeout: 10_000,
  });
  return probe.error === undefined && probe.status === 0;
};

/** Rejects a mirrored global config that sets `shell`, which would fight Quoder's trampoline. */
async function assertNoGlobalShellOverride(configDirectory: string): Promise<void> {
  for (const name of GLOBAL_CONFIG_NAMES) {
    const content = await readFile(join(configDirectory, name), "utf8").catch(() => undefined);
    if (content === undefined) continue;
    if (hasForbiddenProperty(content, ["shell"])) throw new Error(GLOBAL_SHELL_COLLISION_MESSAGE);
  }
}

/** Preserves the mirrored global settings and adds only the sandboxed shell. */
async function mergedGlobalConfig(
  configDirectory: string,
  trampolinePath: string,
): Promise<Record<string, unknown>> {
  const existing = await readFile(join(configDirectory, GLOBAL_CONFIG_NAME), "utf8")
    .catch(() => undefined);
  let base: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      // Never silently discard the user's settings; refuse to launch instead.
      throw new Error(UNREADABLE_GLOBAL_CONFIG_MESSAGE);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(UNREADABLE_GLOBAL_CONFIG_MESSAGE);
    }
    base = parsed as Record<string, unknown>;
  }
  return { ...base, shell: trampolinePath };
}

/**
 * Creates the private config mirror, profile, and trampoline for one harness session.
 * Every failure path removes the scratch tree and throws, so grants stay disabled.
 */
export async function prepareToolSandbox(
  options: PrepareToolSandboxOptions = {},
): Promise<ToolSandbox> {
  if ((options.platform ?? platform()) !== "darwin") throw new Error(UNSUPPORTED_PLATFORM_MESSAGE);
  const sandboxExists = options.sandboxExecutableExists ?? (() => existsSync(SANDBOX_EXECUTABLE));
  if (!sandboxExists()) throw new Error(MISSING_SANDBOX_TOOL_MESSAGE);
  const validateProfile = options.validateProfile ?? defaultValidateProfile;

  // Resolve the scratch root up front: every profile rule must name the kernel's resolved path.
  const root = await mkdtemp(join(await realpath(tmpdir()), "quoder-tool-sandbox-"));
  try {
    const configDirectory = join(root, "opencode-config");
    await mkdir(configDirectory, { mode: 0o700 });
    const source = options.sourceConfigDirectory ?? userConfigDirectory();
    // Mirror the user's settings so the private directory behaves like theirs. `cp` only reads the
    // source tree; Quoder never writes to the real configuration.
    await cp(source, configDirectory, { recursive: true, force: true, dereference: true })
      .catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      });
    await assertNoGlobalShellOverride(configDirectory);

    const profilePath = join(root, "model-tools.sb");
    const trampolinePath = join(root, "quoder-model-shell");
    // Denying the whole scratch root covers the mirrored provider credentials and also stops a
    // model-run command from reading the profile or trampoline to map the boundary.
    const deniedReadSubpaths = [root];
    const merged = await mergedGlobalConfig(configDirectory, trampolinePath);

    await writeFile(profilePath, buildSeatbeltProfile({ deniedReadSubpaths }), {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(
      trampolinePath,
      buildShellTrampoline({ profilePath, shellPath: options.shellPath ?? "/bin/sh" }),
      { encoding: "utf8", mode: 0o700 },
    );
    if (!validateProfile(profilePath)) throw new Error(PROFILE_REJECTED_MESSAGE);

    // Core V2 Bash reads `shell` from the filesystem-backed global config document.
    await writeFile(
      join(configDirectory, GLOBAL_CONFIG_NAME),
      `${JSON.stringify(merged, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    return {
      configDirectory,
      shellCommand: trampolinePath,
      profilePath,
      deniedReadSubpaths,
      remove: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
