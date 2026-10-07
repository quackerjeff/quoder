import { describe, expect, it } from "vitest";

import { CONTINUE_MARK, LineEndingKeys } from "../../src/harness/line-keys.js";

const CONTINUE = `${CONTINUE_MARK}\r`;

/** Feeds chunks (strings or raw bytes) through the filter and returns what readline would see. */
const translate = async (...chunks: Array<string | Buffer>): Promise<string> => {
  const keys = new LineEndingKeys();
  let forwarded = "";
  keys.on("data", (chunk: Buffer) => {
    forwarded += chunk.toString("utf8");
  });
  for (const chunk of chunks) keys.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  keys.end();
  await new Promise((resolveEnd) => keys.on("end", resolveEnd));
  return forwarded;
};

describe("line endings from the terminal", () => {
  it.each([
    ["Return", "\r"],
    ["CR LF", "\r\n"],
    ["kitty Return", "\u001b[13u"],
    ["kitty Ctrl+M", "\u001b[109;5u"],
    ["kitty keypad Enter", "\u001b[57414u"],
  ])("submits on %s", async (_name, sequence) => {
    await expect(translate(`a${sequence}`)).resolves.toBe("a\r");
  });

  it.each([
    ["kitty Shift+Return", "\u001b[13;2u"],
    ["kitty Alt+Return", "\u001b[13;3u"],
    ["kitty Ctrl+Return", "\u001b[13;5u"],
    ["xterm modifyOtherKeys Shift+Return", "\u001b[27;2;13~"],
    ["ESC Return (key mapping or Option+Return)", "\u001b\r"],
    ["Ctrl+J", "\n"],
    ["kitty Ctrl+J", "\u001b[106;5u"],
  ])("continues on %s", async (_name, sequence) => {
    await expect(translate(`a${sequence}b\r`)).resolves.toBe(`a${CONTINUE}b\r`);
  });

  it("never forwards a typed Ctrl+G, which is reserved for the continue mark", async () => {
    await expect(translate("a\u0007\rb\u001b[103;5u\r")).resolves.toBe("a\rb\r");
  });
});

describe("kitty keys translated back for readline", () => {
  it.each([
    ["Ctrl+C", "\u001b[99;5u", "\u0003"],
    ["Ctrl+D", "\u001b[100;5u", "\u0004"],
    ["Ctrl+Shift+C", "\u001b[99;6u", "\u0003"],
    ["Ctrl+U", "\u001b[117;5u", "\u0015"],
    ["Ctrl+[", "\u001b[91;5u", "\u001b"],
    ["Alt+B", "\u001b[98;3u", "\u001bb"],
    ["Alt+Shift+B", "\u001b[98;4u", "\u001bB"],
    ["Alt+Backspace", "\u001b[127;3u", "\u001b\u007f"],
    ["Shift+Tab", "\u001b[9;2u", "\u001b[Z"],
    ["Esc (dropped, so a following Return still submits)", "\u001b[27u", ""],
    ["Caps Lock (no legacy encoding)", "\u001b[57358u", ""],
  ])("%s", async (_name, sequence, legacy) => {
    await expect(translate(`x${sequence}y`)).resolves.toBe(`x${legacy}y`);
  });

  it("leaves legacy keys and other escape sequences untouched", async () => {
    await expect(translate("a\u001b[Db\u0003\u001bf")).resolves.toBe("a\u001b[Db\u0003\u001bf");
  });
});

describe("input split across chunks", () => {
  it("keeps a multi-byte character split between chunks", async () => {
    const bytes = Buffer.from("héllo\r", "utf8");
    await expect(translate(bytes.subarray(0, 2), bytes.subarray(2))).resolves.toBe("héllo\r");
  });

  it("completes an escape sequence split between chunks", async () => {
    await expect(translate("one\u001b[13", ";2utwo\r")).resolves.toBe(`one${CONTINUE}two\r`);
  });

  it("releases a lone Esc as the Esc key after the short hold", async () => {
    const keys = new LineEndingKeys({ holdMs: 5 });
    let forwarded = "";
    keys.on("data", (chunk: Buffer) => {
      forwarded += chunk.toString("utf8");
    });
    keys.write("a\u001b");
    await new Promise((resolveTick) => setImmediate(resolveTick));
    expect(forwarded).toBe("a");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    expect(forwarded).toBe("a\u001b");
    keys.end();
  });
});

describe("bracketed paste", () => {
  it("turns every pasted line break into a continuation, so the block is one prompt", async () => {
    await expect(translate("\u001b[200~first\rsecond\nthird\r\n\u001b[201~\r")).resolves.toBe(
      `first${CONTINUE}second${CONTINUE}third${CONTINUE}\r`,
    );
  });

  it("handles paste markers split between chunks and leaves pasted escapes alone", async () => {
    await expect(translate("\u001b[20", "0~a\u001b[13;2u\rb\u001b[2", "01~\r")).resolves.toBe(`a\u001b[13;2u${CONTINUE}b\r`);
  });
});

