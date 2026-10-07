# Milestone 4 — Git Awareness

## Context

The product plan's next milestone is Git Awareness (FR-9 and FR-10 in `docs/requirements.md`). Quoder already resolves and validates a project root, streams model activity, and formats each prompt result. It does not yet capture repository state around prompts, summarize changed files, or let the developer inspect the resulting diff.

Milestone 3 is closed. Permission prompts are enabled; the accepted unconfined-tool posture does not change this milestone. Milestone 4 adds visibility into repository changes and must not introduce automatic Git mutations.

## Decision

Capture Git state immediately before and after each developer-submitted prompt, using the canonical `Project.root`. Present a sanitized per-prompt summary of the observed repository changes and let the developer inspect a diff before continuing. Never stage, commit, stash, reset, or otherwise mutate Git state automatically.

The summary must preserve the distinction between repository changes already present before the prompt and status changes observed across the prompt. A path dirty at both endpoints is labeled pre-existing unless a verified content comparison proves its content changed. Do not claim authorship or an exact run-only patch where the captured data cannot prove it. Group 1 resolved the snapshot and final-diff contract in `decisions.md`.

The unit of reporting is one developer-submitted prompt, including an automatic fresh-session retry after OpenCode drops a prompt. Do not introduce run IDs, durable execution records, or history commands; those belong to Milestone 6. Do not restore OpenCode conversation history; that belongs to Milestone 5.

## Scope

- Capture `HEAD`, current branch (including detached/unborn states), working-tree/index status, and diff information before and after a prompt.
- Classify added, modified, and deleted paths; account for staged, unstaged, and non-ignored untracked files.
- Show a concise completion summary with file counts and line additions/deletions where Git can report them.
- Provide an interactive way to inspect the resulting diff before continuing to the next prompt.
- Handle answered, denied, cancelled, and failed prompts without losing the post-run repository snapshot.
- Keep operation functional outside a Git repository and when Git inspection fails: report that repository state is unavailable without failing the OpenCode prompt.

## Non-goals

- Automatic commits or any other Git mutation.
- Persistent execution history, run identifiers, prompt/model records, or a history browser (Milestone 6).
- Persistent harness context (Milestone 5).
- Change ownership proof when another process or person modifies the repository concurrently.
- Tracking ignored files, nested submodule contents, or file changes outside the resolved project root.

## Interaction Design

After every prompt outcome, show the prompt result followed by a Git summary when a post-prompt capture was attempted. Capture failure is reported as unavailable and does not replace the prompt result. The summary uses endpoint state transitions and labels baseline-dirty paths as pre-existing; it does not imply that the model authored observed changes.

When the final state contains inspectable content (tracked diff, untracked file content, or committed tree change), an interactive terminal shows `View diff [v] / Continue [Enter]`. Enter continues to the same REPL; `v` opens the viewer; leaving the viewer returns to the choice. If there is no diff content, report no changes or the branch/status-only transition and continue without an empty choice. If baseline changes remain unchanged, identify them as pre-existing and offer the final-state diff so the developer can inspect what remains in the repository.

In non-TTY mode, do not wait for a menu response. Print the summary and then the sanitized diff automatically, using the same byte limit and omission notice as the interactive viewer. With no diff content, print only the summary. This makes piped output deterministic and keeps it useful for logs or capture.

The diff viewer displays 40 lines per page and supports next page, previous page, and leave (`n`, `p`, `q`/Escape). Leaving returns to the View/Continue choice. Ctrl+C retains the current REPL interrupt behavior. Keep at most 1 MiB of rendered diff text per prompt; if more is available, clearly state that the view is truncated and how many bytes were omitted when known. Show binary changes as a path and binary-change notice, without rendering raw bytes. Render untracked text separately from tracked Git diff. Sanitize all repository-controlled paths and line content before terminal output. Diff viewing is read-only and does not feed content into the next model prompt.

### Summary examples

```text
Git changes observed: 2 files (1 added, 1 modified; +8 -2)
  modified  src/app.ts
  added     notes/todo.txt (untracked)
Pre-existing changes: 1 file (README.md)
View diff [v] / Continue [Enter]
```

```text
Git changes observed: none
Repository state: clean
```

```text
Git changes observed: unavailable (could not read repository state after the prompt)
The prompt completed successfully.
```

### Prompt outcome and repository-state table

| Prompt outcome | Post-prompt capture | Summary behavior | Diff choice |
| --- | --- | --- | --- |
| Answered | Always attempt | Show observed path/status transitions and pre-existing paths after the answer and normal completion line. | Offer when final diff content exists. |
| Permission rejected | Always attempt after rejection settles | Preserve the rejection explanation; show any observed repository transitions, including none. | Offer when final diff content exists. |
| Failed | Always attempt after failure settles | Preserve the failure reason; show any observed repository transitions, including none. | Offer when final diff content exists. |
| Cancelled | Always attempt after cancellation and session cleanup settle | Preserve the cancellation result; show state observed at cancellation completion. | Offer when final diff content exists. |

For non-Git directories or Git inspection failures, say repository state is unavailable, identify whether before or after capture failed when known, and continue normal prompt handling. If only one endpoint is available, do not claim a before/after delta. On a TTY, the viewer uses the same bounded content policy; in non-TTY mode the bounded diff follows the summary automatically. A repository with only pre-existing dirty paths reports those as pre-existing and makes the final-state diff available. A branch/HEAD-only transition with no inspectable content is summarized without offering an empty viewer.

All paths and diff text are repository-controlled input. Sanitize terminal control sequences and provide bounded/paginated viewing so diff content cannot corrupt the TUI or overwhelm it. Show every retained diff page, and clearly mark any content omitted by the per-prompt byte limit.

File counts describe observed status transitions, with baseline-dirty paths listed separately as pre-existing. Line counts describe the final inspectable diff content (including baseline changes and committed changes when HEAD moved); they are not attributed to the prompt. Binary and unavailable line counts are omitted from numeric totals or identified as unavailable.

## Constraints

- Use the canonical `Project.root`; do not repeat or weaken project-root resolution.
- Use Git via argument arrays (no shell interpolation) and bounded subprocess execution.
- Preserve the exact before and after Git observations sufficiently to explain pre-existing changes.
- Git inspection must never stage, commit, stash, reset, or rewrite files.
- Do not write prompts, model output, diffs, or repository file contents to persistent logs.
- Follow the Group 1 command and reporting contract recorded in `docs/tech.md` and `decisions.md`.

## Risks

- A naive after-only `git diff` includes developer changes that predate the prompt and misses untracked file contents.
- Status alone cannot identify content changes to a path already dirty at the baseline; report it as pre-existing unless a verified content comparison becomes available.
- Large diffs, binary changes, rename detection, file modes, submodules, and unusual paths can make summary or viewing behavior misleading.
- Concurrent external edits can occur during a prompt; report observed state changes without claiming who caused them.
- Repository paths and diff lines can contain terminal escape sequences or other hostile text.
- Git may be unavailable, fail, or run against an unborn branch; these conditions must not block model execution.
