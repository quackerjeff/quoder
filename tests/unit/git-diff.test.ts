import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureGitDiff, hasInspectableGitDiff, MAX_GIT_DIFF_BYTES } from "../../src/harness/git-diff.js";
import { captureGitSnapshot, compareGitSnapshots } from "../../src/harness/git-state.js";

const roots: string[] = [];
const temporaryDirectory = async () => {
  const root = await mkdtemp(join(tmpdir(), "quoder-git-diff-test-"));
  roots.push(root);
  return root;
};
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const repository = async () => {
  const root = await temporaryDirectory();
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.name", "Quoder Fixture");
  git(root, "config", "user.email", "quoder-fixture@example.invalid");
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "baseline");
  return root;
};

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("read-only Git diff capture", () => {
  it("captures staged, unstaged, and untracked text while omitting binary content", async () => {
    const root = await repository();
    const before = await captureGitSnapshot(root);
    await writeFile(join(root, "tracked.txt"), "staged\n");
    git(root, "add", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "staged\nunstaged\n");
    await writeFile(join(root, "new.txt"), "new text\n");
    await writeFile(join(root, "binary-new.bin"), Buffer.from([0, 4, 5]));
    const after = await captureGitSnapshot(root);
    const comparison = await compareGitSnapshots(before, after);
    const result = await captureGitDiff(comparison);
    expect(hasInspectableGitDiff(comparison)).toBe(true);
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.text).toContain("+staged");
    expect(result.text).toContain("+unstaged");
    expect(result.text).toContain("+new text");
    expect(result.text).toContain("binary untracked file; content omitted");
    expect(result.text).not.toContain("\u0000");
  });

  it("sanitizes terminal controls from tracked content and path names and enforces the byte cap", async () => {
    const root = await repository();
    const before = await captureGitSnapshot(root);
    await writeFile(join(root, "tracked.txt"), `\u001b[31m${"é".repeat(MAX_GIT_DIFF_BYTES)}\u001b[0m\n`);
    await writeFile(join(root, "new\u001b[2J.txt"), "safe\n");
    const after = await captureGitSnapshot(root);
    const result = await captureGitDiff(await compareGitSnapshots(before, after));
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(MAX_GIT_DIFF_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.omittedBytes).toBeGreaterThan(0);
    expect(result.text).not.toContain("\u001b");
  });

  it("never reads untracked symlink targets outside the project", async () => {
    const root = await repository();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, "secret.txt"), "outside secret\n");
    await symlink(join(outside, "secret.txt"), join(root, "outside-link"));
    const snapshot = await captureGitSnapshot(root);
    const result = await captureGitDiff(await compareGitSnapshots(snapshot, snapshot));
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.text).toContain("symlink, unsafe path, or not a regular file");
    expect(result.text).not.toContain("outside secret");
  });

  it("rejects a symlinked parent component when reading an untracked path", async () => {
    const root = await repository();
    const outside = await temporaryDirectory();
    const parent = join(root, "parent");
    await writeFile(join(outside, "candidate.txt"), "outside secret");
    await symlink(outside, parent);
    const snapshot = await captureGitSnapshot(root);
    if (snapshot.kind !== "available") throw new Error("Expected a Git snapshot");
    const after = { ...snapshot, untrackedPaths: ["parent/candidate.txt"] };
    const comparison = await compareGitSnapshots(snapshot, after);

    const result = await captureGitDiff(comparison);
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.text).toContain("symlink, unsafe path, or not a regular file");
    expect(result.text).not.toContain("outside secret");
  });
});