describe("review cycle 2 fixes", () => {
  it("does not get stuck in a paste when the end marker is split right after its ESC", async () => {
    await expect(translate("\u001b[200~l1\rl2\u001b", "[201~", "typed\r\u001b[99;5u")).resolves.toBe(
      `l1${CONTINUE}l2typed\r\u0003`,
    );
  });

  it("releases a held incomplete sequence after a short wait", async () => {
    const keys = new LineEndingKeys({ holdMs: 5 });
    let forwarded = "";
    keys.on("data", (chunk: Buffer) => {
      forwarded += chunk.toString("utf8");
    });
    keys.write("a\u001b[");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    expect(forwarded).toBe("a\u001b[");
    keys.end();
  });

  it("passes only Ctrl+C and Ctrl+D while busy, and reports a Return", async () => {
    let busy = true;
    let returns = 0;
    const keys = new LineEndingKeys({ isBusy: () => busy, onReturnWhileBusy: () => returns++ });
    let forwarded = "";
    keys.on("data", (chunk: Buffer) => {
      forwarded += chunk.toString("utf8");
    });
    keys.write("typed\u001b[13;2umore\r\u001b[99;5u");
    busy = false;
    keys.write("next\r");
    keys.end();
    await new Promise((resolveEnd) => keys.on("end", resolveEnd));
    expect(forwarded).toBe("\u0003next\r");
    expect(returns).toBe(1);
  });
});

describe("review cycle 3 fixes", () => {
  const live = (options: ConstructorParameters<typeof LineEndingKeys>[0]) => {
    const keys = new LineEndingKeys(options);
    let forwarded = "";
    keys.on("data", (chunk: Buffer) => {
      forwarded += chunk.toString("utf8");
    });
    return { keys, forwarded: () => forwarded };
  };
  const wait = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

  it("ends a paste whose end marker arrives late, and drops the marker's late remainder", async () => {
    const { keys, forwarded } = live({ pasteTimeoutMs: 20 });
    keys.write("\u001b[200~l1\rl2\u001b");
    await wait(60);
    keys.write("[201~typed\r\u001b[99;5u");
    keys.end();
    await new Promise((resolveEnd) => keys.on("end", resolveEnd));
    expect(forwarded()).toBe(`l1${CONTINUE}l2typed\r\u0003`);
  });

  it("ends a paste whose end marker is lost entirely", async () => {
    const { keys, forwarded } = live({ pasteTimeoutMs: 20 });
    keys.write("\u001b[200~l1\rl2");
    await wait(60);
    keys.write("typed\r\u001b[100;5u");
    keys.end();
    await new Promise((resolveEnd) => keys.on("end", resolveEnd));
    expect(forwarded()).toBe(`l1${CONTINUE}l2typed\r\u0004`);
  });

  it("keeps a paste open while its chunks keep arriving within the timeout", async () => {
    const { keys, forwarded } = live({ pasteTimeoutMs: 40 });
    keys.write("\u001b[200~a\r");
    await wait(10);
    keys.write("b\r");
    await wait(10);
    keys.write("c\u001b[201~\r");
    keys.end();
    await new Promise((resolveEnd) => keys.on("end", resolveEnd));
    expect(forwarded()).toBe(`a${CONTINUE}b${CONTINUE}c\r`);
  });

  it("holds a paste start marker split right after its ESC", async () => {
    await expect(translate("\u001b", "[200~one\rtwo\u001b[201~\r")).resolves.toBe(`one${CONTINUE}two\r`);
  });
});

describe("busy permission decision keys", () => {
  it("routes A/P/D and kitty Escape to the decision handler without forwarding them", async () => {
    const decisions: string[] = [];
    const keys = new LineEndingKeys({
      isBusy: () => true,
      onBusyDecisionKey: (key) => decisions.push(key),
    });
    let forwarded = "";
    keys.on("data", (chunk: Buffer) => { forwarded += chunk.toString("utf8"); });

    keys.write("aP?d\u001b[27u\u001b[99;5u\u001b[100;5u");
    keys.end();
    await new Promise((resolveEnd) => keys.on("end", resolveEnd));

    expect(decisions).toEqual(["a", "p", "d", "escape"]);
    expect(forwarded).toBe("\u0003\u0004");
  });

  it("does not treat pasted decision letters as key presses", async () => {
    const decisions: string[] = [];
    const keys = new LineEndingKeys({ isBusy: () => true, onBusyDecisionKey: (key) => decisions.push(key) });
    let forwarded = "";
    keys.on("data", (chunk: Buffer) => { forwarded += chunk.toString("utf8"); });

    keys.write("\u001b[200~APD\u001b[201~\u001b[99;5u");
    keys.end();
    await new Promise((resolveEnd) => keys.on("end", resolveEnd));

    expect(decisions).toEqual([]);
    expect(forwarded).toBe("\u0003");
  });
});

describe("diff navigation keys", () => {
  it("routes view, navigation, leave, Enter, Escape, and existing exit keys without inserting them", async () => {
    const decisions: string[] = [];
    const keys = new LineEndingKeys({
      isDiffInteraction: () => true,
      onDiffInteractionKey: (key) => decisions.push(key),
    });
    let forwarded = "";
    keys.on("data", (chunk: Buffer) => { forwarded += chunk.toString("utf8"); });

    for (const key of ["v", "n", "p", "q", "\r", "\u001b[27u", "\u001b[99;5u", "\u001b[100;5u"]) keys.write(key);
    keys.end();
    await new Promise((resolveEnd) => keys.on("end", resolveEnd));

    expect(decisions).toEqual(["v", "n", "p", "q", "enter", "escape", "ctrl-c", "ctrl-d"]);
    expect(forwarded).toBe("");
  });
});
