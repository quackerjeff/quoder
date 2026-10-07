# Security Review: Milestone 4 — Git Awareness

## Cycle 1 — 2026-10-06
Reviewing: Groups 1–5

### Threat Model
- The selected project repository, its Git metadata, paths, and file contents are untrusted input.
- Model-run tools can modify the project while Quoder is executing; the documented Core V2 tool process is unconfined and runs with the host user's authority.
- Git subprocess arguments and repository-controlled diff output cross into Quoder's process and terminal output.
- Untracked-file reads cross the project-root filesystem boundary and must not follow repository-controlled symlinks outside that root.
- Terminal output may be viewed interactively or captured by a caller in non-TTY mode; hostile content must not inject control sequences or exceed output bounds.
- Assets at risk are files outside the selected project, terminal integrity, and any sensitive content accidentally emitted to stdout.

### Critical
- None.

### Warning
- [src/harness/git-diff.ts:71-76] **Confidence: High** — The untracked-file containment and symlink checks are subject to a time-of-check/time-of-use race. After `realpath(target)` confirms the path is inside the project, the code opens `canonicalTarget` by pathname. `O_NOFOLLOW` protects only the final path component; it does not prevent a parent directory from being replaced with a symlink before `open()` resolves the path.
  - **Attack**: An actor able to modify the repository during diff capture could repeatedly replace an untracked file's parent directory with a symlink to a directory outside the project. If the swap lands between `realpath()` and `open()`, Quoder can read the outside file and include its contents in the interactive diff or piped output.
  - **Remediation**: Anchor traversal to an already-open project directory handle and open each path component relative to its parent handle with no-follow semantics, including the final file. If the supported runtime cannot provide race-resistant directory-relative opens, omit untracked contents whenever safe traversal cannot be guaranteed.

### Suggestion
- None.

### Verdict: FAIL

## Cycle 2 — 2026-10-06
Reviewing: Groups 1–5 after the untracked-file validation change

### Threat Model
- The selected project repository, its Git metadata, paths, and file contents are untrusted input.
- Model-run tools can modify the project while Quoder is executing; the documented Core V2 tool process is unconfined and runs with the host user's authority.
- Git subprocess arguments and repository-controlled diff output cross into Quoder's process and terminal output.
- Untracked-file reads cross the project-root filesystem boundary and must not follow repository-controlled symlinks outside that root.
- Terminal output may be viewed interactively or captured by a caller in non-TTY mode; hostile content must not inject control sequences or exceed output bounds.
- Assets at risk are files outside the selected project, terminal integrity, and any sensitive content accidentally emitted to stdout.

### Critical
- None.

### Warning
- [src/harness/git-diff.ts:56-75] **Confidence: High** — The post-open device/inode comparison detects a path that remains swapped when revalidation runs, but `realpath()` and the following `lstat()` are separate pathname operations. A concurrently controlled parent can be switched to an outside symlink after `realpath()` returns an in-project pathname and before `lstat()` resolves that pathname. If that outside file is the one already opened, the inode comparison can pass while the subsequent read returns outside-project content.
  - **Attack**: A repository writer able to run a concurrent process can rapidly toggle an untracked file's parent between its in-project directory and a symlink to an outside directory, arranging the outside target during `open()` and the later `lstat()` while the in-project path is observed by `realpath()`. Quoder may then emit the outside file through the already-open descriptor.
  - **Remediation**: Use a race-resistant directory-relative open primitive that holds and walks directory descriptors with no-follow semantics. If that cannot be provided on supported platforms, omit untracked file contents and report paths only until a safe reader is available.

### Suggestion
- None.

### Verdict: FAIL

## Cycle 3 — 2026-10-06
Reviewing: Groups 1–5 after directory-relative native reader implementation

### Threat Model
- The selected project repository, its Git metadata, paths, and file contents are untrusted input.
- Model-run tools can modify the project while Quoder is executing; the documented Core V2 tool process is unconfined and runs with the host user's authority.
- Git subprocess arguments and repository-controlled diff output cross into Quoder's process and terminal output.
- Untracked-file reads cross the project-root filesystem boundary and must not follow repository-controlled symlinks outside that root.
- Terminal output may be viewed interactively or captured by a caller in non-TTY mode; hostile content must not inject control sequences or exceed output bounds.
- Assets at risk are files outside the selected project, terminal integrity, and any sensitive content accidentally emitted to stdout.

### Critical
- None.

### Warning
- None.

### Suggestion
- None.

### Verdict: PASS
