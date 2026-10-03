import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { authenticatedServerProcessConfig } from "../../src/opencode-server.js";
import { findPackageRoot, opencodeExecutablePath, packagePath } from "../../src/package-root.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

describe("package-relative resolution", () => {
  it("finds Quoder's package root from its own modules and from nested directories", () => {
    expect(findPackageRoot()).toBe(repositoryRoot);
    expect(findPackageRoot(join(repositoryRoot, "src"))).toBe(repositoryRoot);
    expect(findPackageRoot(join(repositoryRoot, "node_modules", "opencode-ai"))).toBe(repositoryRoot);
  });

  it("does not depend on the working directory", () => {
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(findPackageRoot()).toBe(repositoryRoot);
      expect(opencodeExecutablePath()).toBe(join(repositoryRoot, "node_modules", ".bin", "opencode"));
      expect(packagePath("package.json")).toBe(join(repositoryRoot, "package.json"));
      expect(authenticatedServerProcessConfig({ username: "quoder", password: "x" }).executable).toBe(
        join(repositoryRoot, "node_modules", ".bin", "opencode"),
      );
    } finally {
      process.chdir(original);
    }
  });

  it("rejects a directory tree that only contains other packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-package-root-test-"));
    try {
      const nested = join(root, "project", "src");
      await mkdir(nested, { recursive: true });
      await writeFile(join(root, "project", "package.json"), JSON.stringify({ name: "quacktrack" }), "utf8");
      await writeFile(join(root, "package.json"), "not json", "utf8");
      expect(() => findPackageRoot(nested)).toThrow("Quoder package root not found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("server working directory", () => {
  it("passes an optional cwd to the server process configuration", () => {
    expect(authenticatedServerProcessConfig({ username: "u", password: "p" })).not.toHaveProperty("cwd");
    expect(authenticatedServerProcessConfig({ username: "u", password: "p", cwd: "/work/QuackTrack" }).cwd).toBe("/work/QuackTrack");
  });
});
