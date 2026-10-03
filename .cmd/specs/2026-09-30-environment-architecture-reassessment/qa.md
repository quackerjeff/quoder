# QA Report: OpenCode/Ollama Environment and Architecture Reassessment

## Cycle 1 — 2026-10-02
Validating: Groups 1–5 and Fix Groups 1–6 (environment preflight)

QA was performed by a fresh, independent engineer. The checklist is the Group 6 Accept criteria, the spec's "Deterministic preflight contract", and its "Go/no-go decision". `npm run verify:live` was **not** run. The user's real OpenCode configuration and credentials were not read, printed, copied or modified, and no environment variables were printed. No service, model, dependency or configuration was installed, started, stopped or changed. No source, test, configuration or documentation file was modified. The only repository writes are this file and the Group 6 checkbox in `tasks.md`.

### Coverage
- **Automated**
  - `npm run typecheck` passed.
  - `npm test -- --reporter=dot` passed 117/117 across 5 files. The typed-fake preflight suite covers:
    - the passing matrix;
    - absent or malformed configuration and JSONC parsing;
    - an unreachable endpoint and a missing model;
    - direct-inference failure, and OpenCode discovery and inference failure;
    - stage and whole-run deadlines, never-settling operations, post-deadline ownership rejection and late rejection;
    - cleanup failure and redaction.
  - `git diff --check` and `git diff --cached --check` were both clean.
- **Manual (real command, target environment)**
  - Real `npm run verify:environment` happy path: 5 consecutive runs.
  - Synthetic failure paths through `XDG_CONFIG_HOME=<mktemp -d>` with dummy values only, 7 runs:
    - (a) no config;
    - (b) malformed config;
    - (c1) unreachable `https://127.0.0.1:9/v1`;
    - (c2) non-existent `https://qa-nonexistent.invalid/v1`;
    - (d) non-HTTPS `http://127.0.0.1:9/v1`;
    - (e) the required model is not configured;
    - (f) the unroutable RFC 5737 TEST-NET host `https://192.0.2.1/v1`, which exercises the real 10-second discovery deadline.
  - After every run: an OpenCode server/process residue check and a `quoder-live-probe-*` directory check.
  - Structural redaction checks over every captured output.
  - A check that readiness is kept separate from the Milestone 0 predicates, in the output and in the docs.
- **Not covered**
  - **Live expiry of the 60-second inference deadlines and the 180-second whole-run deadline.** Every happy run finished in about 5 s. These deadlines are covered only by fake-timer and typed-fake unit tests.
  - **Live cleanup after a post-launch failure,** where OpenCode inference fails after the disposable repository and server exist. In this cycle, real server-owning cleanup was observed only on successful runs. The failure branch is covered by unit and fake-child tests and by the Fix Group 1–3 records in `tasks.md`.
  - **Live negative path for `Pinned dependencies`.** It would require altering `node_modules` or `package.json`, which is prohibited.
  - **Live failure of `Direct inference`, `OpenCode model discovery` and `OpenCode inference` against the real endpoint.** It would require mutating the real config, service or model, which is prohibited. These are covered by typed-fake tests only.
  - **Cold-model latency.** All runs found the model warm.
  - **Any Milestone 0 capability predicate.** These are out of scope by design.

### Environment
- **Host:** macOS 26.7 (build 25G229), arm64 (Darwin 25.6.0).
- **Runtime:** Node `v24.18.1`, npm `12.0.2`.
- **Pinned dependencies:** `npm ls --depth=0 @opencode-ai/sdk opencode-ai` exited 0 and reported `@opencode-ai/sdk@1.18.33` and `opencode-ai@1.18.33`.
- **Repository:** HEAD `91b9d04`. The working tree is uncommitted Group 1–5 and Fix Group 1–6 work. `git status --short` was identical before and after QA, apart from this report and the Group 6 checkbox.
- **Topology** (from `decisions.md` and `docs/tech.md`; not re-read from user configuration):
  - A remote HTTPS OpenAI-compatible service at the redacted host identity recorded in `decisions.md`.
  - OpenCode provider `ollama` via `@ai-sdk/openai-compatible`.
  - Diagnostic model `ollama/qwen3-coder:30b`.
