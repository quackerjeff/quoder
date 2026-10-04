# Backlog

Future work that is agreed but not yet scheduled into a spec. When an item is picked up, move it into that spec's `tasks.md` and remove it here.

Hardening items carried forward from completed specs are also recorded in their `decisions.md`:
- `.cmd/specs/2026-10-03-milestone-1-minimal-harness/decisions.md`: review and security items. Project-root containment and subagent sessions must be resolved before or in Milestone 3.

## Cursor navigation in multi-line prompts

*Requested 2026-10-03, during Milestone 2 (spec `2026-10-03-milestone-2-streaming-ui`, Group 5a).*

**Today:** Shift+Return starts a new `…` line, and Return sends all the lines as one prompt. Each earlier line is committed as soon as Shift+Return is pressed, because readline edits only the current line:
- You cannot move the cursor back into an earlier line to edit it.
- Up and Down recall readline history instead of moving between lines.
- Backspace at the start of a line does not join it to the previous line.
- Readline's history stores each line separately, not the whole multi-line prompt.

**Wanted:** a multi-line editor for the prompt, with:
- Up and Down to move between lines; Left at a line's start and Right at its end to cross lines;
- Home and End per line;
- Backspace at a line's start (and Delete at its end) to join lines;
- history entries that recall a whole multi-line prompt.

The existing behaviour stays: Shift+Return inserts a line break, Return submits, Ctrl-C discards.

**Notes for whoever picks this up:**
- Readline cannot do this, so a small custom line editor is needed. It could be done together with the possible move to a full-screen TUI (Milestone 2 decision 1), since both replace readline's rendering.
- Keep `LineEndingKeys` (`src/harness/line-keys.ts`) as the key decoder. It already turns kitty-protocol keys into legacy bytes and classifies Return versus Shift+Return.
- Consider bracketed paste (`CSI ? 2004 h`), so a pasted block is inserted as text rather than handled as keystrokes.
- Rendering must handle wrapped lines and wide characters, and keep the cursor where it is while the status line redraws.
