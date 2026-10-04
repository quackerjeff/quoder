/**
 * Worker thread for Markdown rendering (see `isolated-render.ts`). It runs `marked` and
 * `highlight.js` away from the main thread, so a slow or memory-hungry render on crafted model text
 * can be abandoned (and this worker terminated) without blocking Ctrl-C or crashing Quoder.
 *
 * Protocol: requests `{ id, source, color }` arrive on `workerData.port`; each reply
 * `{ id, output }` is posted on the same port *before* `id` is stored in the shared RESULT slot and
 * notified, so the main thread can read it synchronously once it sees the id.
 */
import { workerData, type MessagePort } from "node:worker_threads";

import { renderMarkdown } from "./markdown.js";
import { createTheme } from "./style.js";
import { READY_SLOT, RESULT_SLOT, type RenderReply, type RenderRequest } from "./render-protocol.js";

const { port, signal } = workerData as { readonly port: MessagePort; readonly signal: SharedArrayBuffer };
const flags = new Int32Array(signal);
const themes = { color: createTheme(true), plain: createTheme(false) };

port.on("message", (request: RenderRequest) => {
  let output: string | undefined;
  try {
    output = renderMarkdown(request.source, request.color ? themes.color : themes.plain);
  } catch {
    output = undefined;
  }
  const reply: RenderReply = { id: request.id, output };
  port.postMessage(reply);
  Atomics.store(flags, RESULT_SLOT, request.id);
  Atomics.notify(flags, RESULT_SLOT);
});

Atomics.store(flags, READY_SLOT, 1);
Atomics.notify(flags, READY_SLOT);
