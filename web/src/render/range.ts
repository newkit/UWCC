// The maps of the image some corrections need (range for Sea-thru, haze for
// UDCP, weights and low frequencies for Ancuti's fusion): estimated by the
// core from a small copy of the image, and handed to the renderer as textures.

import { usesRange } from '../model';
import { mapsFromPixels } from '../worker/client';
import type { FrameMaps } from './renderer';

/** Long side of the copy the core works from; it reduces it further itself where a map is coarser. */
const COPY_MAX = 256;

let scratch: HTMLCanvasElement | null = null;

/**
 * The maps `correction` needs of an image or video frame, in the form
 * `CorrectionRenderer.setMaps` takes. `fixedRange` replaces the range map
 * estimated from the frame, for corrections analysed on a map of their own.
 */
export function frameMapsOf(source: CanvasImageSource, width: number, height: number, correction: Float32Array, fixedRange?: Float32Array): Promise<FrameMaps> {
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
  return mapsFromPixels(new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer), w, h, correction, usesRange(correction) ? fixedRange : undefined);
}
