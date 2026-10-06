# Milestone 3 — Interactive Permission Handling

## Context

Milestone 2 is complete. Quoder currently rejects every OpenCode permission request and every question; this keeps the harness from granting access but prevents normal work when OpenCode asks. This milestone adds an interactive decision path while retaining OpenCode Core V2 as the enforcement mechanism.

The handoff and prior Milestone 1 security review identified hardening items: prevent model-callable processes from reading or using server credentials, contain the selected Git root within the launch directory, register subagent sessions, make permission replies explicit, and sanitize project labels.

**Requirement restated 2026-10-06.** Credential isolation is defence in depth for the permission prompt, not a precondition for it. The prompt's purpose is to show the developer what is about to run and let them refuse it. It is not a containment boundary: an approved Bash command already carries full host-user authority, which OpenCode states itself ("Bash runs with host-user filesystem, process, and network authority"). Gating the prompt on perfect credential isolation treated a safety prompt as a security control and blocked the feature on hardening it. Root containment, explicit replies, session registration, and label sanitization remain required because they are cheap and affect correctness.

## Decision

Use the run-long, preconnected OpenCode event monitor to observe permission requests belonging to the harness session tree. Present each request in the existing terminal UI and return the developer's explicit choice through `client.v2.session.permission.reply`. Preserve question handling as a separate path. No approval is sent when there is no valid affirmative user choice.

Offer one-time approval and denial. The pinned OpenCode 1.18.33 bundle source shows that `always` persists the request's `save` patterns for the current project ID and action, and native permission evaluation applies those saved records. “Allow for project” therefore means exactly those patterns, which may differ from the immediate request resources. Show the patterns; disable the choice when the save list is empty. Cover this behavior with a no-model integration scenario before release.

## Constraints

- OpenCode `opencode-ai@1.18.33` and `@opencode-ai/sdk@1.18.33` remain exactly pinned.
- OpenCode native permissions remain authoritative. Quoder must not execute the protected operation itself or bypass a denied request.
- No credentials, prompt text, model output, or raw OpenCode diagnostics may be written to traces or reports.
- Never inspect or print `~/.config/opencode`, credentials, or provider configuration.
- Do not run `npm run verify:live`, `npm run verify:harness`, or a scratch script that sends a real model prompt without explicit developer authorization.
- Real permission forwarding is enabled by the CLI. The harness dependency still defaults to off so embedders and non-interactive paths keep deny-by-default, and focused tests cover both configurations.
- All terminal text derived from project names, paths, permission events, or OpenCode output must be sanitized using the existing terminal sanitizers.

## Design

The event monitor is the source of permission requests because `permission.v2.asked` is not durable and a late subscription misses it. The monitor must be connected before any session is created. The request view should be built only from verified event fields; current evidence includes action and resource paths, not necessarily a human-readable command. Session ownership must include children, using verified session parent relationships or equivalent tracking before requests from those sessions are acted upon.

Project identity is the canonical project root. Accept a Git-reported root only if the canonical launch directory is that root or a descendant. Project-scoped saved permissions must be confirmed to use this identity and must not apply to other projects.

Reducing the usability of the authenticated server credential by model-callable processes is desirable but optional. Existing research identified an OpenCode `shell.env` hook, but pinned Core V2 Bash does not call it. The macOS Seatbelt approach in Group 3.1 covers a different OpenCode Bash spawn path; it does not cover the Core V2 session path the harness uses, because `Shell.preferred()` discards a shell whose filename is not a recognised shell name. This is tracked as follow-up hardening and does not block grants. For this single-developer, local-only tool, the residual risk is self-approval under prompt injection; it is accepted and documented.

Any persistent preference behavior must be explicit, project-scoped, inspectable, and reversible where the native API supports it. For the pinned version, inspect and remove saved permissions through OpenCode's saved-permission APIs; do not create a parallel Quoder policy store.

### Permission prompt interaction

The prompt is a temporary keyboard decision panel in the existing live terminal view. It is not a second text prompt: decision keystrokes never enter readline or the model prompt. Use the existing semantic theme for emphasis, but make every choice understandable without color.

```text
OpenCode requests permission (1 of 2)
Action: external_directory
Requested resource:
  /path/to/resource
Allow for project would also allow:
  /path/to/saved-pattern

[A] Allow once  [P] Allow for project  [D] Deny  [Esc] Deny
```

