// Parameter types and the values derived from them. The formulas here must
// match `core/src/reference.rs`.

export type Adjustments = {
  strength: number;
  temperature: number;
  tint: number;
  exposure: number;
  contrast: number;
  saturation: number;
  /** Saturation that acts on muted colours and leaves strong ones nearly alone. */
  vibrance: number;
  /** Channel gains set by the neutral picker; [1, 1, 1] = none. */
  neutral: [number, number, number];
};

/** The adjustments that are plain sliders. */
export type SliderKey = Exclude<keyof Adjustments, 'neutral'>;

export const NO_NEUTRAL: [number, number, number] = [1, 1, 1];
export const hasNeutral = (a: Adjustments) => a.neutral.some((g) => g !== 1);

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  strength: 1, temperature: 0, tint: 0, exposure: 0, contrast: 0, saturation: 0, vibrance: 0, neutral: NO_NEUTRAL,
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
  { key: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01, format: (v) => signed(v, 0, '%') },
];

/** The sliders a colour mode sets. The strength of the correction and the neutral point are not part of a look. */
const LOOK_KEYS = ['temperature', 'tint', 'exposure', 'contrast', 'saturation', 'vibrance'] as const satisfies readonly SliderKey[];
type Look = Partial<Record<(typeof LOOK_KEYS)[number], number>>;

/**
 * Colour modes: named positions of the look sliders, nothing more. Choosing
 * one moves the sliders; a file's mode is read back from where its sliders
 * stand, so there is no second state to keep in step with them.
 */
export const COLOR_MODES = [
  { id: 'natural', label: 'Natural', look: {} },
  { id: 'vivid', label: 'Vivid', look: { contrast: 0.2, saturation: 0.1, vibrance: 0.35 } },
  { id: 'deep', label: 'Deep', look: { exposure: -0.14, contrast: 0.35, vibrance: 0.2 } },
  { id: 'soft', label: 'Soft', look: { contrast: -0.15, saturation: -0.1 } },
  { id: 'warm', label: 'Warm', look: { temperature: 0.25, vibrance: 0.15 } },
  { id: 'cool', label: 'Cool', look: { temperature: -0.25, vibrance: 0.15 } },
  { id: 'mono', label: 'Black & white', look: { contrast: 0.15, saturation: -1 } },
] as const satisfies readonly { id: string; label: string; look: Look }[];

export type ColorMode = (typeof COLOR_MODES)[number]['id'];
export const DEFAULT_COLOR_MODE: ColorMode = 'natural';

/** The adjustments with the look sliders at the positions of the given mode. */
export function withColorMode(a: Adjustments, mode: ColorMode): Adjustments {
  const look: Look = COLOR_MODES.find((m) => m.id === mode)?.look ?? {};
  const next = { ...a };
  for (const key of LOOK_KEYS) next[key] = look[key] ?? 0;
  return next;
}

/** The mode whose slider positions the adjustments have; `null` when the sliders were moved away from every mode. */
export function colorModeOf(a: Adjustments): ColorMode | null {
  const match = COLOR_MODES.find((m) => LOOK_KEYS.every((key) => a[key] === ((m.look as Look)[key] ?? 0)));
  return match?.id ?? null;
}

/** The selectable correction methods. `core` is the id the WASM core knows the method by. */
export const ALGORITHMS = [
  { id: 'uwcc', core: 0, label: 'UWCC' },
  { id: 'matrix', core: 1, label: 'Hue-shift matrix' },
  { id: 'ancuti', core: 2, label: 'Ancuti white balance' },
  { id: 'seathru', core: 3, label: 'Sea-thru (estimated range)' },
  { id: 'uwccAlways', core: 4, label: 'UWCC, always applied' },
  { id: 'seathruDepth', core: 5, label: 'Sea-thru (depth model)' },
  { id: 'udcp', core: 6, label: 'UDCP haze removal' },
  { id: 'ancutiFusion', core: 7, label: 'Ancuti balance and fusion' },
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
 * haze flag, airlight (2), fusion flag, gamma, sharpen (2), tone.
 */
export const CORRECTION_LEN = 24 + 6 * RANGE_NODES;

/** Position of the ranged flag; the haze flag and the airlight follow it. */
const RANGED_AT = 15 + 6 * RANGE_NODES;
/** Position of the fusion flag; gamma and the two sharpen values follow it. */
export const FUSION_AT = RANGED_AT + 4;
/** Position of the tone value: slope of the tone curve at black, 1 = no change. */
export const TONE_AT = FUSION_AT + 4;

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
IDENTITY_CORRECTION.set([1, 0, 1, 1], FUSION_AT + 1); // gamma 1, sharpen (0, 1), tone 1

/** Does this correction read a map of the image (range or haze), so that drawing it needs one? */
export const usesRange = (correction: Float32Array) => correction[RANGED_AT] > 0.5;

/**
 * Identifies the map a correction needs for a given frame: two corrections with
 * the same key get the same map from the same pixels.
 */
export const mapKey = (correction: Float32Array) => {
  // Fusion maps depend on the whole correction; range and haze maps only on the haze flag and the airlight.
  const part = usesFusion(correction) ? correction : usesRange(correction) ? correction.subarray(RANGED_AT + 1, RANGED_AT + 4) : null;
  return part ? Array.from(part, (v) => v.toFixed(4)).join(',') : '';
};

/** Does this correction have the fusion step, so that drawing it needs fusion maps? */
export const usesFusion = (correction: Float32Array) => correction[FUSION_AT] > 0.5;

/** Does drawing this correction need any map of the image? */
export const usesMaps = (correction: Float32Array) => usesRange(correction) || usesFusion(correction);

export function analysisFromArray(a: Float32Array): Analysis {
  const n = CORRECTION_LEN;
  return { correction: a.slice(0, n), depletion: a[n], sceneFraction: a[n + 1], waterRatio: a[n + 2], strength: a[n + 3] };
}

/** Number of values the adjustments take in the flat form (`ADJUSTMENTS_LEN` in the core). */
export const ADJUSTMENTS_LEN = 10;

/** Flat parameter block for the core's reference implementation: correction + adjustments. */
export function packParams(correction: Float32Array, a: Adjustments): Float32Array {
  const p = new Float32Array(CORRECTION_LEN + ADJUSTMENTS_LEN);
  p.set(correction.subarray(0, CORRECTION_LEN));
  p.set([a.strength, a.temperature, a.tint, a.exposure, a.contrast, a.saturation, ...a.neutral, a.vibrance], CORRECTION_LEN);
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
