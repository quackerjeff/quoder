# Milestone 1 — Minimal Harness

## Context

Milestone 0 passed: the authoritative `npm run verify:live` (2026-10-03) reported PASS for all nine predicates against the pinned OpenCode `1.18.33`. `docs/requirements.md` defines Milestone 1 as the first usable command-line harness:

- **Goal.** A persistent prompt in which each submitted prompt creates a fresh OpenCode session, runs it against the local model, shows the response, and deletes the session.
- **Exit criterion.** The developer can submit multiple prompts without manually restarting OpenCode, and every prompt executes in a fresh OpenCode session.

Relevant requirements: FR-1 (launch from a project directory), FR-3 (fresh session per prompt), FR-15 (session destruction), NFR-1 (OpenCode isolated behind an adapter), NFR-2 (a crash must not damage the repository), and NFR-5 (local-first). FR-7 and FR-8 (interactive permissions) are Milestone 3. FR-12 (full cancellation) is Milestone 2.

The product name is **Quoder**. The requirements' `quackharness` command and `.quackharness/` directory are earlier working names. The prompt label `QuackTrack >` is the developer's *project* name (`~/Development/QuackTrack`), so the prompt shows the current project's name.

## Decision

Build a `quoder` CLI on the Milestone 0 mechanisms, which are proven live:

- authenticated project-local server launch;
- Core V2 sessions with an explicit model binding;
- completion via `session/active`;
- final-response correlation;
- verified deletion;
- the run-long event monitor.

Move those mechanisms from the probe into shared modules, so the probe and the harness use one implementation and the probe keeps passing.

User decisions (2026-10-03):

1. **Credentials: deferred to Milestone 3.** Model-run shell commands can read the OpenCode server password. A verified mitigation (a `shell.env` plugin hook) requires dropping `--pure`. Under the default policy bash is already allowed, so the exposure grants nothing beyond bash in Milestone 1. It becomes material with Milestone 3's restrictive shell rules, and is documented as a known limitation until then.
2. **Model: `ollama/glm-4.7-flash:latest` by default**, bound explicitly to every session, with a `--model provider/id` override. Group 1 verifies it through OpenCode before implementation relies on it. The Milestone 0 probe keeps `ollama/qwen3-coder:30b`.
3. **Ctrl-C: abort and return.** During a prompt, Ctrl-C interrupts the run, settles and deletes the session, and returns to the prompt. At an idle prompt, Ctrl-C or Ctrl-D exits cleanly.

## Constraints

- Retain exact `opencode-ai@1.18.33` and `@opencode-ai/sdk@1.18.33`. Do not modify user OpenCode configuration.
- Keep `--pure`, per decision 1.
- Keep OpenCode the execution and enforcement engine. Quoder never approves a permission request in Milestone 1: every `permission.v2.asked` for a Quoder session is **rejected** and reported to the developer. Rejecting, never approving, keeps enforcement intact. Every `question.v2.asked` is rejected and its question text shown, so the developer can answer in the next prompt.
- Every executed prompt's session is deleted and the deletion verified with a 404 check, including after errors and Ctrl-C. Deletion failures are reported, never silent.
- No automatic Git commits or pushes, and no file edits by Quoder itself (requirements §9).
- Credentials, authorization headers, and raw configuration never reach output, logs, or tracked artifacts.
- The Milestone 0 probe (`npm run verify:live`) and preflight (`npm run verify:environment`) keep working, and their tests keep passing.

## Design

### Command and launch (FR-1)

- `quoder [--model provider/id]` is run from a project directory. The project root is the Git repository root, or the current directory if it is not in a repository. The prompt label is the project root's directory name, for example `QuackTrack > `.
- Quoder starts **one** authenticated, project-local OpenCode server at launch and reuses it for every prompt. If the server exits unexpectedly, the harness reports it and starts a fresh server for the next prompt.
- **Binary location.** The OpenCode binary and package manifests are resolved from Quoder's **installed package location** (`import.meta.url`), never from `process.cwd()`. This fixes the latent launcher defect that the cwd-relative path would cause, and closes the related security suggestion. The server's working directory and every session's location are the project root.
- **Packaging.** `package.json` gains `name`, `version`, `bin: { "quoder": ... }`, and a `build` script that compiles to `dist/`. The CLI can then be run with `node dist/...` or installed with `npm link`.

### Per-prompt execution (FR-3 steps 2, 3, 5, 8, 10; FR-15)

For each non-empty prompt:

1. Create a Core V2 session with the explicit model and the project root as its location.
2. Submit the prompt.
3. Wait for completion through `session/active` plus a turn-scoped assistant message. There is **no fixed execution timeout**; the developer controls duration with Ctrl-C. Individual API calls stay bounded.
4. Show the final response: the turn's last completed assistant message. If the turn ended in a step error, show a concise, credential-safe error instead.
5. Delete and verify the session.

A minimal status line ("Starting fresh OpenCode session…", elapsed time on completion) is shown. Full streaming is Milestone 2.

### Event monitor (reuse)

The run-long monitor from the probe is generalized:

- it is confirmed connected (`server.connected`);
- it is scoped to the harness's own sessions;
- it rejects questions and permission asks for the active session and reports each to the developer;
- it is restarted with the server.

### Ctrl-C and exit

- **During a prompt.** Interrupt, settle to idle, delete, and verify, then return to the prompt with "Execution cancelled." A second Ctrl-C while cleanup is in progress is ignored, with a hint.
- **At an idle prompt.** Ctrl-C, Ctrl-D, or `/exit` exits: delete any remaining session, stop the monitor, terminate the server with the bounded owned-child policy, then exit.
- A failure inside the harness never leaves a server process or an undeleted session silently behind.

### Commands

Milestone 1 accepts `/exit` and `/help`. Other `/`-prefixed input is rejected with a hint; it is reserved for later milestones (FR-13, FR-14).

### Module structure (NFR-1)

- **OpenCode-specific code** stays behind the adapter and server modules: the launcher, the monitor, and the adapter.
- **New harness modules:**
  - project resolution;
  - the session runner (one prompt end to end);
  - the REPL loop with signal handling;
  - output formatting.
- **Testing.** Behaviour is unit-tested with typed fakes (no real server and no model). The REPL is tested through injected input and output streams.

### Verification

- Automated tests cover the following:
  - project resolution;
  - binary resolution independent of the working directory;
  - a fresh session per prompt with deletion on every path: success, model error, rejected permission, rejected question, Ctrl-C, and server loss;
  - output formatting;
  - command handling.
- A bounded live acceptance check (`npm run verify:harness`) drives the real CLI against the real server with the default model:
  - two prompts in one harness process;
  - two distinct session IDs, each deleted (404);
  - no residual server.
  
  It is model-dependent, and a non-cooperating reply is reported as such.

Security review applies: process spawning, binary resolution, an authenticated server, and untrusted model output shown in a terminal (control-sequence sanitization).

## Risks

- **`glm-4.7-flash:latest` has not been verified through OpenCode tool calling.** Group 1 checks it; if it is unreliable, escalate the default-model choice.
- **Untrusted model output.** Terminal escape sequences in model output could manipulate the developer's terminal, so displayed text is sanitized.
- **Shared-module refactor.** Moving code out of the probe risks probe regressions. The probe's existing tests and a fresh `verify:environment` guard it.
- **Rejected permissions and questions.** Rejecting them may end a turn early, which limits what Milestone 1 prompts can accomplish until Milestone 3. The output states the reason.
