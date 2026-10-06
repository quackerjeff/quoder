import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Project {
  /** The canonical (`realpath`) Git repository root, or the launch directory outside a repository. */
  readonly root: string;
  /** Shown in the prompt label, for example `QuackTrack`. */
  readonly name: string;
}

export type GitTopLevel = (directory: string) => Promise<string | undefined>;

export const gitTopLevel: GitTopLevel = async (directory) => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: directory,
      timeout: 5_000,
    });
    const root = stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
};

async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path);
  return realpath(resolved).catch(() => resolved);
}

function containsPath(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

export async function resolveProject(directory: string, topLevel: GitTopLevel = gitTopLevel): Promise<Project> {
  const launchDirectory = await canonicalPath(directory);
  const gitDirectory = await topLevel(directory);
  const candidate = gitDirectory === undefined ? launchDirectory : await canonicalPath(gitDirectory);
  // A crafted .git/config core.worktree can make Git report a root outside the launched tree.
  // Only accept a canonical Git root that actually contains the canonical launch directory.
  const root = gitDirectory !== undefined && containsPath(candidate, launchDirectory)
    ? candidate
    : launchDirectory;
  return { root, name: basename(root) || root };
}
