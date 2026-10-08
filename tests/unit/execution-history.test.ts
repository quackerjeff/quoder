import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createExecutionHistoryStore,
  EXECUTION_HISTORY_DEFAULT_RETENTION,
  EXECUTION_HISTORY_MAX_BYTES,
  EXECUTION_HISTORY_VERSION,
  resolveExecutionHistoryBaseDirectory,
  validateExecutionHistoryRecord,
  type CompleteExecutionHistoryInput,
  type ExecutionHistoryRecord,
} from "../../src/harness/execution-history.js";

const roots: string[] = [];
const projectName = "private project";
const ids = {
  a: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  b: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  c: "cccccccccccccccccccccccccccccccc",
  d: "dddddddddddddddddddddddddddddddd",
};
const startedAt = "2026-10-07T12:00:00.000Z";
const finishedAt = "2026-10-07T12:00:02.000Z";

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quoder-execution-history-test-"));
  roots.push(root);
  return root;
}

async function makeStore(
  projectRoot: string,
  stateRoot: string,
  createID?: () => string,
  afterDeleteSnapshot?: () => Promise<void>,
) {
  return createExecutionHistoryStore(
    { name: projectName, root: projectRoot },
    {
      storageDirectory: join(stateRoot, "quoder", "history"),
      ...(createID === undefined ? {} : { createID }),
      ...(afterDeleteSnapshot === undefined ? {} : { afterDeleteSnapshot }),
    },
  );
}

const startInput = (start = startedAt) => ({
  startedAt: start,
  branch: "feature/history",
  startingHead: "0123456789abcdef",
  model: { providerID: "ollama", id: "test-model" },
  prompt: "Implement history",
  injectedContext: "Objective: \"Keep it local\"",
});

function completion(overrides: Partial<CompleteExecutionHistoryInput> = {}): CompleteExecutionHistoryInput {
  return {
    finishedAt,
    durationMs: 2_000,
    status: "answered",
    permissionDecisions: [{ action: "bash", resourceCount: 1, reply: "once", replied: true }],
    commands: [{ command: "npm test", status: "succeeded" }],
    toolActivity: [{ tool: "bash", status: "succeeded" }],
    filesChanged: {
      status: "available",
      paths: [{ kind: "modified", path: "src/history.ts", previousPath: null }],
      reason: null,
    },
    finalResponse: "Implemented persistent history.",
    attempts: 1,
    ...overrides,
  };
}

