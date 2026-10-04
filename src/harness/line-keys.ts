import { StringDecoder } from "node:string_decoder";
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
 * legacy bytes readline understands. Bracketed paste is requested too, so a pasted block is one
 * prompt rather than one prompt per line.
 *
 * A line that continues the prompt is forwarded as `CONTINUE_MARK` followed by `\r`. The mark is a
 * control key readline ignores, so the harness recognizes it in the keypress stream: a `return`
 * keypress that directly follows the mark continues the prompt, any other `return` submits it.
 * Each decision is taken at the keypress readline turns into a `line`, so nothing can drift.
 *
 * Continue: Shift/Alt/Ctrl+Return (`CSI 13;<mod> u`, xterm `CSI 27;2;13 ~`, `ESC \r`), Ctrl+J
 * (`\n`, `CSI 106;5 u`), and every line break inside a bracketed paste.
 * Submit: Return (`\r`, `\r\n`, `CSI 13 u`, Ctrl+M, keypad Enter).
 */

/** Ctrl+G (BEL): readline binds nothing to it, so it is neither echoed nor inserted. */
export const CONTINUE_MARK = "\u0007";

/** Push the kitty keyboard protocol's disambiguate flag and enable bracketed paste. */
export const ENABLE_KEYBOARD_PROTOCOL = "\u001b[>1u\u001b[?2004h";
/** Pop the keyboard flag and disable bracketed paste, restoring the terminal. */
export const DISABLE_KEYBOARD_PROTOCOL = "\u001b[<u\u001b[?2004l";

const CONTINUE = `${CONTINUE_MARK}\r`;
const SUBMIT = "\r";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

