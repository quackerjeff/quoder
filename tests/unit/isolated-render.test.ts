import { afterEach, describe, expect, it } from "vitest";

import { IsolatedMarkdownRenderer, type IsolatedRendererOptions } from "../../src/ui/isolated-render.js";
import { PLAIN_THEME, createTheme } from "../../src/ui/style.js";

const FIXTURE = new URL("../fixtures/render-worker-fixture.mjs", import.meta.url);
const renderers: IsolatedMarkdownRenderer[] = [];

/** A renderer on the fixture worker, started and given time to load. */
const ready = async (options: IsolatedRendererOptions = {}) => {
  const renderer = new IsolatedMarkdownRenderer({ workerUrl: FIXTURE, deadlineMs: 200, ...options });
  renderers.push(renderer);
  renderer.start();
  await waitForWorker(renderer);
  return renderer;
};

/** Polls until the worker renders (replies are prefixed "R:"), as after a respawn. */
const waitForWorker = async (renderer: IsolatedMarkdownRenderer) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (renderer.render("probe", PLAIN_THEME).startsWith("R:")) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("worker did not become ready");
};

const timed = (renderer: IsolatedMarkdownRenderer, source: string) => {
  const started = performance.now();
  const output = renderer.render(source, PLAIN_THEME);
  return { output, ms: performance.now() - started };
};

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.close();
});

describe("Markdown rendering isolated in a worker (security review cycle 4)", () => {
  it("renders in the worker and passes the theme's colour setting", async () => {
    const renderer = await ready();
    expect(renderer.render("hello", PLAIN_THEME)).toBe("R:hello");
    expect(renderer.render("hello", createTheme(true))).toBe("R:hello:color");
  });

  it.each(["spin", "die"])("abandons a worker that %ss within the deadline, shows plain text, and recovers", async (source) => {
    const renderer = await ready();
    const { output, ms } = timed(renderer, source);
    expect(output).toBe(`${source}\n`);
    expect(ms).toBeLessThan(400);
    // Until the replacement is ready, chunks are shown plain at once rather than waited for.
    expect(timed(renderer, "**next**")).toMatchObject({ output: "**next**\n" });
    await waitForWorker(renderer);
    expect(renderer.render("again", PLAIN_THEME)).toBe("R:again");
  });

  // A worker that dies cannot signal, so the wait runs to the deadline (200 ms in Quoder; 2 s here
  // to leave the worker time to reach its memory limit).
  it("survives the worker running out of memory", { timeout: 20_000 }, async () => {
    const renderer = await ready({ deadlineMs: 2_000, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
    expect(renderer.render("oom", PLAIN_THEME)).toBe("oom\n");
    await waitForWorker(renderer);
    expect(renderer.render("after", PLAIN_THEME)).toBe("R:after");
  });

  it("bounds marked's quadratic paths by the deadline", async () => {
    const renderer = await ready();
    const { output, ms } = timed(renderer, `marked:${"![](".repeat(31_000)}`);
    expect(output.startsWith("marked:![](")).toBe(true);
    expect(ms).toBeLessThan(400);
  });

  it("shows sanitized plain text when rendering fails, before the worker is ready, and after close", async () => {
    const renderer = await ready();
    expect(renderer.render("throw", PLAIN_THEME)).toBe("throw\n");
    const fresh = new IsolatedMarkdownRenderer({ workerUrl: FIXTURE });
    renderers.push(fresh);
    expect(fresh.render("early \u001b]52;c;eA==\u0007text", PLAIN_THEME)).toBe("early text\n");
    renderer.close();
    expect(renderer.render("closed", PLAIN_THEME)).toBe("closed\n");
  });
});
