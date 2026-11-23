import type { Adjustments } from '../model';
import { CorrectionRenderer, createWorkCanvas } from '../render/renderer';
import { encodeJpeg } from '../worker/client';

const TILE = 2048;

/**
 * Full-resolution export: the image is corrected tile by tile on the GPU,
 * so its size is not limited by texture or canvas limits, then encoded as
 * one JPEG in the worker.
 */
export async function exportPhoto(
  file: Blob,
  correction: Float32Array,
  adjustments: Adjustments,
  quality: number,
  onProgress: (fraction: number, stage: 'render' | 'encode') => void,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const renderer = new CorrectionRenderer(createWorkCanvas(TILE, TILE));
  try {
    const W = bitmap.width, H = bitmap.height;
    let pixels: Uint8ClampedArray;
    try {
      pixels = new Uint8ClampedArray(W * H * 4);
    } catch {
      throw new Error('Not enough memory to export this photo at full resolution on this device.');
    }
    const tile = new Uint8Array(TILE * TILE * 4);
    for (let y = 0; y < H; y += TILE) {
      for (let x = 0; x < W; x += TILE) {
        const w = Math.min(TILE, W - x), h = Math.min(TILE, H - y);
        const part = await createImageBitmap(bitmap, x, y, w, h);
        renderer.setSource(part, w, h);
        part.close();
        renderer.draw(correction, adjustments);
        const view = tile.subarray(0, w * h * 4);
        renderer.readPixels(w, h, view);
        for (let row = 0; row < h; row++) { // readPixels rows are bottom-up
          pixels.set(view.subarray(row * w * 4, (row + 1) * w * 4), ((y + h - 1 - row) * W + x) * 4);
        }
      }
      onProgress(Math.min(1, (y + TILE) / H), 'render');
      await new Promise((resolve) => setTimeout(resolve)); // keep the page responsive
    }
    onProgress(0, 'encode');
    const jpeg = await encodeJpeg(pixels, W, H, quality);
    return new Blob([jpeg], { type: 'image/jpeg' });
  } finally {
    renderer.dispose();
    bitmap.close();
  }
}

/** `GOPR0042.JPG` -> `GOPR0042_uwcc.jpg` */
export function outputName(sourceName: string, suffix = '_uwcc'): string {
  const base = sourceName.replace(/\.[^./\\]+$/, '');
  return `${base}${suffix}.jpg`;
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
