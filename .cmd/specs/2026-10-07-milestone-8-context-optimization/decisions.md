# Decisions: Milestone 8 — Context Optimization

## 2026-10-07 — Existing M5/M6/M7 capabilities credited
**Context**: The M8 roadmap calls for context pruning and several measurements, but M5 already implements a bounded/pruned context builder and M6/M7 already measure some run values.
**Decision**: Treat M5's 4,096-code-point cap, saved-memory priority/omission rules, previous-request continuity, live Git context, and transcript exclusion as existing implementation. Treat REPL context/request code-point display, elapsed time, output-token totals, and history duration as existing measurement coverage. Do not duplicate these capabilities.
**Rationale**: The source-to-spec audit must distinguish implementation gaps from completed prior milestones; M5 QA and source files verify these behaviors.

## 2026-10-07 — Original decision questions
**Context**: Initial planning identified an unspecified comparison baseline, continuity scenarios, previous-result meaning, metrics persistence, and additional pruning scope.
**Decision**: The user subsequently resolved the comparison and continuity questions below; only usage metrics and any additional pruning scope remain open in Group 2.
**Rationale**: Keep the decision history while making the current blocker unambiguous.

## 2026-10-07 — 20-turn context comparison and synthetic continuity acceptance
**Context**: M8 needs reproducible evidence for context reduction and continuity; live model acceptance is not authorized or required for this validation.
**Decision**: Use a fixed 20-turn transcript fixture. At each turn, the transcript baseline is the complete fixture conversation supplied through that turn: all preceding developer and assistant messages plus the current developer request. Quoder's per-turn supplied text is the generated `combinedPrompt` (bounded background context plus that same current request). Sum Unicode code points across all 20 per-turn inputs on both sides, using the same counting method, and require Quoder's cumulative total to be no more than 50% of the transcript baseline total. This measures supplied text, not provider tokenizer tokens, and excludes common OpenCode system/tool overhead that the fixture cannot observe.

Continuity QA uses deterministic synthetic context-builder scenarios, with no model call: (a) a follow-up that refers to the previous developer request, (b) required developer-authored saved decisions and constraints, and (c) live Git state. Assert the generated input contains the required facts, current request remains verbatim, context bounds and untrusted-data encoding hold, and the 20-turn cumulative comparison meets the stated threshold. Keep the M5 previous-developer-request-only policy: do not inject the previous assistant response. Assistant-response-only facts are intentionally unavailable unless captured as developer-authored memory or reflected in current Git state.
**Rationale**: This uses a fixed, repeatable fixture and the existing code-point accounting, makes the 20-turn cumulative basis explicit, and validates the approved continuity sources without making live provider calls or changing M5's assistant-output trust boundary.

## 2026-10-07 — Interim remaining Group 2 decision (resolved below)
**Context**: At this point in planning, the comparison, continuity scope, previous-result meaning, and live-QA posture were decided while usage/pruning scope remained open.
**Decision**: The user subsequently resolved the remaining usage/pruning question as recorded below.
**Rationale**: Preserve chronology while keeping the current decision clear.

## 2026-10-07 — Group 2 resolved: per-run usage display, no new persistence, M5 pruning retained
**Context**: Group 2 required a decision about usage beyond existing output-token totals, persistence, and pruning beyond M5.
**Decision**: Display SDK-reported per-run input and output usage when present. Persist no new usage metrics. Keep M5 context pruning unchanged. The existing completion UI changes to present the available usage; Group 3 assigns an independent UI designer to define its labels, units, unavailable-value behavior, and layout before coding.
**Rationale**: This supplies the requested model-usage measurement while limiting stored data and preserving the already reviewed M5 context policy.

## 2026-10-07 — UI design required after Group 2 resolution
**Context**: Group 2 chose to display SDK-reported input usage in the existing completion summary, changing user-facing output.
**Decision**: Require an independent UI-designer task in Group 3 to define the presentation before implementation.
**Rationale**: The workflow requires explicit UI design when existing user-facing behavior changes; the architect records scope without pre-empting the designer's details.
