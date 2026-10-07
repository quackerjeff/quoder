import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import { TextDecoder } from "node:util";

import { packagePath } from "../package-root.js";
import { sanitizeForTerminal, sanitizeLine } from "./terminal-text.js";
import { classifyGitCommandFailure, runGitReadOnly, type GitComparison, type GitFailureKind, type GitSnapshot } from "./git-state.js";

export const MAX_GIT_DIFF_BYTES = 1024 * 1024;
export const GIT_DIFF_PAGE_LINES = 40;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const MAX_UNTRACKED_CONTENT_BYTES = 1024 * 1024;
const MAX_UNTRACKED_FILES = 1_000;
const SAFE_READER_TIMEOUT_MS = 2_000;
const MAX_UNTRACKED_CAPTURE_MS = 10_000;

export interface GitDiffDocument {
  readonly kind: "available";
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedBytes: number | undefined;
}

export interface GitDiffUnavailable {
  readonly kind: "unavailable";
  readonly reason: GitFailureKind;
}

export type GitDiffResult = GitDiffDocument | GitDiffUnavailable;

export function hasInspectableGitDiff(comparison: GitComparison): boolean {
  if (comparison.after.kind !== "available") return false;
  return comparison.after.trackedDiff.files > 0 ||
    comparison.after.untrackedPaths.length > 0 ||
    (comparison.committedDiff?.files ?? 0) > 0;
}

type SafeReadResult =
  | { readonly kind: "read"; readonly content: Buffer }
  | { readonly kind: "too-large" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "unavailable" };

async function readWithSafeNativeHelper(
  rootHandle: number,
  relativePath: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<SafeReadResult> {
  return new Promise((resolveResult) => {
    const helperPath = packagePath("dist", "native", "read-untracked");
    const child = spawn(helperPath, [relativePath, String(maxBytes)], {
      env: {},
      stdio: ["ignore", "pipe", "ignore", rootHandle],
    });
    const stdout = child.stdout;
    if (stdout === null) {
      child.kill("SIGKILL");
      resolveResult({ kind: "unavailable" });
      return;
    }
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (result: SafeReadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "unavailable" });
    }, timeoutMs);
    timer.unref();

    stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) {
        child.kill("SIGKILL");
        finish({ kind: "unavailable" });
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", () => finish({ kind: "unavailable" }));
    child.once("close", (code) => {
      if (code === 0) finish({ kind: "read", content: Buffer.concat(chunks, outputBytes) });
      else if (code === 20) finish({ kind: "unsafe" });
      else if (code === 21) finish({ kind: "too-large" });
      else finish({ kind: "unavailable" });
    });
  });
}

async function safeUntrackedContent(root: string, relativePath: string, remainingReadBytes: number, remainingTimeMs: number): Promise<{
  readonly text: string;
  readonly bytesRead: number;
}> {
  const components = relativePath.split("/");
  if (relativePath === "" || relativePath.startsWith("/") ||
    components.some((component) => component === ".." || component === "." || component === "")) {
    return { text: "[content omitted: invalid repository path]\n", bytesRead: 0 };
  }
  if (Buffer.byteLength(relativePath, "utf8") > 4096) return { text: "[content omitted: path exceeds safe reader limit]\n", bytesRead: 0 };
  const readLimit = Math.min(MAX_UNTRACKED_FILE_BYTES, Math.max(0, remainingReadBytes));
  if (readLimit === 0) return { text: "[content omitted: prompt untracked-content limit reached]\n", bytesRead: 0 };

  let rootHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const result = await readWithSafeNativeHelper(
      rootHandle.fd,
      relativePath,
      readLimit,
      Math.max(1, Math.min(SAFE_READER_TIMEOUT_MS, remainingTimeMs)),
    );
    if (result.kind === "too-large") return { text: `[content omitted: file exceeds ${readLimit} byte read limit]\n`, bytesRead: 0 };
    if (result.kind === "unsafe") return { text: "[content omitted: symlink, unsafe path, or not a regular file]\n", bytesRead: 0 };
    if (result.kind === "unavailable") return { text: "[content unavailable: safe untracked-file reader failed]\n", bytesRead: 0 };
    const content = result.content;
    if (content.includes(0)) return { text: "[binary untracked file; content omitted]\n", bytesRead: content.length };
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return { text: "[binary or non-UTF-8 untracked file; content omitted]\n", bytesRead: content.length };
    }
    return { text: decoded, bytesRead: content.length };
  } catch {
    return { text: "[content unavailable: could not safely read untracked file]\n", bytesRead: 0 };
  } finally {
    await rootHandle?.close().catch(() => undefined);
  }
}

