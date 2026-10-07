import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const GIT_ENVIRONMENT_OVERRIDES = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
]);

export interface GitCaptureOptions {
  /** Tests and callers may lower these limits; values above the implementation ceiling are capped. */
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export type GitFailureKind = "not-repository" | "timed-out" | "output-limit" | "command-failed";

export interface GitUnavailable {
  readonly kind: "unavailable";
  readonly root: string;
  readonly reason: GitFailureKind;
}

export interface GitPathStatus {
  /** Repository-relative path. It may contain whitespace or terminal control characters. */
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly submoduleStatus: string;
  readonly kind: "tracked" | "untracked" | "unmerged";
  readonly originalPath?: string;
}

export interface GitDiffStats {
  /** Number of tracked path records in the numstat output. */
  readonly files: number;
  /** Undefined when a binary file is present or the total cannot be represented safely. */
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly binaryFiles: number;
}

export interface GitSnapshot {
  readonly kind: "available";
  readonly root: string;
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly branchState: "attached" | "detached" | "unborn";
  readonly paths: readonly GitPathStatus[];
  readonly untrackedPaths: readonly string[];
  /** Tracked staged and unstaged diff against this snapshot's HEAD. */
  readonly trackedDiff: GitDiffStats;
}

export type GitSnapshotResult = GitSnapshot | GitUnavailable;

export interface GitPathChange {
  readonly kind: "added" | "modified" | "deleted" | "renamed" | "unmerged";
  readonly path: string;
  readonly previousPath?: string;
}

export interface GitPreExistingPath {
  /** Path shown at the final endpoint. */
  readonly path: string;
  /** Path at the baseline; differs when Git reports a rename during the interval. */
  readonly baselinePath: string;
  /** True when endpoint status changed; this still does not prove content authorship. */
  readonly statusChanged: boolean;
}

export interface GitComparison {
  readonly kind: "available" | "unavailable";
  readonly before: GitSnapshotResult;
  readonly after: GitSnapshotResult;
  /** Paths that became dirty between the two endpoint status snapshots. */
  readonly observedChanges: readonly GitPathChange[];
  /** Paths that were dirty at the baseline and remain dirty at the final snapshot. */
  readonly preExistingPaths: readonly GitPreExistingPath[];
  /** Baseline-dirty paths that are clean at the final endpoint. */
  readonly resolvedPaths: readonly string[];
  readonly headChanged: boolean;
  readonly branchChanged: boolean;
  /** Tree delta between endpoint commits, when both commits exist and HEAD moved. */
  readonly committedDiff: GitDiffStats | undefined;
}

type GitCommandFailure = Error & {
  readonly code?: string | number;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals;
};

export function classifyGitCommandFailure(error: unknown): GitFailureKind {
  const gitError = error as GitCommandFailure;
  if (gitError.killed === true || gitError.signal === "SIGTERM" || gitError.code === "ETIMEDOUT") return "timed-out";
  if (gitError.message?.includes("maxBuffer")) return "output-limit";
  if (gitError.code === 128 && /not a git repository/i.test(gitError.message)) return "not-repository";
  return "command-failed";
}

async function runGit(
  root: string,
  args: readonly string[],
  limits: Required<GitCaptureOptions> = { timeoutMs: GIT_TIMEOUT_MS, maxBufferBytes: GIT_MAX_BUFFER_BYTES },
): Promise<Buffer> {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (GIT_ENVIRONMENT_OVERRIDES.has(name) || name.startsWith("GIT_TRACE") || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)) {
      delete env[name];
    }
  }
  const { stdout } = await execFileAsync("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", ...args], {
    cwd: root,
    env,
    encoding: "buffer",
    timeout: limits.timeoutMs,
    maxBuffer: limits.maxBufferBytes,
    windowsHide: true,
  });
  return stdout;
}

/** Shared bounded read-only Git runner for state capture and diff inspection. */
export function runGitReadOnly(root: string, args: readonly string[]): Promise<Buffer> {
  return runGit(root, args);
}

function nulFields(output: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index++) {
    if (output[index] === 0) {
      fields.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < output.length) fields.push(output.subarray(start));
  return fields;
}

