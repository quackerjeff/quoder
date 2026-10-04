// Test worker speaking the isolated renderer's protocol (src/ui/render-protocol.ts), with
// misbehaviours chosen by the source text: "spin" never returns, "die" exits mid-request,
// "oom" allocates until its memory limit kills it, "throw" fails to render, "marked:<text>" lexes
// <text> with the real marked (for its quadratic paths); anything else is echoed as "R:<source>".
import { workerData } from "node:worker_threads";
import { Lexer } from "marked";

const READY_SLOT = 0;
const RESULT_SLOT = 1;
const { port, signal } = workerData;
const flags = new Int32Array(signal);

port.on("message", (request) => {
  let output;
  if (request.source === "spin") for (;;);
  if (request.source === "die") process.exit(1);
  if (request.source === "oom") {
    const hoard = [];
    for (;;) hoard.push(new Array(1_000_000).fill(hoard.length));
  }
  if (request.source.startsWith("marked:")) output = `lexed ${Lexer.lex(request.source.slice(7)).length}`;
  else if (request.source !== "throw") output = `R:${request.source}${request.color ? ":color" : ""}`;
  port.postMessage({ id: request.id, output });
  Atomics.store(flags, RESULT_SLOT, request.id);
  Atomics.notify(flags, RESULT_SLOT);
});

Atomics.store(flags, READY_SLOT, 1);
Atomics.notify(flags, READY_SLOT);
