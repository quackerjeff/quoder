import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

export const PROJECT_MEMORY_VERSION = 1 as const;
export const PROJECT_MEMORY_MAX_BYTES = 32 * 1024;
export const PROJECT_MEMORY_MAX_CODE_POINTS = 500;
export const PROJECT_MEMORY_MAX_LIST_ITEMS = 20;
export const PROJECT_MEMORY_MAX_REQUEST_EXCERPT = 512;
export const PROJECT_MEMORY_MAX_RESPONSE_EXCERPT = 1_536;

export interface PreviousExecutionSummary {
  readonly requestExcerpt: string;
  readonly responseExcerpt: string;
  readonly requestTruncated: boolean;
  readonly responseTruncated: boolean;
}

export interface ProjectMemory {
  readonly version: typeof PROJECT_MEMORY_VERSION;
  readonly objective: string | null;
  readonly task: string | null;
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly unresolvedIssues: readonly string[];
  readonly previousExecution: PreviousExecutionSummary | null;
  readonly automaticSummary: boolean;
}

export type MemoryUnavailableReason =
  | "corrupt"
  | "unsupported-version"
  | "invalid-data"
  | "oversized"
  | "unsafe-path"
  | "io-error";

export type ProjectMemoryLoadResult =
  | { readonly status: "missing"; readonly memory: ProjectMemory }
  | { readonly status: "loaded"; readonly memory: ProjectMemory }
  | { readonly status: "unavailable"; readonly reason: MemoryUnavailableReason };

export type ProjectMemoryWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MemoryUnavailableReason };

export interface ProjectMemoryStore {
  /** Absolute JSON path, suitable for a local `/memory show` display. */
  readonly filePath: string;
  load(): Promise<ProjectMemoryLoadResult>;
  /** Refuses to replace an existing malformed or unsupported document. */
  save(memory: ProjectMemory): Promise<ProjectMemoryWriteResult>;
  /** Explicit user-directed reset; can replace malformed or unsupported JSON. */
  clear(): Promise<ProjectMemoryWriteResult>;
}

export interface MemoryDirectoryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platformName?: NodeJS.Platform;
}

export interface ProjectMemoryStoreOptions extends MemoryDirectoryOptions {
  /** Test seam and embedders: final private directory containing project memory files. */
  readonly storageDirectory?: string;
}

export const emptyProjectMemory = (): ProjectMemory => ({
  version: PROJECT_MEMORY_VERSION,
  objective: null,
  task: null,
  decisions: [],
  constraints: [],
  unresolvedIssues: [],
  previousExecution: null,
  automaticSummary: true,
});

const codePointLength = (value: string): number => Array.from(value).length;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const stringOrNull = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && codePointLength(value) <= PROJECT_MEMORY_MAX_CODE_POINTS);

const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= PROJECT_MEMORY_MAX_LIST_ITEMS && value.every(
    (entry) => typeof entry === "string" && codePointLength(entry) <= PROJECT_MEMORY_MAX_CODE_POINTS,
  );

/** Runtime validation shared by disk reads and writes. */
export function validateProjectMemory(value: unknown): value is ProjectMemory {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, [
    "automaticSummary",
    "constraints",
    "decisions",
    "objective",
    "previousExecution",
    "task",
    "unresolvedIssues",
    "version",
  ])) return false;
  if (value.version !== PROJECT_MEMORY_VERSION) return false;
  if (!stringOrNull(value.objective) || !stringOrNull(value.task)) return false;
  if (!stringList(value.decisions) || !stringList(value.constraints) || !stringList(value.unresolvedIssues)) return false;
  if (typeof value.automaticSummary !== "boolean") return false;
  if (value.previousExecution !== null) {
    const previous = value.previousExecution;
    if (!isRecord(previous) || !exactKeys(previous, [
      "requestExcerpt",
      "requestTruncated",
      "responseExcerpt",
      "responseTruncated",
    ])) return false;
    if (
      typeof previous.requestExcerpt !== "string" ||
      codePointLength(previous.requestExcerpt) > PROJECT_MEMORY_MAX_REQUEST_EXCERPT ||
      typeof previous.responseExcerpt !== "string" ||
      codePointLength(previous.responseExcerpt) > PROJECT_MEMORY_MAX_RESPONSE_EXCERPT ||
      typeof previous.requestTruncated !== "boolean" ||
      typeof previous.responseTruncated !== "boolean"
    ) return false;
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= PROJECT_MEMORY_MAX_BYTES;
}

export function resolveProjectMemoryDirectory(options: MemoryDirectoryOptions = {}): string {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const platformName = options.platformName ?? platform();
  const xdgStateHome = environment.XDG_STATE_HOME;
  const base = xdgStateHome !== undefined && isAbsolute(xdgStateHome)
    ? xdgStateHome
    : platformName === "darwin"
      ? join(home, "Library", "Application Support")
      : join(home, ".local", "state");
  return platformName === "darwin" && !(xdgStateHome !== undefined && isAbsolute(xdgStateHome))
    ? join(base, "Quoder", "context")
    : join(base, "quoder", "context");
}

const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";

