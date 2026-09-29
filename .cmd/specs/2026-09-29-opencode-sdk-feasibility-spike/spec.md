# OpenCode SDK Feasibility Spike

## Context

Quoder is intended to give a developer one persistent shell/TUI experience while executing every submitted prompt in a fresh, disposable OpenCode session. The authoritative product requirements are in `docs/requirements.md`.

The PRD explicitly makes SDK feasibility Milestone 0 and prohibits production application work until it passes. The first slice is therefore a disposable TypeScript probe, not the Quoder CLI. It must establish whether the installed OpenCode version exposes every contract on which the architecture depends.

### PRD-to-delivery summary

- **Product goal:** Preserve developer continuity without retaining a growing OpenCode/LLM conversation.
- **Primary user:** A developer using OpenCode with locally hosted Ollama models under constrained VRAM.
- **Key future flow:** Accept a prompt, build compact context, create a fresh OpenCode session, execute visibly and safely, capture the result, and delete the session.
- **Initial non-goals:** A replacement agent runtime, custom editing/shell tools, multi-agent orchestration, autonomous planning, RAG, automatic Git operations, cloud sync, web UI, or IDE integration.
- **Primary constraints:** Local-first operation, OpenCode remains the execution and permission-enforcement engine, repository state remains authoritative, and OpenCode-specific code must stay behind an adapter.

## Decision

Implement only the PRD's Milestone 0 feasibility probe. The probe will use a disposable Git repository to exercise one OpenCode session that writes `hello.txt`, then a second fresh session that demonstrates conversational isolation.

Before implementation, research the actually installed OpenCode version and its authoritative TypeScript SDK/API surface. Record package names, exact versions, import paths, method signatures, event shapes, permission-response flow, cancellation semantics, and session deletion behavior in `docs/tech.md`. No production architecture is approved by this spec beyond the isolation boundary required to keep OpenCode calls in a small adapter/probe module.

This spike may end in either outcome:

- **PASS:** Every PRD exit criterion is demonstrated with reproducible evidence, allowing Milestone 1 to be scoped separately.
- **FAIL:** One or more critical capabilities cannot be demonstrated. Stop and reassess the architecture; do not emulate missing OpenCode behavior inside Quoder without a new decision.

### Smallest viable user outcome

A developer can run one documented verification command and receive an explicit capability matrix showing whether the installed OpenCode environment can safely support Quoder's disposable-session architecture.

### Alternatives considered

- **Build the minimal harness immediately:** Rejected because the PRD explicitly requires the feasibility milestone first.
- **Test only session creation and prompting:** Rejected because permissions, cancellation, deletion, streaming, project-directory targeting, file modification, and isolation are architectural dependencies rather than optional refinements.
- **Use CLI-output scraping:** Not selected. Structured SDK/API contracts must be preferred where available; research must establish whether they are sufficient.

## Constraints

- Do not implement Milestone 1 CLI/TUI behavior, persistent harness state, history, Git summaries, model/agent selectors, or context optimization.
- Do not bypass or reimplement OpenCode permission enforcement.
- Do not run the file-write test against the Quoder repository; create a disposable temporary Git repository.
- Do not write integration code against remembered or inferred OpenCode APIs. Use only contracts verified in `docs/tech.md`.
- Pin the exact installed OpenCode SDK/API package version for the spike if it is alpha, preview, or otherwise unstable.
- Use the developer's existing OpenCode/Ollama configuration; do not provision or reconfigure model infrastructure.
- Treat cleanup as mandatory on success, error, and cancellation paths.
- Keep claims scoped to the environment and OpenCode version actually tested.

## Design

### Research boundary

Group 1 determines the executable contract. It must answer:

1. Which OpenCode package/API and version are installed or supported?
2. Does the supported API connect to or host OpenCode, target a project directory, create/delete sessions, submit prompts, and stream structured events?
3. How are permission requests detected and answered?
4. How is an active execution cancelled, and how is cancellation completion observed?
5. How are final assistant results distinguished from intermediate events?
6. How can the probe prove that a second session has no conversation history from the first?

Unverified answers remain blockers, not implementation assumptions.

### Probe components

