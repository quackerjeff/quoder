import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
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

export async function resolveProject(directory: string, topLevel: GitTopLevel = gitTopLevel): Promise<Project> {
  const resolved = resolve((await topLevel(directory)) ?? directory);
  // OpenCode silently drops the first prompt on a fresh server when the session directory differs
  // textually from the server's resolved cwd (verified live), so the root is always canonical.
  const root = await realpath(resolved).catch(() => resolved);
  return { root, name: basename(root) || root };
}
