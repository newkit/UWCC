import { ALGORITHMS, type Analyses, analysisFromArray } from '../model';
import type { Request, Response } from './core.worker';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Response>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data.result);
      else entry.reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The processing worker failed.');
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

type Payload<T> = T extends unknown ? Omit<T, 'id'> : never;

function call<T>(request: Payload<Request>, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ ...request, id }, transfer);
  });
}

/** Automatic analysis of a small RGBA copy of the image, by every method. */
export async function analyze(rgba: Uint8Array, width: number, height: number): Promise<Analyses> {
  const results = await call<Float32Array[]>({ type: 'analyze', rgba, width, height, algorithms: ALGORITHMS.map((a) => a.core) });
  return Object.fromEntries(ALGORITHMS.map((a, i) => [a.id, analysisFromArray(results[i])])) as Analyses;
}

/** Range map of a small RGBA copy: width, height, then one value per cell. */
export function rangeMap(rgba: Uint8Array, width: number, height: number): Promise<Float32Array> {
  return call<Float32Array>({ type: 'rangeMap', rgba, width, height });
}

/** Gains that turn a patch of the source grey after the given correction; empty when the patch is unusable. */
export function neutralGains(patch: Uint8Array, correction: Float32Array, strength: number, range: number): Promise<Float32Array> {
  return call<Float32Array>({ type: 'neutral', patch, correction, strength, range });
}

const NO_RANGE = new Float32Array(0);

/** CPU reference implementation; used for thumbnails and to check the shader. */
export function applyReference(rgba: Uint8Array, width: number, params: Float32Array, range: Float32Array = NO_RANGE): Promise<Uint8Array> {
  return call<Uint8Array>({ type: 'reference', rgba, width, params, range });
}

/** Encode RGBA pixels as JPEG. The pixel buffer is transferred and no longer usable afterwards. */
export function encodeJpeg(rgba: Uint8ClampedArray, width: number, height: number, quality: number): Promise<ArrayBuffer> {
  return call<ArrayBuffer>({ type: 'encodeJpeg', rgba, width, height, quality }, [rgba.buffer]);
}
