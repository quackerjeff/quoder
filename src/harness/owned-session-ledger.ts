import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { resolveExecutionHistoryBaseDirectory, type HistoryDirectoryOptions } from "./execution-history.js";

export const OWNED_SESSION_ID_PATTERN = /^ses_[a-f0-9]{24}$/u;
const LEDGER_VERSION = 1 as const;
const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_LEDGER_RECORDS = 100;
const LEDGER_FILENAME = /^ses_[a-f0-9]{24}\.json$/u;
const TEMP_FILENAME = /^\.session-[a-f0-9]{24}\.tmp$/u;

export type OwnedSessionState = "intent" | "created" | "ambiguous";

export interface OwnedSessionRecord {
  readonly version: typeof LEDGER_VERSION;
  readonly id: string;
  readonly projectRoot: string;
  readonly createdAt: string;
  readonly state: OwnedSessionState;
}

export type OwnedSessionLedgerResult =
  | { readonly status: "available"; readonly records: readonly OwnedSessionRecord[] }
  | { readonly status: "unavailable"; readonly reason: "corrupt" | "invalid-data" | "oversized" | "unsafe-path" | "io-error" };

export interface OwnedSessionLedger {
  list(): Promise<OwnedSessionLedgerResult>;
  prepare(id: string): Promise<void>;
  markCreated(id: string): Promise<void>;
  markAmbiguous(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface OwnedSessionLedgerOptions extends HistoryDirectoryOptions {
  readonly storageDirectory?: string;
  readonly createNonce?: () => string;
  readonly now?: () => Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";

const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

function errorReason(error: unknown): "unsafe-path" | "io-error" {
  if (typeof error === "object" && error !== null) {
    const code = Reflect.get(error, "code");
    if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") return "unsafe-path";
  }
  return "io-error";
}

function validateRecord(value: unknown): value is OwnedSessionRecord {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "createdAt,id,projectRoot,state,version") return false;
  if (value.version !== LEDGER_VERSION || typeof value.id !== "string" || !OWNED_SESSION_ID_PATTERN.test(value.id)) return false;
  if (typeof value.projectRoot !== "string" || !isAbsolute(value.projectRoot)) return false;
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) return false;
  return value.state === "intent" || value.state === "created" || value.state === "ambiguous";
}

async function outsideProject(projectRoot: string, candidate: string): Promise<boolean> {
  const target = resolve(candidate);
  const root = resolve(projectRoot);
  if (isWithin(root, target)) return false;
  let ancestor = target;
  const suffix: string[] = [];
  for (;;) {
    try {
      const realAncestor = await realpath(ancestor);
      return !isWithin(root, resolve(realAncestor, ...suffix.reverse()));
    } catch (error) {
      if (!isMissing(error)) return false;
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      suffix.push(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : sep.length)));
      ancestor = parent;
    }
  }
}

async function ensurePrivateDirectory(path: string): Promise<"unsafe-path" | "io-error" | undefined> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isDirectory() || (typeof process.getuid === "function" && info.uid !== process.getuid())) return "unsafe-path";
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
    return undefined;
  } catch (error) {
    return errorReason(error);
  }
}

async function readRecord(path: string): Promise<OwnedSessionRecord | undefined> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw Object.assign(new Error("unsafe ledger file"), { ledgerReason: "unsafe-path" });
    }
    if (info.size > MAX_LEDGER_BYTES) throw Object.assign(new Error("oversized ledger"), { ledgerReason: "oversized" });
    await handle.chmod(0o600);
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= MAX_LEDGER_BYTES) {
      const chunk = Buffer.alloc(Math.min(16 * 1024, MAX_LEDGER_BYTES + 1 - bytes));
      const result = await handle.read(chunk, 0, chunk.byteLength, bytes);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
    }
    if (bytes > MAX_LEDGER_BYTES) throw Object.assign(new Error("oversized ledger"), { ledgerReason: "oversized" });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    } catch {
      throw Object.assign(new Error("corrupt ledger"), { ledgerReason: "corrupt" });
    }
    if (!validateRecord(value)) throw Object.assign(new Error("invalid ledger"), { ledgerReason: "invalid-data" });
    return value;
  } finally {
    await handle.close();
  }
}

