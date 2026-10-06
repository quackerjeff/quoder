interface ShellEnvironmentOutput {
  readonly env: Record<string, string | undefined>;
}

const SERVER_SECRET_ENVIRONMENT_KEYS = [
  "OPENCODE_API_KEY",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONSOLE_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
] as const;

/** OpenCode plugin hook: model-run shells must not inherit Quoder's authenticated server secret. */
export default {
  id: "quoder-shell-env",
  server: async () => ({
    "shell.env": (_input: unknown, output: ShellEnvironmentOutput): void => {
      // OpenCode merges these values over process.env before starting the shell. Empty values
      // prevent model-run commands from inheriting server credentials or inline config contents.
      for (const key of SERVER_SECRET_ENVIRONMENT_KEYS) output.env[key] = "";
    },
  }),
};
