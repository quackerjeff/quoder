import { execFileSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureGitSnapshot, compareGitSnapshots } from "../../src/harness/git-state.js";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quoder-git-state-test-"));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
}

async function repository(): Promise<string> {
  const root = await temporaryDirectory();
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.name", "Quoder Fixture");
  git(root, "config", "user.email", "quoder-fixture@example.invalid");
  await writeFile(join(root, "modified.txt"), "baseline\n");
  await writeFile(join(root, "deleted.txt"), "remove me\n");
  await writeFile(join(root, "rename-before.txt"), "rename me\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture baseline");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Git state snapshots", () => {
  it("captures a clean branch, HEAD, and empty status", async () => {
    const root = await repository();
    const snapshot = await captureGitSnapshot(root);

    expect(snapshot).toMatchObject({
      kind: "available",
      root,
      branch: "main",
      branchState: "attached",
      paths: [],
      untrackedPaths: [],
      trackedDiff: { files: 0, additions: 0, deletions: 0, binaryFiles: 0 },
    });
    expect(snapshot.kind === "available" && snapshot.head).toMatch(/^[0-9a-f]{40,64}$/u);
  });

  it("captures staged and unstaged paths, untracked paths, deletions, renames, and unusual names", async () => {
    const root = await repository();
    const baseline = await captureGitSnapshot(root);
    await writeFile(join(root, "modified.txt"), "baseline\nworking change\n");
    await writeFile(join(root, "staged.txt"), "first\n");
    git(root, "add", "staged.txt");
    await writeFile(join(root, "staged.txt"), "first\nsecond\n");
    await rm(join(root, "deleted.txt"));
    git(root, "mv", "rename-before.txt", "rename-after.txt");
    await writeFile(join(root, "untracked file.txt"), "new file\n");
    const unusual = "control-\u001b-tab\tline\nname.txt";
    await writeFile(join(root, unusual), "odd name\n");
    const final = await captureGitSnapshot(root);

    expect(final.kind).toBe("available");
    if (final.kind !== "available" || baseline.kind !== "available") throw new Error("Expected Git snapshots");
    expect(final.paths.map(({ path }) => path)).toEqual(expect.arrayContaining([
      "modified.txt", "staged.txt", "deleted.txt", "rename-after.txt", "untracked file.txt", unusual,
    ]));
    expect(final.untrackedPaths).toEqual(expect.arrayContaining(["untracked file.txt", unusual]));
    expect(final.paths.find(({ path }) => path === "rename-after.txt")).toMatchObject({
      originalPath: "rename-before.txt",
      kind: "tracked",
    });
    expect(final.trackedDiff).toMatchObject({ files: 4, additions: 3, deletions: 1, binaryFiles: 0 });

    const comparison = await compareGitSnapshots(baseline, final);
    expect(comparison.observedChanges).toEqual(expect.arrayContaining([
      { kind: "modified", path: "modified.txt" },
      { kind: "added", path: "staged.txt" },
      { kind: "deleted", path: "deleted.txt" },
      { kind: "renamed", path: "rename-after.txt", previousPath: "rename-before.txt" },
      { kind: "added", path: "untracked file.txt" },
    ]));
  });

  it("keeps dirty-baseline paths in the pre-existing group instead of attributing edits", async () => {
    const root = await repository();
    await writeFile(join(root, "modified.txt"), "pre-existing edit\n");
    const baseline = await captureGitSnapshot(root);
    await writeFile(join(root, "modified.txt"), "changed again during prompt\n");
    git(root, "add", "modified.txt");
    const final = await captureGitSnapshot(root);

    const comparison = await compareGitSnapshots(baseline, final);
    expect(comparison.preExistingPaths).toContainEqual({ path: "modified.txt", baselinePath: "modified.txt", statusChanged: true });
    expect(comparison.observedChanges).not.toContainEqual(expect.objectContaining({ path: "modified.txt" }));
  });

  it("reports binary numstat and committed tree changes when HEAD moves", async () => {
    const root = await repository();
    const baseline = await captureGitSnapshot(root);
    await writeFile(join(root, "modified.txt"), "baseline\ncommitted line\n");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 3, 255]));
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "prompt fixture commit");
    const final = await captureGitSnapshot(root);

    expect(final.kind).toBe("available");
    if (final.kind !== "available") throw new Error("Expected final snapshot");
    expect(final.trackedDiff.binaryFiles).toBe(0);
    const committed = await compareGitSnapshots(baseline, final);
    expect(committed.headChanged).toBe(true);
    expect(committed.committedDiff).toMatchObject({ files: 2, additions: undefined, deletions: undefined, binaryFiles: 1 });
  });

  it("recognizes an unborn repository and reports non-repository state explicitly", async () => {
    const unbornRoot = await temporaryDirectory();
    git(unbornRoot, "init", "--quiet", "--initial-branch=empty");
    const unborn = await captureGitSnapshot(unbornRoot);
    expect(unborn).toMatchObject({ kind: "available", branch: "empty", branchState: "unborn", head: undefined });
    await writeFile(join(unbornRoot, "first.txt"), "first commit\n");
    git(unbornRoot, "add", "first.txt");
    git(unbornRoot, "commit", "--quiet", "-m", "first commit");
    const firstCommit = await captureGitSnapshot(unbornRoot);
    const initialDelta = await compareGitSnapshots(unborn, firstCommit);
    expect(initialDelta.headChanged).toBe(true);
    expect(initialDelta.committedDiff).toMatchObject({ files: 1, additions: 1, deletions: 0, binaryFiles: 0 });

    const outside = await temporaryDirectory();
    await mkdir(join(outside, "child"));
    expect(await captureGitSnapshot(outside)).toEqual({ kind: "unavailable", root: outside, reason: "not-repository" });
  });

  it("recognizes detached HEAD and does not execute configured Git helpers", async () => {
    const root = await repository();
    git(root, "checkout", "--quiet", "--detach");
    const marker = join(root, "helper-ran");
    const helper = join(root, "fixture-helper");
    await writeFile(helper, `#!/bin/sh\nprintf invoked > ${marker}\nprintf '\\n'\n`);
    await chmod(helper, 0o700);
    git(root, "config", "core.fsmonitor", helper);
    git(root, "config", "diff.external", helper);

    const snapshot = await captureGitSnapshot(root);

    expect(snapshot).toMatchObject({ kind: "available", branch: undefined, branchState: "detached" });
    await expect(access(marker)).rejects.toThrow();
  });

  it("uses the requested project root despite inherited Git directory overrides", async () => {
    const root = await repository();
    const otherRoot = await repository();
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(otherRoot, ".git");
    try {
      const snapshot = await captureGitSnapshot(root);
      expect(snapshot).toMatchObject({ kind: "available", root, branch: "main" });
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("reports a repository command failure without mistaking it for a clean state", async () => {
    const root = await repository();
    git(root, "config", "core.repositoryformatversion", "99");

    await expect(captureGitSnapshot(root)).resolves.toEqual({
      kind: "unavailable",
      root,
      reason: "command-failed",
    });
  });

  it("classifies subprocess output and timeout limits", async () => {
    const root = await repository();

    await expect(captureGitSnapshot(root, { maxBufferBytes: 32 })).resolves.toMatchObject({
      kind: "unavailable",
      reason: "output-limit",
    });
    await expect(captureGitSnapshot(root, { timeoutMs: 1 })).resolves.toMatchObject({
      kind: "unavailable",
      reason: "timed-out",
    });
  });

  it("keeps final-state status available when only one endpoint cannot be compared", async () => {
    const root = await repository();
    const outside = await temporaryDirectory();
    const unavailable = await captureGitSnapshot(outside);
    const final = await captureGitSnapshot(root);
    const comparison = await compareGitSnapshots(unavailable, final);

    expect(comparison).toMatchObject({ kind: "unavailable", observedChanges: [], committedDiff: undefined });
    expect(comparison.after).toBe(final);
  });
});