function untrackedSectionHeading(path: string): string {
  return `### Untracked file: ${sanitizeLine(path, 500)}\n`;
}

async function untrackedDiff(snapshot: GitSnapshot): Promise<string[]> {
  const sections: string[] = [];
  let totalRead = 0;
  const startedAt = Date.now();
  const paths = snapshot.untrackedPaths.slice(0, MAX_UNTRACKED_FILES);
  for (const path of paths) {
    const remainingTime = MAX_UNTRACKED_CAPTURE_MS - (Date.now() - startedAt);
    if (remainingTime <= 0) {
      sections.push("[remaining untracked paths omitted: safe reader time limit reached]\n");
      break;
    }
    const file = await safeUntrackedContent(snapshot.root, path, MAX_UNTRACKED_CONTENT_BYTES - totalRead, remainingTime);
    totalRead += file.bytesRead;
    const heading = untrackedSectionHeading(path);
    if (file.text.startsWith("[binary") || file.text.startsWith("[content") || file.text.startsWith("[Symbolic") ||
      file.text.startsWith("Symbolic link") || file.text.startsWith("[content unavailable")) {
      sections.push(`${heading}${file.text}`);
      continue;
    }
    const content = sanitizeForTerminal(file.text).replace(/\r\n?/gu, "\n");
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    sections.push(`${heading}--- /dev/null\n+++ b/${sanitizeLine(path, 500)}\n${lines.map((line) => `+${line}`).join("\n")}\n`);
  }
  if (snapshot.untrackedPaths.length > MAX_UNTRACKED_FILES) {
    sections.push(`[${snapshot.untrackedPaths.length - MAX_UNTRACKED_FILES} additional untracked paths omitted]\n`);
  }
  return sections;
}

function truncateUtf8(text: string, maxBytes: number): { readonly text: string; readonly omittedBytes: number } {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return { text, omittedBytes: 0 };
  let keptBytes = 0;
  let kept = "";
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (keptBytes + bytes > maxBytes) break;
    kept += character;
    keptBytes += bytes;
  }
  return { text: kept, omittedBytes: totalBytes - keptBytes };
}

/** Builds a sanitized, bounded final-state diff. It never writes to the repository. */
export async function captureGitDiff(comparison: GitComparison): Promise<GitDiffResult> {
  if (comparison.after.kind !== "available") return { kind: "unavailable", reason: "command-failed" };
  const after = comparison.after;
  const sections: string[] = [];
  try {
    if (after.trackedDiff.files > 0 && after.head !== undefined) {
      const output = await runGitReadOnly(after.root, [
        "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", after.head, "--", ".",
      ]);
      const text = output.toString("utf8");
      if (text !== "") sections.push(`### Final tracked diff (against ${after.head})\n${text}`);
    }

    if (comparison.headChanged && comparison.committedDiff !== undefined && comparison.committedDiff.files > 0 &&
      comparison.before.kind === "available" && after.head !== undefined) {
      const output = comparison.before.head === undefined
        ? await runGitReadOnly(after.root, [
            "diff-tree", "--root", "-p", "--no-commit-id", "-r", "--no-ext-diff", "--no-textconv", after.head, "--", ".",
          ])
        : await runGitReadOnly(after.root, [
            "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", comparison.before.head, after.head, "--", ".",
          ]);
      const text = output.toString("utf8");
      if (text !== "") sections.push(`### Committed tree change (${comparison.before.head ?? "unborn"} → ${after.head})\n${text}`);
    }

    sections.push(...await untrackedDiff(after));
  } catch (error) {
    return { kind: "unavailable", reason: classifyGitCommandFailure(error) };
  }

  const safeText = sanitizeForTerminal(sections.join("\n")).replace(/\r\n?/gu, "\n");
  const bounded = truncateUtf8(safeText, MAX_GIT_DIFF_BYTES);
  return {
    kind: "available",
    text: bounded.text,
    truncated: bounded.omittedBytes > 0,
    omittedBytes: bounded.omittedBytes > 0 ? bounded.omittedBytes : undefined,
  };
}