- **Pre-existing unrelated processes:** the user's interactive OpenCode sessions (PIDs 55010, 55071, 55074, 75881) were already running, started 2026-10-01. They are not `opencode serve` and are not preflight residue. The same set appeared after every run, and no new PID appeared.
- **Temporary directory:** `os.tmpdir()` = `$TMPDIR` = `/var/folders/86/…/T`. Five pre-existing `tmp.*` directories dated 2026-09-25 are unrelated to this cycle.

### Results

#### Automated
| Command | Exit | Elapsed | Result |
| --- | --- | --- | --- |
| `npm run typecheck` | 0 | 0.33 s | No errors |
| `npm test -- --reporter=dot` | 0 | 2.17 s | 5 files, 117/117 passed |
| `git diff --check` | 0 | — | Clean |
| `git diff --cached --check` | 0 | — | Clean |

#### Real happy path: `npm run verify:environment` (default configuration)
Each run printed exactly the following lines, identical across all five runs, after the `npm notice` and `tsc` build lines:

```
Pinned dependencies: PASS - verified
Provider configuration: PASS - verified
Endpoint reachability: PASS - verified
Model discovery: PASS - verified
Direct inference: PASS - verified
OpenCode model discovery: PASS - verified
OpenCode inference: PASS - verified
Cleanup: PASS - verified
Environment Readiness: PASS
```

| Run | Start (UTC) | Exit | Wall clock (`/usr/bin/time -p`, includes `build:live`) | Rows in approved order | Verdict lines | `pgrep -fl "opencode serve"` | `quoder-live-probe-*` dirs | New OpenCode PIDs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 17:11:16 | 0 | 5.48 s | 8/8 | 1 (`PASS`) | none (exit 1) | 0 | none |
| 2 | 17:11:31 | 0 | 4.91 s | 8/8 | 1 (`PASS`) | none (exit 1) | 0 | none |
| 3 | 17:11:40 | 0 | 4.81 s | 8/8 | 1 (`PASS`) | none (exit 1) | 0 | none |
| 4 | 17:11:45 | 0 | 4.77 s | 8/8 | 1 (`PASS`) | none (exit 1) | 0 | none |
| 5 | 17:11:50 | 0 | 4.95 s | 8/8 | 1 (`PASS`) | none (exit 1) | 0 | none |

- **Reliability:** 5/5 PASS. Elapsed time ranged from 4.77 s to 5.48 s (mean about 4.98 s), far under the 180-second whole-run bound. Exit 0 occurred only with all eight rows PASS.
- **Readiness layers:** every layer passed on every run: service/endpoint, model, direct inference, OpenCode model discovery, project-local OpenCode inference, and cleanup.

#### Synthetic failure paths (`XDG_CONFIG_HOME=<fresh mktemp -d> npm run verify:environment`)
Each temporary directory was removed after its run, and removal was confirmed. Dummy values only were used: header `Authorization: Bearer qa-dummy-secret-value-1234567890`.

Row columns:
- **Pin:** Pinned dependencies
- **Cfg:** Provider configuration
- **Endpoint:** Endpoint reachability
- **Model:** Model discovery
- **Direct:** Direct inference
- **OC disc:** OpenCode model discovery
- **OC inf:** OpenCode inference

Row values:
- **skip:** `FAIL - prerequisite check failed`
- **fail:** `FAIL - check failed; sensitive diagnostics suppressed`
- **timeout:** `FAIL - finite deadline exceeded`

| Case | Config | Pin | Cfg | Endpoint | Model | Direct | OC disc | OC inf | Cleanup | Verdict | Exit | Wall clock | Residue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (a) | No `opencode/` config file | PASS | fail | skip | skip | skip | skip | skip | PASS | FAIL | 1 | 0.57 s | none; 0 dirs |
| (b) | Truncated `opencode.json` | PASS | fail | skip | skip | skip | skip | skip | PASS | FAIL | 1 | 0.46 s | none; 0 dirs |
| (c1) | Valid JSONC, `https://127.0.0.1:9/v1` | PASS | PASS | fail | skip | skip | skip | skip | PASS | FAIL | 1 | 0.41 s | none; 0 dirs |
| (c2) | Valid JSONC, `https://qa-nonexistent.invalid/v1` | PASS | PASS | fail | skip | skip | skip | skip | PASS | FAIL | 1 | 0.51 s | none; 0 dirs |
| (d) | Valid JSONC, `http://127.0.0.1:9/v1` | PASS | fail (HTTPS required) | skip | skip | skip | skip | skip | PASS | FAIL | 1 | 0.42 s | none; 0 dirs |
| (e) | Valid JSONC, model `qa-other-model` only | PASS | fail | skip | skip | skip | skip | skip | PASS | FAIL | 1 | 0.43 s | none; 0 dirs |
| (f) | Valid JSON, `https://192.0.2.1/v1` (TEST-NET, unroutable) | PASS | PASS | timeout | skip | skip | skip | skip | PASS | FAIL | 1 | 10.95 s | none; 0 dirs |

