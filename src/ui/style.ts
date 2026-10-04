import { styleText } from "node:util";

/** Semantic colour roles. Presentation code names a role, never a raw colour. */
export type StyleRole =
  | "prompt"
  | "accent"
  | "dim"
  | "success"
  | "warning"
  | "error"
  | "tool"
  | "path"
  | "command"
  | "heading"
  | "strong"
  | "emphasis"
  | "code"
  | "quote"
  | "link"
  | "strike"
  | "codeKeyword"
  | "codeString"
  | "codeNumber"
  | "codeComment"
  | "codeTitle"
  | "codeType"
  | "codeMeta"
  | "codeAddition"
  | "codeDeletion";

type StyleFormat = Parameters<typeof styleText>[0];

const PALETTE: Readonly<Record<StyleRole, StyleFormat>> = {
  prompt: ["bold", "cyan"],
  accent: "cyan",
  dim: "gray",
  success: "green",
  warning: "yellow",
  error: "red",
  tool: ["bold", "blue"],
  path: "cyan",
  command: "yellow",
  heading: ["bold", "magenta"],
  strong: "bold",
  emphasis: "italic",
  code: "yellow",
  quote: ["gray", "italic"],
  link: ["underline", "blue"],
  strike: "strikethrough",
  codeKeyword: "magenta",
  codeString: "green",
  codeNumber: "yellow",
  codeComment: ["gray", "italic"],
  codeTitle: "blue",
  codeType: "cyan",
  codeMeta: "gray",
  codeAddition: "green",
  codeDeletion: "red",
};

/**
 * Styles text by role. Callers sanitize untrusted text first: a theme adds Quoder's own escape
 * sequences and must never carry ones that came from the model or a tool.
 */
export interface Theme {
  readonly color: boolean;
  readonly paint: (role: StyleRole, text: string) => string;
}

export const createTheme = (color: boolean): Theme => ({
  color,
  // Detection already decided whether colour is wanted; styleText must not second-guess it.
  paint: color ? (role, text) => (text === "" ? text : styleText(PALETTE[role], text, { validateStream: false })) : (_role, text) => text,
});

export const PLAIN_THEME: Theme = createTheme(false);

export interface ColorEnvironment {
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `--no-color` on the command line. */
  readonly noColorFlag?: boolean;
}

/**
 * Whether Quoder emits colour. `--no-color` and a non-empty `NO_COLOR` (no-color.org) always win;
 * `FORCE_COLOR` turns colour on even when piped (`0` or `false` turns it off); otherwise colour is
 * used only on a TTY whose `TERM` is not `dumb`.
 */
export const colorEnabled = ({ isTTY, env, noColorFlag = false }: ColorEnvironment): boolean => {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force.toLowerCase() !== "false";
  return isTTY && env.TERM !== "dumb";
};
