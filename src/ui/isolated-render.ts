import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort, type ResourceLimits } from "node:worker_threads";

import { plainMarkdown } from "./markdown.js";
import { READY_SLOT, RESULT_SLOT, SIGNAL_BYTES, type RenderReply, type RenderRequest } from "./render-protocol.js";
import type { Theme } from "./style.js";

/**
 * Markdown rendering isolated in a worker thread, with a hard deadline per chunk.
 *
 * Model text is untrusted, and `marked` has several super-linear paths on crafted input (emphasis
 * and link openers are quadratic; huge tables exhaust memory). Rules in front of the lexer kept
 * leaking (security review cycles 1–4), so rendering now runs where it can be abandoned:
 * - each chunk is posted to the worker, and the main thread waits for the reply with
 *   `Atomics.wait` for at most `deadlineMs`, so the caller's API stays synchronous and ordered;
 * - if the deadline passes, or the worker has died (for example of its own out-of-memory limit),
 *   the worker is terminated and the chunk is shown as sanitized plain text; a fresh worker is
 *   started in the background, and chunks are shown plain until it is ready;
 * - the main thread therefore never blocks longer than the deadline, and a memory blow-up kills
 *   only the worker, never Quoder (whose exit hooks restore the terminal and stop the server).
 */
export interface IsolatedRendererOptions {
  /** Longest the main thread waits for one chunk (default 200 ms). */
  readonly deadlineMs?: number;
  /** The worker script; defaults to the compiled `render-worker.js` next to this module. */
  readonly workerUrl?: URL;
  readonly resourceLimits?: ResourceLimits;
}

export const RENDER_DEADLINE_MS = 200;
const DEFAULT_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 };

interface WorkerState {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly flags: Int32Array;
  dead: boolean;
}

export class IsolatedMarkdownRenderer {
  readonly #deadlineMs: number;
  readonly #workerUrl: URL;
  readonly #limits: ResourceLimits;
  #state: WorkerState | undefined;
  #nextId = 0;
  #closed = false;

  constructor(options: IsolatedRendererOptions = {}) {
    this.#deadlineMs = options.deadlineMs ?? RENDER_DEADLINE_MS;
    this.#workerUrl = options.workerUrl ?? new URL("./render-worker.js", import.meta.url);
    this.#limits = options.resourceLimits ?? DEFAULT_LIMITS;
  }

  /** Starts the worker ahead of the first chunk, so it is ready when the first answer streams. */
  start(): void {
    this.#ensureWorker();
  }

  /** Renders one chunk, or returns it as sanitized plain text if that cannot be done in time. */
  render(source: string, theme: Theme): string {
    const state = this.#ensureWorker();
    if (state === undefined || state.dead || Atomics.load(state.flags, READY_SLOT) !== 1) return plainMarkdown(source);
    this.#nextId = this.#nextId >= 0x7fffffff ? 1 : this.#nextId + 1;
    const id = this.#nextId;
    const request: RenderRequest = { id, source, color: theme.color };
    try {
      state.port.postMessage(request);
    } catch {
      this.#discard(state);
      return plainMarkdown(source);
    }
    const until = performance.now() + this.#deadlineMs;
    for (;;) {
      const finished = Atomics.load(state.flags, RESULT_SLOT);
      if (finished === id) break;
      const left = until - performance.now();
      if (left <= 0) {
        // Too slow, or the worker died: abandon it; a fresh one starts for later chunks.
        this.#discard(state);
        this.#ensureWorker();
        return plainMarkdown(source);
      }
      Atomics.wait(state.flags, RESULT_SLOT, finished, left);
    }
    for (;;) {
      const message = receiveMessageOnPort(state.port);
      if (message === undefined) return plainMarkdown(source);
      const reply = message.message as RenderReply;
      if (reply.id === id) return reply.output ?? plainMarkdown(source);
    }
  }

  /** Stops the worker; later chunks are shown plain. */
  close(): void {
    this.#closed = true;
    if (this.#state !== undefined) this.#discard(this.#state);
  }

  #ensureWorker(): WorkerState | undefined {
    if (this.#closed) return undefined;
    if (this.#state !== undefined && !this.#state.dead) return this.#state;
    try {
      const signal = new SharedArrayBuffer(SIGNAL_BYTES);
      const { port1, port2 } = new MessageChannel();
      const worker = new Worker(this.#workerUrl, {
        workerData: { port: port2, signal },
        transferList: [port2],
        resourceLimits: this.#limits,
        stdout: true,
        stderr: true,
      });
      // The worker must never keep Quoder alive, and its own output is not shown.
      worker.unref();
      port1.unref();
      worker.stdout.resume();
      worker.stderr.resume();
      const state: WorkerState = { worker, port: port1, flags: new Int32Array(signal), dead: false };
      worker.on("error", () => {
        state.dead = true;
      });
      worker.on("exit", () => {
        state.dead = true;
      });
      this.#state = state;
      return state;
    } catch {
      return undefined;
    }
  }

  #discard(state: WorkerState): void {
    state.dead = true;
    if (this.#state === state) this.#state = undefined;
    state.port.close();
    void state.worker.terminate().catch(() => undefined);
  }
}
