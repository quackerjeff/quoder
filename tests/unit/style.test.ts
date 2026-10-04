import { describe, expect, it } from "vitest";

import { PLAIN_THEME, colorEnabled, createTheme } from "../../src/ui/style.js";

describe("colour detection", () => {
  it.each([
    ["a TTY", { isTTY: true, env: {} }, true],
    ["piped output", { isTTY: false, env: {} }, false],
    ["a dumb terminal", { isTTY: true, env: { TERM: "dumb" } }, false],
    ["NO_COLOR on a TTY", { isTTY: true, env: { NO_COLOR: "1" } }, false],
    ["an empty NO_COLOR", { isTTY: true, env: { NO_COLOR: "" } }, true],
    ["--no-color on a TTY", { isTTY: true, env: {}, noColorFlag: true }, false],
    ["FORCE_COLOR when piped", { isTTY: false, env: { FORCE_COLOR: "1" } }, true],
    ["FORCE_COLOR=0 on a TTY", { isTTY: true, env: { FORCE_COLOR: "0" } }, false],
    ["FORCE_COLOR=false on a TTY", { isTTY: true, env: { FORCE_COLOR: "false" } }, false],
    ["NO_COLOR over FORCE_COLOR", { isTTY: true, env: { NO_COLOR: "1", FORCE_COLOR: "1" } }, false],
    ["--no-color over FORCE_COLOR", { isTTY: false, env: { FORCE_COLOR: "1" }, noColorFlag: true }, false],
  ])("for %s", (_name, environment, expected) => {
    expect(colorEnabled(environment)).toBe(expected);
  });
});

describe("themes", () => {
  it("leaves text unchanged without colour", () => {
    expect(PLAIN_THEME.color).toBe(false);
    expect(PLAIN_THEME.paint("error", "failed")).toBe("failed");
  });

  it("wraps text in SGR sequences with colour, regardless of the process's own streams", () => {
    const theme = createTheme(true);
    expect(theme.paint("error", "failed")).toBe("\u001b[31mfailed\u001b[39m");
    expect(theme.paint("prompt", "QuackTrack")).toBe("\u001b[1m\u001b[36mQuackTrack\u001b[39m\u001b[22m");
  });

  it("adds nothing around empty text", () => {
    expect(createTheme(true).paint("dim", "")).toBe("");
  });
});
