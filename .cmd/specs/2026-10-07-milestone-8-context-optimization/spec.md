# Milestone 8 — Context Optimization

## Context

Roadmap source: `docs/requirements.md`, “Milestone 8 — Context Optimization”. The stated goal is to minimize LLM context while preserving execution quality. Its features are to measure harness-context size, user-prompt size, execution duration, and model usage where available; implement context pruning; and prefer intent, decisions, constraints, current state, and the immediate previous result over complete conversation transcripts.

Milestone 5 already implements structured persistent memory and bounded context construction. `src/harness/context-builder.ts` sends objective/task, developer-authored decisions/constraints/issues, the previous developer-request excerpt, and bounded live Git state, within 4,096 Unicode code points. It keeps the current request verbatim and excludes the previous assistant response from model context. It already prunes lower-priority saved entries when the cap is reached. See `.cmd/specs/2026-10-07-milestone-5-persistent-context/{spec.md,decisions.md,qa.md}` and `docs/tech.md`.

Milestones 6–7 already provide several measurements: execution history stores elapsed duration; the REPL prints harness-context and request code-point counts before execution; `LiveView` counts output tokens from `step.ended` and the final result displays elapsed time and output-token count. M8 now preserves the availability of numeric input/output fields from step events and independently sums reported input/output values for display. These values are not persisted. These existing capabilities must be credited; M8 must not duplicate or silently redefine them.

Group 2 is resolved: the completion UI will display SDK-reported per-run input and output usage when present; no usage metrics will be persisted; and M5 pruning will remain unchanged. Group 3 must have an independent UI designer define the presentation before implementation. No new history fields or pruning policy are in scope.

## Source Requirements

- Minimize LLM context while preserving execution quality.
- Measure harness-context size, user-prompt size, execution duration, and model usage where available.
- Implement context pruning.
- Prefer intent, decisions, constraints, current state, and the immediate previous result over complete conversation transcripts.
- Exit when the harness consistently supplies “substantially less” context than a long-running OpenCode conversation while maintaining sufficient continuity for normal development work.

## Current-State Audit

- M5 satisfies structured, bounded memory; the 4,096-code-point injected-context ceiling; saved-context pruning; explicit priority ordering; immediate previous request continuity; live Git state; and omission of full conversation history and prior assistant response from future prompts.
- M7 displays exact Unicode code-point counts for injected context and current prompt before execution.
- M2/M7 display elapsed execution duration and output-token totals; M6 stores duration per execution.
- Quoder does not record total prompt tokens or model cost. M8 adds a fixed synthetic supplied-text comparison; it does not claim to measure a live long-running OpenCode conversation or provider token use.
- Therefore M8 is not a greenfield context-pruning feature. Any additional pruning behavior, metrics persistence/display, or comparative acceptance must be specified after the open decisions below.

The user resolved the phrase “immediate previous result” as the M5 previous-developer-request-only policy. Do not inject the prior assistant response. Validate continuity through follow-up references, saved developer-authored decisions/constraints, and live Git state using synthetic fixtures; live model QA is not required or authorized.

## Design Boundary

Plan an evidence-first audit and decision gate before implementation. For comparison acceptance, use a fixed 20-turn transcript fixture and cumulative supplied text measured in Unicode code points. For turn N, the baseline input comprises all prior developer and assistant messages plus the current developer request; Quoder's input is that turn's generated `combinedPrompt` (background context plus the same current request). Sum the per-turn counts across all 20 turns, applying one counting method to both sides; the Quoder cumulative total must be at most 50% of the transcript baseline cumulative total. This synthetic text-size comparison does not claim tokenizer-token savings and excludes common OpenCode system/tool overhead unavailable to the fixture.

Preserve the M5 prompt envelope and safety boundaries: current request remains verbatim; background values remain labeled as untrusted data; prior assistant output is not injected; context remains bounded; and no full conversation transcript is introduced.

