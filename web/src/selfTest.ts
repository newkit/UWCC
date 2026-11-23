// Compares the GPU shader with the core's CPU reference on a generated image,
// once for every branch of the per-pixel pipeline.
// Exposed for automated checks: `await window.uwccSelfTest()`.

import { type Adjustments, CORRECTION_LEN, FUSION_AT, RANGE_NODES, packParams } from './model';

/** Position of the ranged flag in a correction; the haze flag and the airlight follow. */
const RANGED_AT = 15 + 6 * RANGE_NODES;
import { CorrectionRenderer, createWorkCanvas } from './render/renderer';
import { applyReference, mapsFromPixels } from './worker/client';

export type SelfTestResult = { maxDiff: number; meanDiff: number; pixels: number; cases: Record<string, number> };

function correction(matrix: number[], rest: { encoded?: boolean; comp?: number[]; backscatter?: number[]; logGain?: number[]; airlight?: number[]; fusion?: number[] } = {}): Float32Array {
  const c = new Float32Array(CORRECTION_LEN);
  c.set(matrix);
  c[12] = rest.encoded ? 1 : 0;
  c.set(rest.comp ?? [0, 0], 13);
  if (rest.backscatter && rest.logGain) {
    c.set(rest.backscatter, 15);
    c.set(rest.logGain, 15 + 3 * RANGE_NODES);
    c[RANGED_AT] = 1;
    if (rest.airlight) c.set([1, ...rest.airlight], RANGED_AT + 1);
  }
  // Fusion flag, gamma, sharpen shift and scale; neutral values when the step is off.
  c.set(rest.fusion ? [1, ...rest.fusion] : [0, 1, 0, 1], FUSION_AT);
  return c;
}

/** Made-up parameters of the size each method produces. */
const CASES: Record<string, Float32Array> = {
  linearMatrix: correction([0.03, 1.5, -0.14, 0.004, 0, 1.2, 0, -0.01, 0, 0, 0.45, -0.04]),
  encodedMatrix: correction([2.1, -0.6, 0.9, -0.2, 0, 1.4, 0, -0.1, 0, 0, 1.5, -0.4], { encoded: true }),
  compensation: correction([2.4, 0, 0, 0, 0, 1.1, 0, 0, 0, 0, 0.6, 0], { encoded: true, comp: [0.33, 0.08] }),
  ranged: correction([0.9, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.45, 0], {
    // Tables that differ per channel and vary over range, so a wrong index or blend shows.
    backscatter: Array.from({ length: 3 * RANGE_NODES }, (_, i) => 0.004 * (i % RANGE_NODES) * (1 + Math.floor(i / RANGE_NODES))),
    logGain: Array.from({ length: 3 * RANGE_NODES }, (_, i) => 0.25 * (i % RANGE_NODES) / (1 + Math.floor(i / RANGE_NODES)) + 0.1),
  }),
  // As UDCP produces: on encoded values, reading the haze map.
  haze: correction([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], {
    encoded: true,
    airlight: [0.6, 0.8],
    backscatter: [0.1, 0.6, 0.8].flatMap((a) => Array.from({ length: RANGE_NODES }, (_, i) => a * Math.min(i / (RANGE_NODES - 1), 0.9))),
    logGain: Array.from({ length: 3 * RANGE_NODES }, (_, i) => -Math.log(Math.max(1 - (i % RANGE_NODES) / (RANGE_NODES - 1), 0.1))),
  }),
  // As Ancuti's method with fusion produces.
  fusion: correction([1.6, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0.8, 0], { encoded: true, comp: [0.3, 0], fusion: [1.5, -0.2, 2.5] }),
};

export async function selfTest(): Promise<SelfTestResult> {
  const size = 64;
  const source = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = Math.floor(i / size);
    // Covers dark and bright values, with red mostly low as in underwater footage.
    source.set([(x * y) % 256 >> 2, (x * 4 + y) % 256, (y * 4 + x * 3) % 256, 255], i * 4);
  }
  const adjustments: Adjustments = { strength: 0.9, temperature: 0.2, tint: -0.1, exposure: 0.3, contrast: 0.15, saturation: 0.2, neutral: [1.3, 0.9, 0.8] };

  const renderer = new CorrectionRenderer(createWorkCanvas(size, size));
  renderer.setSource(new ImageData(source, size, size), size, size);
  const bottomUp = new Uint8Array(size * size * 4);
  const cases: Record<string, number> = {};
  let maxDiff = 0, sum = 0;
  try {
    for (const [name, params] of Object.entries(CASES)) {
      const maps = await mapsFromPixels(new Uint8Array(source), size, size, params);
      renderer.setMaps(maps);
      renderer.draw(params, adjustments);
      renderer.readPixels(size, size, bottomUp);
      const reference = await applyReference(new Uint8Array(source), size, packParams(params, adjustments), maps);
      let worst = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          for (let ch = 0; ch < 3; ch++) {
            const d = Math.abs(bottomUp[((size - 1 - y) * size + x) * 4 + ch] - reference[(y * size + x) * 4 + ch]);
            worst = Math.max(worst, d);
            sum += d;
          }
        }
      }
      cases[name] = worst;
      maxDiff = Math.max(maxDiff, worst);
    }
  } finally {
    renderer.dispose();
  }
  const pixels = size * size;
  return { maxDiff, meanDiff: sum / (pixels * 3 * Object.keys(CASES).length), pixels, cases };
}

declare global {
  interface Window { uwccSelfTest: typeof selfTest }
}
window.uwccSelfTest = selfTest;
