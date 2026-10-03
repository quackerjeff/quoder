# OpenCode/Ollama Environment and Architecture Reassessment

## Context

The completed `2026-09-29-opencode-sdk-feasibility-spike` produced a reliable but negative Milestone 0 result. QA Cycle 2 proved that the authenticated project-local OpenCode server and an initial Core V2 session could be created, but the first model prompt timed out after 120 seconds while the configured Ollama service was unavailable. The scenario therefore did not reach enough of the workflow to satisfy any of the nine complete capability predicates.

That result is evidence about the tested environment at that time, not proof that the remaining OpenCode contracts are intrinsically incompatible with Quoder. The prior spec, its QA report, reviews, decisions, and implementation remain historical evidence and must not be rewritten or reopened by this work.

The product requirements in `docs/requirements.md` still make Milestone 0 a prerequisite for production development. Milestone 1 remains blocked until one authoritative capability run passes all nine predicates.

## Decision

Perform a bounded reassessment before authorizing another expensive feasibility run. The reassessment will:

1. Establish the intended deployment topology and identify the exact OpenCode provider/model configuration the target environment is supposed to use.
2. Diagnose the model path in layers: process/service availability, endpoint reachability, model presence, direct bounded inference, OpenCode provider discovery, and a minimal bounded OpenCode inference check.
3. Distinguish a restorable environment failure from an architectural incompatibility using recorded evidence rather than inference from the prior timeout.
4. Add a deterministic, non-secret-bearing preflight command if the existing repository lacks one sufficient to reject an unready environment before `npm run verify:live` starts.
5. Produce a documented GO or NO-GO decision about authorizing a future authoritative feasibility QA cycle.

GO means only that the environment and integration path are ready for a separately authorized authoritative capability run. It does not pass Milestone 0 and does not authorize Milestone 1. Milestone 0 passes only when `npm run verify:live` subsequently reports PASS for all nine predicates.

### Smallest viable outcome

A developer can run one bounded preflight and receive an actionable, redacted readiness result before deciding whether to spend time on the authoritative nine-capability scenario.

### Alternatives considered

- **Immediately rerun `npm run verify:live`:** Rejected because QA Cycle 2 already showed that an unavailable model service consumes the prompt timeout and prevents useful downstream evidence.
- **Treat the prior failure as an SDK incompatibility:** Rejected because server startup and Core V2 session creation succeeded, while the configured model path was unavailable and later predicates were not reached.
- **Start Milestone 1 while infrastructure is repaired:** Rejected because the PRD requires all nine Milestone 0 predicates to pass first.
- **Provision or silently reconfigure Ollama during diagnosis:** Rejected. Diagnosis must first identify the intended topology and configuration; any mutation requires an explicit, bounded implementation task justified by evidence.

## Constraints

- Do not begin Milestone 1 or implement production CLI/TUI features.
- Do not edit or reinterpret the completed prior spec as if it were active work.
- Do not run `npm run verify:live` during research, diagnosis, implementation, review, or security review. A future authoritative run requires a documented GO decision and explicit user authorization.
- Do not install, upgrade, start, stop, or reconfigure OpenCode, Ollama, models, system services, remote hosts, or user-level configuration during Group 1.
- Do not expose provider credentials, authorization headers, tokens, raw configuration secrets, model prompt content, or sensitive server diagnostics in tracked artifacts or command output.
- Continue to use the project-local `opencode-ai@1.18.33` and `@opencode-ai/sdk@1.18.33` unless verified findings support a separately recorded dependency decision.
- All probes must have explicit finite timeouts, avoid destructive prompts, and leave no server, model request, fixture, or temporary repository running.
- Keep environment readiness distinct from capability success. A passing preflight cannot satisfy any of the nine Milestone 0 predicates.

## Design

### Evidence layers

Diagnosis proceeds from cheapest and most deterministic to most integrated:

1. **Topology and configuration intent** — determine whether Ollama is expected locally or on another host and which OpenCode provider/model identifier is intended. Record only redacted configuration shape and source location.
2. **Runtime availability** — verify the expected endpoint is reachable and responds as the expected service within a short timeout.
3. **Model availability** — verify the configured model identifier is present and discoverable without pulling or mutating models.
4. **Direct bounded inference** — submit a harmless sentinel request directly through the intended model service and require an exact bounded response.
5. **OpenCode integration** — verify the project-local OpenCode process resolves the intended provider/model and can complete a minimal harmless prompt with finite timeout and cleanup.
6. **Readiness decision** — compare results against the decision matrix below.

Each layer records command/procedure, timestamp, platform and relevant version, redacted endpoint identity, duration, exit status, and a concise classification. Raw secrets and unrestricted provider dumps are prohibited.

### Failure taxonomy

