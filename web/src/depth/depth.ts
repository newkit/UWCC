// Depth from a single photo, by a neural network running on this device.
// Used by the Sea-thru method that takes its range from the model.

import { rangeFromDisparity } from '../worker/client';
import type { DepthRequest, DepthResponse } from './depth.worker';

/** The model takes sides that are multiples of this (its patch size). */
const PATCH = 14;
/** Long side the model is run at: a compromise between detail and time (about a second per photo). */
const MODEL_MAX = 378;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Extract<DepthResponse, { ok: true }>) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./depth.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<DepthResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data);
      else entry.reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'The depth model failed.');
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

/** Size the model is run at for an image of the given size. */
export function depthInputSize(width: number, height: number): { width: number; height: number } {
  const scale = MODEL_MAX / Math.max(width, height);
  const fit = (side: number) => Math.max(PATCH, Math.round((side * scale) / PATCH) * PATCH);
  return { width: fit(width), height: fit(height) };
}

/**
 * Range map (in the form the renderer and the core take) of an image, from
 * the depth model. `rgba` must have a size given by `depthInputSize`.
 */
export async function depthRange(rgba: Uint8Array, width: number, height: number): Promise<Float32Array> {
  const id = nextId++;
  const modelUrl = new URL('models/depth-anything-v2-small-q8.onnx', document.baseURI).href;
  const result = await new Promise<Extract<DepthResponse, { ok: true }>>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, modelUrl, rgba, width, height } satisfies DepthRequest);
  });
  return rangeFromDisparity(result.disparity, result.width, result.height);
}
