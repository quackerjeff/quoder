import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  utimes,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

export const EXECUTION_HISTORY_VERSION = 1 as const;
export const EXECUTION_HISTORY_MAX_BYTES = 32 * 1024 * 1024;
export const EXECUTION_HISTORY_DEFAULT_RETENTION = 100;
export const EXECUTION_HISTORY_MAX_RETENTION = 1_000;
export const EXECUTION_HISTORY_LIST_LIMIT = 10;
export const EXECUTION_HISTORY_ID_PATTERN = /^[a-f0-9]{32}$/u;

export type ExecutionHistoryOutcome =
  | "answered"
  | "permission-rejected"
  | "question-rejected"
  | "cancelled"
  | "failed";

export type ExecutionHistoryStatus = "in-progress" | ExecutionHistoryOutcome;
export type HistoryCommandStatus = "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type HistoryToolStatus = Exclude<HistoryCommandStatus, "running">;

export interface HistoryPermissionDecision {
  readonly action: string | null;
  readonly resourceCount: number | null;
  readonly reply: "once" | "always" | "reject" | "not-replied";
  readonly replied: boolean;
}

export interface HistoryCommand {
  readonly command: string;
  readonly status: HistoryCommandStatus;
}

export interface HistoryToolActivity {
  readonly tool: string;
  readonly status: HistoryToolStatus;
}

export interface HistoryChangedPath {
  readonly kind: "added" | "modified" | "deleted" | "renamed" | "unmerged";
  readonly path: string;
  readonly previousPath: string | null;
}

export interface HistoryFileChanges {
  readonly status: "available" | "unavailable";
  readonly paths: readonly HistoryChangedPath[];
  readonly reason: string | null;
}

export interface ExecutionHistoryRecord {
  readonly version: typeof EXECUTION_HISTORY_VERSION;
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly project: { readonly name: string; readonly root: string };
  readonly branch: string | null;
  readonly startingHead: string | null;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly agent: string | null;
  readonly prompt: string;
  readonly injectedContext: string;
  readonly permissionDecisions: readonly HistoryPermissionDecision[];
  readonly commands: readonly HistoryCommand[];
  readonly toolActivity: readonly HistoryToolActivity[];
  readonly filesChanged: HistoryFileChanges | null;
  readonly finalResponse: string | null;
  readonly status: ExecutionHistoryStatus;
  readonly attempts: number;
  readonly failureStage: "server-start" | null;
}

export interface BeginExecutionHistoryInput {
  readonly startedAt?: string;
  readonly branch: string | null;
  readonly startingHead: string | null;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly agent?: string | null;
  readonly prompt: string;
  readonly injectedContext: string;
}

export interface CompleteExecutionHistoryInput {
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: ExecutionHistoryOutcome;
  readonly permissionDecisions: readonly HistoryPermissionDecision[];
  readonly commands: readonly HistoryCommand[];
  readonly toolActivity: readonly HistoryToolActivity[];
  readonly filesChanged: HistoryFileChanges;
  readonly finalResponse: string | null;
  readonly attempts: number;
  readonly failureStage?: "server-start" | null;
}

export interface ExecutionHistorySummary {
  readonly id: string;
  readonly startedAt: string;
  readonly status: ExecutionHistoryStatus;
}

export type HistoryUnavailableReason =
  | "corrupt"
  | "unsupported-version"
  | "invalid-data"
  | "oversized"
  | "unsafe-path"
  | "io-error";

export type HistoryWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: HistoryUnavailableReason };

export type HistoryRecordResult =
  | { readonly status: "found"; readonly record: ExecutionHistoryRecord }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly reason: HistoryUnavailableReason };

export type HistoryListResult =
  | { readonly status: "available"; readonly records: readonly ExecutionHistorySummary[] }
  | { readonly status: "unavailable"; readonly reason: HistoryUnavailableReason };

export type HistoryRetentionResult =
  | { readonly status: "available"; readonly maxCompletedRecords: number }
  | { readonly status: "unavailable"; readonly reason: HistoryUnavailableReason };

export type HistoryDeleteResult =
  | { readonly status: "deleted" }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly reason: HistoryUnavailableReason };

