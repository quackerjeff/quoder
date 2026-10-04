import { Transform, type TransformCallback } from "node:stream";

/**
 * Keyboard input for the interactive prompt, between the terminal and readline.
 *
 * Shift+Return must start a new line rather than submit, but a legacy terminal sends the same `\r`
 * for both keys. Like OpenCode and Codex, Quoder therefore asks the terminal for the kitty keyboard
 * protocol's "disambiguate" level (`CSI > 1 u`; supported by iTerm2, kitty, WezTerm, Ghostty, foot,
 * and others; ignored elsewhere). In that mode Shift+Return arrives as `CSI 13;2 u`, while plain
 * Return stays `\r`. The mode also re-encodes keys readline depends on (Ctrl+C becomes
 * `CSI 99;5 u`, Esc `CSI 27 u`, Alt+key `CSI <key>;3 u`), so this filter turns them back into the
 * legacy bytes readline understands.
 *
 * Line endings are decided here and reported in order:
 * - Return (`\r`, `\r\n`, `CSI 13 u`) submits;
 * - Shift/Alt/Ctrl+Return (`CSI 13;<mod> u`, xterm `CSI 27;2;13 ~`, `ESC \r`), Ctrl+J, and newlines
 *   inside pasted text (`\n`) continue the prompt.
 * Every line ending is forwarded to readline as `\r`, so each readline `line` pairs with one report.
 */
export type LineEnding = "submit" | "continue";

/** Push the kitty keyboard protocol's disambiguate flag; terminals without it ignore this. */
export const ENABLE_KEYBOARD_PROTOCOL = "\u001b[>1u";
/** Pop it again, restoring the terminal's previous keyboard mode. */
export const DISABLE_KEYBOARD_PROTOCOL = "\u001b[<u";

const TOKEN = /\u001b\[(\d+)(?:;(\d+))?u|\u001b\[27;2;13~|\u001b\r|\r\n|\r|\n/gu;

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;

type Decoded = { readonly bytes: string; readonly ending?: LineEnding };

/** Translates one `CSI <code>;<modifiers> u` key into legacy bytes (or a line ending). */
function decodeKittyKey(code: number, modifierField: number): Decoded {
  const modifiers = Math.max(0, modifierField - 1);
  const alt = (modifiers & ALT) !== 0 ? "\u001b" : "";
  if (code === 13) return { bytes: "\r", ending: modifiers === 0 ? "submit" : "continue" };
  if (code === 27) return { bytes: "\u001b" };
  if (code === 9) return { bytes: (modifiers & SHIFT) !== 0 ? "\u001b[Z" : "\t" };
  if (code === 127) return { bytes: `${alt}\u007f` };
  if ((modifiers & CTRL) !== 0) {
    // Ctrl+letter and Ctrl+[ \ ] ^ _ map onto C0 controls, as a legacy terminal would send them.
    const upper = code >= 97 && code <= 122 ? code - 32 : code;
    if (upper >= 64 && upper <= 95) return { bytes: `${alt}${String.fromCharCode(upper & 0x1f)}` };
    if (code === 32) return { bytes: `${alt}\u0000` };
    return { bytes: "" };
  }
  if (code >= 32 && code < 0xe000) {
    const text = String.fromCodePoint(code);
    return { bytes: `${alt}${(modifiers & SHIFT) !== 0 ? text.toUpperCase() : text}` };
  }
  // Keys with no legacy encoding (for example Caps Lock in the private-use range) are dropped.
  return { bytes: "" };
}

export class LineEndingKeys extends Transform {
  readonly #onLineEnding: (ending: LineEnding) => void;

  constructor(onLineEnding: (ending: LineEnding) => void) {
    super();
    this.#onLineEnding = onLineEnding;
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const forwarded = text.replace(TOKEN, (token, code?: string, modifiers?: string) => {
      const decoded: Decoded =
        code !== undefined
          ? decodeKittyKey(Number(code), modifiers === undefined ? 1 : Number(modifiers))
          : { bytes: "\r", ending: token === "\r" || token === "\r\n" ? "submit" : "continue" };
      if (decoded.ending !== undefined) this.#onLineEnding(decoded.ending);
      return decoded.bytes;
    });
    callback(null, forwarded);
  }
}
