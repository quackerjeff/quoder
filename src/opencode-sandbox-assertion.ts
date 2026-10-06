/**
 * Post-startup verification that the running server actually resolved Quoder's sandbox.
 *
 * Writing a config file is not evidence that OpenCode used it: `opencode serve` does not validate
 * configuration at startup, so a typo, a precedence change, or an unexpected config layer would
 * fail silently and leave model-run shells unsandboxed. This reads the resolved configuration back
 * from the live server and refuses to continue unless the sandbox trampoline is in force.
 *
 * `shell` is the only subprocess interception point OpenCode 1.18.33 exposes, so paths that spawn
 * processes outside it cannot be sandboxed and must instead be absent. Local MCP servers inherit
 * the server environment directly (`packages/opencode/src/mcp/index.ts` merges `...process.env`),
 * so any configured local MCP server is a launch failure rather than a warning.
 */

export const CONFIG_UNREADABLE_MESSAGE =
  "Quoder could not read the running OpenCode server's resolved configuration; interactive permission grants stay disabled";
export const SHELL_NOT_SANDBOXED_MESSAGE =
  "The running OpenCode server did not resolve Quoder's model-run tool sandbox as its shell; interactive permission grants stay disabled";
export const LOCAL_MCP_PRESENT_MESSAGE =
  "The running OpenCode server has local MCP servers configured; they would inherit Quoder's server credentials outside the tool sandbox";

export interface RuntimeConfigReader {
  /** Resolved configuration from the live server, normally `client.config.get()`. */
  readonly readConfig: () => Promise<unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Unwraps either a bare config object or an SDK `{ data }` envelope. */
const configBody = (value: unknown): Record<string, unknown> | undefined => {
  const outer = asRecord(value);
  if (outer === undefined) return undefined;
  const inner = asRecord(outer.data);
  return inner ?? outer;
};

/** Reports the ids of configured local MCP servers, which spawn unsandboxed child processes. */
export function localMcpServerIds(config: Record<string, unknown>): readonly string[] {
  const mcp = asRecord(config.mcp);
  if (mcp === undefined) return [];
  return Object.entries(mcp)
    .filter(([, entry]) => asRecord(entry)?.type === "local")
    .map(([id]) => id);
}

/**
 * Fails closed unless the live server resolved exactly the expected sandbox trampoline and has no
 * configured local MCP server. Never includes configuration contents in the thrown message.
 */
export async function assertSandboxedRuntimeConfig(
  reader: RuntimeConfigReader,
  expected: { readonly shellCommand: string },
): Promise<void> {
  let raw: unknown;
  try {
    raw = await reader.readConfig();
  } catch {
    // The cause may embed provider configuration, so it is never surfaced.
    throw new Error(CONFIG_UNREADABLE_MESSAGE);
  }
  const config = configBody(raw);
  if (config === undefined) throw new Error(CONFIG_UNREADABLE_MESSAGE);

  if (config.shell !== expected.shellCommand) throw new Error(SHELL_NOT_SANDBOXED_MESSAGE);

  const localServers = localMcpServerIds(config);
  if (localServers.length > 0) throw new Error(LOCAL_MCP_PRESENT_MESSAGE);
}
