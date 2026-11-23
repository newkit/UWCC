// The neutral picker: the user points at something that should be grey or
// white, and the channel gains that make it so become part of the adjustments.

import { usesRange } from '../model';
import { neutralGains } from '../worker/client';
import { rangeMapOf } from './range';

/** Side of the sampled patch, as a share of the image's short side. */
const PATCH_SHARE = 0.02;
/** The patch is read at no more than this many pixels per side. */
const PATCH_MAX = 16;

/** Bilinear lookup in a range map as the core returns it (width, height, cells); same arithmetic as the shader. */
function sampleRange(map: Float32Array, u: number, v: number): number {
  const w = map[0], h = map[1];
  const x = Math.min(Math.max(u * w - 0.5, 0), w - 1), y = Math.min(Math.max(v * h - 0.5, 0), h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const at = (cx: number, cy: number) => map[2 + cy * w + cx];
  const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (x - x0);
  const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (x - x0);
  return top + (bottom - top) * (y - y0);
}

/**
 * Gains that make the spot at (u, v), 0..1 from the top left of the image,
 * neutral once `correction` at `strength` has been applied.
 * Throws when the spot is too dark or blown out to tell its colour.
 */
export async function pickNeutral(
  source: CanvasImageSource,
  width: number,
  height: number,
  u: number,
  v: number,
  correction: Float32Array,
  strength: number,
  /** The range map in use, when it is not the one estimated from colour. */
  fixedRange?: Float32Array,
): Promise<[number, number, number]> {
  const side = Math.max(3, Math.round(Math.min(width, height) * PATCH_SHARE));
  const x = Math.min(Math.max(Math.round(u * width - side / 2), 0), Math.max(0, width - side));
  const y = Math.min(Math.max(Math.round(v * height - side / 2), 0), Math.max(0, height - side));
  const out = Math.min(side, PATCH_MAX);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, Math.min(side, width), Math.min(side, height), 0, 0, out, out);
  const patch = new Uint8Array(ctx.getImageData(0, 0, out, out).data.buffer);
  const range = usesRange(correction) ? sampleRange(fixedRange ?? await rangeMapOf(source, width, height), u, v) : 0.5;
  const gains = await neutralGains(patch, correction, strength, range);
  if (gains.length !== 3) throw new Error('That spot is too dark or too bright to read its colour. Pick another one.');
  return [gains[0], gains[1], gains[2]];
}