| Classification | Meaning | Required disposition |
| --- | --- | --- |
| Environment unavailable | Intended service is stopped, unreachable, or the intended model is absent | Describe the bounded restoration required; no architectural conclusion |
| Configuration mismatch | Ollama works directly but project-local OpenCode resolves the wrong endpoint, provider, or model | Specify a reviewed configuration correction and regression preflight |
| Integration incompatibility | Direct inference works, but the pinned project-local OpenCode path fails reproducibly with equivalent bounded inputs | Record contract evidence and evaluate architecture or version options |
| Ready for capability QA | All preflight layers pass with finite cleanup | Recommend GO for a separately authorized authoritative run |
| Inconclusive | Evidence is conflicting, unsafe to collect, or depends on unresolved user intent | Recommend NO-GO and state the exact missing decision/evidence |

### Deterministic preflight contract

Group 2 approves a stable `npm run verify:environment` command that:

- validates the pinned project-local CLI/SDK versions;
- reads only the required provider fields from the existing OpenCode configuration and never emits the authorization value;
- checks the configured remote endpoint and exact diagnostic model `ollama/qwen3-coder:30b` without changing either;
- proves a bounded harmless inference through the model service and through project-local OpenCode when safe;
- emits exactly these stable rows: `Pinned dependencies`, `Provider configuration`, `Endpoint reachability`, `Model discovery`, `Direct inference`, `OpenCode model discovery`, `OpenCode inference`, and `Cleanup`, followed by exactly one `Environment Readiness: PASS|FAIL`;
- exits zero only when every required readiness row passes;
- reports actionable classifications without secrets or raw configuration;
- uses 10-second endpoint/model-discovery deadlines, 60-second direct/OpenCode inference deadlines, and a 180-second whole-run deadline, and performs cleanup on every path;
- remains explicitly separate from `npm run verify:live` and the nine-capability verdict.

The implementation must also pass `{ providerID: "ollama", id: "qwen3-coder:30b" }` when the feasibility probe creates each model-executing Core V2 session. It must not rely on OpenCode's ambient default model. This removes the verified default-selection ambiguity but does not classify readiness as PASS unless the OpenCode inference row itself passes.

Tests isolate filesystem, HTTP, and process boundaries with typed fakes. They cover the passing matrix, absent or malformed provider configuration, unreachable endpoint, missing model, direct-inference failure, OpenCode discovery/inference failure, timeout, credential redaction, and cleanup after every post-launch failure. No automated test contacts the real endpoint or starts the real CLI.

Security review is applicable because the implementation reads credential-bearing configuration, sends authenticated network requests, launches an authenticated child process, and writes diagnostics.

### Go/no-go decision

The final decision for a future capability QA cycle is:

- **GO:** the intended topology is documented; service, model, direct inference, and project-local OpenCode integration checks all pass; preflight output is finite, redacted, and reproducible; reviews and this spec's QA gate pass.
- **NO-GO:** any required layer fails or remains inconclusive. Record whether the next action is environment restoration, configuration correction, dependency evaluation, or architecture reconsideration.

Neither decision changes the prior capability verdict. Even after GO, the user must explicitly authorize the authoritative `npm run verify:live` run. Milestone 1 remains blocked unless that later run passes Fresh session creation, Project directory, Local model invocation, Streaming events, Permission handling, File modification, Cancellation, Session deletion, and Session isolation.

### UI decision

No product UI design is required. The only user-facing behavior in scope is a developer diagnostic command with stable, readable readiness rows and actionable failures.

## Risks

- The intended Ollama host may be remote while diagnosis runs on the development Mac. Mitigation: establish topology before treating local service absence as a fault.
- Reading provider configuration may reveal secrets. Mitigation: inspect only necessary fields, redact values at collection boundaries, and prohibit raw configuration capture.
- A lightweight inference can still be slow or consume GPU resources. Mitigation: use a harmless minimal sentinel, finite deadlines, and one attempt per evidence layer unless a task explicitly authorizes repetition.
- A passing preflight may be mistaken for feasibility success. Mitigation: keep readiness and capability verdicts separately named and repeat the nine-predicate gate in reports and docs.
- Findings may imply an OpenCode or provider upgrade. Mitigation: do not upgrade in place; document compatibility evidence and create a separate decision/task before dependency changes.

## Source-to-Spec Audit

- **Source requirement:** `docs/requirements.md` requires Milestone 0 SDK feasibility before application development and requires all nine capability predicates.
- **Prior evidence:** QA Cycle 2 reliably failed in an environment where Ollama was unavailable; it did not establish inherent failure of unexecuted contracts.
- **User direction:** begin a separate environment/architecture reassessment spec.
- **Architectural elaboration:** the layered preflight, failure taxonomy, and GO/NO-GO readiness gate are introduced here to make the required reassessment deterministic and inexpensive. They do not weaken or replace the PRD capability gate.