Render one request at a time in event-arrival order. Show the action and each requested resource. Show the exact `save` patterns under a separate heading because they can differ from the immediate resources. Do not show a shell command unless a later design verifies a safe and reliable correlation from the permission source to a tool call. Sanitize every event-derived string before formatting; wrap long paths without truncating their meaning.

| State | Behavior |
| --- | --- |
| No pending request | No permission panel; live status view and existing input rules continue. |
| Pending, interactive TTY | Erase the ephemeral status line through `LiveView.note`, print the request and choices, then route only decision keys to the permission controller. Keep other typed input out of readline and off the terminal. |
| Allow once | Case-insensitive `A` sends `reply: "once"` for this exact session/request ID. Wait for the API result before showing the next request. |
| Allow for project | Case-insensitive `P` sends `reply: "always"` only when `save` is nonempty. Display every exact save pattern first. When empty, `P` has no effect and a short note explains why the choice is unavailable. |
| Deny | Case-insensitive `D` or Escape sends `reply: "reject"` for the selected request. OpenCode 1.18.33 rejects all other pending permission requests in the same session as part of this native response; clear those entries from the queue when their reply events arrive. |
| Unknown key | Ignore it without changing the request or sending an API call. Keep the choices visible. |
| Request no longer pending | Do not send or retry an approval. Remove the stale panel, report a sanitized fixed notice, and continue with the next still-pending request. |
| Reply in flight | Disable all decision keys for that request until the API call settles; do not allow duplicate replies. |
| Reply succeeds | Remove the request and show the next pending item, if any. Resume the live status view when the queue is empty. |
| Reply fails or times out | Do not assume an approval succeeded or retry it. Stop the current execution through the existing failure/cancellation lifecycle, clear the UI queue, and report that permission status could not be confirmed. |
| Ctrl-C | Preserve existing run cancellation. Send no allow reply; clear the panel and queue as the current session is interrupted and disposed. |
| EOF / Ctrl-D | Follow the existing input-close shutdown path. Send no allow reply; cancel and dispose the active session before shutting down. |
| Non-TTY input | No decision UI is possible. Print a sanitized plain-text request notice and reject it through OpenCode, preserving fail-closed behavior. |
| Monitor lost | Do not accept a permission choice without a live event monitor. Stop the run through the existing unhealthy-server path; do not synthesize an approval. |

Only one decision may be in flight at a time. Requests arriving during the panel join the queue. Native reply events can resolve or reject sibling requests, so reconcile the queue against those events and pending status before rendering the next choice. The live status display resumes after the queue empties. In a non-TTY session, requests are rejected immediately because no trustworthy interactive decision can be collected.

Keyboard guidance: `A`, `P`, and `D` are case-insensitive single keypresses. Return does not submit or choose anything. Escape is explicitly Deny. Ctrl-C remains cancellation. The labels remain visible and color-independent, and focus is represented by the currently active panel because the interaction is keyboard-only.

## Risks

- Removing `--pure` enables plugin loading. The `shell.env` hook does not run for Core V2 Bash. Quoder rejects project targets with project plugin configuration or plugin directories, preserving other project OpenCode configuration. User-level plugins remain trusted. Runtime credential isolation is not established on the harness path; this is an accepted defense-in-depth gap and does not block permission prompts.
- A permission event can arrive before a create call returns; monitor registration and pending-request state must not lose it.
- A child session may request permission before its parent is visibly registered. Child-session tracking must account for event ordering.
- The persisted `save` patterns may be broader than the immediate request resources. Display their exact scope and require explicit confirmation of it.
- OpenCode's native reject reply also rejects other pending requests for the same session; the UI queue must reconcile those sibling replies.
- Terminal input multiplexing can interfere with cancellation, multiline prompts, bracketed paste, and status-line rendering.
- A rejected permission produces an incomplete assistant turn. The final result must explain the denial rather than presenting an empty answer as success.

## Exit Criteria

- An allowed operation proceeds only after an explicit developer decision forwarded through OpenCode's permission API.
- An ask operation is surfaced and awaits a decision.
- A denied operation is blocked by OpenCode.
- Outside-project read and edit requests follow the verified project policy.
- Permission requests are displayed for explicit developer review; credential isolation remains defense in depth and is not an exit gate.
- Untrusted Git metadata cannot redirect project scope outside the launch directory.
- Requests from subagent sessions are handled without bypassing OpenCode.
- General review, security review, and QA pass for the restated permission-prompt scope; documentation reflects actual behavior and clearly discloses that model-run tools are unconfined.
