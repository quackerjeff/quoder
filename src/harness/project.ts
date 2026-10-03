import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Project {
  /** The Git repository root, or the launch directory outside a repository. */
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
  const root = resolve((await topLevel(directory)) ?? directory);
  return { root, name: basename(root) || root };
}
