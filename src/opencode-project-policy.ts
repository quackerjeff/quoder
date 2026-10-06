import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse } from "node:path";

const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"] as const;
const PLUGIN_PATHS = [join(".opencode", "plugins"), join(".opencode", "plugin")] as const;

/**
 * Project settings Quoder refuses to launch under.
 *
 * `plugin` executes code inside the authenticated server process. `shell` has later precedence
 * than Quoder's private global config in Core V2, so a project could otherwise replace the
 * sandbox trampoline with an unsandboxed shell and void the credential boundary.
 */
const FORBIDDEN_PROPERTIES = ["plugin", "shell"] as const;

const REJECTION_MESSAGES: Record<(typeof FORBIDDEN_PROPERTIES)[number], string> = {
  plugin: "This project has OpenCode plugin configuration; Quoder cannot launch it securely",
  shell: "This project overrides the OpenCode `shell`; Quoder cannot launch it securely",
};

/**
 * Finds JSON/JSONC object keys after JSON escape decoding. OpenCode accepts JSONC, so comments may
 * occur between a key and its colon. Scanning string tokens avoids treating text inside strings or
 * comments as configuration while still catching equivalent spellings such as `"pl\\u0075gin"`.
 *
 * Returns the first matching property name so callers can report a specific reason.
 */
export function findForbiddenProperty(
  content: string,
  names: readonly string[],
): string | undefined {
  let index = 0;
  const skipTrivia = (): void => {
    for (;;) {
      while (/\s/u.test(content[index] ?? "")) index++;
      if (content.startsWith("//", index)) {
        const newline = content.indexOf("\n", index + 2);
        index = newline < 0 ? content.length : newline + 1;
      } else if (content.startsWith("/*", index)) {
        const end = content.indexOf("*/", index + 2);
        if (end < 0) throw new Error("Unterminated comment in OpenCode project configuration");
        index = end + 2;
      } else {
        return;
      }
    }
  };

  while (index < content.length) {
    skipTrivia();
    if (content[index] !== '"') {
      index++;
      continue;
    }

    const start = index++;
    let escaped = false;
    while (index < content.length) {
      const character = content[index++];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') break;
    }
    if (content[index - 1] !== '"' || escaped) {
      throw new Error("Unterminated string in OpenCode project configuration");
    }

    const token = content.slice(start, index);
    let decoded: unknown;
    try {
      decoded = JSON.parse(token);
    } catch {
      throw new Error("Invalid string in OpenCode project configuration");
    }
    skipTrivia();
    if (typeof decoded === "string" && names.includes(decoded) && content[index] === ":") {
      return decoded;
    }
  }
  return undefined;
}

/** Convenience predicate for callers that only need to know whether any key matched. */
export function hasForbiddenProperty(content: string, names: readonly string[]): boolean {
  return findForbiddenProperty(content, names) !== undefined;
}

/**
 * Project plugins execute in the authenticated server process, and a project `shell` would
 * outrank Quoder's sandbox trampoline in Core V2 precedence. Reject targets whose OpenCode
 * project layers declare either. Walk ancestors because OpenCode layers config up to the project.
 */
export function assertNoProjectOpenCodePlugins(directory: string): void {
  let current = realpathSync(directory);
  const filesystemRoot = parse(current).root;
  while (true) {
    for (const configName of CONFIG_NAMES) {
      const configPaths = [join(current, configName), join(current, ".opencode", configName)];
      for (const configPath of configPaths) {
        if (!existsSync(configPath)) continue;
        // JSONC comments and trailing commas are allowed. Reject any decoded forbidden key even if
        // its value is malformed or empty, rather than try to partially parse config.
        const content = readFileSync(configPath, "utf8");
        const found = findForbiddenProperty(content, FORBIDDEN_PROPERTIES);
        if (found !== undefined) {
          throw new Error(REJECTION_MESSAGES[found as (typeof FORBIDDEN_PROPERTIES)[number]]);
        }
      }
    }
    for (const pluginPath of PLUGIN_PATHS) {
      const path = join(current, pluginPath);
      if (existsSync(path)) {
        throw new Error("This project has OpenCode plugins; Quoder cannot launch it securely");
      }
    }

    if (current === filesystemRoot) break;
    current = dirname(current);
  }
}
