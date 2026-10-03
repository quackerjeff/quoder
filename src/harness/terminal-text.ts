/**
 * Model output and model-raised questions are untrusted. Before they reach the developer's
 * terminal, escape sequences (CSI, OSC, and other ESC-introduced codes), other C0/C1 control
 * characters, and bidirectional overrides are removed; tabs and newlines are kept.
 */
const ESCAPE_SEQUENCES =
  // OSC ... (BEL | ESC \), CSI ... final byte, then any other two-byte ESC sequence.
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]?|\u001b[ -~]?|\u009b[0-?]*[ -/]*[@-~]?/gu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/gu;

export function sanitizeForTerminal(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(ESCAPE_SEQUENCES, "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(BIDI_CONTROLS, "");
}

/** A sanitized single line, shortened for summaries. */
export function sanitizeLine(text: string, maxLength = 200): string {
  const line = sanitizeForTerminal(text).replace(/\s+/gu, " ").trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}
