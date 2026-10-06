/**
 * Model-independent runtime acceptance for OpenCode's native saved-permission contract.
 * This intentionally is not part of `npm test`; run `npm run verify:permissions` explicitly.
 */
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import {
  basicAuthorizationHeader,
  defaultAuthenticatedServerLauncherDependencies,
  launchAuthenticatedOpenCodeServer,
} from "../src/opencode-server.js";

const execFileAsync = promisify(execFile);

interface ApiResult<T> {
  readonly data: T | undefined;
  readonly error: unknown | undefined;
  readonly response: Response;
}

const requireData = <T>(result: ApiResult<T>): T => {
  requireOK(result);
  if (result.data === undefined) throw new Error("OpenCode permission acceptance request failed");
  return result.data;
};

const requireOK = (result: ApiResult<unknown>): void => {
  if (result.error !== undefined || !result.response.ok) throw new Error("OpenCode permission acceptance request failed");
};

const report = (name: string, pass: boolean): void => {
  process.stdout.write(`${name}: ${pass ? "PASS" : "FAIL"}\n`);
};

async function main(): Promise<number> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "quoder-permission-acceptance-"));
  const projectA = join(temporaryRoot, "project-a");
  const projectB = join(temporaryRoot, "project-b");
  const outside = join(temporaryRoot, "outside");
  await Promise.all([mkdir(projectA), mkdir(projectB), mkdir(join(outside, "approved"), { recursive: true })]);
  const [canonicalA, canonicalB, canonicalResource] = await Promise.all([
    realpath(projectA),
    realpath(projectB),
    realpath(join(outside, "approved")),
  ]);
  await Promise.all([
    execFileAsync("git", ["init", "--quiet"], { cwd: canonicalA }),
    execFileAsync("git", ["init", "--quiet"], { cwd: canonicalB }),
  ]);
  await Promise.all([
    execFileAsync("git", ["remote", "add", "origin", `https://example.invalid/quoder-acceptance-a-${randomBytes(6).toString("hex")}.git`], { cwd: canonicalA }),
    execFileAsync("git", ["remote", "add", "origin", `https://example.invalid/quoder-acceptance-b-${randomBytes(6).toString("hex")}.git`], { cwd: canonicalB }),
  ]);
  const resource = join(canonicalResource, "harmless-probe.txt");
  const savePattern = join(canonicalResource, "**");
  const previousConfig = process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { external_directory: "ask" } });

  type Server = Awaited<ReturnType<typeof launchAuthenticatedOpenCodeServer>>;
  type Client = ReturnType<typeof createOpencodeClient>;
  const runtimes: Array<{ readonly server: Server; readonly client: Client }> = [];
  const sessions: Array<{ readonly client: Client; readonly sessionID: string }> = [];
  const projectIDs = new Set<string>();
  let failureRow = "Launch authenticated no-model server";
  let startupDiagnostics = "";
  try {
    const launchRuntime = async (directory: string): Promise<{ readonly server: Server; readonly client: Client }> => {
      const username = "quoder-permission-check";
      const password = randomBytes(32).toString("base64url");
      startupDiagnostics = "";
      const server = await launchAuthenticatedOpenCodeServer({ username, password, cwd: directory }, {
        ...defaultAuthenticatedServerLauncherDependencies,
        spawnServer: (config) => {
          const child = spawn(config.executable, [...config.args], {
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            env: config.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const collectSafeDiagnostic = (chunk: Buffer) => {
            // Retained in memory only so a fixed category can be emitted on failure. Never print
            // or persist raw OpenCode output, which may contain sensitive configuration details.
            if (startupDiagnostics.length < 64_000) startupDiagnostics += chunk.toString("utf8").slice(0, 64_000 - startupDiagnostics.length);
          };
          child.stdout.on("data", collectSafeDiagnostic);
          child.stderr.on("data", collectSafeDiagnostic);
          return child;
        },
      });
      const client = createOpencodeClient({
        baseUrl: server.url,
        headers: { Authorization: basicAuthorizationHeader(username, password) },
      });
      const runtime = { server, client };
      runtimes.push(runtime);
      return runtime;
    };

    failureRow = "Launch authenticated no-model server for project A";
    const runtimeA = await launchRuntime(canonicalA);
    failureRow = "Create temporary project session";
    const createSession = async (activeClient: Client, directory: string) => {
      const body = requireData(await activeClient.v2.session.create({
        agent: "build",
        location: { directory },
      }));
      sessions.push({ client: activeClient, sessionID: body.data.id });
      projectIDs.add(body.data.projectID);
      return body.data;
    };
    const createRequest = async (activeClient: Client, sessionID: string, save: readonly string[] = []) => {
      const body = requireData(await activeClient.v2.session.permission.create({
        sessionID,
        agent: "build",
        action: "external_directory",
        resources: [resource],
        save: [...save],
      }));
      if (body.data.effect !== "ask") throw new Error("OpenCode did not ask for the harmless outside-project resource");
      const pending = requireData(await activeClient.v2.session.permission.list({ sessionID })).data;
      if (!pending.some((request) => request.id === body.data.id)) throw new Error("Asked permission was not listed as pending");
      return body.data.id;
    };
    const listSaved = async (activeClient: Client, projectID: string) =>
      requireData(await activeClient.v2.permission.saved.list({ projectID })).data;

    const sessionA = await createSession(runtimeA.client, canonicalA);
    failureRow = "No-model permission request and pending list";
    const initialRequest = await createRequest(runtimeA.client, sessionA.id, [savePattern]);
    report("No-model permission request and pending list", true);
    failureRow = "Allow for project persists exact native pattern";
    requireOK(await runtimeA.client.v2.session.permission.reply({
      sessionID: sessionA.id,
      requestID: initialRequest,
      reply: "always",
    }));
    const savedA = await listSaved(runtimeA.client, sessionA.projectID);
    const exactSaved = savedA.filter((item) => item.action === "external_directory" && item.resource === savePattern);
    if (exactSaved.length !== 1) throw new Error("OpenCode did not save the exact pattern for project A");
    report("Allow for project persists exact native pattern", true);

    failureRow = "Launch authenticated no-model server for project B";
    const runtimeB = await launchRuntime(canonicalB);
    failureRow = "Create temporary project session B";
    const sessionB = await createSession(runtimeB.client, canonicalB);
    if (sessionA.projectID === sessionB.projectID) {
      failureRow = "Temporary Git projects receive separate OpenCode project IDs";
      throw new Error("Temporary projects did not receive separate project IDs");
    }
    failureRow = "Project B still asks for project A's saved resource";
    const requestB = await createRequest(runtimeB.client, sessionB.id);
    requireOK(await runtimeB.client.v2.session.permission.reply({
      sessionID: sessionB.id,
      requestID: requestB,
      reply: "reject",
    }));
    const savedB = await listSaved(runtimeB.client, sessionB.projectID);
    if (savedB.some((item) => item.resource === savePattern)) {
      failureRow = "Project B saved-permission listing excludes project A's pattern";
      throw new Error("Project A's saved pattern leaked into project B");
    }
    report("Saved pattern is isolated to project A", true);

    failureRow = "Native saved-pattern revocation";
    for (const item of exactSaved) requireOK(await runtimeA.client.v2.permission.saved.remove({ id: item.id }));
    const afterRevoke = await listSaved(runtimeA.client, sessionA.projectID);
    if (afterRevoke.some((item) => item.resource === savePattern)) throw new Error("Saved pattern remained after native revocation");
    report("Native saved-pattern revocation", true);

    failureRow = "Revoked pattern asks again";
    const requestAfterRevoke = await createRequest(runtimeA.client, sessionA.id, [savePattern]);
    requireOK(await runtimeA.client.v2.session.permission.reply({
      sessionID: sessionA.id,
      requestID: requestAfterRevoke,
      reply: "reject",
    }));
    report("Revoked pattern asks again", true);
    report("Overall no-model permission acceptance", true);
    return 0;
  } catch (error) {
    if (failureRow.startsWith("Launch authenticated no-model server") && error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes("timed out")) failureRow = "OpenCode server listener startup timeout";
      else if (message.includes("exited during startup")) failureRow = "OpenCode server exited before listener readiness";
      else if (message.includes("did not accept") || message.includes("did not reject")) failureRow = "OpenCode server authentication check";
      const diagnostic = startupDiagnostics.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").toLowerCase();
      if (diagnostic.includes("eacces") || diagnostic.includes("eperm") || diagnostic.includes("operation not permitted")) {
        failureRow = "Local server listener was blocked by execution permissions";
      } else if (diagnostic.includes("opencode-shell-env-plugin")) failureRow = "OpenCode shell hook module startup";
      else if (diagnostic.includes("plugin") && failureRow === "OpenCode server exited before listener readiness") failureRow = "OpenCode server plugin startup";
      else if (diagnostic.includes("config") && failureRow === "OpenCode server exited before listener readiness") failureRow = "OpenCode server inline configuration startup";
    }
    report(failureRow, false);
    report("Overall no-model permission acceptance", false);
    return 1;
  } finally {
    const cleanupClient = runtimes[0]?.client;
    if (cleanupClient !== undefined) {
      for (const projectID of projectIDs) {
        const saved = await cleanupClient.v2.permission.saved.list({ projectID }).catch(() => undefined);
        if (saved?.data !== undefined && saved.error === undefined) {
          for (const item of saved.data.data) await cleanupClient.v2.permission.saved.remove({ id: item.id }).catch(() => undefined);
        }
      }
      for (const { client, sessionID } of sessions) await client.session.delete({ sessionID }).catch(() => undefined);
    }
    for (const runtime of runtimes.reverse()) await runtime.server.close().catch(() => undefined);
    if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = previousConfig;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

process.exitCode = await main();