function statusRecord(field: Buffer): { readonly text: string; readonly path: string } | undefined {
  const text = field.toString("utf8");
  const prefixes: readonly RegExp[] = [
    /^1 ([^ ]{2}) ([^ ]{4}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ /u,
    /^2 ([^ ]{2}) ([^ ]{4}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ /u,
    /^u ([^ ]{2}) ([^ ]{4}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ /u,
  ];
  if (text.startsWith("? ")) return { text, path: text.slice(2) };
  for (const prefix of prefixes) {
    const match = prefix.exec(text);
    if (match !== null) return { text, path: text.slice(match[0].length) };
  }
  return undefined;
}

function parseStatus(output: Buffer): {
  readonly head: string | undefined;
  readonly branch: string | undefined;
  readonly branchState: GitSnapshot["branchState"];
  readonly paths: readonly GitPathStatus[];
} {
  const fields = nulFields(output);
  let head: string | undefined;
  let branch: string | undefined;
  let branchState: GitSnapshot["branchState"] = "attached";
  const paths: GitPathStatus[] = [];

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field === undefined) continue;
    const text = field.toString("utf8");
    if (text.startsWith("# branch.oid ")) {
      const value = text.slice("# branch.oid ".length);
      if (value === "(initial)") branchState = "unborn";
      else if (value !== "(unknown)") head = value;
      continue;
    }
    if (text.startsWith("# branch.head ")) {
      const value = text.slice("# branch.head ".length);
      if (value === "(detached)") branchState = "detached";
      else branch = value;
      continue;
    }

    const record = statusRecord(field);
    if (record === undefined) continue; // Porcelain v2 permits future record/header extensions.
    if (record.text.startsWith("? ")) {
      paths.push({ path: record.path, indexStatus: "?", worktreeStatus: "?", submoduleStatus: "N...", kind: "untracked" });
      continue;
    }

    const kind = record.text.startsWith("u ") ? "unmerged" : "tracked";
    const code = record.text[0];
    const status = record.text.slice(2, 4);
    const submoduleStatus = record.text.slice(5, 9);
    if (code === "2") {
      const original = fields[index + 1];
      if (original !== undefined) index++;
      paths.push({
        path: record.path,
        ...(original === undefined ? {} : { originalPath: original.toString("utf8") }),
        indexStatus: status[0] ?? ".",
        worktreeStatus: status[1] ?? ".",
        submoduleStatus,
        kind,
      });
    } else {
      paths.push({
        path: record.path,
        indexStatus: status[0] ?? ".",
        worktreeStatus: status[1] ?? ".",
        submoduleStatus,
        kind,
      });
    }
  }
  return { head, branch, branchState, paths };
}

function parseNumstat(output: Buffer): GitDiffStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  const fields = nulFields(output);
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]?.toString("utf8") ?? "";
    const firstTab = field.indexOf("\t");
    const secondTab = field.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    files++;
    const added = field.slice(0, firstTab);
    const removed = field.slice(firstTab + 1, secondTab);
    if (added === "-" || removed === "-") binaryFiles++;
    else {
      const addCount = Number(added);
      const deleteCount = Number(removed);
      if (Number.isSafeInteger(addCount) && Number.isSafeInteger(deleteCount)) {
        additions += addCount;
        deletions += deleteCount;
      }
    }
    // With -z, a rename/copy has an empty path in the numstat record followed by two paths.
    if (field.slice(secondTab + 1) === "") index += 2;
  }
  const totalsFit = Number.isSafeInteger(additions) && Number.isSafeInteger(deletions);
  return {
    files,
    additions: binaryFiles === 0 && totalsFit ? additions : undefined,
    deletions: binaryFiles === 0 && totalsFit ? deletions : undefined,
    binaryFiles,
  };
}

const emptyDiffStats = (): GitDiffStats => ({ files: 0, additions: 0, deletions: 0, binaryFiles: 0 });

