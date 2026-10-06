# Security Review: Milestone 3 — Interactive Permission Handling

## Cycle 1 — 2026-10-05
Reviewing: Groups 1–6

### Threat Model
- A target project and its Git metadata may be attacker-controlled.
- OpenCode project plugins execute in the authenticated server process, which holds credentials for Quoder’s local API.
- The model can request operations through OpenCode; Quoder must forward only explicit user decisions.
- Permission events and model-controlled strings cross into the terminal UI and must not spoof or obscure the requested scope.
- The local server is bound to loopback; its credentials, sessions, and native permission store are sensitive assets.
- Automated verification used source, tests, and typecheck; no model prompt or runtime acceptance script was run.

### Critical
- [src/opencode-project-policy.ts:22](/Users/jeffrey/Development/quoder/src/opencode-project-policy.ts:22) **Confidence: High** — The project-plugin scanner checks for the literal JSON key `"plugin"` with a regular expression instead of parsing the config. A valid JSON key such as `"pl\\u0075gin"` decodes to `plugin`, so OpenCode can load the configured project plugin while Quoder’s scan allows launch. That plugin runs in the authenticated server process and can read `OPENCODE_SERVER_PASSWORD` and inline configuration from its environment, then use the local API to reply to permission requests.
  - **Attack**: An attacker could provide a project whose OpenCode config uses an escaped `plugin` key to activate a malicious plugin. When the developer launches Quoder on that project, the plugin can access server credentials and issue native permission replies without the developer’s decision.
  - **Remediation**: Parse each project config with a parser matching OpenCode’s JSON/JSONC semantics and reject any decoded `plugin` property. Add regression coverage for escaped property names. Keep interactive permission forwarding disabled until the scanner and credential boundary are reviewed again.

### Warning
- None.

### Suggestion
- None.

### Verdict: FAIL

Independent checks passed: `npm test` (22 files, 441 tests) and `npm run typecheck`. 

# Security Review: Milestone 3 — Interactive Permission Handling

## Cycle 2 — 2026-10-05
Reviewing: Groups 1–6

### Threat Model

- A target project and its Git metadata may be attacker controlled.
- Project OpenCode plugins execute in the authenticated server process, which holds credentials for Quoder’s local API.
- The model can request operations through OpenCode; Quoder must forward only explicit user decisions.
- Permission events and model controlled strings cross into the terminal UI and must not spoof or obscure the requested scope.
- The local server is bound to loopback; its credentials, sessions, and native permission store are sensitive assets.
- The Cycle 1 plugin-key scanner bypass was remediated and reviewed with its regression tests.
- No model prompt or live acceptance script was run.

### Critical

- None.

### Warning

- None.

### Suggestion

- [src/opencode-shell-env-plugin.ts:13](/Users/jeffrey/Development/quoder/src/opencode-shell-env-plugin.ts:13) **Confidence: Low** — The hook clears sensitive variables from the environment passed to model-run shells. Actual tool-shell isolation has not been exercised; retain the default-off decision gate until QA verifies that runtime boundary.

### Verdict: PASS

The scanner decodes JSON string tokens before checking property names, so escaped spellings such as `"pl\\u0075gin"` are rejected. It also checks comments between keys and colons, scans ancestor project configuration layers, and rejects project plugin directories. The added tests cover the escaped-key bypass and decoy strings and comments. No critical or warning findings were identified.