async function assertOutsideProject(projectRoot: string, candidate: string): Promise<boolean> {
  const absoluteCandidate = resolve(candidate);
  const absoluteProject = resolve(projectRoot);
  if (isWithin(absoluteProject, absoluteCandidate)) return false;

  // Resolve the nearest existing ancestor before creating directories, so a configured symlink
  // cannot redirect state into the target repository.
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

function unavailableFrom(error: unknown): MemoryUnavailableReason {
  if (typeof error === "object" && error !== null) {
    const code = Reflect.get(error, "code");
    if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") return "unsafe-path";
  }
  return "io-error";
}

async function ensurePrivateDirectory(
  directory: string,
  projectRoot: string,
): Promise<MemoryUnavailableReason | undefined> {
  if (!(await assertOutsideProject(projectRoot, directory))) return "unsafe-path";
  try {
    const applicationDirectory = dirname(directory);
    if (!(await assertOutsideProject(projectRoot, applicationDirectory))) return "unsafe-path";
    await mkdir(applicationDirectory, { recursive: true, mode: 0o700 });
    const appInfo = await lstat(applicationDirectory);
    if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) return "unsafe-path";
    if (typeof process.getuid === "function" && appInfo.uid !== process.getuid()) return "unsafe-path";
    await chmod(applicationDirectory, 0o700);

    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return "unsafe-path";
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return "unsafe-path";
    await chmod(directory, 0o700);
    const actual = await realpath(directory);
    return isWithin(resolve(projectRoot), actual) ? "unsafe-path" : undefined;
  } catch (error) {
    return unavailableFrom(error);
  }
}

async function readDocument(filePath: string): Promise<
  | { readonly status: "missing" }
  | { readonly status: "loaded"; readonly memory: ProjectMemory }
  | { readonly status: "unavailable"; readonly reason: MemoryUnavailableReason }
> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return isMissing(error)
      ? { status: "missing" }
      : { status: "unavailable", reason: unavailableFrom(error) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { status: "unavailable", reason: "unsafe-path" };
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      return { status: "unavailable", reason: "unsafe-path" };
    }
    if (info.size > PROJECT_MEMORY_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    await handle.chmod(0o600);
    const buffer = Buffer.alloc(PROJECT_MEMORY_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > PROJECT_MEMORY_MAX_BYTES) return { status: "unavailable", reason: "oversized" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
    } catch {
      return { status: "unavailable", reason: "corrupt" };
    }
    if (isRecord(parsed) && typeof parsed.version === "number" && parsed.version !== PROJECT_MEMORY_VERSION) {
      return { status: "unavailable", reason: "unsupported-version" };
    }
    if (!validateProjectMemory(parsed)) return { status: "unavailable", reason: "invalid-data" };
    return { status: "loaded", memory: parsed };
  } catch (error) {
    return { status: "unavailable", reason: unavailableFrom(error) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeAtomic(filePath: string, memory: ProjectMemory): Promise<ProjectMemoryWriteResult> {
  const bytes = Buffer.from(JSON.stringify(memory), "utf8");
  if (bytes.byteLength > PROJECT_MEMORY_MAX_BYTES) return { ok: false, reason: "oversized" };
  const temporaryPath = join(dirname(filePath), `.${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    return { ok: true };
  } catch {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    return { ok: false, reason: "io-error" };
  }
}

export function createProjectMemoryStore(
  projectRoot: string,
  options: ProjectMemoryStoreOptions = {},
): ProjectMemoryStore {
  const directory = resolve(options.storageDirectory ?? resolveProjectMemoryDirectory(options));
  const key = createHash("sha256").update(projectRoot, "utf8").digest("hex");
  const filePath = join(directory, `${key}.json`);

  const ready = (): Promise<MemoryUnavailableReason | undefined> => ensurePrivateDirectory(directory, projectRoot);
  const read = async (): Promise<ProjectMemoryLoadResult> => {
    const unavailable = await ready();
    if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
    const document = await readDocument(filePath);
    return document.status === "missing"
      ? { status: "missing", memory: emptyProjectMemory() }
      : document;
  };

  return {
    filePath,
    load: read,
    save: async (memory) => {
      let serialized: string;
      try {
        serialized = JSON.stringify(memory);
      } catch {
        return { ok: false, reason: "invalid-data" };
      }
      if (Buffer.byteLength(serialized, "utf8") > PROJECT_MEMORY_MAX_BYTES) {
        return { ok: false, reason: "oversized" };
      }
      if (!validateProjectMemory(memory)) return { ok: false, reason: "invalid-data" };
      const unavailable = await ready();
      if (unavailable !== undefined) return { ok: false, reason: unavailable };
      const current = await readDocument(filePath);
      if (current.status === "unavailable") return { ok: false, reason: current.reason };
      return writeAtomic(filePath, memory);
    },
    clear: async () => {
      const unavailable = await ready();
      if (unavailable !== undefined) return { ok: false, reason: unavailable };
      try {
        const info = await lstat(filePath);
        if (info.isSymbolicLink() || !info.isFile()) return { ok: false, reason: "unsafe-path" };
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          return { ok: false, reason: "unsafe-path" };
        }
      } catch (error) {
        if (!isMissing(error)) return { ok: false, reason: unavailableFrom(error) };
      }
      return writeAtomic(filePath, emptyProjectMemory());
    },
  };
}
