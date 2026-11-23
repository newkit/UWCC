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

/** The selectable correction methods. `core` is the id the WASM core knows the method by. */
export const ALGORITHMS = [
  { id: 'uwcc', core: 0, label: 'UWCC (default)' },
  { id: 'matrix', core: 1, label: 'Hue-shift matrix' },
  { id: 'ancuti', core: 2, label: 'Ancuti white balance' },
  { id: 'seathru', core: 3, label: 'Sea-thru (estimated range)' },
] as const;

export type Algorithm = (typeof ALGORITHMS)[number]['id'];
export const DEFAULT_ALGORITHM: Algorithm = 'uwcc';

/** Samples per range table in a correction (`RANGE_NODES` in the core). */
export const RANGE_NODES = 8;

/**
 * Number of values in a correction. The layout is that of `Correction::to_array` in the core:
 * matrix (12), encoded flag, compensation (2), backscatter and log-gain tables (3 x RANGE_NODES each), ranged flag.
 */
export const CORRECTION_LEN = 16 + 6 * RANGE_NODES;

/**
 * Result of the automatic analysis. `correction` starts with a row-major 3x4
 * matrix (rows are [fromR, fromG, fromB, offset]); see `CORRECTION_LEN`.
 */
export type Analysis = {
  correction: Float32Array;
  /** 0 = red is healthy, 1 = red is absent: how much red was rebuilt from green. */
  depletion: number;
  sceneFraction: number;
  waterRatio: number;
  /** 0 = no colour cast found, nothing applied; 1 = full correction. Already contained in `correction`. */
  strength: number;
};

/** One analysis per method, so switching method needs no new analysis. */
export type Analyses = Record<Algorithm, Analysis>;

export const IDENTITY_CORRECTION = new Float32Array(CORRECTION_LEN);
IDENTITY_CORRECTION.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

/** Does this correction depend on range, so that drawing it needs a range map? */
export const usesRange = (correction: Float32Array) => correction[CORRECTION_LEN - 1] > 0.5;

export function analysisFromArray(a: Float32Array): Analysis {
  const n = CORRECTION_LEN;
  return { correction: a.slice(0, n), depletion: a[n], sceneFraction: a[n + 1], waterRatio: a[n + 2], strength: a[n + 3] };
}

/** Flat parameter block for the core's reference implementation: correction + adjustments (6). */
export function packParams(correction: Float32Array, a: Adjustments): Float32Array {
  const p = new Float32Array(CORRECTION_LEN + 6);
  p.set(correction.subarray(0, CORRECTION_LEN));
  p.set([a.strength, a.temperature, a.tint, a.exposure, a.contrast, a.saturation], CORRECTION_LEN);
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
