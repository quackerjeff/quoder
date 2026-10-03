# Permission Event Race

## Context

The 2026-10-03 authoritative `npm run verify:live` passed 8 of 9 predicates. Permission handling failed:

- `permission.create` succeeded.
- The stage's own global subscription never observed `permission.v2.asked` and timed out at its 120 s bound.

`permission.v2.asked` is not durable and cannot be replayed. The SDK's SSE subscription connects lazily on its first read, and the stage first reads only after dispatching `create`, so a warm server can publish the event before the subscriber connects. This race was previously accepted as a residual risk; it has now been observed. Milestone 0 remains unpassed.

## Decision

Observe permission events through the driver's run-long global subscription. It is already opened at run start for the question guard and stays connected for the whole run, so it is connected well before any permission request exists. That subscription becomes a run event monitor:

- It rejects questions for the probe's own sessions, as before.
- It records `permission.v2.asked` events for the probe's own sessions.

The permission stage creates its request, then waits, within a finite bound, for the recorded `permission.v2.asked` whose ID equals the created request's ID. It then replies `once`, as before. Correlation strictness is unchanged:

- `effect` must be `ask`;
- the observed ID must equal the created ID;
- the event must belong to the probe's session.

## Constraints

- Retain exact pins.
- Do not modify user configuration.
- Do not run `npm run verify:live` without explicit user authorization.
- Preserve the stage isolation and journal contract, question rejection, redaction, and every other predicate.
- No event may be accepted unless it belongs to the probe's session and its ID matches the created request.
- The wait is finite. A missing event yields Permission handling FAIL, never a false PASS.

## Tests

- A regression test reproduces the race: the event is published before a late subscriber would connect. The run-long monitor must still observe it.
- Tests also cover an unrelated session's event being ignored, a mismatched ID being ignored, and no event within the bound producing FAIL.

Security review applies, because the change alters how untrusted events drive a permission reply.
