# QA Report: Milestone 8 Context Optimization

## Cycle 1 — 2026-10-07
Validating: Group 7 tasks

### Coverage

- **Automated:** Group 4's prescribed suite passed: five test files, 146 tests; `npm run typecheck`; and `npm run build`. Evidence is recorded in `review.md`. The context-builder tests verify exact Unicode code-point accounting for the context, current request, and combined prompt; the 4,096-code-point background-context bound; verbatim current request; untrusted-data escaping; saved decisions and constraints; live Git state; previous developer-request follow-up; and exclusion of assistant-response-only content. The fixed 20-turn comparison is an automated acceptance assertion.
- **Automated:** Stream-event and live-view tests cover valid input/output fields, partial and absent fields, malformed fields, independently summed values, and preservation of SDK-reported zero. Format tests cover labels, compact counts, omitted unavailable values, zero display, and absence of usage on cancelled outcomes.
- **Automated:** Integration tests cover separate fresh sessions for successive prompts, retrying a dropped prompt in a fresh session with the same submitted text, and verify completed history has no input-token, output-token, or usage field. Existing execution-history types/schema contain no usage fields.
- **Manual/independent measurement:** Recomputed the approved fixed fixture through the built `buildHarnessContext` implementation, summing Unicode code points over the transcript baseline and each generated `combinedPrompt` using the same `Array.from(...).length` method.
  - Transcript cumulative total: **128,561 code points**.
  - Quoder cumulative total: **15,645 code points**.
  - Quoder/baseline ratio: **12.17%**; reduction: **87.83%**.
  - Acceptance threshold: Quoder total no more than 50% of baseline. **PASS**.
- **Not covered:** No live model/provider call was made, as specified. No interactive TTY/manual visual run was performed; UI presentation is covered by formatter and integration tests, including piped output. Results therefore validate supplied prompt text and local behavior, not provider tokenization, model continuity quality, or total OpenCode system/tool context.

### Critical

- None.

### Warning

- The benchmark is a deterministic synthetic supplied-text comparison. It does not measure provider token counts or common OpenCode system/tool overhead, consistent with the approved scope.
- SDK usage aggregation is validated with synthetic event payloads and the pinned SDK contract research; no live provider was used to establish that every provider/model emits both fields.

### Suggestion

- None.

### Release Confidence

READY — all approved M8 Group 7 acceptance criteria are met by automated coverage and the independently recomputed fixed-fixture result. The documented limits do not block release under the explicit no-live-model QA decision.

### Verdict: PASS
