# Security Review: Milestone 5 Persistent Harness Context

## Cycle 3 — 2026-10-07
Reviewing: Groups 1–5

### Threat Model

- Developers author persistent memory; model responses and repository metadata are also untrusted inputs.
- Memory files are project-scoped, stored outside the repository with restrictive permissions, and remain accessible to same-user processes.
- Saved memory and live Git context enter future OpenCode prompts, where tools can act with the developer’s authority.
- Terminal output and diagnostic traces could expose sensitive content or mishandle untrusted text.
- The assets at risk are developer data and the authority available to model-run tools.

### Critical

- None.

### Warning

- None.

### Suggestion

- None.

### Verdict: PASS

The prior response-excerpt finding is addressed: response excerpts remain local for `/memory show` and are excluded from future prompts. The prior Git-path finding is addressed: path and memory values are encoded as bounded single-line data, with coverage for newline and control characters. Storage validation, ownership and symlink checks, private modes, atomic replacement, corruption behavior, and documented last-writer-wins semantics were reviewed. Trace events exclude prompt, memory, and response contents; terminal display sanitizes stored text. No remaining security findings were identified.
