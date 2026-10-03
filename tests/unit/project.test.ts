import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { gitTopLevel, resolveProject } from "../../src/harness/project.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

describe("project resolution", () => {
  it("uses the Git repository root and its directory name", async () => {
    await expect(resolveProject("/work/QuackTrack/src", async () => "/work/QuackTrack")).resolves.toEqual({
      root: "/work/QuackTrack",
      name: "QuackTrack",
    });
  });

  it("falls back to the launch directory outside a repository", async () => {
    await expect(resolveProject("/tmp/scratch-project", async () => undefined)).resolves.toEqual({
      root: "/tmp/scratch-project",
      name: "scratch-project",
    });
  });

  it("finds the real repository root from a subdirectory with git", async () => {
    expect(await gitTopLevel(join(repositoryRoot, "src"))).toBe(await realpath(repositoryRoot));
  });

  it("reports no repository for a directory outside one", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoder-project-test-"));
    try {
      await mkdir(join(root, "nested"));
      expect(await gitTopLevel(join(root, "nested"))).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