export interface ExecutionHistoryStore {
  readonly directory: string;
  begin(input: BeginExecutionHistoryInput): Promise<
    | { readonly status: "created"; readonly record: ExecutionHistoryRecord }
    | { readonly status: "unavailable"; readonly reason: HistoryUnavailableReason }
  >;
  complete(id: string, input: CompleteExecutionHistoryInput): Promise<HistoryWriteResult>;
  list(limit?: number): Promise<HistoryListResult>;
  get(id: string): Promise<HistoryRecordResult>;
  retention(): Promise<HistoryRetentionResult>;
  setRetention(maxCompletedRecords: number): Promise<HistoryWriteResult>;
  delete(id: string): Promise<HistoryDeleteResult>;
  clearAll(): Promise<{ readonly status: "cleared"; readonly deleted: number } | { readonly status: "unavailable"; readonly reason: HistoryUnavailableReason }>;
}

export interface HistoryDirectoryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platformName?: NodeJS.Platform;
}

export interface ExecutionHistoryStoreOptions extends HistoryDirectoryOptions {
  readonly storageDirectory?: string;
  readonly createID?: () => string;
  /** Test seam for reproducing deletion/finalization races deterministically. */
  readonly afterDeleteSnapshot?: () => Promise<void>;
}

interface RecordFileIdentity {
  readonly id: string;
  readonly status: ExecutionHistoryStatus;
}

const RECORD_FILE = /^([a-f0-9]{32})--(in-progress|answered|permission-rejected|question-rejected|cancelled|failed)\.json$/u;
const TEMP_FILE = /^\.history-[a-f0-9]{24}\.tmp$/u;
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FINAL_STATUSES: readonly ExecutionHistoryOutcome[] = [
  "answered",
  "permission-rejected",
  "question-rejected",
  "cancelled",
  "failed",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function errorReason(error: unknown): HistoryUnavailableReason {
  if (typeof error === "object" && error !== null) {
    const code = Reflect.get(error, "code");
    if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") return "unsafe-path";
  }
  return "io-error";
}

export function resolveExecutionHistoryBaseDirectory(options: HistoryDirectoryOptions = {}): string {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const platformName = options.platformName ?? platform();
  const xdgStateHome = environment.XDG_STATE_HOME;
  const useXdg = xdgStateHome !== undefined && isAbsolute(xdgStateHome);
  const base = useXdg
    ? xdgStateHome
    : platformName === "darwin"
      ? join(home, "Library", "Application Support")
      : join(home, ".local", "state");
  return platformName === "darwin" && !useXdg
    ? join(base, "Quoder", "history")
    : join(base, "quoder", "history");
}

const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

async function assertOutsideProject(projectRoot: string, candidate: string): Promise<boolean> {
  const absoluteCandidate = resolve(candidate);
  const absoluteProject = resolve(projectRoot);
  if (isWithin(absoluteProject, absoluteCandidate)) return false;
  let ancestor = absoluteCandidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      const realAncestor = await realpath(ancestor);
      return !isWithin(absoluteProject, resolve(realAncestor, ...suffix.reverse()));
    } catch (error) {
      if (!isMissing(error)) return false;
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      suffix.push(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : sep.length)));
      ancestor = parent;
    }
  }
}

function validISODate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function validNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validPermission(value: unknown): value is HistoryPermissionDecision {
  if (!isRecord(value) || !exactKeys(value, ["action", "resourceCount", "reply", "replied"])) return false;
  return validNullableString(value.action) &&
    (value.resourceCount === null || (Number.isSafeInteger(value.resourceCount) && (value.resourceCount as number) >= 0)) &&
    (value.reply === "once" || value.reply === "always" || value.reply === "reject" || value.reply === "not-replied") &&
    typeof value.replied === "boolean";
}

function validCommand(value: unknown): value is HistoryCommand {
  return isRecord(value) && exactKeys(value, ["command", "status"]) && typeof value.command === "string" &&
    (value.status === "running" || value.status === "succeeded" || value.status === "failed" || value.status === "cancelled" || value.status === "unknown");
}

