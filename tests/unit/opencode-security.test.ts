import { describe, expect, it, vi } from "vitest";

import quoderShellEnvironmentPlugin from "../../src/opencode-shell-env-plugin.js";
import { authenticatedServerProcessConfig } from "../../src/opencode-server.js";

describe("OpenCode credential isolation hook", () => {
  it("keeps server authentication in the server environment and blanks it for model-run shells", async () => {
    vi.stubEnv("OPENCODE_CONFIG_CONTENT", JSON.stringify({ plugin: ["trusted-user-plugin"] }));
    vi.stubEnv("OPENCODE_PURE", "1");
    try {
      const server = authenticatedServerProcessConfig({
        username: "quoder-user-sentinel",
        password: "quoder-password-sentinel",
      });
      const inlineConfig = JSON.parse(server.env.OPENCODE_CONFIG_CONTENT ?? "{}") as { plugin: string[] };

      expect(server.args.join(" ")).not.toContain("quoder-password-sentinel");
      expect(server.env.OPENCODE_SERVER_USERNAME).toBe("quoder-user-sentinel");
      expect(server.env.OPENCODE_SERVER_PASSWORD).toBe("quoder-password-sentinel");
      expect(server.env).not.toHaveProperty("OPENCODE_PURE");
      expect(inlineConfig.plugin).toHaveLength(2);
      expect(inlineConfig.plugin[0]).toBe("trusted-user-plugin");
      expect(inlineConfig.plugin[1]).toContain("opencode-shell-env-plugin");

      expect(quoderShellEnvironmentPlugin.id).toBe("quoder-shell-env");
      const plugin = await quoderShellEnvironmentPlugin.server();
      const shellEnvironment: { env: Record<string, string | undefined> } = {
        env: {
          OPENCODE_API_KEY: "provider-key-sentinel",
          OPENCODE_AUTH_CONTENT: "auth-content-sentinel",
          OPENCODE_CONFIG_CONTENT: server.env.OPENCODE_CONFIG_CONTENT,
          OPENCODE_CONSOLE_TOKEN: "console-token-sentinel",
          OPENCODE_SERVER_PASSWORD: server.env.OPENCODE_SERVER_PASSWORD,
        },
      };
      plugin["shell.env"]({}, shellEnvironment);

      expect(shellEnvironment.env).toEqual({
        OPENCODE_API_KEY: "",
        OPENCODE_AUTH_CONTENT: "",
        OPENCODE_CONFIG_CONTENT: "",
        OPENCODE_CONSOLE_TOKEN: "",
        OPENCODE_SERVER_PASSWORD: "",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