- **Failure-path expectations:** every expected result held.
  - (a) gave `Provider configuration: FAIL`, the downstream rows as prerequisite failures, `Cleanup` present, and exit 1.
  - (b) and (d) were rejected by the parser.
  - (c1) and (c2) gave `Endpoint reachability: FAIL`.
  - (f) proved that the real 10-second discovery deadline is finite. The run took 10.95 s including the build.
- **No OpenCode work in synthetic cases:** none started an OpenCode child, so the synthetic configuration was never handed to OpenCode.
- **Structural checks on all 12 outputs** (5 happy, 7 failure) were automated with a scratch checker:
  - exactly 8 rows, in the approved order;
  - exactly 1 `Environment Readiness:` line;
  - exit code consistent with the rows (0 only when all pass);
  - no program output line besides the rows and the verdict.

#### Redaction
- **Evidence strings:** every row's evidence string is one of the four fixed values (`verified`, `check failed; sensitive diagnostics suppressed`, `prerequisite check failed`, `finite deadline exceeded`).
- **Credential and content search:** across all 12 captured outputs, there were 0 matches for:
  - `Bearer`, `Basic `, `Authorization`;
  - `qa-dummy`, `1234567890`;
  - `ENVIRONMENT_READY` (model output and the prompt sentinel);
  - the configured host name;
  - `127.0.0.1`, `192.0.2`, `invalid`;
  - any run of 32 or more base64/token characters.
- **Dummy secret:** it never appeared in the output, including in case (c), where an authenticated request was attempted.
- **Raw configuration, URLs and server diagnostics:** none were emitted.

#### Cleanup
- After all 12 runs, `pgrep -fl "opencode serve"` returned nothing.
- No new `opencode` PID appeared.
- 0 `quoder-live-probe-*` directories remained in `$TMPDIR`.
- Every synthetic `XDG_CONFIG_HOME` directory was deleted.
- `Cleanup: PASS` was reported on every run.

#### Separation from Milestone 0
- **Preflight output:** it contains no capability, predicate or Milestone wording.
- **README:** it still states "Capability verdict: FAIL. Milestone 1 remains blocked."
- **`docs/tech.md`:** it states that the preflight "does not change any Milestone 0 capability result".
- **`spec.md`, `decisions.md`, `tasks.md`:** each states that readiness PASS changes no Milestone 0 predicate.
- **Conclusion:** nothing examined presents environment readiness as passing any of the nine predicates.

### Go/no-go criteria check
| Criterion | Evidence | Met |
| --- | --- | --- |
| Topology documented | `decisions.md` "Group 1/2 decision state" and `docs/tech.md` record a remote HTTPS OpenAI-compatible provider `ollama` and model `ollama/qwen3-coder:30b` | Yes |
| Service/endpoint passes | `Endpoint reachability: PASS`, 5/5 | Yes |
| Model passes | `Model discovery: PASS`, 5/5 | Yes |
| Direct inference passes | `Direct inference: PASS`, 5/5 | Yes |
| Project-local OpenCode inference passes | `OpenCode model discovery` and `OpenCode inference` PASS, 5/5 | Yes |
| Output finite | 4.77–10.95 s on all 12 runs; real deadline expiry proven at 10 s | Yes |
| Output redacted | Fixed evidence strings only, 0 credential or content matches | Yes |
| Output reproducible | 5 consecutive identical PASS outputs; identical failure shapes per case | Yes |
| Reviews pass | `review.md` Cycle 7: PASS, 0 critical, 0 warnings | Yes |
| Security review passes | `security-review.md` Cycle 1: PASS, 0 critical, 0 warnings | Yes |
| This QA gate passes | No Critical or Warning findings below | Yes |

