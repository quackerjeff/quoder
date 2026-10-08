# Security Review: Milestone 8 Context Optimization

## Cycle 1 — 2026-10-07
Reviewing: Groups 1–4

### Threat Model
- The developer request, saved project memory, and live Git snapshot enter the prompt-building path; saved and Git-derived values are untrusted background data.
- The prompt is sent to OpenCode. Prior assistant-response excerpts remain in existing local M5 memory, but are excluded from subsequent prompts.
- SDK step events provide numeric usage data that is normalized and displayed in the completion summary.
- Assets include developer-authored context, repository information, and the integrity of the terminal output.
- This change adds no usage persistence, provider calls, or new storage fields; M5 pruning and its context bound remain unchanged.

### Critical
- None.

### Warning
- None.

### Suggestion
- [docs/tech.md:221] **Confidence: Low** — The research caveat still says missing or malformed usage is converted to zero and “must be addressed,” although this implementation now omits unavailable fields and preserves reported zero. Update the note in the documentation group so it describes the current behavior.

### Verdict: PASS