function validToolActivity(value: unknown): value is HistoryToolActivity {
  return isRecord(value) && exactKeys(value, ["tool", "status"]) && typeof value.tool === "string" &&
    (value.status === "succeeded" || value.status === "failed" || value.status === "cancelled" || value.status === "unknown");
}

function validChangedPath(value: unknown): value is HistoryChangedPath {
  return isRecord(value) && exactKeys(value, ["kind", "path", "previousPath"]) &&
    (value.kind === "added" || value.kind === "modified" || value.kind === "deleted" || value.kind === "renamed" || value.kind === "unmerged") &&
    typeof value.path === "string" && validNullableString(value.previousPath);
}

function validFileChanges(value: unknown): value is HistoryFileChanges {
  if (!isRecord(value) || !exactKeys(value, ["paths", "reason", "status"])) return false;
  return Array.isArray(value.paths) && value.paths.every(validChangedPath) &&
    validNullableString(value.reason) && (value.status === "available" || value.status === "unavailable") &&
    (value.status !== "available" || value.reason === null) &&
    (value.status !== "unavailable" || (value.reason !== null && value.paths.length === 0));
}

export function validateExecutionHistoryRecord(value: unknown): value is ExecutionHistoryRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "agent", "attempts", "branch", "commands", "durationMs", "failureStage", "filesChanged", "finalResponse",
    "finishedAt", "id", "injectedContext", "model", "permissionDecisions", "project", "prompt", "startingHead",
    "startedAt", "status", "toolActivity", "version",
  ])) return false;
  if (value.version !== EXECUTION_HISTORY_VERSION || typeof value.id !== "string" || !EXECUTION_HISTORY_ID_PATTERN.test(value.id)) return false;
  if (!validISODate(value.startedAt) || !(value.finishedAt === null || validISODate(value.finishedAt))) return false;
  if (value.finishedAt === null ? value.durationMs !== null : !(typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0)) return false;
  if (!isRecord(value.project) || !exactKeys(value.project, ["name", "root"]) || typeof value.project.name !== "string" || typeof value.project.root !== "string") return false;
  if (!validNullableString(value.branch) || !validNullableString(value.startingHead)) return false;
  if (!isRecord(value.model) || !exactKeys(value.model, ["id", "providerID"]) || typeof value.model.id !== "string" || typeof value.model.providerID !== "string") return false;
  if (!validNullableString(value.agent) || typeof value.prompt !== "string" || typeof value.injectedContext !== "string") return false;
  if (!Array.isArray(value.permissionDecisions) || !value.permissionDecisions.every(validPermission)) return false;
  if (!Array.isArray(value.commands) || !value.commands.every(validCommand)) return false;
  if (!Array.isArray(value.toolActivity) || !value.toolActivity.every(validToolActivity)) return false;
  if (value.filesChanged !== null && !validFileChanges(value.filesChanged)) return false;
  if (!validNullableString(value.finalResponse)) return false;
  if (!(value.status === "in-progress" || FINAL_STATUSES.includes(value.status as ExecutionHistoryOutcome))) return false;
  if (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 || (value.attempts as number) > 2) return false;
  if (!(value.failureStage === null || value.failureStage === "server-start")) return false;
  if (value.status === "in-progress") {
    return value.finishedAt === null && value.durationMs === null && value.filesChanged === null && value.finalResponse === null && value.failureStage === null;
  }
  return value.finishedAt !== null && value.filesChanged !== null &&
    (value.failureStage === null || value.status === "failed") &&
    (value.status === "answered" ? typeof value.finalResponse === "string" : value.finalResponse === null);
}

function recordFilename(record: ExecutionHistoryRecord): string {
  return `${record.id}--${record.status}.json`;
}

function parseFilename(name: string): RecordFileIdentity | undefined {
  const match = RECORD_FILE.exec(name);
  if (match === null) return undefined;
  const [, id, rawStatus] = match;
  if (id === undefined || rawStatus === undefined) return undefined;
  return { id, status: rawStatus as ExecutionHistoryStatus };
}

