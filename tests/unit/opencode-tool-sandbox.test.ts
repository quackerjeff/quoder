import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildSeatbeltProfile,
  buildShellTrampoline,
  CREDENTIAL_ENVIRONMENT_KEYS,
  GLOBAL_SHELL_COLLISION_MESSAGE,
  MISSING_SANDBOX_TOOL_MESSAGE,
  prepareToolSandbox,
  PROFILE_REJECTED_MESSAGE,
  UNREADABLE_GLOBAL_CONFIG_MESSAGE,
  UNSUPPORTED_PLATFORM_MESSAGE,
  type ToolSandbox,
} from "../../src/opencode-tool-sandbox.js";

const scratchDirectories: string[] = [];
const sandboxes: ToolSandbox[] = [];

const makeScratch = async (): Promise<string> => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "quoder-sandbox-test-"));
  scratchDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.remove().catch(() => undefined);
  for (const directory of scratchDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("buildSeatbeltProfile", () => {
  it("denies outbound loopback so a leaked server password cannot be used", () => {
    const profile = buildSeatbeltProfile({ deniedReadSubpaths: [] });
    expect(profile).toContain('(deny network-outbound (remote ip "localhost:*"))');
  });

  it("does not deny inbound loopback, which would break DNS resolution", () => {
    expect(buildSeatbeltProfile({ deniedReadSubpaths: [] })).not.toContain("network-inbound");
  });

  it("denies process inspection but re-allows self, without which DNS and TLS fail", () => {
    const profile = buildSeatbeltProfile({ deniedReadSubpaths: [] });
    const denyIndex = profile.indexOf("(deny process-info*)");
    const allowIndex = profile.indexOf("(allow process-info* (target self))");
    expect(denyIndex).toBeGreaterThanOrEqual(0);
    // Seatbelt applies the last matching rule, so the self allowance must follow the denial.
    expect(allowIndex).toBeGreaterThan(denyIndex);
  });

  it("emits a file-read denial for each supplied subpath", () => {
    const profile = buildSeatbeltProfile({
      deniedReadSubpaths: ["/private/var/one", "/private/var/two"],
    });
    expect(profile).toContain('(deny file-read* (subpath "/private/var/one"))');
    expect(profile).toContain('(deny file-read* (subpath "/private/var/two"))');
  });

  it("escapes quotes and backslashes so a crafted path cannot inject profile rules", () => {
    const profile = buildSeatbeltProfile({
      deniedReadSubpaths: ['/tmp/a"))(allow default)((x', "/tmp/back\\slash"],
    });
    expect(profile).toContain('(deny file-read* (subpath "/tmp/a\\"))(allow default)((x"))');
    expect(profile).toContain('(deny file-read* (subpath "/tmp/back\\\\slash"))');
    // The injected text must not become an effective rule.
    expect(profile.split("\n").filter((line) => line === "(allow default)")).toHaveLength(1);
  });
});

describe("buildShellTrampoline", () => {
  it("drops every credential variable and execs the sandboxed shell", () => {
    const script = buildShellTrampoline({ profilePath: "/tmp/p.sb", shellPath: "/bin/sh" });
    for (const key of CREDENTIAL_ENVIRONMENT_KEYS) expect(script).toContain(`-u ${key}`);
    expect(script).toContain("exec /usr/bin/env");
    expect(script).toContain('/usr/bin/sandbox-exec -f "/tmp/p.sb"');
    expect(script.trimEnd().endsWith('"/bin/sh" "$@"')).toBe(true);
  });

  it("never uses `env -i`, which traps under a profile that denies process-info", () => {
    const script = buildShellTrampoline({ profilePath: "/tmp/p.sb", shellPath: "/bin/sh" });
    expect(script).not.toMatch(/env\s+-i/);
  });

  it("quotes the profile and shell paths", () => {
    const script = buildShellTrampoline({
      profilePath: "/tmp/has space/p.sb",
      shellPath: "/bin/with space",
    });
    expect(script).toContain('-f "/tmp/has space/p.sb"');
    expect(script).toContain('"/bin/with space" "$@"');
  });
});

describe("prepareToolSandbox", () => {
  it("fails closed on a non-macOS platform", async () => {
    await expect(prepareToolSandbox({ platform: "linux" })).rejects.toThrow(
      UNSUPPORTED_PLATFORM_MESSAGE,
    );
  });

  it("fails closed when sandbox-exec is missing", async () => {
    await expect(
      prepareToolSandbox({ platform: "darwin", sandboxExecutableExists: () => false }),
    ).rejects.toThrow(MISSING_SANDBOX_TOOL_MESSAGE);
  });

  it("fails closed when the kernel rejects the profile", async () => {
    const source = await makeScratch();
    await expect(prepareToolSandbox({
      platform: "darwin",
      sandboxExecutableExists: () => true,
      sourceConfigDirectory: source,
      validateProfile: () => false,
    })).rejects.toThrow(PROFILE_REJECTED_MESSAGE);
  });

  it("fails closed when the user's global config already sets a shell", async () => {
    const source = await makeScratch();
    await writeFile(join(source, "opencode.json"), JSON.stringify({ shell: "/bin/zsh" }));
    await expect(prepareToolSandbox({
      platform: "darwin",
      sandboxExecutableExists: () => true,
      sourceConfigDirectory: source,
      validateProfile: () => true,
    })).rejects.toThrow(GLOBAL_SHELL_COLLISION_MESSAGE);
  });

  it("fails closed rather than discarding an unparsable global config", async () => {
    const source = await makeScratch();
    await writeFile(join(source, "opencode.json"), "{ this is not json");
    await expect(prepareToolSandbox({
      platform: "darwin",
      sandboxExecutableExists: () => true,
      sourceConfigDirectory: source,
      validateProfile: () => true,
    })).rejects.toThrow(UNREADABLE_GLOBAL_CONFIG_MESSAGE);
  });

  it("removes the scratch tree when preparation fails", async () => {
    const source = await makeScratch();
    await writeFile(join(source, "opencode.json"), JSON.stringify({ shell: "/bin/zsh" }));
    const { readdir } = await import("node:fs/promises");
    const temporaryRoot = await realpath(tmpdir());
    const matching = async (): Promise<string[]> =>
      (await readdir(temporaryRoot)).filter((name) => name.startsWith("quoder-tool-sandbox-")).sort();
    // Compare against a baseline rather than an absolute count: unrelated runs may own their own
    // directories, and this test only owns the one its failing call would have created.
    const before = await matching();
    await expect(prepareToolSandbox({
      platform: "darwin",
      sandboxExecutableExists: () => true,
      sourceConfigDirectory: source,
      validateProfile: () => true,
    })).rejects.toThrow(GLOBAL_SHELL_COLLISION_MESSAGE);
    // A leaked scratch directory would leave a mirrored copy of provider credentials behind.
    expect(await matching()).toEqual(before);
  });

  it("mirrors the user's settings, adds the shell, and never writes to the source", async () => {
    const source = await makeScratch();
    await writeFile(join(source, "opencode.json"), JSON.stringify({ theme: "quoder" }));
    await writeFile(join(source, "instructions.md"), "keep me\n");
    const sandbox = await prepareToolSandbox({
      platform: "darwin",
      sandboxExecutableExists: () => true,
      sourceConfigDirectory: source,
      validateProfile: () => true,
    });
    sandboxes.push(sandbox);

    const mirrored = JSON.parse(
      await readFile(join(sandbox.configDirectory, "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(mirrored.theme).toBe("quoder");
    expect(mirrored.shell).toBe(sandbox.shellCommand);
    expect(await readFile(join(sandbox.configDirectory, "instructions.md"), "utf8")).toBe("keep me\n");

    // The real configuration must be untouched.
    const original = JSON.parse(await readFile(join(source, "opencode.json"), "utf8")) as Record<string, unknown>;
    expect(original).toEqual({ theme: "quoder" });
  });

  it("names only realpath-resolved subpaths, since Seatbelt matches resolved paths", async () => {
    const source = await makeScratch();
    const sandbox = await prepareToolSandbox({
      platform: "darwin",
      sandboxExecutableExists: () => true,
      sourceConfigDirectory: source,
      validateProfile: () => true,
    });
    sandboxes.push(sandbox);
    for (const subpath of sandbox.deniedReadSubpaths) {
      expect(subpath).toBe(await realpath(subpath));
    }
    const profile = await readFile(sandbox.profilePath, "utf8");
    // A rule naming the unresolved /var alias would silently fail to match.
    expect(profile).not.toMatch(/\(subpath "\/var\//);
  });

  it("keeps the profile and trampoline private and executable as needed", async () => {
    const source = await makeScratch();
    const sandbox = await prepareToolSandbox({
      platform: "darwin",
      sandboxExecutableExists: () => true,
      sourceConfigDirectory: source,
      validateProfile: () => true,
    });
    sandboxes.push(sandbox);
    expect((await stat(sandbox.profilePath)).mode & 0o777).toBe(0o600);
    expect((await stat(sandbox.shellCommand)).mode & 0o777).toBe(0o700);
  });

  it("works when the user has no existing OpenCode configuration", async () => {
    const sandbox = await prepareToolSandbox({
      platform: "darwin",
      sandboxExecutableExists: () => true,
      sourceConfigDirectory: join(await makeScratch(), "absent"),
      validateProfile: () => true,
    });
    sandboxes.push(sandbox);
    const mirrored = JSON.parse(
      await readFile(join(sandbox.configDirectory, "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(mirrored).toEqual({ shell: sandbox.shellCommand });
  });
});
