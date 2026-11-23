// The neutral picker: the user points at something that should be grey or
// white, and the channel gains that make it so become part of the adjustments.

import { neutralGains } from '../worker/client';
import { frameMapsOf } from './range';

/** Side of the sampled patch, as a share of the image's short side. */
const PATCH_SHARE = 0.02;
/** The patch is read at no more than this many pixels per side. */
const PATCH_MAX = 16;

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
  const maps = await frameMapsOf(source, width, height, correction, fixedRange);
  const gains = await neutralGains(patch, correction, strength, u, v, maps);
  if (gains.length !== 3) throw new Error('That spot is too dark or too bright to read its colour. Pick another one.');
  return [gains[0], gains[1], gains[2]];
}
