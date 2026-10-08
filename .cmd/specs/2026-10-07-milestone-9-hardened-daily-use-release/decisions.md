# Decisions: Milestone 9 — Hardened Daily-Use Release

## 2026-10-07 — Planning baseline

**Context**: The M9 roadmap lists broad reliability features without defining operational contracts for logging, stale-resource detection, recovery actions, configuration validation, or failure presentation.

**Decision**: Preserve the exact roadmap scope and require unresolved product/operational behavior to be settled before implementation. Group 1 research is complete.

**Rationale**: Existing code already implements portions of cleanup, interruption labeling, corruption detection, and error sanitization. M9 must close verified gaps without inventing destructive recovery, ownership over external processes, or new acceptance thresholds.

## 2026-10-07 — Recovery and diagnostics direction

**Context**: The roadmap names reliability outcomes but leaves cleanup authority, corruption recovery, logging, validation, and failure messages open.

**Decisions**:

1. **Stale resources**: Detect and report stale resources, then ask the developer before cleanup. Preserve the restriction to demonstrably Quoder-owned resources; do not act on unrelated OpenCode processes or ambiguous sessions.
2. **Corrupt state**: Preserve the corrupt source and provide manual recovery guidance only. Do not add an interactive backup/reset flow or overwrite, delete, or replace the source.
3. **Structured logging**: Provide opt-in JSONL outside the target project. Record operational metadata only: no prompts, tool output, provider payloads, or secrets. Exact event fields and the safe default path may be implementation details, subject to the path being outside the project.
4. **Configuration validation**: At startup validate Quoder-owned settings and launch-critical dependency inputs. Do not broaden this into validation of all user OpenCode configuration.
5. **Failure reporting**: Distinguish OpenCode, provider/inference, configuration, and local-state failures with sanitized actionable messages. Do not expose raw responses or sensitive configuration.

**Rationale**: These choices establish conservative recovery and diagnostic boundaries while preserving data and keeping user approval ahead of cleanup. Startup checks cover settings Quoder owns and inputs required to launch; corrupt data remains intact for developer-led recovery.

No Group 2 product decisions remain open. Implementation must not broaden validation into arbitrary OpenCode configuration or turn manual corrupt-state guidance into an interactive reset flow.

## 2026-10-07 — Durable ownership ledger and cleanup confirmation

**Context**: The bounded pinned-version probe verified caller-supplied Core V2 session IDs survive server restart and are discoverable by exact ID. Quoder currently does not persist OpenCode session IDs, leaving sessions unidentifiable after a hard crash.

**Decision**: Use a durable Quoder ownership ledger. Before V2 session creation, generate a random custom session ID in the verified `ses_<24 lowercase hex>` shape and atomically persist an intent that binds that exact ID to the canonical project root. Pass the ID to V2 create and require the returned ID to match. Reconcile only exact IDs in the ledger and verify project/location before offering cleanup. Require explicit developer confirmation before deleting each identified session. Leave old or unregistered sessions untouched. Warn that activity may be unknown and cleanup may interrupt work when the prior server's termination cannot be established.

**Rationale**: The probe verifies the custom ID is durable/listable for pinned OpenCode 1.18.33. An intent written before create covers a crash after server-side creation but before Quoder records the response. Exact-ID matching and explicit confirmation preserve the ownership and user-approval boundaries.

**Constraints and residual limits**: Do not infer ownership from project, title, agent, age, or an ID prefix alone. The session ID is a random correlation marker backed by Quoder's private ledger, not upstream ownership metadata. OpenCode ID collision/conflict behavior was not verified; perform a pre-create exact-ID absence check, and treat a create conflict or ambiguous result as unresolved rather than deleting. `Session3.active()` is scoped to the current OpenCode process, so a new server cannot prove an old orphan server is idle. Disclose this uncertainty before confirmation. Old/unregistered sessions remain unidentifiable and must not be cleaned up by this feature.

## 2026-10-07 — Fail-closed cleanup eligibility

**Context**: Review Cycle 2 identified that a failed ambiguous-outcome ledger update could leave an `intent` entry that later reconciliation might offer for deletion. The pinned API does not provide independent Quoder ownership metadata or verified create idempotency/collision semantics to safely resolve this state.

**Decision**: Only a durably persisted `created-confirmed` entry, recorded after a successful create response exactly matches the requested ID, can be offered for cleanup. Require exact ID and canonical project/location checks plus explicit developer confirmation. Intent-only, uncommitted, ambiguous, and other unconfirmed entries are report-only and never cleanup candidates. Fail closed if persisting the intent or a required ownership transition fails; never treat a failed quarantine/update as cleanup authorization. Preserve existing constraints against ownership inference from project/title/age/prefix, touching old or unregistered sessions, or acting on unrelated processes.

**Accepted limitation**: A server session may be created before Quoder durably records `created-confirmed`. If a crash or ledger write failure occurs in that window, the session may be discoverable from its intent ID but remains report-only and requires manual recovery. This narrow recovery gap is accepted in favor of never offering a conflicting, ambiguous, or unquarantined ID for deletion. Cleanup still requires disclosure that activity may be unknown and deletion may interrupt work, followed by explicit confirmation.
