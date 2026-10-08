import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createOwnedSessionLedger,
  resolveOwnedSessionLedgerDirectory,
} from "../../src/harness/owned-session-ledger.js";

const roots: string[] = [];
const makeRoots = async () => {
  const root = await mkdtemp(join(tmpdir(), "quoder-owned-session-ledger-"));
  roots.push(root);
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  return { root, project, state };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("owned OpenCode session ledger", () => {
  it("publishes an intent before creation and preserves its state across store instances", async () => {
    const { project, state } = await makeRoots();
    const options = { storageDirectory: state, createNonce: () => "a".repeat(24), now: () => new Date("2026-10-08T00:00:00.000Z") };
    const first = createOwnedSessionLedger(project, options);
    const id = `ses_${"1".repeat(24)}`;

    await first.prepare(id);

    const restarted = createOwnedSessionLedger(project, options);
    await expect(restarted.list()).resolves.toMatchObject({
      status: "available",
      records: [{ id, projectRoot: project, state: "intent", createdAt: "2026-10-08T00:00:00.000Z" }],
    });
    await restarted.markCreated(id);
    await expect(first.list()).resolves.toMatchObject({ status: "available", records: [{ id, state: "created" }] });
  });

  it("refuses ID conflicts and keeps an explicitly ambiguous create out of cleanup candidates", async () => {
    const { project, state } = await makeRoots();
    const ledger = createOwnedSessionLedger(project, { storageDirectory: state, createNonce: () => "b".repeat(24) });
    const id = `ses_${"2".repeat(24)}`;

    await ledger.prepare(id);
    await expect(ledger.prepare(id)).rejects.toBeDefined();
    await ledger.markAmbiguous(id);

    await expect(ledger.list()).resolves.toMatchObject({ status: "available", records: [{ id, state: "ambiguous" }] });
  });

  it("leaves a failed ambiguous transition as report-only intent across a new store instance", async () => {
    const { project, state } = await makeRoots();
    const firstNonce = "d".repeat(24);
    const blockedNonce = "e".repeat(24);
    let nonceCalls = 0;
    const options = {
      storageDirectory: state,
      createNonce: () => nonceCalls++ === 0 ? firstNonce : blockedNonce,
    };
    const ledger = createOwnedSessionLedger(project, options);
    await ledger.list();
    const id = `ses_${"5".repeat(24)}`;
    const blockedTemporary = join(resolveOwnedSessionLedgerDirectory(project, options), `.session-${blockedNonce}.tmp`);
    await writeFile(blockedTemporary, "pre-existing temporary file", { mode: 0o600 });

    await ledger.prepare(id);
    await expect(ledger.markAmbiguous(id)).rejects.toBeDefined();

    const restarted = createOwnedSessionLedger(project, options);
    await expect(restarted.list()).resolves.toMatchObject({
      status: "available",
      records: [{ id, state: "intent", projectRoot: project }],
    });
  });

  it("preserves a corrupt ledger source and returns a typed unavailable result", async () => {
    const { project, state } = await makeRoots();
    const ledger = createOwnedSessionLedger(project, { storageDirectory: state });
    await ledger.list();
    const id = `ses_${"3".repeat(24)}`;
    const path = join(resolveOwnedSessionLedgerDirectory(project, { storageDirectory: state }), `${id}.json`);
    const original = "{broken-ledger";
    await writeFile(path, original, { mode: 0o600 });

    await expect(ledger.list()).resolves.toMatchObject({ status: "unavailable", reason: "corrupt" });
    await expect(readFile(path, "utf8")).resolves.toBe(original);
  });

  it("removes an intent only when the caller has established absence", async () => {
    const { project, state } = await makeRoots();
    const ledger = createOwnedSessionLedger(project, { storageDirectory: state, createNonce: () => "c".repeat(24) });
    const id = `ses_${"4".repeat(24)}`;
    await ledger.prepare(id);

    await ledger.remove(id);

    await expect(ledger.list()).resolves.toMatchObject({ status: "available", records: [] });
  });
});
