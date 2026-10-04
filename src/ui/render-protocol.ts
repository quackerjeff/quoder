/** Shared between `isolated-render.ts` and its worker (`render-worker.ts`). */

/** Int32 slot set to 1 once the worker has loaded and is listening. */
export const READY_SLOT = 0;
/** Int32 slot holding the id of the last request the worker finished. */
export const RESULT_SLOT = 1;
export const SIGNAL_BYTES = 2 * Int32Array.BYTES_PER_ELEMENT;

export interface RenderRequest {
  readonly id: number;
  readonly source: string;
  readonly color: boolean;
}

export interface RenderReply {
  readonly id: number;
  /** Undefined when rendering threw; the caller then shows plain text. */
  readonly output: string | undefined;
}
