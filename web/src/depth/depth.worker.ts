/// <reference lib="webworker" />
// Runs the depth model (Depth Anything V2 Small, see public/models/NOTICE.txt)
// off the main thread. The model and the runtime are fetched from the app's
// own origin, on first use only.

import * as ort from 'onnxruntime-web/wasm';

export type DepthRequest = { id: number; modelUrl: string; rgba: Uint8Array; width: number; height: number };
export type DepthResponse =
  | { id: number; ok: true; disparity: Float32Array; width: number; height: number }
  | { id: number; ok: false; error: string };

// One thread: the site cannot be cross-origin isolated, so WASM threads are unavailable.
ort.env.wasm.numThreads = 1;

/** Normalisation the model was trained with (ImageNet mean and deviation). */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let session: Promise<ort.InferenceSession> | null = null;

function load(modelUrl: string): Promise<ort.InferenceSession> {
  session ??= (async () => {
    const response = await fetch(modelUrl);
    if (!response.ok) throw new Error('The depth model could not be loaded.');
    return ort.InferenceSession.create(new Uint8Array(await response.arrayBuffer()), { executionProviders: ['wasm'] });
  })();
  // A failed load may be tried again later.
  session.catch(() => { session = null; });
  return session;
}

self.onmessage = async (event: MessageEvent<DepthRequest>) => {
  const { id, modelUrl, rgba, width, height } = event.data;
  const post = (message: DepthResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
  try {
    const model = await load(modelUrl);
    const plane = width * height;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      for (let ch = 0; ch < 3; ch++) input[ch * plane + i] = (rgba[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
    }
    const result = await model.run({ [model.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width]) });
    const output = result[model.outputNames[0]];
    const [outHeight, outWidth] = output.dims.slice(-2);
    const disparity = new Float32Array(output.data as Float32Array);
    post({ id, ok: true, disparity, width: outWidth, height: outHeight }, [disparity.buffer]);
  } catch (error) {
    post({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
