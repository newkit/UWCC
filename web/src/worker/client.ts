import { ALGORITHMS, type Algorithm, type Analyses, type Analysis, analysisFromArray, usesDepthModel, usesFusion, usesRange } from '../model';
import type { FrameMaps } from '../render/renderer';
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

const NO_RANGE = new Float32Array(0);

/**
 * Automatic analysis of a small RGBA copy of the image, by every method that
 * needs nothing but the image. With `all`, also by the methods that normally
 * take a range map from the depth model; they then estimate the range from
 * colour (used for video).
 */
export async function analyze(rgba: Uint8Array, width: number, height: number, all = false): Promise<Analyses> {
  const methods = ALGORITHMS.filter((a) => all || !usesDepthModel(a.id));
  const results = await call<Float32Array[]>({ type: 'analyze', rgba, width, height, algorithms: methods.map((a) => a.core), range: NO_RANGE });
  return Object.fromEntries(methods.map((a, i) => [a.id, analysisFromArray(results[i])])) as Analyses;
}

/** Analysis by one method on a given range map. */
export async function analyzeWithRange(algorithm: Algorithm, rgba: Uint8Array, width: number, height: number, range: Float32Array): Promise<Analysis> {
  const core = ALGORITHMS.find((a) => a.id === algorithm)!.core;
  const results = await call<Float32Array[]>({ type: 'analyze', rgba, width, height, algorithms: [core], range });
  return analysisFromArray(results[0]);
}

/** Range map from a depth model's output (larger = nearer), in the same form as `rangeMap` returns. */
export function rangeFromDisparity(disparity: Float32Array, width: number, height: number): Promise<Float32Array> {
  return call<Float32Array>({ type: 'rangeFromDisparity', disparity, width, height });
}

/** The map `correction` needs (range, or haze), from a small RGBA copy: width, height, then one value per cell. */
export function rangeMap(rgba: Uint8Array, width: number, height: number, correction: Float32Array): Promise<Float32Array> {
  return call<Float32Array>({ type: 'rangeMap', rgba, width, height, correction });
}

/**
 * The maps `correction` needs, from a small RGBA copy of the image.
 * `fixedRange` is used in place of the estimated range map when given.
 */
export async function mapsFromPixels(rgba: Uint8Array, width: number, height: number, correction: Float32Array, fixedRange?: Float32Array): Promise<FrameMaps> {
  const maps: FrameMaps = {};
  if (usesRange(correction)) maps.range = fixedRange ?? await rangeMap(rgba, width, height, correction);
  if (usesFusion(correction)) maps.fusion = await call<Float32Array>({ type: 'fusionMaps', rgba, width, height, correction });
  return maps;
}

/**
 * Gains that turn a patch of the source grey after the given correction; empty when the patch is unusable.
 * The patch lies at (u, v), 0..1 from the top left of the image the maps belong to.
 */
export function neutralGains(patch: Uint8Array, correction: Float32Array, strength: number, u: number, v: number, maps: FrameMaps): Promise<Float32Array> {
  return call<Float32Array>({ type: 'neutral', patch, correction, strength, u, v, range: maps.range ?? NO_RANGE, fusion: maps.fusion ?? NO_RANGE });
}

/** CPU reference implementation; used for thumbnails and to check the shader. */
export function applyReference(rgba: Uint8Array, width: number, params: Float32Array, maps: FrameMaps = {}): Promise<Uint8Array> {
  return call<Uint8Array>({ type: 'reference', rgba, width, params, range: maps.range ?? NO_RANGE, fusion: maps.fusion ?? NO_RANGE });
}

/** Encode RGBA pixels as JPEG. The pixel buffer is transferred and no longer usable afterwards. */
export function encodeJpeg(rgba: Uint8ClampedArray, width: number, height: number, quality: number): Promise<ArrayBuffer> {
  return call<ArrayBuffer>({ type: 'encodeJpeg', rgba, width, height, quality }, [rgba.buffer]);
}