async function writeTemporary(directory: string, bytes: Buffer, nonce: string): Promise<string> {
  const path = join(directory, `.session-${nonce}.tmp`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

export function resolveOwnedSessionLedgerDirectory(
  projectRoot: string,
  options: OwnedSessionLedgerOptions = {},
): string {
  const base = resolve(options.storageDirectory ?? resolveExecutionHistoryBaseDirectory(options));
  const projectHash = createHash("sha256").update(resolve(projectRoot), "utf8").digest("hex");
  return join(base, projectHash, "owned-sessions");
}

/** Private per-project ledger. Each intent is published exclusively before its session-create request. */
export function createOwnedSessionLedger(
  projectRoot: string,
  options: OwnedSessionLedgerOptions = {},
): OwnedSessionLedger {
  const canonicalRoot = resolve(projectRoot);
  const base = resolve(options.storageDirectory ?? resolveExecutionHistoryBaseDirectory(options));
  const directory = resolveOwnedSessionLedgerDirectory(projectRoot, options);
  const projectDirectory = dirname(directory);
  const xdgStateHome = (options.environment ?? process.env).XDG_STATE_HOME;
  const applicationDirectory = options.storageDirectory === undefined && (options.platformName ?? platform()) === "darwin" &&
    !(xdgStateHome !== undefined && isAbsolute(xdgStateHome))
    ? dirname(base)
    : undefined;
  const createNonce = options.createNonce ?? (() => randomBytes(12).toString("hex"));
  const now = options.now ?? (() => new Date());
  let readyPromise: Promise<"available" | "unsafe-path" | "io-error"> | undefined;

  const ready = async (): Promise<"available" | "unsafe-path" | "io-error"> => {
    readyPromise ??= (async () => {
      if (!(await outsideProject(canonicalRoot, directory)) || !(await outsideProject(canonicalRoot, base))) return "unsafe-path";
      for (const path of [...(applicationDirectory === undefined ? [] : [applicationDirectory]), base, projectDirectory, directory]) {
        const error = await ensurePrivateDirectory(path);
        if (error !== undefined) return error;
      }
      return "available";
    })();
    return readyPromise;
  };

  const filePath = (id: string): string => {
    if (!OWNED_SESSION_ID_PATTERN.test(id)) throw new TypeError("Invalid owned OpenCode session ID");
    return join(directory, `${id}.json`);
  };

  const writeNew = async (record: OwnedSessionRecord): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(record), "utf8");
    if (bytes.byteLength > MAX_LEDGER_BYTES) throw new Error("Owned session record exceeds its size limit");
    const temp = await writeTemporary(directory, bytes, createNonce());
    try {
      await link(temp, filePath(record.id));
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  };

  const update = async (id: string, state: OwnedSessionState): Promise<void> => {
    const path = filePath(id);
    const current = await readRecord(path);
    if (current === undefined || current.projectRoot !== canonicalRoot) throw new Error("Owned session intent is unavailable");
    const replacement: OwnedSessionRecord = { ...current, state };
    const temp = await writeTemporary(directory, Buffer.from(JSON.stringify(replacement), "utf8"), createNonce());
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Unsafe owned session record");
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  };

  return {
    async list(): Promise<OwnedSessionLedgerResult> {
      const available = await ready();
      if (available !== "available") return { status: "unavailable", reason: available };
      try {
        const names = (await readdir(directory)).filter((name) => LEDGER_FILENAME.test(name));
        if (names.length > MAX_LEDGER_RECORDS) return { status: "unavailable", reason: "oversized" };
        const records: OwnedSessionRecord[] = [];
        for (const name of names) {
          const record = await readRecord(join(directory, name));
          if (record === undefined) continue;
          if (record.id !== name.slice(0, -5)) return { status: "unavailable", reason: "invalid-data" };
          if (record.projectRoot !== canonicalRoot) return { status: "unavailable", reason: "invalid-data" };
          records.push(record);
        }
        return { status: "available", records: records.sort((a, b) => a.id.localeCompare(b.id)) };
      } catch (error) {
        const reason = typeof error === "object" && error !== null ? Reflect.get(error, "ledgerReason") : undefined;
        if (reason === "corrupt" || reason === "invalid-data" || reason === "oversized" || reason === "unsafe-path") return { status: "unavailable", reason };
        return { status: "unavailable", reason: errorReason(error) };
      }
    },
    async prepare(id: string): Promise<void> {
      const available = await ready();
      if (available !== "available") throw Object.assign(new Error("Owned session ledger is unavailable"), { ledgerReason: available });
      const existing = await readdir(directory);
      if (existing.filter((name) => LEDGER_FILENAME.test(name)).length >= MAX_LEDGER_RECORDS) {
        throw Object.assign(new Error("Owned session ledger reached its record limit"), { ledgerReason: "oversized" });
      }
      const record: OwnedSessionRecord = {
        version: LEDGER_VERSION,
        id,
        projectRoot: canonicalRoot,
        createdAt: now().toISOString(),
        state: "intent",
      };
      if (!validateRecord(record)) throw new TypeError("Invalid owned session intent");
      await writeNew(record);
    },
    async markCreated(id: string): Promise<void> {
      await update(id, "created");
    },
    async markAmbiguous(id: string): Promise<void> {
      await update(id, "ambiguous");
    },
    async remove(id: string): Promise<void> {
      const available = await ready();
      if (available !== "available") throw Object.assign(new Error("Owned session ledger is unavailable"), { ledgerReason: available });
      const path = filePath(id);
      try {
        const record = await readRecord(path);
        if (record?.projectRoot !== canonicalRoot) throw new Error("Owned session record does not match project");
        await unlink(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}
