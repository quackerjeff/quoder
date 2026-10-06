import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertNoProjectOpenCodePlugins } from "../../src/opencode-project-policy.js";

describe("project OpenCode plugin policy", () => {
  it("allows project settings without a project plugin source", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-project-policy-"));
    try {
      await writeFile(join(root, "opencode.json"), JSON.stringify({ permission: { bash: "ask" } }));
      await mkdir(join(root, ".opencode"), { recursive: true });
      await writeFile(join(root, ".opencode", "opencode.jsonc"), '{\n  "agent": {}\n}');
      expect(() => assertNoProjectOpenCodePlugins(root)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["root-json", "nested-jsonc", "plugin-directory", "singular-plugin-directory"])(
    "rejects project plugin source: %s",
    async (source) => {
      const root = await mkdtemp(join(tmpdir(), "quoder-project-policy-"));
      try {
        if (source === "root-json") {
          await writeFile(join(root, "opencode.json"), '{"plugin": ["example"]}');
        } else if (source === "nested-jsonc") {
          await mkdir(join(root, ".opencode"), { recursive: true });
          await writeFile(join(root, ".opencode", "opencode.jsonc"), '{\n  "plugin": ["example"],\n}');
        } else if (source === "plugin-directory") {
          await mkdir(join(root, ".opencode", "plugins"), { recursive: true });
        } else {
          await mkdir(join(root, ".opencode", "plugin"), { recursive: true });
        }

        expect(() => assertNoProjectOpenCodePlugins(root)).toThrow("project has OpenCode plugin");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a project plugin declared in an ancestor config layer", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-project-policy-"));
    const project = join(root, "repo", "nested");
    try {
      await mkdir(project, { recursive: true });
      await writeFile(join(root, "opencode.json"), '{"plugin": ["example"]}');
      expect(() => assertNoProjectOpenCodePlugins(project)).toThrow("project has OpenCode plugin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A project `shell` outranks Quoder's private global config in Core V2 precedence, so it could
  // replace the sandbox trampoline with an unsandboxed shell and void the credential boundary.
  it.each(["root-json", "nested-jsonc", "ancestor"])(
    "rejects a project shell override: %s",
    async (source) => {
      const root = await mkdtemp(join(tmpdir(), "quoder-project-policy-"));
      const project = join(root, "repo", "nested");
      try {
        await mkdir(project, { recursive: true });
        if (source === "root-json") {
          await writeFile(join(project, "opencode.json"), '{"shell": "/bin/zsh"}');
        } else if (source === "nested-jsonc") {
          await mkdir(join(project, ".opencode"), { recursive: true });
          await writeFile(join(project, ".opencode", "opencode.jsonc"), '{\n  "shell": "/bin/zsh",\n}');
        } else {
          await writeFile(join(root, "opencode.json"), '{"shell": "/bin/zsh"}');
        }
        expect(() => assertNoProjectOpenCodePlugins(project)).toThrow("overrides the OpenCode `shell`");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a shell key encoded with a JSON unicode escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-project-policy-"));
    try {
      await writeFile(join(root, "opencode.json"), String.raw`{"sh\u0065ll": "/bin/zsh"}`);
      expect(() => assertNoProjectOpenCodePlugins(root)).toThrow("overrides the OpenCode `shell`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reject shell text inside strings or JSONC comments", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-project-policy-"));
    try {
      await writeFile(
        join(root, "opencode.jsonc"),
        '{\n  // shell: "/bin/zsh"\n  "agent": { "note": "shell" }\n}',
      );
      expect(() => assertNoProjectOpenCodePlugins(root)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a plugin key encoded with a JSON unicode escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-project-policy-"));
    try {
      await writeFile(join(root, "opencode.json"), String.raw`{"pl\u0075gin": ["example"]}`);
      expect(() => assertNoProjectOpenCodePlugins(root)).toThrow("project has OpenCode plugin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reject plugin text inside strings or JSONC comments", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-project-policy-"));
    try {
      await writeFile(
        join(root, "opencode.jsonc"),
        '{\n  // "plugin": ["not active"]\n  "description": "the word plugin is harmless",\n  "agent": {},\n}',
      );
      expect(() => assertNoProjectOpenCodePlugins(root)).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a plugin key when a JSONC comment separates it from the colon", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-project-policy-"));
    try {
      await writeFile(join(root, "opencode.jsonc"), '{\n  "plugin" /* comment */ : [],\n}');
      expect(() => assertNoProjectOpenCodePlugins(root)).toThrow("project has OpenCode plugin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
