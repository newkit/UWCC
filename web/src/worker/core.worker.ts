/// <reference lib="webworker" />
// Runs the WASM core and the JPEG encoder off the main thread.

import encodeJpeg from '@jsquash/jpeg/encode';
import init, { analyze, apply_reference, neutral_gains, range_from_disparity, range_map } from '../core-pkg/uwcc_core.js';

export type Request =
  | { id: number; type: 'analyze'; rgba: Uint8Array; width: number; height: number; algorithms: number[]; range: Float32Array }
  | { id: number; type: 'rangeFromDisparity'; disparity: Float32Array; width: number; height: number }
  | { id: number; type: 'rangeMap'; rgba: Uint8Array; width: number; height: number }
  | { id: number; type: 'neutral'; patch: Uint8Array; correction: Float32Array; strength: number; range: number }
  | { id: number; type: 'reference'; rgba: Uint8Array; width: number; params: Float32Array; range: Float32Array }
  | { id: number; type: 'encodeJpeg'; rgba: Uint8ClampedArray; width: number; height: number; quality: number };

export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

const ready = init();

self.onmessage = async (event: MessageEvent<Request>) => {
  const msg = event.data;
  try {
    await ready;
    let result: unknown;
    const transfer: Transferable[] = [];
    if (msg.type === 'analyze') {
      result = msg.algorithms.map((algorithm) => analyze(msg.rgba, msg.width, msg.height, algorithm, msg.range));
    } else if (msg.type === 'rangeFromDisparity') {
      result = range_from_disparity(msg.disparity, msg.width, msg.height);
    } else if (msg.type === 'rangeMap') {
      result = range_map(msg.rgba, msg.width, msg.height);
    } else if (msg.type === 'neutral') {
      result = neutral_gains(msg.patch, msg.correction, msg.strength, msg.range);
    } else if (msg.type === 'reference') {
      apply_reference(msg.rgba, msg.width, msg.params, msg.range);
      result = msg.rgba;
    } else {
      const image = { data: msg.rgba, width: msg.width, height: msg.height } as unknown as ImageData;
      // Baseline encoding: progressive mode and coding optimisation are off for speed and memory at 48 MP.
      const jpeg = await encodeJpeg(image, { quality: msg.quality, progressive: false, optimize_coding: false });
      result = jpeg;
      transfer.push(jpeg);
    }
    (self as DedicatedWorkerGlobalScope).postMessage({ id: msg.id, ok: true, result } satisfies Response, transfer);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    (self as DedicatedWorkerGlobalScope).postMessage({ id: msg.id, ok: false, error: text } satisfies Response);
  }
};
