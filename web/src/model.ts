// Parameter types and the values derived from them. The formulas here must
// match `core/src/reference.rs`.

export type Adjustments = {
  strength: number;
  temperature: number;
  tint: number;
  exposure: number;
  contrast: number;
  saturation: number;
};

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  strength: 1, temperature: 0, tint: 0, exposure: 0, contrast: 0, saturation: 0,
};

export type ControlSpec = { key: keyof Adjustments; label: string; min: number; max: number; step: number; format: (v: number) => string };

const signed = (v: number, digits = 0, unit = '') => `${v > 0 ? '+' : ''}${(v * (unit === '%' ? 100 : 1)).toFixed(digits)}${unit}`;

export const CONTROLS: ControlSpec[] = [
  { key: 'strength', label: 'Correction', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, format: (v) => signed(v, 0, '%') },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, format: (v) => signed(v, 0, '%') },
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.02, format: (v) => signed(v, 2, ' EV') },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01, format: (v) => signed(v, 0, '%') },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01, format: (v) => signed(v, 0, '%') },
];

/** Result of the automatic analysis. `correction` is row-major 3x4: rows are [fromR, fromG, fromB, offset]. */
export type Analysis = {
  correction: Float32Array;
  /** 0 = red is healthy, 1 = red is absent: how much red was rebuilt from green. */
  depletion: number;
  sceneFraction: number;
  waterRatio: number;
  /** 0 = no colour cast found, nothing applied; 1 = full correction. Already contained in `correction`. */
  strength: number;
};

export const IDENTITY_CORRECTION = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

export function analysisFromArray(a: Float32Array): Analysis {
  return { correction: a.slice(0, 12), depletion: a[12], sceneFraction: a[13], waterRatio: a[14], strength: a[15] };
}

/** Flat parameter block for the core's reference implementation: matrix (12) + adjustments (6). */
export function packParams(correction: Float32Array, a: Adjustments): Float32Array {
  const p = new Float32Array(18);
  p.set(correction.subarray(0, 12));
  p.set([a.strength, a.temperature, a.tint, a.exposure, a.contrast, a.saturation], 12);
  return p;
}

const WB_RANGE = 0.4;
const LUMA = [0.2126, 0.7152, 0.0722];

/** Uniform values the shader needs, precomputed once per change. */
export function shaderValues(a: Adjustments) {
  const g = [Math.exp(WB_RANGE * a.temperature), Math.exp(-WB_RANGE * a.tint), Math.exp(-WB_RANGE * a.temperature)];
  const norm = LUMA[0] * g[0] + LUMA[1] * g[1] + LUMA[2] * g[2];
  return {
    whiteBalance: g.map((x) => x / norm) as [number, number, number],
    exposure: 2 ** a.exposure,
    contrast: 2 ** a.contrast,
  };
}
