# Permission acceptance procedure

## Model-independent native persistence check

This command starts the pinned local OpenCode server, makes permission API calls only, and does not submit a prompt or contact a model:

```bash
npm run verify:permissions
```

It creates two disposable Git projects and a harmless path outside both. It forces `external_directory` to ask through process-local inline configuration, then verifies that:

1. OpenCode reports the request as ask and pending.
2. `always` saves the exact supplied pattern for project A.
3. Project B receives a different project ID and is still asked for the same resource.
4. Removing the native saved record removes the rule.
5. The same request in project A asks again after revocation.

The script removes its saved permission records and sessions in `finally` and prints only fixed row names and results. It is deliberately separate from `npm test` and `npm run verify:live`.

## Model-based permission behavior

Run only after the Group 7 security review passes and the default-off permission decision gate is enabled for acceptance. Use a disposable Git project, a separate harmless outside directory, and no sensitive files.

1. Configure one harmless in-project command as allowed and ask Quoder to run it; confirm it executes.
2. Ask for a harmless read from the outside directory; confirm the request is shown and wait for a decision. Allow once and confirm that request completes.
3. Repeat the outside read; confirm it asks again, then deny it and verify no output from the protected read reached the response.
4. Ask for a harmless outside-project edit; deny it and confirm the target file was not created or changed.
5. On another matching request, choose Allow for project only after reviewing the exact saved patterns shown by Quoder. Confirm a matching future request is allowed and a nonmatching request still asks.
6. Run `npm run verify:permissions` to inspect and revoke the exact native saved record, then confirm the matching request asks again.

Do not capture model text, provider configuration, credentials, authorization headers, or raw OpenCode diagnostics. Do not run this procedure through the automated test suite.