### Critical
- None.

### Warning
- None.

### Suggestion
- **[docs] Stale preflight status for Group 7.**
  - `docs/tech.md` "Environment Preflight Implementation" still says `OpenCode inference` remained FAIL (2026-09-30) and that the integration incompatibility "remains unresolved".
  - The `decisions.md` "Group 1/2 decision state" block still lists the classification as `Integration incompatibility` and the recommendation as `NO-GO`.
  - Later decisions reclassify the failure, and this cycle observed readiness PASS 5/5.
  - Group 7 should reconcile these statements without implying any Milestone 0 change.
- **[preflight UX] Configuration failures share one evidence string.**
  - Absent, malformed, non-HTTPS and model-not-configured configurations all print the same `check failed; sensitive diagnostics suppressed`.
  - The row identifies the layer, which matches the taxonomy granularity. A fixed, non-secret sub-reason (for example "absent", "unparseable", "non-HTTPS", "model not configured") would make the output more actionable without weakening redaction.
- **[coverage] Live server-owning failure path not exercised.**
  - Real cleanup after a failure inside `OpenCode inference`, once the server and repository exist, was not exercised live in this cycle, because inducing it would need a real config or service change.
  - If a safe injection point is ever added, for example a fixed wrong sentinel behind a test-only flag, one live run would close this gap.
- **[carry-forward] Prior nonblocking suggestions remain open.** None blocks readiness:
  - from `review.md` Cycle 7: the `>=` timestamp-boundary test, a docs clause on failed-step rejection, and the vacuous closure assertion;
  - from `security-review.md`: `OPENCODE_SERVER_PASSWORD` inherited by tool processes, which is a Milestone 1 concern; `redirect: "error"`; resolving from `process.cwd()`; and the fixture `wx` write.

### Residual Gaps
- **What `npm run verify:live` will exercise that the preflight cannot.** The preflight proves only that the service, model, direct inference, and one minimal project-local OpenCode prompt work, with cleanup. It cannot prove any of the nine Milestone 0 predicates:
  - Fresh session creation;
  - Project directory;
  - Local model invocation in the full scenario;
  - Streaming events;
  - Permission handling;
  - File modification;
  - Cancellation;
  - Session deletion;
  - Session isolation.
- **Real-process cancellation timing.** It depends on the model choosing one tokenized foreground `bash` call, and on the same-host timestamp and sequence ordering, which has only been unit-tested and validated in diagnostics.
- **Multi-step final-response correlation.** Correlation under real multi-step turns has never been exercised end to end.
- **Accepted permission-event race** (`decisions.md`, "Accept the permission-event subscription race", user-accepted):
  - `permission.v2.asked` is not replayable.
  - The SDK's SSE subscription connects lazily on the first read, after `permission.create` is dispatched.
  - A missed event fails conservatively, as Permission handling FAIL bounded by the 120-second stream timeout.
  - If `verify:live` reports Permission handling FAIL with no observed `permission.v2.asked`, investigate this race first. The fix is to connect the global stream before `create`.
- **Environment drift.** The remote endpoint had an outage during Fix Group 6 (connection refused). Readiness is a point-in-time observation, so rerun `npm run verify:environment` immediately before any authorized `verify:live`.
- **Cold-model latency.** It was not observed in this cycle. All five runs took about 5 s, against the 60-second inference deadlines.
- **Untested live deadlines.** Live expiry of the 60-second and 180-second deadlines was not observed. It is covered by unit tests only.

### Release Confidence
- READY. The environment preflight is ready to gate a future, separately authorized authoritative capability run. This is readiness confidence only and is not a statement about product release.

Future Capability QA: GO

GO does not pass Milestone 0 and does not authorize Milestone 1, and it does not itself authorize running `npm run verify:live`. Running it requires separate, explicit user authorization. Milestone 0 passes only when a later, separately user-authorized `npm run verify:live` reports PASS for all nine predicates: Fresh session creation, Project directory, Local model invocation, Streaming events, Permission handling, File modification, Cancellation, Session deletion, and Session isolation. Milestone 1 remains blocked until then. The prior capability verdict (FAIL) is unchanged.

### Verdict: PASS
