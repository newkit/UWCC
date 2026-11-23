import { type Analysis, analysisFromArray } from '../model';
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

/** Automatic analysis of a small RGBA copy of the image. */
export async function analyze(rgba: Uint8Array): Promise<Analysis> {
  return analysisFromArray(await call<Float32Array>({ type: 'analyze', rgba }));
}

/** CPU reference implementation; used to check the shader. */
export function applyReference(rgba: Uint8Array, params: Float32Array): Promise<Uint8Array> {
  return call<Uint8Array>({ type: 'reference', rgba, params });
}

/** Encode RGBA pixels as JPEG. The pixel buffer is transferred and no longer usable afterwards. */
export function encodeJpeg(rgba: Uint8ClampedArray, width: number, height: number, quality: number): Promise<ArrayBuffer> {
  return call<ArrayBuffer>({ type: 'encodeJpeg', rgba, width, height, quality }, [rgba.buffer]);
}