async function writeTemporary(directory: string, bytes: Buffer): Promise<string> {
  const path = join(directory, `.history-${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

async function writeAtomic(filePath: string, bytes: Buffer): Promise<void> {
  const directory = dirname(filePath);
  const temporary = await writeTemporary(directory, bytes);
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function ensureDirectory(
  directory: string,
  historyBaseDirectory: string,
  applicationDirectory: string | undefined,
  projectRoot: string,
): Promise<HistoryUnavailableReason | undefined> {
  if (!(await assertOutsideProject(projectRoot, directory)) ||
    !(await assertOutsideProject(projectRoot, historyBaseDirectory)) ||
    (applicationDirectory !== undefined && !(await assertOutsideProject(projectRoot, applicationDirectory)))) return "unsafe-path";
  try {
    if (applicationDirectory !== undefined) await mkdir(applicationDirectory, { recursive: true, mode: 0o700 });
    await mkdir(historyBaseDirectory, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const privateDirectories = [
      ...(applicationDirectory === undefined ? [] : [applicationDirectory]),
      historyBaseDirectory,
      directory,
    ];
    for (const candidate of privateDirectories) {
      const handle = await open(candidate, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isDirectory()) return "unsafe-path";
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) return "unsafe-path";
        await handle.chmod(0o700);
      } finally {
        await handle.close();
      }
    }
    const actual = await realpath(directory);
    return isWithin(resolve(projectRoot), actual) ? "unsafe-path" : undefined;
  } catch (error) {
    return errorReason(error);
  }
}

async function cleanOldTemporaryFiles(directory: string, now: number): Promise<void> {
  const names = await readdir(directory);
  await Promise.all(names.filter((name) => TEMP_FILE.test(name)).map(async (name) => {
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (info.isFile() && now - info.mtimeMs >= TEMP_MAX_AGE_MS) await unlink(path);
    } catch {
      // An overlapping operation may already have replaced or removed this unique temp file.
    }
  }));
}

async function readJSON(path: string): Promise<
  | { readonly status: "missing" }
  | { readonly status: "loaded"; readonly value: unknown }
  | { readonly status: "unavailable"; readonly reason: HistoryUnavailableReason }
> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return isMissing(error)
      ? { status: "missing" }
      : { status: "unavailable", reason: errorReason(error) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: "unavailable", reason: "unsafe-path" };
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return { status: "unavailable", reason: "unsafe-path" };
    if (info.size > EXECUTION_HISTORY_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    await handle.chmod(0o600);
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= EXECUTION_HISTORY_MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, EXECUTION_HISTORY_MAX_BYTES + 1 - bytesRead));
      const result = await handle.read(chunk, 0, chunk.byteLength, bytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    if (bytesRead > EXECUTION_HISTORY_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    try {
      return { status: "loaded", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytesRead))) };
    } catch {
      return { status: "unavailable", reason: "corrupt" };
    }
  } catch (error) {
    return { status: "unavailable", reason: errorReason(error) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeRecordExclusive(directory: string, record: ExecutionHistoryRecord): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  if (bytes.byteLength > EXECUTION_HISTORY_MAX_BYTES) throw Object.assign(new Error("oversized"), { historyReason: "oversized" });
  const path = join(directory, recordFilename(record));
  const temporary = await writeTemporary(directory, bytes);
  try {
    const startedAt = new Date(record.startedAt);
    await utimes(temporary, startedAt, startedAt);
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function historyReason(error: unknown): HistoryUnavailableReason {
  if (typeof error === "object" && error !== null && Reflect.get(error, "historyReason") === "oversized") return "oversized";
  return errorReason(error);
}

function validRetention(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= EXECUTION_HISTORY_MAX_RETENTION;
}

export function createExecutionHistoryStore(
  project: { readonly name: string; readonly root: string },
  options: ExecutionHistoryStoreOptions = {},
): ExecutionHistoryStore {
  const baseDirectory = resolve(options.storageDirectory ?? resolveExecutionHistoryBaseDirectory(options));
  const projectKey = createHash("sha256").update(project.root, "utf8").digest("hex");
  const directory = join(baseDirectory, projectKey);
  const applicationDirectory = options.storageDirectory === undefined ? dirname(baseDirectory) : undefined;
  const settingsPath = join(directory, "settings.json");
  const createID = options.createID ?? (() => randomBytes(16).toString("hex"));
  let cleanupPromise: Promise<void> | undefined;
  const ready = async (): Promise<HistoryUnavailableReason | undefined> => {
    const reason = await ensureDirectory(directory, baseDirectory, applicationDirectory, project.root);
    if (reason !== undefined) return reason;
    cleanupPromise ??= cleanOldTemporaryFiles(directory, Date.now()).catch(() => undefined);
    await cleanupPromise;
    return undefined;
  };
  const filenames = async (): Promise<string[]> => (await readdir(directory)).filter((name) => RECORD_FILE.test(name));
  const recordPaths = async (id: string): Promise<string[]> =>
    (await filenames()).filter((name) => parseFilename(name)?.id === id).map((name) => join(directory, name));
  const fileSummaries = async (): Promise<ExecutionHistorySummary[]> => {
    const summaries: ExecutionHistorySummary[] = [];
    for (const name of await filenames()) {
      const identity = parseFilename(name);
      if (identity === undefined) continue;
      const path = join(directory, name);
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw Object.assign(new Error("unsafe history record"), { historyReason: "unsafe-path" });
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          throw Object.assign(new Error("history record owner mismatch"), { historyReason: "unsafe-path" });
        }
        await handle.chmod(0o600);
        summaries.push({ id: identity.id, status: identity.status, startedAt: new Date(info.mtimeMs).toISOString() });
      } finally {
        await handle.close();
      }
    }
    return summaries;
  };

  const loadRetention = async (): Promise<HistoryRetentionResult> => {
    const unavailable = await ready();
    if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
    const parsed = await readJSON(settingsPath);
    if (parsed.status === "missing") return { status: "available", maxCompletedRecords: EXECUTION_HISTORY_DEFAULT_RETENTION };
    if (parsed.status === "unavailable") return parsed;
    if (!isRecord(parsed.value)) return { status: "unavailable", reason: "invalid-data" };
    if (typeof parsed.value.version === "number" && parsed.value.version !== EXECUTION_HISTORY_VERSION) {
      return { status: "unavailable", reason: "unsupported-version" };
    }
    if (!exactKeys(parsed.value, ["maxCompletedRecords", "version"]) || parsed.value.version !== EXECUTION_HISTORY_VERSION || !validRetention(parsed.value.maxCompletedRecords)) {
      return { status: "unavailable", reason: "invalid-data" };
    }
    return { status: "available", maxCompletedRecords: parsed.value.maxCompletedRecords };
  };

  const prune = async (maxCompletedRecords: number): Promise<void> => {
    const summaries = (await fileSummaries())
      .filter((summary) => summary.status !== "in-progress")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const excess = Math.max(0, summaries.length - maxCompletedRecords);
    for (const item of summaries.slice(0, excess)) {
      await unlinkIfPresent(join(directory, `${item.id}--${item.status}.json`));
    }
  };

  const get = async (id: string): Promise<HistoryRecordResult> => {
    const unavailable = await ready();
    if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
    if (!EXECUTION_HISTORY_ID_PATTERN.test(id)) return { status: "missing" };
    try {
      await lstat(join(directory, `.deleted-${id}`));
      return { status: "missing" };
    } catch (error) {
      if (!isMissing(error)) return { status: "unavailable", reason: errorReason(error) };
    }
    const paths = await recordPaths(id);
    if (paths.length === 0) return { status: "missing" };
    const sorted = paths.sort((a, b) => {
      const left = parseFilename(a.slice(directory.length + 1));
      const right = parseFilename(b.slice(directory.length + 1));
      if (left?.status === "in-progress" && right?.status !== "in-progress") return 1;
      if (right?.status === "in-progress" && left?.status !== "in-progress") return -1;
      return b.localeCompare(a);
    });
    for (const path of sorted) {
      const parsed = await readJSON(path);
      if (parsed.status !== "loaded") return parsed;
      if (isRecord(parsed.value) && typeof parsed.value.version === "number" && parsed.value.version !== EXECUTION_HISTORY_VERSION) {
        return { status: "unavailable", reason: "unsupported-version" };
      }
      const filenameIdentity = parseFilename(path.slice(directory.length + 1));
      if (!validateExecutionHistoryRecord(parsed.value) || parsed.value.id !== id || filenameIdentity?.status !== parsed.value.status) {
        return { status: "unavailable", reason: "invalid-data" };
      }
      return { status: "found", record: parsed.value };
    }
    return { status: "missing" };
  };

  const deleteRecord = async (id: string): Promise<HistoryDeleteResult> => {
    const unavailable = await ready();
    if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
    if (!EXECUTION_HISTORY_ID_PATTERN.test(id)) return { status: "missing" };
    const paths = await recordPaths(id);
    try {
      await options.afterDeleteSnapshot?.();
      if (paths.length === 0) return { status: "missing" };
      const tombstonePath = join(directory, `.deleted-${id}`);
      try {
        const handle = await open(tombstonePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
          await handle.writeFile(id);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (!(typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST")) throw error;
      }
      const pathsAfterTombstone = await recordPaths(id);
      await Promise.all([...new Set([...paths, ...pathsAfterTombstone])].map(unlinkIfPresent));
      return { status: "deleted" };
    } catch (error) {
      return { status: "unavailable", reason: errorReason(error) };
    }
  };

  return {
    directory,
    begin: async (input) => {
      const unavailable = await ready();
      if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
      const startedAt = input.startedAt ?? new Date().toISOString();
      if (!validISODate(startedAt)) return { status: "unavailable", reason: "invalid-data" };
      for (let attempt = 0; attempt < 10; attempt++) {
        const id = createID().toLowerCase();
        if (!EXECUTION_HISTORY_ID_PATTERN.test(id)) return { status: "unavailable", reason: "invalid-data" };
        try {
          await lstat(join(directory, `.deleted-${id}`));
          continue;
        } catch (error) {
          if (!isMissing(error)) return { status: "unavailable", reason: errorReason(error) };
        }
        if ((await recordPaths(id)).length > 0) continue;
        const record: ExecutionHistoryRecord = {
          version: EXECUTION_HISTORY_VERSION,
          id,
          startedAt,
          finishedAt: null,
          durationMs: null,
          project: { name: project.name, root: project.root },
          branch: input.branch,
          startingHead: input.startingHead,
          model: input.model,
          agent: input.agent ?? null,
          prompt: input.prompt,
          injectedContext: input.injectedContext,
          permissionDecisions: [],
          commands: [],
          toolActivity: [],
          filesChanged: null,
          finalResponse: null,
          status: "in-progress",
          attempts: 0,
          failureStage: null,
        };
        if (!validateExecutionHistoryRecord(record)) return { status: "unavailable", reason: "invalid-data" };
        try {
          await writeRecordExclusive(directory, record);
          return { status: "created", record };
        } catch (error) {
          if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST") continue;
          return { status: "unavailable", reason: historyReason(error) };
        }
      }
      return { status: "unavailable", reason: "io-error" };
    },
    complete: async (id, input) => {
      const existing = await get(id);
      if (existing.status !== "found") {
        return { ok: false, reason: existing.status === "unavailable" ? existing.reason : "invalid-data" };
      }
      if (existing.record.status !== "in-progress" || !validISODate(input.finishedAt) ||
        !Number.isFinite(input.durationMs) || input.durationMs < 0 || !FINAL_STATUSES.includes(input.status) ||
        !input.permissionDecisions.every(validPermission) || !input.commands.every(validCommand) ||
        !input.toolActivity.every(validToolActivity) || !validFileChanges(input.filesChanged) ||
        !(input.finalResponse === null || typeof input.finalResponse === "string") ||
        (input.status === "answered" ? typeof input.finalResponse !== "string" : input.finalResponse !== null) ||
        !Number.isInteger(input.attempts) || input.attempts < 0 || input.attempts > 2) {
        return { ok: false, reason: "invalid-data" };
      }
      const tombstone = join(directory, `.deleted-${id}`);
      try {
        await lstat(tombstone);
        return { ok: false, reason: "invalid-data" };
      } catch (error) {
        if (!isMissing(error)) return { ok: false, reason: errorReason(error) };
      }
      const record: ExecutionHistoryRecord = {
        ...existing.record,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        permissionDecisions: input.permissionDecisions,
        commands: input.commands,
        toolActivity: input.toolActivity,
        filesChanged: input.filesChanged,
        finalResponse: input.status === "answered" ? input.finalResponse : null,
        status: input.status,
        attempts: input.attempts,
        failureStage: input.failureStage ?? null,
      };
      if (!validateExecutionHistoryRecord(record)) return { ok: false, reason: "invalid-data" };
      const bytes = Buffer.from(JSON.stringify(record), "utf8");
      if (bytes.byteLength > EXECUTION_HISTORY_MAX_BYTES) return { ok: false, reason: "oversized" };
      let temporary: string | undefined;
      try {
        temporary = await writeTemporary(directory, bytes);
        const startedAt = new Date(record.startedAt);
        await utimes(temporary, startedAt, startedAt);
      } catch (error) {
        if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
        return { ok: false, reason: historyReason(error) };
      }
      if (temporary === undefined) return { ok: false, reason: "io-error" };
      const finalPath = join(directory, recordFilename(record));
      const inProgressPath = join(directory, recordFilename(existing.record));
      try {
        await link(temporary, finalPath);
        try {
          await lstat(tombstone);
          await unlink(finalPath).catch(() => undefined);
          return { ok: false, reason: "invalid-data" };
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await unlinkIfPresent(inProgressPath);
        const savedRetention = await loadRetention();
        if (savedRetention.status === "available") await prune(savedRetention.maxCompletedRecords);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: historyReason(error) };
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
    list: async (limit = EXECUTION_HISTORY_LIST_LIMIT) => {
      const unavailable = await ready();
      if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
      if (!Number.isInteger(limit) || limit < 1 || limit > EXECUTION_HISTORY_MAX_RETENTION) {
        return { status: "unavailable", reason: "invalid-data" };
      }
      try {
        const byId = new Map<string, ExecutionHistorySummary>();
        for (const summary of await fileSummaries()) {
          try {
            await lstat(join(directory, `.deleted-${summary.id}`));
            continue;
          } catch (error) {
            if (!isMissing(error)) return { status: "unavailable", reason: errorReason(error) };
          }
          const previous = byId.get(summary.id);
          if (previous === undefined || (previous.status === "in-progress" && summary.status !== "in-progress")) byId.set(summary.id, summary);
        }
        const records = [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
        return { status: "available", records };
      } catch (error) {
        return { status: "unavailable", reason: errorReason(error) };
      }
    },
    get,
    retention: loadRetention,
    setRetention: async (maxCompletedRecords) => {
      if (!validRetention(maxCompletedRecords)) return { ok: false, reason: "invalid-data" };
      const unavailable = await ready();
      if (unavailable !== undefined) return { ok: false, reason: unavailable };
      const previous = await loadRetention();
      if (previous.status === "unavailable" && previous.reason !== "corrupt" && previous.reason !== "invalid-data" && previous.reason !== "unsupported-version" && previous.reason !== "oversized") {
        return { ok: false, reason: previous.reason };
      }
      try {
        const bytes = Buffer.from(JSON.stringify({ version: EXECUTION_HISTORY_VERSION, maxCompletedRecords }), "utf8");
        await writeAtomic(settingsPath, bytes);
        await prune(maxCompletedRecords);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: historyReason(error) };
      }
    },
    delete: deleteRecord,
    clearAll: async () => {
      const unavailable = await ready();
      if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
      try {
        const ids = new Set((await filenames()).flatMap((name) => {
          const parsed = parseFilename(name);
          return parsed === undefined ? [] : [parsed.id];
        }));
        let deleted = 0;
        for (const id of ids) {
          const result = await deleteRecord(id);
          if (result.status === "unavailable") return result;
          if (result.status === "deleted") deleted++;
        }
        return { status: "cleared", deleted };
      } catch (error) {
        return { status: "unavailable", reason: errorReason(error) };
      }
    },
  };

}