- **OpenCode integration module:** The smallest boundary containing verified SDK/API calls.
- **Capability runner:** Executes each required scenario and records pass/fail evidence.
- **Disposable-repository fixture:** Creates an isolated temporary Git repository, supplies the prompt to create `hello.txt`, verifies exact file content, and cleans up safely.
- **Isolation scenario:** In session one, submits `Remember this session-only token: <random 128-bit nonce>. Reply exactly TOKEN_STORED.` and verifies that acknowledgement. After deleting session one, session two receives no harness context or transcript from session one and is asked `Reply with the session-only token from my previous conversation. If no previous conversation is available, reply exactly NO_PRIOR_SESSION.` PASS requires the exact sentinel `NO_PRIOR_SESSION`; returning the nonce is FAIL and any other response is INCONCLUSIVE/FAIL. The report retains the prompts, redacts the nonce to a digest, and records the raw classification.
- **Permission scenario:** Research must identify a harmless action inside the disposable repository that the installed OpenCode policy deterministically classifies as `ask`. The probe submits that action, observes an actual OpenCode permission-request event, responds through the verified OpenCode permission API, and confirms the allowed action completes. A probe-owned mock, a pre-allowed action, or changing the user's policy does not satisfy this live criterion. If the existing environment cannot deterministically produce such a request, the criterion is FAIL and the architecture must be reassessed.
- **Cancellation scenario:** The disposable repository contains a benign long-running fixture command that emits a start marker and then waits beyond the probe timeout. OpenCode is prompted to run that exact fixture. After the structured command/tool-start event and marker are observed, the probe cancels through the verified OpenCode API. PASS requires an OpenCode terminal cancellation result within a finite documented timeout, no normal-completion event after cancellation, termination of the fixture process, and successful session deletion. Failure to start the fixture or reach the cancellation state is FAIL, not a skipped check.
- **Capability report:** Emits all nine PRD exit criteria with evidence and a final PASS/FAIL result.

### Required capability matrix

| Capability | Required evidence |
| --- | --- |
| Fresh session creation | Unique session identifiers from two independent creates |
| Project directory | File activity occurs only in the disposable repository |
| Local model invocation | A final response is received using existing local configuration |
| Streaming events | At least one structured execution event is observed before completion |
| Permission handling | An actual OpenCode permission-request event is detected and answered through the verified OpenCode permission API |
| File modification | `hello.txt` exists with exact content `Hello from OpenCode` |
| Cancellation | Active work reaches an observed cancelled terminal state without terminating the probe |
| Session deletion | Both sessions are explicitly deleted, including cleanup paths |
| Session isolation | The second session cannot use a nonce disclosed only in the first session |

The live runner must print each named row exactly once as `PASS` or `FAIL`, print an overall verdict, and exit nonzero on any failure. The stable entry point for this spec is `npm run verify:live`; Group 1 must verify and pin the Node/npm and test-tool versions that make this command reproducible.

### Testing and QA

Automated tests should cover probe-owned transformations, event classification, report aggregation, cleanup behavior, and adapter calls through a test double. The live environment scenario is a separate opt-in integration verification because it invokes the configured model and OpenCode runtime.

Dedicated QA is required because the result is an environment-dependent go/no-go architecture decision that unit tests alone cannot validate.

### UI design decision

No separate UI-design task is required. This slice produces a developer-facing command/report only, and the required output is the capability matrix above rather than a reusable application interface.

## Open Questions

- What exact OpenCode version and TypeScript package/API are installed in the target environment?
- Does OpenCode support every required lifecycle action through a stable structured API, or are some capabilities experimental?
- Can a permission request be triggered deterministically without unsafe filesystem or shell access?
- What cancellation terminal state and event ordering does the installed version guarantee? Group 1 must resolve this before tests are written.
- Should the eventual product binary be named `quoder`, replacing the PRD examples `quackharness` and `QuackTrack`? This does not block the spike.

## Risks

- The OpenCode SDK may not expose permission or cancellation operations required by the architecture.
- Event ordering or event schemas may be unstable across versions.
- Local model behavior is nondeterministic, so isolation evidence must use a nonce-based assertion and retain diagnostic output.
- Integration tests may hang when OpenCode or Ollama is unavailable; explicit timeouts and cleanup are required.
- A superficially successful file write could occur in the wrong working directory; the disposable-repository boundary must be asserted.
- The PRD uses legacy names in examples, creating naming ambiguity for later user-facing work.

## Source-to-spec audit

- The nine capability outcomes and stop-on-critical-failure rule come directly from PRD Milestone 0.
- TypeScript comes from the PRD's required minimal TypeScript program; no broader production stack is selected.
- The PRD requires `hello.txt` to contain the quoted text. Exact decoded-text equality after permitting at most one trailing newline is an added falsifiability decision. Unit-test seams, explicit timeouts, the nonce/sentinel isolation protocol, deterministic live permission/cancellation protocols, and a machine-readable capability report are also architectural test-design decisions.
- Later PRD milestones are intentionally excluded.