async function completed(store: ReturnType<typeof createExecutionHistoryStore>, id: string, start: string) {
  const created = await store.begin(startInput(start));
  if (created.status !== "created") throw new Error(`Could not create history record: ${created.reason}`);
  const saved = await store.complete(id, completion({ finishedAt: new Date(Date.parse(start) + 1000).toISOString() }));
  if (!saved.ok) throw new Error(`Could not complete history record: ${saved.reason}`);
  return created.record;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("execution history persistence", () => {
  it("resolves XDG and platform state paths with the documented fallbacks", () => {
    expect(resolveExecutionHistoryBaseDirectory({
      environment: { XDG_STATE_HOME: "/state" },
      homeDirectory: "/home/dev",
      platformName: "linux",
    })).toBe("/state/quoder/history");
    expect(resolveExecutionHistoryBaseDirectory({
      environment: {},
      homeDirectory: "/Users/dev",
      platformName: "darwin",
    })).toBe("/Users/dev/Library/Application Support/Quoder/history");
    expect(resolveExecutionHistoryBaseDirectory({
      environment: { XDG_STATE_HOME: "relative-state" },
      homeDirectory: "/home/dev",
      platformName: "linux",
    })).toBe("/home/dev/.local/state/quoder/history");
  });

  it("creates an in-progress record outside the project with private hashed storage", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, projectName);
    const stateRoot = join(root, "state");
    await mkdir(projectRoot);
    const store = await makeStore(projectRoot, stateRoot, () => ids.a);

    const result = await store.begin(startInput());
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.record).toMatchObject({
      id: ids.a,
      status: "in-progress",
      attempts: 0,
      project: { name: projectName, root: projectRoot },
      model: { providerID: "ollama", id: "test-model" },
      prompt: "Implement history",
      injectedContext: "Objective: \"Keep it local\"",
      filesChanged: null,
      finalResponse: null,
    });
    expect(store.directory).toContain(createHash("sha256").update(projectRoot).digest("hex"));
    expect(store.directory).not.toContain(projectName);
    expect(store.directory.startsWith(projectRoot)).toBe(false);
    expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(store.directory, `${ids.a}--in-progress.json`))).mode & 0o777).toBe(0o600);
    expect(await store.list()).toEqual({
      status: "available",
      records: [{ id: ids.a, startedAt, status: "in-progress" }],
    });
  });

  it("finalizes and retrieves all approved record fields with the start-time ordering intact", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = await makeStore(projectRoot, join(root, "state"), () => ids.a);
    const started = await store.begin(startInput());
    expect(started.status).toBe("created");
    if (started.status !== "created") return;

    await expect(store.complete(ids.a, completion())).resolves.toEqual({ ok: true });
    const result = await store.get(ids.a);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.record).toMatchObject({
      version: EXECUTION_HISTORY_VERSION,
      id: ids.a,
      startedAt,
      finishedAt,
      durationMs: 2_000,
      branch: "feature/history",
      startingHead: "0123456789abcdef",
      permissionDecisions: [{ action: "bash", resourceCount: 1, reply: "once", replied: true }],
      commands: [{ command: "npm test", status: "succeeded" }],
      toolActivity: [{ tool: "bash", status: "succeeded" }],
      filesChanged: { status: "available", paths: [{ kind: "modified", path: "src/history.ts", previousPath: null }] },
      finalResponse: "Implemented persistent history.",
      status: "answered",
      attempts: 1,
    });
    expect(validateExecutionHistoryRecord(result.record)).toBe(true);
    expect(await readdir(store.directory)).toContain(`${ids.a}--answered.json`);
    expect(await readdir(store.directory)).not.toContain(`${ids.a}--in-progress.json`);
    expect(await store.list()).toEqual({ status: "available", records: [{ id: ids.a, startedAt, status: "answered" }] });
  });

  it("keeps IDs unique across existing states and retries a colliding generated ID", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const sequence = [ids.a, ids.a, ids.b];
    const store = await makeStore(projectRoot, join(root, "state"), () => sequence.shift() ?? ids.c);
    const first = await store.begin(startInput());
    await store.complete(ids.a, completion());
    const second = await store.begin(startInput());
    expect(first).toMatchObject({ status: "created", record: { id: ids.a } });
    expect(second).toMatchObject({ status: "created", record: { id: ids.b } });
  });

  it("allocates distinct run IDs when independent stores begin concurrently", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const stores = Array.from({ length: 12 }, () => createExecutionHistoryStore(
      { name: projectName, root: projectRoot },
      { storageDirectory: join(root, "state", "quoder", "history") },
    ));
    const results = await Promise.all(stores.map((store, index) => store.begin(startInput(
      new Date(Date.parse(startedAt) + index).toISOString(),
    ))));
    const created = results.flatMap((result) => result.status === "created" ? [result.record] : []);
    expect(created).toHaveLength(stores.length);
    expect(new Set(created.map((record) => record.id)).size).toBe(stores.length);
  });

  it("keeps projects isolated and does not expose roots in record filenames", async () => {
    const root = await temporaryDirectory();
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
    const stateRoot = join(root, "state");
    const storeA = await makeStore(projectA, stateRoot, () => ids.a);
    const storeB = await makeStore(projectB, stateRoot, () => ids.b);
    await storeA.begin(startInput());

    expect((await storeB.list())).toEqual({ status: "available", records: [] });
    expect(storeA.directory).not.toBe(storeB.directory);
    expect((await readdir(storeA.directory)).some((name) => name.includes(projectA))).toBe(false);
  });

  it("lists by start time without reading record bodies", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const sequence = [ids.a, ids.b, ids.c];
    const store = await makeStore(projectRoot, join(root, "state"), () => sequence.shift() ?? ids.d);
    await store.begin(startInput("2026-10-07T12:00:00.000Z"));
    await store.begin(startInput("2026-10-07T12:00:02.000Z"));
    await store.begin(startInput("2026-10-07T12:00:01.000Z"));

    const listing = await store.list(2);
    expect(listing).toMatchObject({ status: "available", records: [{ id: ids.b }, { id: ids.c }] });
  });

  it("uses default retention and prunes oldest completed records when the limit changes", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const sequence = [ids.a, ids.b, ids.c];
    const store = await makeStore(projectRoot, join(root, "state"), () => sequence.shift() ?? ids.d);
    await expect(store.retention()).resolves.toEqual({ status: "available", maxCompletedRecords: EXECUTION_HISTORY_DEFAULT_RETENTION });

    for (const [offset, id] of [[0, ids.a], [1, ids.b], [2, ids.c]] as const) {
      await completed(store, id, new Date(Date.parse(startedAt) + offset * 1_000).toISOString());
    }
    await expect(store.setRetention(2)).resolves.toEqual({ ok: true });
    await expect(store.retention()).resolves.toEqual({ status: "available", maxCompletedRecords: 2 });
    await expect(store.get(ids.a)).resolves.toEqual({ status: "missing" });
    await expect(store.list()).resolves.toMatchObject({ status: "available", records: [{ id: ids.c }, { id: ids.b }] });
  });

  it("rejects invalid retention and preserves corrupt settings for manual recovery", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = await makeStore(projectRoot, join(root, "state"), () => ids.a);
    expect(await store.setRetention(0)).toEqual({ ok: false, reason: "invalid-data" });
    await store.retention();
    const settingsPath = join(store.directory, "settings.json");
    const original = "{broken";
    await writeFile(settingsPath, original, { mode: 0o600 });
    await expect(store.retention()).resolves.toEqual({ status: "unavailable", reason: "corrupt" });
    await expect(store.setRetention(8)).resolves.toEqual({ ok: false, reason: "corrupt" });
    expect(await readFile(settingsPath, "utf8")).toBe(original);
    await expect(store.retention()).resolves.toEqual({ status: "unavailable", reason: "corrupt" });
  });

  it("preflights history clear and preserves malformed record sources", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = await makeStore(projectRoot, join(root, "state"), () => ids.a);
    await store.begin(startInput());
    const recordPath = join(store.directory, `${ids.a}--in-progress.json`);
    const original = "{malformed-record";
    await writeFile(recordPath, original, { mode: 0o600 });

    await expect(store.delete(ids.a)).resolves.toEqual({ status: "unavailable", reason: "corrupt" });
    await expect(store.clearAll()).resolves.toEqual({ status: "unavailable", reason: "corrupt" });
    expect(await readFile(recordPath, "utf8")).toBe(original);
  });

  it("deletes exact IDs, preserves tombstones against concurrent finalization, and clears project history", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const sequence = [ids.a, ids.b];
    const store = await makeStore(projectRoot, join(root, "state"), () => sequence.shift() ?? ids.c);
    await store.begin(startInput());
    await expect(store.delete(ids.a)).resolves.toEqual({ status: "deleted" });
    await expect(store.complete(ids.a, completion())).resolves.toEqual({ ok: false, reason: "invalid-data" });
    expect(await store.list()).toEqual({ status: "available", records: [] });
    const replacement = await store.begin(startInput());
    expect(replacement).toMatchObject({ status: "created", record: { id: ids.b } });
    await expect(store.clearAll()).resolves.toMatchObject({ status: "cleared", deleted: 1 });
    await expect(store.get(ids.b)).resolves.toEqual({ status: "missing" });
  });

  it("removes a finalized record when deletion races between its filename snapshot and tombstone", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    let signalSnapshot: () => void = () => undefined;
    let releaseDelete: () => void = () => undefined;
    const snapshotTaken = new Promise<void>((resolveSnapshot) => { signalSnapshot = resolveSnapshot; });
    const holdDelete = new Promise<void>((resolveDelete) => { releaseDelete = resolveDelete; });
    const store = await makeStore(projectRoot, join(root, "state"), () => ids.a, async () => {
      signalSnapshot();
      await holdDelete;
    });
    const started = await store.begin(startInput());
    expect(started.status).toBe("created");

    const deleting = store.delete(ids.a);
    await snapshotTaken;
    await expect(store.complete(ids.a, completion())).resolves.toEqual({ ok: true });
    releaseDelete();
    await expect(deleting).resolves.toEqual({ status: "deleted" });

    await expect(store.get(ids.a)).resolves.toEqual({ status: "missing" });
    expect(await readdir(store.directory)).not.toContain(`${ids.a}--answered.json`);
  });

  it("leaves interrupted records in progress and permits only valid terminal outcomes", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = await makeStore(projectRoot, join(root, "state"), () => ids.a);
    await store.begin(startInput());

    const restartedStore = await makeStore(projectRoot, join(root, "state"), () => ids.b);
    await expect(restartedStore.get(ids.a)).resolves.toMatchObject({ status: "found", record: { status: "in-progress", finishedAt: null, durationMs: null } });
    await expect(restartedStore.complete(ids.a, completion({ status: "failed", finalResponse: null, failureStage: "server-start", attempts: 0 })))
      .resolves.toEqual({ ok: true });
  });

  it("reports malformed and unsupported records without exposing file contents", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = await makeStore(projectRoot, join(root, "state"), () => ids.a);
    await store.begin(startInput());
    const recordPath = join(store.directory, `${ids.a}--in-progress.json`);
    await writeFile(recordPath, "{broken", { mode: 0o600 });
    await expect(store.get(ids.a)).resolves.toEqual({ status: "unavailable", reason: "corrupt" });
    await writeFile(recordPath, JSON.stringify({ version: EXECUTION_HISTORY_VERSION + 1 }), { mode: 0o600 });
    await expect(store.get(ids.a)).resolves.toEqual({ status: "unavailable", reason: "unsupported-version" });
  });

  it("rejects symlink records and storage paths inside the project", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = await makeStore(projectRoot, join(root, "state"), () => ids.a);
    await store.begin(startInput());
    const recordPath = join(store.directory, `${ids.a}--in-progress.json`);
    const target = join(projectRoot, "sentinel.txt");
    await writeFile(target, "keep me");
    await unlink(recordPath);
    await symlink(target, recordPath);
    await expect(store.get(ids.a)).resolves.toEqual({ status: "unavailable", reason: "unsafe-path" });
    expect(await readFile(target, "utf8")).toBe("keep me");

    const unsafeStore = createExecutionHistoryStore({ name: "project", root: projectRoot }, {
      storageDirectory: join(projectRoot, ".quoder", "history"),
      createID: () => ids.b,
    });
    await expect(unsafeStore.begin(startInput())).resolves.toEqual({ status: "unavailable", reason: "unsafe-path" });
  });

  it("rejects malformed schema values and oversized documents", async () => {
    const valid: ExecutionHistoryRecord = {
      version: EXECUTION_HISTORY_VERSION,
      id: ids.a,
      startedAt,
      finishedAt,
      durationMs: 2_000,
      project: { name: projectName, root: "/project" },
      branch: "main",
      startingHead: null,
      model: { providerID: "ollama", id: "model" },
      agent: null,
      prompt: "prompt",
      injectedContext: "context",
      permissionDecisions: [],
      commands: [],
      toolActivity: [],
      filesChanged: { status: "available", paths: [], reason: null },
      finalResponse: "answer",
      status: "answered",
      attempts: 1,
      failureStage: null,
    };
    expect(validateExecutionHistoryRecord(valid)).toBe(true);
    expect(validateExecutionHistoryRecord({ ...valid, attempts: 3 })).toBe(false);
    expect(validateExecutionHistoryRecord({ ...valid, status: "in-progress" })).toBe(false);
  });

  it("refuses a serialized record above the 32 MiB ceiling without creating a partial run", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = await makeStore(projectRoot, join(root, "state"), () => ids.a);
    const result = await store.begin({ ...startInput(), prompt: "x".repeat(EXECUTION_HISTORY_MAX_BYTES) });

    expect(result).toEqual({ status: "unavailable", reason: "oversized" });
    expect(await store.list()).toEqual({ status: "available", records: [] });
    expect((await readdir(store.directory)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("ignores fresh temp files and removes them only after the stale threshold", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = await makeStore(projectRoot, join(root, "state"), () => ids.a);
    await store.begin(startInput());
    const freshTemporary = join(store.directory, `.history-${"e".repeat(24)}.tmp`);
    const staleTemporary = join(store.directory, `.history-${"f".repeat(24)}.tmp`);
    await writeFile(freshTemporary, "partial record", { mode: 0o600 });
    await writeFile(staleTemporary, "abandoned partial record", { mode: 0o600 });
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(staleTemporary, staleDate, staleDate);

    expect((await store.list()).status).toBe("available");
    const restartedStore = await makeStore(projectRoot, join(root, "state"), () => ids.b);
    expect((await restartedStore.list()).status).toBe("available");
    expect((await lstat(freshTemporary)).isFile()).toBe(true);
    await expect(lstat(staleTemporary)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
