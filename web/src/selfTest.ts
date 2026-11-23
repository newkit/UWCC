// Compares the GPU shader with the core's CPU reference on a generated image.
// Exposed for automated checks: `await window.uwccSelfTest()`.

import { type Adjustments, packParams } from './model';
import { CorrectionRenderer, createWorkCanvas } from './render/renderer';
import { applyReference } from './worker/client';

export type SelfTestResult = { maxDiff: number; meanDiff: number; pixels: number };

export async function selfTest(): Promise<SelfTestResult> {
  const size = 64;
  const source = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = Math.floor(i / size);
    // Covers dark and bright values, with red mostly low as in underwater footage.
    source.set([(x * y) % 256 >> 2, (x * 4 + y) % 256, (y * 4 + x * 3) % 256, 255], i * 4);
  }
  const correction = new Float32Array([0.03, 1.5, -0.14, 0.004, 0, 1.2, 0, -0.01, 0, 0, 0.45, -0.04]);
  const adjustments: Adjustments = { strength: 0.9, temperature: 0.2, tint: -0.1, exposure: 0.3, contrast: 0.15, saturation: 0.2 };

  const renderer = new CorrectionRenderer(createWorkCanvas(size, size));
  renderer.setSource(new ImageData(source, size, size), size, size);
  renderer.draw(correction, adjustments);
  const bottomUp = new Uint8Array(size * size * 4);
  renderer.readPixels(size, size, bottomUp);
  renderer.dispose();

  const reference = await applyReference(new Uint8Array(source), packParams(correction, adjustments));
  let maxDiff = 0, sum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let ch = 0; ch < 3; ch++) {
        const gpu = bottomUp[((size - 1 - y) * size + x) * 4 + ch];
        const cpu = reference[(y * size + x) * 4 + ch];
        const d = Math.abs(gpu - cpu);
        maxDiff = Math.max(maxDiff, d);
        sum += d;
      }
    }
  }
  return { maxDiff, meanDiff: sum / (size * size * 3), pixels: size * size };
}

declare global {
  interface Window { uwccSelfTest: typeof selfTest }
}
window.uwccSelfTest = selfTest;
