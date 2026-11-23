// Parameter types and the values derived from them. The formulas here must
// match `core/src/reference.rs`.

export type Adjustments = {
  strength: number;
  temperature: number;
  tint: number;
  exposure: number;
  contrast: number;
  saturation: number;
  /** Channel gains set by the neutral picker; [1, 1, 1] = none. */
  neutral: [number, number, number];
};

/** The adjustments that are plain sliders. */
export type SliderKey = Exclude<keyof Adjustments, 'neutral'>;

export const NO_NEUTRAL: [number, number, number] = [1, 1, 1];
export const hasNeutral = (a: Adjustments) => a.neutral.some((g) => g !== 1);

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  strength: 1, temperature: 0, tint: 0, exposure: 0, contrast: 0, saturation: 0, neutral: NO_NEUTRAL,
};

export type ControlSpec = { key: SliderKey; label: string; min: number; max: number; step: number; format: (v: number) => string };

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
  { id: 'uwcc', core: 0, label: 'UWCC' },
  { id: 'matrix', core: 1, label: 'Hue-shift matrix' },
  { id: 'ancuti', core: 2, label: 'Ancuti white balance' },
  { id: 'seathru', core: 3, label: 'Sea-thru (estimated range)' },
  { id: 'uwccAlways', core: 4, label: 'UWCC, always applied' },
  { id: 'seathruDepth', core: 5, label: 'Sea-thru (depth model)' },
  { id: 'udcp', core: 6, label: 'UDCP haze removal' },
] as const;

export type Algorithm = (typeof ALGORITHMS)[number]['id'];
export const DEFAULT_ALGORITHM: Algorithm = 'uwcc';

/**
 * Methods that take their range map from the depth model. The model is large
 * and slow next to everything else, so these are analysed only when chosen,
 * and for photos only: a video uses the range estimated from colour instead.
 */
export const usesDepthModel = (algorithm: Algorithm) => algorithm === 'seathruDepth';

/** Samples per range table in a correction (`RANGE_NODES` in the core). */
export const RANGE_NODES = 8;

/**
 * Number of values in a correction. The layout is that of `Correction::to_array` in the core:
 * matrix (12), encoded flag, compensation (2), backscatter and log-gain tables (3 x RANGE_NODES each), ranged flag,
 * haze flag, airlight (2).
 */
export const CORRECTION_LEN = 19 + 6 * RANGE_NODES;

/** Position of the ranged flag; the haze flag and the airlight follow it. */
const RANGED_AT = 15 + 6 * RANGE_NODES;

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

/**
 * One analysis per method, so switching method needs no new analysis.
 * Methods that need the depth model are missing until they were chosen once.
 */
export type Analyses = Partial<Record<Algorithm, Analysis>>;

export const IDENTITY_CORRECTION = new Float32Array(CORRECTION_LEN);
IDENTITY_CORRECTION.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

/** Does this correction read a map of the image (range or haze), so that drawing it needs one? */
export const usesRange = (correction: Float32Array) => correction[RANGED_AT] > 0.5;

/**
 * Identifies the map a correction needs for a given frame: two corrections with
 * the same key get the same map from the same pixels.
 */
export const mapKey = (correction: Float32Array) =>
  usesRange(correction) ? Array.from(correction.subarray(RANGED_AT + 1, CORRECTION_LEN), (v) => v.toFixed(4)).join(',') : '';

export function analysisFromArray(a: Float32Array): Analysis {
  const n = CORRECTION_LEN;
  return { correction: a.slice(0, n), depletion: a[n], sceneFraction: a[n + 1], waterRatio: a[n + 2], strength: a[n + 3] };
}

/** Number of values the adjustments take in the flat form (`ADJUSTMENTS_LEN` in the core). */
export const ADJUSTMENTS_LEN = 9;

/** Flat parameter block for the core's reference implementation: correction + adjustments. */
export function packParams(correction: Float32Array, a: Adjustments): Float32Array {
  const p = new Float32Array(CORRECTION_LEN + ADJUSTMENTS_LEN);
  p.set(correction.subarray(0, CORRECTION_LEN));
  p.set([a.strength, a.temperature, a.tint, a.exposure, a.contrast, a.saturation, ...a.neutral], CORRECTION_LEN);
  return p;
}

const WB_RANGE = 0.4;
const LUMA = [0.2126, 0.7152, 0.0722];

/** Uniform values the shader needs, precomputed once per change. */
export function shaderValues(a: Adjustments) {
  const g = [Math.exp(WB_RANGE * a.temperature), Math.exp(-WB_RANGE * a.tint), Math.exp(-WB_RANGE * a.temperature)];
  const norm = LUMA[0] * g[0] + LUMA[1] * g[1] + LUMA[2] * g[2];
  return {
    // Temperature and tint keep brightness; the neutral picker's gains multiply in.
    whiteBalance: g.map((x, i) => (x / norm) * a.neutral[i]) as [number, number, number],
    exposure: 2 ** a.exposure,
    contrast: 2 ** a.contrast,
  };
}
