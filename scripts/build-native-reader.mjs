import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(repositoryRoot, "native", "read-untracked.c");
const outputPath = join(repositoryRoot, "dist", "native", "read-untracked");

if (process.platform !== "darwin" && process.platform !== "linux") {
  throw new Error("The safe untracked-file reader currently supports macOS and Linux.");
}

mkdirSync(dirname(outputPath), { recursive: true });
const compiler = process.env.CC || "cc";
const result = spawnSync(compiler, [
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  sourcePath,
  "-o",
  outputPath,
], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
  throw new Error(`Could not build the safe untracked-file reader: ${(result.stderr || result.stdout).trim()}`);
}
