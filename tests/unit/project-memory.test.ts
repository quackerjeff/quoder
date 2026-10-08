import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProjectMemoryStore,
  emptyProjectMemory,
  PROJECT_MEMORY_MAX_BYTES,
  resolveProjectMemoryDirectory,
  validateProjectMemory,
  type ProjectMemory,
} from "../../src/harness/project-memory.js";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quoder-project-memory-test-"));
  roots.push(root);
  return root;
}

function storeFor(projectRoot: string, stateRoot: string) {
  return createProjectMemoryStore(projectRoot, { storageDirectory: join(stateRoot, "Quoder", "context") });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project memory persistence", () => {
  it("chooses the XDG or platform default state directory", () => {
    expect(resolveProjectMemoryDirectory({
      environment: { XDG_STATE_HOME: "/state" },
      homeDirectory: "/home/dev",
      platformName: "linux",
    })).toBe("/state/quoder/context");
    expect(resolveProjectMemoryDirectory({
      environment: {},
      homeDirectory: "/Users/dev",
      platformName: "darwin",
    })).toBe("/Users/dev/Library/Application Support/Quoder/context");
    expect(resolveProjectMemoryDirectory({
      environment: {},
      homeDirectory: "/home/dev",
      platformName: "linux",
    })).toBe("/home/dev/.local/state/quoder/context");
    expect(resolveProjectMemoryDirectory({
      environment: { XDG_STATE_HOME: "relative-state" },
      homeDirectory: "/home/dev",
      platformName: "linux",
    })).toBe("/home/dev/.local/state/quoder/context");
  });

  it("loads an empty default without writing into the project and uses a hashed filename", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "my-private-project");
    const stateRoot = join(root, "user-state");
    await mkdir(project);
    const store = storeFor(project, stateRoot);

    await expect(store.load()).resolves.toEqual({ status: "missing", memory: emptyProjectMemory() });
    expect(store.filePath).toContain(createHash("sha256").update(project).digest("hex"));
    expect(store.filePath).not.toContain("my-private-project");
    await expect(lstat(join(project, "context.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips valid memory in a 0700 directory and 0600 file", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const store = storeFor(project, join(root, "state"));
    await mkdir(project);
    const memory: ProjectMemory = {
      ...emptyProjectMemory(),
      objective: "Ship import support",
      task: "Validate headers",
      decisions: ["Keep CSV parsing dependency-free"],
      constraints: ["Do not persist Git diffs"],
      unresolvedIssues: ["Add malformed-row coverage"],
      previousExecution: {
        requestExcerpt: "Implement CSV import",
        responseExcerpt: "The parser now validates headers and reports row numbers.",
        requestTruncated: false,
        responseTruncated: false,
      },
      automaticSummary: false,
    };

    await expect(store.save(memory)).resolves.toEqual({ ok: true });
    await expect(store.load()).resolves.toEqual({ status: "loaded", memory });
    expect((await lstat(join(root, "state", "Quoder"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "state", "Quoder", "context"))).mode & 0o777).toBe(0o700);
    expect((await lstat(store.filePath)).mode & 0o777).toBe(0o600);
  });

  it("restricts an existing owned state file to 0600 when it is loaded", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const store = storeFor(project, join(root, "state"));
    await mkdir(project);
    await store.save(emptyProjectMemory());
    await chmod(store.filePath, 0o644);

    await expect(store.load()).resolves.toMatchObject({ status: "loaded" });
    expect((await lstat(store.filePath)).mode & 0o777).toBe(0o600);
  });

  it("isolates documents by project root", async () => {
    const root = await temporaryDirectory();
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    const stateRoot = join(root, "state");
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
    const storeA = storeFor(projectA, stateRoot);
    const storeB = storeFor(projectB, stateRoot);

    await storeA.save({ ...emptyProjectMemory(), objective: "Project A" });
    await expect(storeB.load()).resolves.toMatchObject({ status: "missing" });
    expect(storeA.filePath).not.toBe(storeB.filePath);
  });

  it("rejects malformed and unsupported documents without overwriting or clearing them", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const store = storeFor(project, join(root, "state"));
    await mkdir(project);
    await store.load();
    const original = "{not valid json";
    await writeFile(store.filePath, original, { mode: 0o600 });

    await expect(store.load()).resolves.toEqual({ status: "unavailable", reason: "corrupt" });
    await expect(store.save({ ...emptyProjectMemory(), objective: "Should not replace corruption" }))
      .resolves.toEqual({ ok: false, reason: "corrupt" });
    expect(await readFile(store.filePath, "utf8")).toBe(original);
    await expect(store.clear()).resolves.toEqual({ ok: false, reason: "corrupt" });
    expect(await readFile(store.filePath, "utf8")).toBe(original);

    const unsupported = JSON.stringify({ ...emptyProjectMemory(), version: 2 });
    await writeFile(store.filePath, unsupported, { mode: 0o600 });
    await expect(store.load()).resolves.toEqual({ status: "unavailable", reason: "unsupported-version" });
    await expect(store.save(emptyProjectMemory())).resolves.toEqual({ ok: false, reason: "unsupported-version" });
    await expect(store.clear()).resolves.toEqual({ ok: false, reason: "unsupported-version" });
    expect(JSON.parse(await readFile(store.filePath, "utf8")).version).toBe(2);
    expect(await readFile(store.filePath, "utf8")).toBe(unsupported);
  });

  it("rejects invalid UTF-8 and oversized disk documents", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const store = storeFor(project, join(root, "state"));
    await mkdir(project);
    await store.load();
    await writeFile(store.filePath, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    await expect(store.load()).resolves.toEqual({ status: "unavailable", reason: "corrupt" });
    await writeFile(store.filePath, Buffer.alloc(PROJECT_MEMORY_MAX_BYTES + 1, 0x20));
    await expect(store.load()).resolves.toEqual({ status: "unavailable", reason: "oversized" });
  });

  it("ignores a partial temporary file left by an interrupted replacement", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const store = storeFor(project, join(root, "state"));
    await mkdir(project);
    const durable = { ...emptyProjectMemory(), objective: "Last committed state" };
    await store.save(durable);
    await writeFile(join(dirname(store.filePath), ".interrupted-write.tmp"), "{ partial json");

    await expect(store.load()).resolves.toEqual({ status: "loaded", memory: durable });
    await expect(store.save({ ...durable, objective: "Next committed state" })).resolves.toEqual({ ok: true });
    await expect(store.load()).resolves.toMatchObject({ status: "loaded", memory: { objective: "Next committed state" } });
  });

  it("validates fields, code-point limits, list bounds, and the serialized byte ceiling", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const store = storeFor(project, join(root, "state"));
    await mkdir(project);
    const valid = emptyProjectMemory();

    expect(validateProjectMemory({ ...valid, objective: "🙂".repeat(500) })).toBe(true);
    expect(validateProjectMemory({ ...valid, objective: "🙂".repeat(501) })).toBe(false);
    expect(validateProjectMemory({ ...valid, decisions: Array.from({ length: 21 }, () => "item") })).toBe(false);
    const oversized: ProjectMemory = {
      ...valid,
      decisions: Array.from({ length: 20 }, () => "🙂".repeat(500)),
      constraints: Array.from({ length: 20 }, () => "🙂".repeat(500)),
      unresolvedIssues: Array.from({ length: 20 }, () => "🙂".repeat(500)),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(PROJECT_MEMORY_MAX_BYTES);
    expect(validateProjectMemory(oversized)).toBe(false);
    const durable = { ...valid, objective: "Preserve this" };
    await store.save(durable);
    await expect(store.save(oversized)).resolves.toEqual({ ok: false, reason: "oversized" });
    await expect(store.load()).resolves.toEqual({ status: "loaded", memory: durable });
  });

  it("refuses storage paths that resolve inside the project", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    await mkdir(project);
    const store = createProjectMemoryStore(project, { storageDirectory: join(project, ".quoder", "context") });

    await expect(store.load()).resolves.toEqual({ status: "unavailable", reason: "unsafe-path" });
    await expect(store.save(emptyProjectMemory())).resolves.toEqual({ ok: false, reason: "unsafe-path" });
    await expect(lstat(join(project, ".quoder"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns a fixed unsafe-path failure when an app directory component is not a directory", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(project);
    await mkdir(stateRoot);
    await writeFile(join(stateRoot, "Quoder"), "not a directory");
    const store = storeFor(project, stateRoot);

    await expect(store.load()).resolves.toEqual({ status: "unavailable", reason: "unsafe-path" });
    await expect(store.save(emptyProjectMemory())).resolves.toEqual({ ok: false, reason: "unsafe-path" });
  });

  it("does not follow a project-key file symlink during load, save, or clear", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(project);
    const store = storeFor(project, stateRoot);
    await store.load();
    const target = join(project, "sentinel.txt");
    await writeFile(target, "leave untouched");
    await symlink(target, store.filePath);

    await expect(store.load()).resolves.toEqual({ status: "unavailable", reason: "unsafe-path" });
    await expect(store.save(emptyProjectMemory())).resolves.toEqual({ ok: false, reason: "unsafe-path" });
    await expect(store.clear()).resolves.toEqual({ ok: false, reason: "unsafe-path" });
    expect(await readFile(target, "utf8")).toBe("leave untouched");
  });

  it("keeps concurrent complete replacements parseable with last-writer-wins semantics", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const store = storeFor(project, join(root, "state"));
    await mkdir(project);

    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.save({ ...emptyProjectMemory(), objective: `writer-${index}` }),
    ));
    expect(results.every((result) => result.ok)).toBe(true);
    const loaded = await store.load();
    expect(loaded.status).toBe("loaded");
    if (loaded.status !== "loaded") throw new Error("Expected a complete document");
    expect(loaded.memory.objective).toMatch(/^writer-\d+$/u);
    const directoryEntries = await readdir(join(root, "state", "Quoder", "context"));
    expect(directoryEntries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("detects an application-directory symlink that points into the project", async () => {
    const root = await temporaryDirectory();
    const project = join(root, "project");
    const stateRoot = join(root, "state");
    await mkdir(project);
    await mkdir(stateRoot);
    await symlink(project, join(stateRoot, "Quoder"));
    const store = storeFor(project, stateRoot);

    await expect(store.load()).resolves.toEqual({ status: "unavailable", reason: "unsafe-path" });
  });
});