The user has defined “substantially less” as at least 50% less cumulative supplied code points over the fixed 20-turn comparison, defined continuity scenarios, confirmed no live model QA run, chosen display-only SDK-reported input/output usage where present, prohibited new usage persistence, and retained M5 pruning unchanged. Do not change these decisions. Distinguish SDK-reported usage from estimates and represent absent usage according to the UI designer's approved design. Do not add a tokenizer/provider/dependency unless researched and approved.

## Group 2 Status

Resolved. No additional user product decision currently blocks implementation. The UI designer must complete Group 3 before coding; that task defines presentation details within the fixed Group 2 scope, not new product scope.

## Constraints

- Stay within Milestone 8; do not implement Milestone 9 crash recovery, stale-session cleanup, structured logging, or generalized configuration validation.
- Reuse verified M5 context behavior and pinned SDK event facts; record newly verified contracts in `docs/tech.md` before coding against them.
- Do not collect or persist provider credentials, raw provider payloads, or new full transcripts.
- No live model/provider calls without explicit user authorization.
- The context is untrusted input to OpenCode; preserve existing labeling, escaping, and current-request precedence.

## Risks

- The 20-turn fixture is a synthetic supplied-text comparison, not real provider token usage or total OpenCode prompt accounting.
- Token usage is provider/model-dependent and may be absent or have different accounting semantics; counts must not be presented as tokenizer-exact unless the source guarantees that.
- SDK usage may be absent or provider/model-dependent; report only SDK-reported values and follow the approved unavailable-value presentation.
- More aggressive pruning can remove facts needed for continuity; M5 already has a fixed ceiling but no quality metric.

## UI Design

### Goal and placement

Show the SDK's per-run input and output usage in the existing permanent completion summary, alongside elapsed time, tool count, and the current output-token total. Do not put usage on the animated live status row: it changes during execution and must remain the compact, single-row progress indicator. Keep the current result ordering: streamed answer first, then the completion summary. Interactive and piped output use the same completion text.

### Labels, units, and aggregation

- Label the values explicitly as `input tokens` and `output tokens`; values are token counts reported by the pinned OpenCode SDK, not Unicode code points, provider-independent estimates, or tokenizer calculations by Quoder.
- Present each count in the existing compact count style (`1.2k` at 1,000 or above; exact integer below 1,000). Preserve an SDK-reported zero as `0`.
- The displayed per-run values are the sum of the corresponding numeric SDK-reported usage fields observed for this prompt's completed steps. Do not calculate a total, cost, reasoning count, or any missing component.
- Keep elapsed time and tool count as they are today. Do not write usage values to execution history or other storage.

### Unavailable-value behavior

- Show each field independently when the SDK reports it. If input is absent, omit only the input segment; if output is absent, omit only the output segment. Do not show `0`, `unknown`, `unavailable`, or a placeholder for an absent field.
- If neither field was reported, retain the existing completion-summary behavior (elapsed time and tool count, with no usage segment). Existing no-usage output-token behavior remains compatible.
- Usage appears only on the answered completion summary, matching the existing summary's tool/output details. Cancelled, failed, or rejected outcomes keep their existing status presentation.

### Copy examples

Both input and output reported:

```text
✓ Done in 41.8s · 4 tools · 1.2k input tokens · 800 output tokens
```

Input reported, output absent:

```text
✓ Done in 41.8s · 4 tools · 1.2k input tokens
```

Neither reported:

```text
✓ Done in 41.8s · 4 tools
```

### Terminal and accessibility constraints

- Reuse the existing success/dim status-line styling; keep words and numbers understandable without color.
- Do not truncate the permanent completion summary to the live status-row width. Let the terminal wrap a longer summary naturally; do not add an extra panel, progress-row field, or alternate layout.
- Preserve the existing single-line summary when it fits. If usage is partially or wholly absent, include only the available segments without punctuation gaps.
- Sanitize/display these numeric SDK values as numeric counts only; never render raw provider payloads.

This is a presentation design only. It does not authorize usage persistence, provider/tokenizer estimates, changes to M5 pruning, or live model/provider calls.
