import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "quoder";

const isQuoderPackageRoot = (directory: string): boolean => {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return typeof manifest === "object" && manifest !== null && Reflect.get(manifest, "name") === PACKAGE_NAME;
  } catch {
    return false;
  }
};

/**
 * Finds Quoder's own package root by walking up from this module's location. Quoder runs from the
 * developer's project directory, so its dependencies must never be resolved from `process.cwd()`.
 */
export function findPackageRoot(startDirectory: string = dirname(fileURLToPath(import.meta.url))): string {
  let directory = resolve(startDirectory);
  for (;;) {
    if (isQuoderPackageRoot(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Quoder package root not found");
    directory = parent;
  }
}

/** Resolves a path inside Quoder's own package, independent of the working directory. */
export const packagePath = (...segments: string[]): string => join(findPackageRoot(), ...segments);

/** The project-local OpenCode CLI pinned by Quoder's package. */
export const opencodeExecutablePath = (): string => packagePath("node_modules", ".bin", "opencode");
