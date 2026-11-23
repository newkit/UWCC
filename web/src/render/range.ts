// The map of the image some corrections need (range for Sea-thru, haze for
// UDCP): estimated by the core from a small copy of the image, and handed to
// the renderer as a texture.

import { rangeMap } from '../worker/client';

/** Long side of the copy the core estimates the map from; it reduces it further itself. */
const COPY_MAX = 128;

let scratch: HTMLCanvasElement | null = null;

/** The map `correction` needs of an image or video frame, in the form `CorrectionRenderer.setRange` takes. */
export function rangeMapOf(source: CanvasImageSource, width: number, height: number, correction: Float32Array): Promise<Float32Array> {
  const scale = Math.min(1, COPY_MAX / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  scratch ??= document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return rangeMap(new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer), w, h, correction);
}