/** Capture Git metadata without writing to the index/worktree or invoking configured helpers. */
export async function captureGitSnapshot(root: string, options: GitCaptureOptions = {}): Promise<GitSnapshotResult> {
  const limits: Required<GitCaptureOptions> = {
    timeoutMs: Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.min(options.timeoutMs ?? GIT_TIMEOUT_MS, GIT_TIMEOUT_MS)
      : GIT_TIMEOUT_MS,
    maxBufferBytes: Number.isSafeInteger(options.maxBufferBytes) && (options.maxBufferBytes ?? 0) > 0
      ? Math.min(options.maxBufferBytes ?? GIT_MAX_BUFFER_BYTES, GIT_MAX_BUFFER_BYTES)
      : GIT_MAX_BUFFER_BYTES,
  };
  try {
    const statusOutput = await runGit(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], limits);
    const parsed = parseStatus(statusOutput);
    const untrackedPaths = parsed.paths.filter((path) => path.kind === "untracked").map((path) => path.path);
    const trackedDiff = parsed.head === undefined
      ? emptyDiffStats()
      : parseNumstat(await runGit(root, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."], limits));
    return {
      kind: "available",
      root,
      head: parsed.head,
      branch: parsed.branch,
      branchState: parsed.branchState,
      paths: parsed.paths,
      untrackedPaths,
      trackedDiff,
    };
  } catch (error) {
    return { kind: "unavailable", root, reason: classifyGitCommandFailure(error) };
  }
}

function classify(path: GitPathStatus): GitPathChange["kind"] {
  if (path.kind === "unmerged") return "unmerged";
  if (path.originalPath !== undefined || path.indexStatus === "R" || path.worktreeStatus === "R") return "renamed";
  if (path.indexStatus === "D" || path.worktreeStatus === "D") return "deleted";
  if (path.indexStatus === "A" || path.worktreeStatus === "A" || path.kind === "untracked") return "added";
  return "modified";
}

/** Compare endpoint status only; dirty-at-both-endpoints paths are never attributed as new edits. */
export async function compareGitSnapshots(before: GitSnapshotResult, after: GitSnapshotResult): Promise<GitComparison> {
  const available = before.kind === "available" && after.kind === "available" && before.root === after.root;
  if (!available) {
    return {
      kind: "unavailable",
      before,
      after,
      observedChanges: [],
      preExistingPaths: [],
      resolvedPaths: [],
      headChanged: available ? before.head !== after.head : false,
      branchChanged: available ? before.branch !== after.branch : false,
      committedDiff: undefined,
    };
  }

  const baseline = new Map(before.paths.map((path) => [path.path, path]));
  const final = new Map(after.paths.map((path) => [path.path, path]));
  const observedChanges: GitPathChange[] = [];
  const preExistingPaths: GitPreExistingPath[] = [];
  const consumedBaseline = new Set<string>();

  for (const path of after.paths) {
    const existing = baseline.get(path.path);
    if (existing !== undefined) {
      consumedBaseline.add(path.path);
      preExistingPaths.push({ path: path.path, baselinePath: existing.path, statusChanged: statusSignature(existing) !== statusSignature(path) });
      continue;
    }
    const renamedBaseline = path.originalPath === undefined ? undefined : baseline.get(path.originalPath);
    if (renamedBaseline !== undefined) {
      consumedBaseline.add(renamedBaseline.path);
      preExistingPaths.push({
        path: path.path,
        baselinePath: renamedBaseline.path,
        statusChanged: true,
      });
      continue;
    }
    observedChanges.push({
      kind: classify(path),
      path: path.path,
      ...(path.originalPath === undefined ? {} : { previousPath: path.originalPath }),
    });
  }

  const resolvedPaths = before.paths
    .filter((path) => !consumedBaseline.has(path.path) && !final.has(path.path))
    .map((path) => path.path);
  const headChanged = before.head !== after.head;
  let committedDiff: GitDiffStats | undefined;
  if (headChanged && after.head !== undefined) {
    try {
      committedDiff = before.head === undefined
        ? parseNumstat(await runGit(after.root, ["diff-tree", "--root", "--numstat", "--no-commit-id", "-r", "-z", "--no-ext-diff", "--no-textconv", after.head, "--", "."]))
        : parseNumstat(await runGit(after.root, [
            "diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", before.head, after.head, "--", ".",
          ]));
    } catch {
      committedDiff = undefined;
    }
  }

  return {
    kind: "available",
    before,
    after,
    observedChanges,
    preExistingPaths,
    resolvedPaths,
    headChanged,
    branchChanged: before.branch !== after.branch || before.branchState !== after.branchState,
    committedDiff,
  };
}

function statusSignature(path: GitPathStatus): string {
  return `${path.kind}:${path.indexStatus}${path.worktreeStatus}:${path.submoduleStatus}`;
}
