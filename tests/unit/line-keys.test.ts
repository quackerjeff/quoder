import { describe, expect, it } from "vitest";

import { LineEndingKeys, type LineEnding } from "../../src/harness/line-keys.js";

const run = async (...chunks: string[]) => {
  const endings: LineEnding[] = [];
  const keys = new LineEndingKeys((ending) => endings.push(ending));
  let forwarded = "";
  keys.on("data", (chunk: Buffer) => {
    forwarded += chunk.toString("utf8");
  });
  for (const chunk of chunks) keys.write(chunk);
  keys.end();
  await new Promise((resolveEnd) => keys.on("end", resolveEnd));
  return { endings, forwarded };
};

describe("line endings from the terminal", () => {
  it("submits on Return, including CR LF", async () => {
    await expect(run("hello\r", "again\r\n")).resolves.toEqual({ endings: ["submit", "submit"], forwarded: "hello\ragain\r" });
  });

  it.each([
    ["CSI u (kitty, iTerm2 CSI u mode)", "\u001b[13;2u"],
    ["xterm modifyOtherKeys", "\u001b[27;2;13~"],
    ["ESC Return (key mapping or Option+Return)", "\u001b\r"],
    ["a bare line feed (Ctrl+J or pasted text)", "\n"],
  ])("continues on Shift+Return encoded as %s", async (_name, sequence) => {
    await expect(run(`one${sequence}two\r`)).resolves.toEqual({ endings: ["continue", "submit"], forwarded: "one\rtwo\r" });
  });

  it("submits on plain Return and continues on modified Return in the kitty keyboard protocol", async () => {
    await expect(run("a\u001b[13ub\u001b[13;3uc\u001b[13;5ud\r")).resolves.toEqual({
      endings: ["submit", "continue", "continue", "submit"],
      forwarded: "a\rb\rc\rd\r",
    });
  });

  it.each([
    ["Ctrl+C", "\u001b[99;5u", "\u0003"],
    ["Ctrl+D", "\u001b[100;5u", "\u0004"],
    ["Ctrl+Shift+C", "\u001b[99;6u", "\u0003"],
    ["Ctrl+U", "\u001b[117;5u", "\u0015"],
    ["Ctrl+[", "\u001b[91;5u", "\u001b"],
    ["Esc", "\u001b[27u", "\u001b"],
    ["Alt+B", "\u001b[98;3u", "\u001bb"],
    ["Alt+Shift+B", "\u001b[98;4u", "\u001bB"],
    ["Alt+Backspace", "\u001b[127;3u", "\u001b\u007f"],
    ["Shift+Tab", "\u001b[9;2u", "\u001b[Z"],
    ["Caps Lock (no legacy encoding)", "\u001b[57358u", ""],
  ])("translates kitty-encoded %s back to legacy bytes for readline", async (_name, sequence, legacy) => {
    await expect(run(`x${sequence}y`)).resolves.toEqual({ endings: [], forwarded: `x${legacy}y` });
  });

  it("leaves other keys and escape sequences untouched", async () => {
    await expect(run("a\u001b[Db\u0003")).resolves.toEqual({ endings: [], forwarded: "a\u001b[Db\u0003" });
  });

  it("keeps the order of several endings in one chunk", async () => {
    await expect(run("a\nb\u001b[13;2uc\rd\r")).resolves.toMatchObject({ endings: ["continue", "continue", "submit", "submit"] });
  });
});