const TOKEN = /\u001b\[(\d+)(?:;(\d+))?u|\u001b\[27;2;13~|\u001b\r|\r\n|\r|\n|\u0007/gu;
/** An escape sequence cut off at the end of a chunk (checked from the last ESC only, so linear). */
const PARTIAL_SEQUENCE = /^\u001b(?:\[[\d;]*)?$/u;
const partialSequenceAtEnd = (text: string): string => {
  const start = text.lastIndexOf("\u001b");
  return start !== -1 && PARTIAL_SEQUENCE.test(text.slice(start)) ? text.slice(start) : "";
};

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const KEYPAD_ENTER = 57414;

/** Translates one `CSI <code>;<modifiers> u` key into legacy bytes. */
function decodeKittyKey(code: number, modifierField: number): string {
  const modifiers = Math.max(0, modifierField - 1);
  const alt = (modifiers & ALT) !== 0 ? "\u001b" : "";
  if (code === 13) return modifiers === 0 ? SUBMIT : CONTINUE;
  if (code === KEYPAD_ENTER) return SUBMIT;
  // Esc alone is dropped: before a Return it would turn the Return into Meta+Return, which
  // readline does not submit, and Quoder binds nothing to Esc.
  if (code === 27) return "";
  if (code === 9) return (modifiers & SHIFT) !== 0 ? "\u001b[Z" : "\t";
  if (code === 127) return `${alt}\u007f`;
  if ((modifiers & CTRL) !== 0) {
    if (code === 106) return CONTINUE; // Ctrl+J
    if (code === 109) return SUBMIT; // Ctrl+M
    if (code === 103) return ""; // Ctrl+G is reserved for the continue mark.
    // Ctrl+letter and Ctrl+[ \ ] ^ _ map onto C0 controls, as a legacy terminal would send them.
    const upper = code >= 97 && code <= 122 ? code - 32 : code;
    if (upper >= 64 && upper <= 95) return `${alt}${String.fromCharCode(upper & 0x1f)}`;
    if (code === 32) return `${alt}\u0000`;
    return "";
  }
  if (code >= 32 && code < 0xe000) {
    const text = String.fromCodePoint(code);
    return `${alt}${(modifiers & SHIFT) !== 0 ? text.toUpperCase() : text}`;
  }
  // Keys with no legacy encoding (for example Caps Lock in the private-use range) are dropped.
  return "";
}

/** Translates keyboard input (outside a paste). */
const translateKeys = (text: string): string =>
  text.replace(TOKEN, (token, code?: string, modifiers?: string) => {
    if (code !== undefined) return decodeKittyKey(Number(code), modifiers === undefined ? 1 : Number(modifiers));
    if (token === "\r" || token === "\r\n") return SUBMIT;
    // A typed Ctrl+G (legacy) is dropped so it can never be mistaken for the continue mark.
    if (token === CONTINUE_MARK) return "";
    return CONTINUE;
  });

/** Pasted text: every line break continues the prompt; the developer submits with Return. */
const translatePaste = (text: string): string => text.replace(/\u0007/gu, "").replace(/\r\n|\r|\n/gu, CONTINUE);

export interface LineEndingKeysOptions {
  /**
   * While this returns true (a prompt is running), typed input is not passed to readline, so it is
   * neither echoed over the status line nor queued. Ctrl+C and Ctrl+D still pass through.
   */
  readonly isBusy?: () => boolean;
  /** Called when Return is pressed while busy. */
  readonly onReturnWhileBusy?: () => void;
  /** How long an incomplete escape sequence is held for the rest to arrive (default 50 ms). */
  readonly holdMs?: number;
  /**
   * How long a paste may go without its end marker before it is ended anyway (default 500 ms), so
   * a delayed or lost marker can never leave every later Return continuing the prompt.
   */
  readonly pasteTimeoutMs?: number;
}

/** Bytes that still mean something while a prompt runs: Ctrl+C (cancel) and Ctrl+D (end input). */
const BUSY_KEYS = /[\u0003\u0004]/gu;

/** The longest suffix of `text` that is a proper prefix of `marker`. */
const markerPrefixAtEnd = (text: string, marker: string): string => {
  for (let length = Math.min(marker.length - 1, text.length); length > 0; length--) {
    if (marker.startsWith(text.slice(-length))) return text.slice(-length);
  }
  return "";
};

export class LineEndingKeys extends Transform {
  readonly #decoder = new StringDecoder("utf8");
  readonly #options: LineEndingKeysOptions;
  #carry = "";
  #pasting = false;
  /** After a paste timed out with part of its end marker held: the rest, dropped if it arrives. */
  #lateMarkerRest = "";
  #holdTimer: NodeJS.Timeout | undefined;

  constructor(options: LineEndingKeysOptions = {}) {
    super();
    this.#options = options;
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#clearHold();
    let text = this.#carry + (typeof chunk === "string" ? chunk : this.#decoder.write(chunk));
    this.#carry = "";
    if (this.#lateMarkerRest !== "" && text.startsWith(this.#lateMarkerRest)) text = text.slice(this.#lateMarkerRest.length);
    this.#lateMarkerRest = "";
    callback(null, this.#deliver(this.#translate(text, true)));
    if (this.#pasting) {
      // A paste whose end marker is late or lost is ended, dropping any held part of the marker.
      this.#holdTimer = setTimeout(() => {
        this.#holdTimer = undefined;
        this.#lateMarkerRest = this.#carry === "" ? "" : PASTE_END.slice(this.#carry.length);
        this.#carry = "";
        this.#pasting = false;
      }, this.#options.pasteTimeoutMs ?? 500);
      this.#holdTimer.unref();
    } else if (this.#carry !== "") {
      // An incomplete sequence that is not completed soon was a key of its own (for example Esc).
      this.#holdTimer = setTimeout(() => {
        this.#holdTimer = undefined;
        const held = this.#carry;
        this.#carry = "";
        const output = this.#deliver(this.#translate(held, false));
        if (output !== "") this.push(output);
      }, this.#options.holdMs ?? 50);
      this.#holdTimer.unref();
    }
  }

  override _flush(callback: TransformCallback): void {
    this.#clearHold();
    const rest = this.#carry + this.#decoder.end();
    this.#carry = "";
    callback(null, this.#deliver(this.#translate(rest, false)));
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#clearHold();
    callback(error);
  }

  #clearHold(): void {
    if (this.#holdTimer !== undefined) clearTimeout(this.#holdTimer);
    this.#holdTimer = undefined;
  }

  /** While busy, only Ctrl+C and Ctrl+D reach readline; a Return is reported instead. */
  #deliver(translated: string): string {
    if (this.#options.isBusy?.() !== true) return translated;
    if (translated.includes("\r")) this.#options.onReturnWhileBusy?.();
    return translated.match(BUSY_KEYS)?.join("") ?? "";
  }

  /**
   * Translates text, switching between keys and paste at the bracketed-paste markers. With `hold`,
   * an incomplete sequence at the end is kept in `#carry` for the next chunk: inside a paste, any
   * prefix of the end marker; outside one, a started escape sequence, a lone ESC included (if
   * nothing follows within the hold time it is released as the Esc key).
   */
  #translate(text: string, hold: boolean): string {
    let output = "";
    let rest = text;
    for (;;) {
      const marker = this.#pasting ? PASTE_END : PASTE_START;
      const index = rest.indexOf(marker);
      if (index === -1) break;
      const segment = rest.slice(0, index);
      output += this.#pasting ? translatePaste(segment) : translateKeys(segment);
      this.#pasting = !this.#pasting;
      rest = rest.slice(index + marker.length);
    }
    if (hold) {
      const partial = this.#pasting ? markerPrefixAtEnd(rest, PASTE_END) : partialSequenceAtEnd(rest);
      if (partial !== "") {
        this.#carry = partial;
        rest = rest.slice(0, -partial.length);
      }
    }
    return output + (this.#pasting ? translatePaste(rest) : translateKeys(rest));
  }
}
