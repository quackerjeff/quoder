# Decisions: Milestone 4 — Git Awareness

## 2026-10-06 — Scope follows FR-9/FR-10

**Context**: The product plan defines Milestone 4 as before/after Git state capture, an execution summary of added/modified/deleted files, and developer-visible diff inspection.

**Decision**: Treat one developer-submitted prompt as the reporting unit, including an automatic fresh-session retry. Capture state around the whole prompt, preserve session cleanup on all outcomes, and expose the resulting diff without mutating the repository.

**Excluded**: Durable execution records and run identifiers remain Milestone 6; persistent harness context remains Milestone 5. Automatic commit, staging, stash, reset, and Git write operations are out of scope.

**Resolved in Group 1**: Capture endpoint snapshots and report observed repository state, not authorship or an exact run-only patch. Record HEAD object ID, branch/detached/unborn state, and porcelain v2 status at both endpoints. Classify path status transitions; identify paths already dirty at the start as pre-existing. A path dirty at both endpoints is not claimed as changed during the prompt unless a later verified content comparison proves that. Concurrent edits remain indistinguishable from prompt edits and must not be attributed to the model.

**Final diff contract**: At the end of a prompt, show tracked staged and unstaged changes relative to the final HEAD (`git diff HEAD`), plus non-ignored untracked file contents as a separate section. Git status and `git ls-files --others --exclude-standard -z` enumerate the untracked paths but not their contents; Quoder must read and render those files separately under implementation-defined size/binary limits. If HEAD changed, report both object IDs and inspect the committed tree delta (`old..new`) separately from the final working-tree diff. This presents the final repository state without mislabeling baseline changes as prompt-only changes.

**Research progress (2026-10-06)**: Local Git is `2.54.0 (Apple Git-157)`. Official documentation confirms porcelain v2 has extensible headers and NUL-delimited path mode; `status --branch` reports branch/HEAD including unborn and detached states. Status may refresh the index unless invoked with `--no-optional-locks`; untracked enumeration can be slow. `git diff`, `git diff --cached`, and `git diff HEAD` represent different comparisons, ordinary diff omits untracked file contents, and `--numstat -z` provides machine-oriented counts with a binary marker. External diff and textconv helpers can be disabled. Sources and details are recorded in `docs/tech.md` with links to official Git documentation.

**Validated in disposable fixtures (2026-10-06)**: Clean and dirty worktrees, staged plus unstaged changes, untracked paths with spaces, deletion, staged rename, control/tab/newline paths, unborn repositories, no-repository failure, HEAD movement with a separately inspectable commit delta, and binary `--numstat -z` markers were exercised. The run confirmed untracked contents are absent from ordinary tracked diffs. It also confirmed `--no-optional-locks` alone still permits a configured `core.fsmonitor` helper to run; `-c core.fsmonitor=false` prevented it in the fixture. `--no-ext-diff --no-textconv` prevented a configured external diff helper. `git diff --no-index` returns status 1 for differing files, so that exit status cannot be treated as an operational error.

**Implementation command constraints**: Use NUL-delimited porcelain v2 and untracked enumeration; parse path records without line splitting or assuming paths lack control characters. Use `--no-optional-locks` and explicitly override repository `core.fsmonitor` with `-c core.fsmonitor=false`. Diff commands must use `--no-ext-diff --no-textconv`. Treat missing/non-Git repository and Git subprocess failures as explicit unavailable state, never as an empty/clean repository. Keep output size and untracked file reads bounded. The observed snapshots cannot establish which actor made concurrent changes.

**Fixture limitations**: Fixtures ran with local Git `2.54.0 (Apple Git-157)` and validate Git command behavior, not a production implementation. Filesystem paths on this platform were UTF-8; the control/tab/newline fixture validates NUL framing but not arbitrary invalid UTF-8 filename bytes. Branch/HEAD snapshot comparison is needed to detect branch moves; endpoint evidence cannot detect intermediate branch changes that return to the same commit.

## 2026-10-06 — Summary and diff interaction

**Context**: Group 1 established endpoint-state reporting and the final-state diff contract. The existing harness has a persistent line-oriented REPL, uses a TTY flag to gate interactive display, and treats Ctrl+C while idle as a request to leave Quoder.

**Decision**: After every attempted prompt, render the normal prompt outcome first and a Git summary afterward. Always attempt the post-prompt snapshot for answered, permission-rejected, failed, and cancelled outcomes. Git unavailable/error states are visible and do not replace or fail the prompt result. Baseline-dirty paths are called out as pre-existing. An unchanged dirty baseline still offers inspection of the final-state diff; a fully clean/no-content state skips the view choice. A branch/HEAD-only transition is summarized without offering an empty viewer.

Interactive terminals show `View diff [v] / Continue [Enter]` when inspectable diff content exists. Enter continues to the existing REPL; `v` enters a viewer; `q` or Escape leaves the viewer and returns to the choice. The viewer pages 40 lines at a time. Ctrl+C preserves the existing REPL interrupt behavior. Non-TTY mode prints the summary and bounded sanitized diff automatically, with no prompt or blocking read.

Bound rendered diff text to 1 MiB per prompt. Page through retained text; indicate truncation clearly and report omitted bytes when known. Binary changes display a path and binary-change notice, never raw bytes. Untracked text is rendered as its own section. All path and content text is sanitized before terminal display. No diff content is added to prompts or persistent logs.

**Concrete summary states**: Report observed path/status transitions and line counts where available; classify paths dirty at baseline as pre-existing. If a baseline or final snapshot fails, state which endpoint is unavailable and do not infer a delta from one snapshot. A non-Git project reports repository state unavailable. No observed changes plus a clean repository is a short no-change summary. Existing dirty paths with no status transition are described as pre-existing, with final diff inspection available.

**Rationale**: Automatic non-TTY output supports shell pipelines without a new command or a blocked menu. Interactive paging avoids dumping a large diff at once. Explicit byte and binary limits keep output bounded and safe while making omissions visible.

## 2026-10-06 — Directory-relative untracked-file reader

**Context**: Group 7 found that checking untracked paths with `realpath()` and then opening by pathname allowed a parent directory to be swapped for a symlink between validation and open. A post-open pathname identity comparison reduced the race but could itself be raced.

**Decision**: Read untracked content through a small native POSIX helper. Quoder opens the project directory and passes that descriptor to the helper. The helper walks repository-relative components using `openat`, `O_DIRECTORY` for parent directories, and `O_NOFOLLOW` for each component, then reads only a regular file from the opened descriptor. Keep binary/invalid-text omission and byte/time bounds. Build the helper with `cc` on macOS/Linux as part of `npm run build` and `npm test`.

**Trade-off**: The build now requires a POSIX C compiler and the safe reader currently supports macOS/Linux. This preserves untracked text diff viewing while avoiding path-based traversal from the helper's root descriptor.
