import {
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type OperationalLogEvent =
  | { readonly event: "server.started" | "server.stopped" | "server.lost" | "monitor.lost" }
  | { readonly event: "prompt.started" | "prompt.retried" }
  | { readonly event: "prompt.completed"; readonly outcome: "answered" | "cancelled" | "failed" | "permission-rejected" | "question-rejected"; readonly elapsedMs: number }
  | { readonly event: "session.created" }
  | { readonly event: "session.deleted"; readonly verified: boolean }
  | { readonly event: "failure.reported"; readonly category: "OpenCode" | "Provider/inference" | "Configuration" | "Local state" };

export type OperationalFailureCategory = "OpenCode" | "Provider/inference" | "Configuration" | "Local state";

export const formatOperationalFailure = (category: OperationalFailureCategory): string => {
  switch (category) {
    case "OpenCode":
      return "OpenCode: the server or session request failed. Restart Quoder; if this continues, run `npm run verify:environment` from Quoder.";
    case "Provider/inference":
      return "Provider/inference: OpenCode reported that the model request could not complete. Check the selected provider/model availability and its configuration in OpenCode.";
    case "Configuration":
      return "Configuration: a Quoder setting or launch-critical input is invalid or unavailable. Correct the named input or run the relevant environment check.";
    case "Local state":
      return "Local state: Quoder could not safely read or interpret its saved state. Preserve the source and follow the manual recovery guidance.";
  }
};

export interface OperationalLog {
  readonly path: string;
  write(event: OperationalLogEvent): void;
  close(): void;
}

export type OperationalLogResult =
  | { readonly ok: true; readonly logger: OperationalLog }
  | { readonly ok: false };

const isInside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const LOG_EVENT_NAMES = new Set([
  "server.started", "server.stopped", "server.lost", "monitor.lost", "prompt.started", "prompt.retried",
  "prompt.completed", "session.created", "session.deleted", "failure.reported",
]);
const OUTCOMES = new Set(["answered", "cancelled", "failed", "permission-rejected", "question-rejected"]);
const FAILURE_CATEGORIES = new Set(["OpenCode", "Provider/inference", "Configuration", "Local state"]);

const recordFor = (event: OperationalLogEvent): Record<string, string | number | boolean> | undefined => {
  if (!LOG_EVENT_NAMES.has(event.event)) return undefined;
  switch (event.event) {
    case "prompt.completed": {
      const outcome = OUTCOMES.has(event.outcome) ? event.outcome : "failed";
      return {
        event: event.event,
        outcome,
        ...(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 ? { elapsedMs: Math.floor(event.elapsedMs) } : {}),
      };
    }
    case "session.deleted":
      return { event: event.event, verified: event.verified === true };
    case "failure.reported":
      return {
        event: event.event,
        category: FAILURE_CATEGORIES.has(event.category) ? event.category : "OpenCode",
      };
    default:
      return { event: event.event };
  }
};

/** Opens a private, append-only JSONL file only when its explicit path is outside the project. */
export function openOperationalLog(configuredPath: string | undefined, projectRoot: string): OperationalLogResult {
  if (configuredPath === undefined || configuredPath === "" || !isAbsolute(configuredPath)) return { ok: false };
  let fd: number | undefined;
  try {
    const root = realpathSync(projectRoot);
    const requested = resolve(configuredPath);
    const directory = realpathSync(dirname(requested));
    const path = resolve(directory, basename(requested));
    if (isInside(root, path)) return { ok: false };

    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) return { ok: false };
    } catch (error) {
      if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "ENOENT") return { ok: false };
    }

    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) {
      closeSync(fd);
      return { ok: false };
    }
    fchmodSync(fd, 0o600);
    let closed = false;
    const logger: OperationalLog = {
      path,
      write(event) {
        if (closed) return;
        try {
          const fields = recordFor(event);
          if (fields === undefined) return;
          const record = { timestamp: new Date().toISOString(), ...fields };
          writeSync(fd!, `${JSON.stringify(record)}\n`, undefined, "utf8");
        } catch {
          try { closeSync(fd!); } catch { /* best effort: diagnostics cannot affect execution */ }
          closed = true;
        }
      },
      close() {
        if (closed) return;
        closed = true;
        try { closeSync(fd!); } catch { /* best effort: diagnostics cannot affect execution */ }
      },
    };
    return { ok: true, logger };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    return { ok: false };
  }
}
