//! UWCC's own method: derives the automatic correction from image statistics.
//!
//! Works in linear light on a small copy of the image. The method is UWCC's
//! own, built from measurements on reference pairs (SPECIFICATION.md §6.5):
//!
//! 1. Measure two things about red. *Depletion*: how weak red is overall,
//!    which decides how much of it is rebuilt from green. *Cast*: whether
//!    even the warmest parts of the frame lack red, which decides how
//!    strongly the whole correction is applied. A frame with properly
//!    coloured content (shallow water, flash, video light) has no cast and
//!    is left alone.
//! 2. Estimate the colour of open water from the pixels with the lowest
//!    green/blue ratio.
//! 3. Rebuild red as green minus a share of blue, so that open water gets no
//!    red and stays blue. Where the frame shows no open water (a reef or
//!    sand close up), the share is reduced: the bluest pixels are then only
//!    shadow or more distant scene, and removing their red in full splits
//!    the picture into orange and blue.
//! 4. Subtract a black point per channel; for rebuilt red a high one where
//!    there is open water.
//! 5. Balance the channels on scene content only; open water is excluded so
//!    that a frame full of blue does not turn the reef yellow.
//! 6. Scale to a common white level, with a cap on the gains to limit noise.
//! 7. Where the result is dark although its highlights are already at the
//!    white level (a frame of shadow with a few lit parts), raise shadows
//!    and mid-tones with the tone curve of the pipeline; gains cannot do
//!    that without clipping the highlights.

use crate::color::{srgb_to_linear, LUMA};
use crate::model::Correction;

/// Red needs no rebuilding when mean red reaches this share of mean green.
const HEALTHY_RED_RATIO: f32 = 0.5;
/// The cast is judged on the warmest pixels: this percentile of red/green
/// among the brighter part of the frame.
const WARM_PERCENTILE: f32 = 95.0;
/// Pixels darker than this percentile of green are ignored when judging the cast.
const WARM_MIN_BRIGHTNESS_PERCENTILE: f32 = 25.0;
/// Warmest red/green at or above the first value: no cast, no correction.
/// At or below the second: full correction. Linear in between.
const CAST_RANGE: (f32, f32) = (0.95, 0.6);
/// Share of blue removed from the rebuilt red, relative to the water ratio.
const WATER_SUBTRACT: f32 = 1.5;
/// The frame counts as having open water as the share of water pixels rises
/// through this range. Below it, the "water" is only the bluest part of the
/// scene, and the two steps that keep water blue are relaxed.
const OPEN_WATER_RAMP: (f32, f32) = (0.2, 0.45);
/// Share of the blue subtraction kept when the frame has no open water.
const WATER_SUBTRACT_MIN: f32 = 0.6;
/// Scene weight ramps up between these positions in the green/blue ratio range.
const SCENE_RAMP: (f32, f32) = (0.2, 0.6);
/// Below this relative spread of the ratio, the frame has no distinct open water.
const MIN_RATIO_SPREAD: f32 = 0.15;
/// Black-point percentile for green and blue, and for red that is not rebuilt.
const BLACK_PERCENTILE: f32 = 0.5;
/// Black-point percentile for fully rebuilt red: high, so that open water
/// and deep shadows get no red. Interpolated by depletion, and used only as
/// far as the frame has open water: on a frame filled by reef it would turn
/// the darker fifth of the scene blue-green.
const BLACK_PERCENTILE_REBUILT_RED: f32 = 20.0;
/// The brightest channel's scene highlights (this percentile) map to `WHITE_LEVEL`.
const WHITE_PERCENTILE: f32 = 99.5;
const WHITE_LEVEL: f32 = 0.68;
/// Upper bound on any channel gain; trades brightness for less amplified noise.
const MAX_GAIN: f32 = 8.0;
/// A result whose median luminance (linear) is below this is lifted to it by the tone curve.
const TONE_MEDIAN: f32 = 0.09;
/// Upper bound on the tone value: the factor by which shadows, and their noise, are raised.
const MAX_TONE: f32 = 4.0;

#[derive(Clone, Copy, Debug)]
pub struct Analysis {
    /// Ready to use: already scaled by `strength`.
    pub correction: Correction,
    /// 0 = red is healthy, 1 = red is absent. Decides how much red is rebuilt from green.
    pub depletion: f32,
    /// 0 = no colour cast, correction not applied; 1 = full correction.
    pub strength: f32,
    /// Share of the frame treated as scene rather than open water.
    pub scene_fraction: f32,
    /// Green/blue ratio of open water.
    pub water_ratio: f32,
}

impl Analysis {
    /// For methods that always apply in full and report no measurements.
    pub(crate) fn plain(correction: Correction) -> Analysis {
        Analysis { correction, strength: 1.0, ..Analysis::NEUTRAL }
    }

    pub(crate) const NEUTRAL: Analysis = Analysis {
        correction: Correction::IDENTITY,
        depletion: 0.0,
        strength: 0.0,
        scene_fraction: 1.0,
        water_ratio: 0.0,
    };
}

fn linear_pixels(rgba: &[u8]) -> Vec<[f32; 3]> {
    let px: Vec<[f32; 3]> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| {
            [
                srgb_to_linear(p[0] as f32 / 255.0),
                srgb_to_linear(p[1] as f32 / 255.0),
                srgb_to_linear(p[2] as f32 / 255.0),
            ]
        })
        .collect();
    px
}

/// Analyse an RGBA8 sRGB buffer.
pub fn analyze_srgb8(rgba: &[u8]) -> Analysis {
    analyze_with(&linear_pixels(rgba), false)
}

/// As [`analyze_srgb8`], but the correction is applied in full even where no
/// colour cast was found: the manual override for frames the cast measure
/// judges wrongly.
pub fn analyze_srgb8_always(rgba: &[u8]) -> Analysis {
    analyze_with(&linear_pixels(rgba), true)
}

/// Analyse linear-light RGB pixels.
pub fn analyze_linear(px: &[[f32; 3]]) -> Analysis {
    analyze_with(px, false)
}

fn analyze_with(px: &[[f32; 3]], always: bool) -> Analysis {
    let n = px.len();
    if n == 0 {
        return Analysis::NEUTRAL;
    }
    let mean = |ch: usize| px.iter().map(|p| p[ch] as f64).sum::<f64>() / n as f64;
    let (mean_r, mean_g) = (mean(0), mean(1));
    if mean_g < 1e-4 {
        return Analysis::NEUTRAL; // essentially black; nothing to measure
    }

    // 1. Red health: overall depletion, and the cast on the warmest pixels.
    let depletion = (1.0 - (mean_r / mean_g) as f32 / HEALTHY_RED_RATIO).clamp(0.0, 1.0);
    let green: Vec<f32> = px.iter().map(|p| p[1]).collect();
    let bright = percentile(&green, WARM_MIN_BRIGHTNESS_PERCENTILE);
    let warmth: Vec<f32> = px.iter().filter(|p| p[1] > bright).map(|p| p[0] / p[1].max(1e-4)).collect();
    let warmest = percentile(&warmth, WARM_PERCENTILE);
    let strength = if always {
        1.0
    } else if warmth.is_empty() {
        0.0
    } else {
        ((CAST_RANGE.0 - warmest) / (CAST_RANGE.0 - CAST_RANGE.1)).clamp(0.0, 1.0)
    };
    if strength == 0.0 {
        return Analysis { depletion, ..Analysis::NEUTRAL };
    }

    // 2. Water colour, from pixels that have a meaningful amount of blue.
    let blue: Vec<f32> = px.iter().map(|p| p[2]).collect();
    let blue_floor = percentile(&blue, 5.0);
    let ratio = |p: &[f32; 3]| p[1] / p[2].max(1e-4);
    let ratios: Vec<f32> = px.iter().filter(|p| p[2] > blue_floor).map(ratio).collect();
    if ratios.is_empty() {
        return Analysis { depletion, ..Analysis::NEUTRAL };
    }
    let water_ratio = percentile(&ratios, 2.0);
    let scene_ratio = percentile(&ratios, 90.0);
    let spread = scene_ratio - water_ratio;

    // Scene weights: 0 for open water, 1 for scene content.
    let mut weights: Vec<f32> = if scene_ratio <= 0.0 || spread / scene_ratio < MIN_RATIO_SPREAD {
        vec![1.0; n]
    } else {
        let (a, b) = (water_ratio + SCENE_RAMP.0 * spread, water_ratio + SCENE_RAMP.1 * spread);
        px.iter().map(|p| smoothstep(a, b, ratio(p))).collect()
    };
    let mut weight_sum: f64 = weights.iter().map(|&w| w as f64).sum();
    if weight_sum < 0.02 * n as f64 {
        weights = vec![1.0; n];
        weight_sum = n as f64;
    }
    let scene_fraction = (weight_sum / n as f64) as f32;

    // 3. Rebuild red.
    // Without open water in the frame, the bluest pixels are reef in shadow or
    // further away, not water: take less blue out of the rebuilt red there.
    let open_water = smoothstep(OPEN_WATER_RAMP.0, OPEN_WATER_RAMP.1, 1.0 - scene_fraction);
    let c = WATER_SUBTRACT * water_ratio * (WATER_SUBTRACT_MIN + (1.0 - WATER_SUBTRACT_MIN) * open_water);
    let red_row = [1.0 - depletion, depletion, -depletion * c];
    let mixed: Vec<[f32; 3]> =
        px.iter().map(|p| [red_row[0] * p[0] + red_row[1] * p[1] + red_row[2] * p[2], p[1], p[2]]).collect();

    // 4. Black points.
    let mut lo = [0.0f32; 3];
    for ch in 0..3 {
        let values: Vec<f32> = mixed.iter().map(|p| p[ch]).collect();
        let q = if ch == 0 {
            BLACK_PERCENTILE + (BLACK_PERCENTILE_REBUILT_RED - BLACK_PERCENTILE) * depletion * open_water
        } else {
            BLACK_PERCENTILE
        };
        lo[ch] = percentile(&values, q);
    }

    // 5. Balance on scene content.
    let mut scene_mean = [0.0f64; 3];
    for (p, &w) in mixed.iter().zip(&weights) {
        for ch in 0..3 {
            scene_mean[ch] += ((p[ch] - lo[ch]).max(0.0) * w) as f64;
        }
    }
    let avg = scene_mean.iter().sum::<f64>() / 3.0;
    if avg <= 0.0 || scene_mean.iter().any(|&m| m <= 0.0) {
        return Analysis { depletion, scene_fraction, water_ratio, ..Analysis::NEUTRAL };
    }
    let balance = [(avg / scene_mean[0]) as f32, (avg / scene_mean[1]) as f32, (avg / scene_mean[2]) as f32];

    // 6. White level and gain cap.
    let mut hi = 0.0f32;
    for ch in 0..3 {
        let values: Vec<f32> = mixed.iter().map(|p| (p[ch] - lo[ch]).max(0.0) * balance[ch]).collect();
        hi = hi.max(weighted_percentile(&values, &weights, WHITE_PERCENTILE));
    }
    if hi <= 0.0 {
        return Analysis { depletion, scene_fraction, water_ratio, ..Analysis::NEUTRAL };
    }
    let mut gain = balance.map(|b| b * WHITE_LEVEL / hi);
    let max_gain = gain.iter().cloned().fold(0.0, f32::max);
    if max_gain > MAX_GAIN {
        gain = gain.map(|g| g * MAX_GAIN / max_gain);
    }

    let full = Correction::affine([
        [red_row[0] * gain[0], red_row[1] * gain[0], red_row[2] * gain[0], -lo[0] * gain[0]],
        [0.0, gain[1], 0.0, -lo[1] * gain[1]],
        [0.0, 0.0, gain[2], -lo[2] * gain[2]],
    ]);
    let mut full = full;
    // 7. Tone: where the result is dark, lift it until the median reaches the target.
    let luma: Vec<f32> = px
        .iter()
        .map(|p| {
            let v = [0, 1, 2].map(|ch| {
                let m = &full.m[ch];
                (m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3]).clamp(0.0, 1.0)
            });
            LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2]
        })
        .collect();
    let median = percentile(&luma, 50.0).max(1e-4);
    // The tone value that maps `median` to the target, from inverting the curve.
    full.tone = (TONE_MEDIAN * (1.0 - median) / (median * (1.0 - TONE_MEDIAN))).clamp(1.0, MAX_TONE);
    Analysis { correction: full.scaled(strength), depletion, strength, scene_fraction, water_ratio }
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a).max(1e-9)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Linear-interpolated percentile, `q` in 0..100.
pub(crate) fn percentile(values: &[f32], q: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v = values.to_vec();
    v.sort_unstable_by(|a, b| a.total_cmp(b));
    let pos = (q / 100.0).clamp(0.0, 1.0) * (v.len() - 1) as f32;
    let i = pos.floor() as usize;
    let j = (i + 1).min(v.len() - 1);
    v[i] + (v[j] - v[i]) * (pos - i as f32)
}

/// Smallest value at which the cumulative weight reaches `q` percent.
fn weighted_percentile(values: &[f32], weights: &[f32], q: f32) -> f32 {
    let mut idx: Vec<usize> = (0..values.len()).collect();
    idx.sort_unstable_by(|&a, &b| values[a].total_cmp(&values[b]));
    let total: f64 = weights.iter().map(|&w| w as f64).sum();
    if total <= 0.0 {
        return percentile(values, q);
    }
    let target = (q as f64 / 100.0) * total;
    let mut acc = 0.0f64;
    for &i in &idx {
        acc += weights[i] as f64;
        if acc >= target {
            return values[i];
        }
    }
    values[*idx.last().unwrap()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_applies_where_the_cast_check_would_not() {
        // Dim but properly coloured content: no cast, so the automatic method leaves it alone.
        let px: Vec<[f32; 3]> = (0..400)
            .map(|i| [0.05 + 0.001 * i as f32, 0.04 + 0.0009 * i as f32, 0.03 + 0.0007 * ((i * 37) % 400) as f32])
            .collect();
        let auto = analyze_linear(&px);
        assert_eq!(auto.strength, 0.0);
        assert_eq!(auto.correction, Correction::IDENTITY);
        let forced = analyze_with(&px, true);
        assert_eq!(forced.strength, 1.0);
        assert_ne!(forced.correction, Correction::IDENTITY);
    }

    #[test]
    fn empty_and_black_are_neutral() {
        assert_eq!(analyze_linear(&[]).correction, Correction::IDENTITY);
        assert_eq!(analyze_linear(&[[0.0; 3]; 100]).correction, Correction::IDENTITY);
    }

    #[test]
    fn healthy_red_means_no_correction() {
        // A neutral grey ramp: red is as strong as green.
        let px: Vec<[f32; 3]> = (0..1000).map(|i| [i as f32 / 1000.0; 3]).collect();
        let a = analyze_linear(&px);
        assert_eq!(a.depletion, 0.0);
        assert_eq!(a.correction, Correction::IDENTITY);
    }

    #[test]
    fn depleted_red_is_rebuilt_from_green() {
        // Blue-green scene without red, varying brightness and green/blue ratio.
        let px: Vec<[f32; 3]> = (0..2000)
            .map(|i| {
                let t = i as f32 / 2000.0;
                [0.001, 0.05 + 0.4 * t, 0.3 + 0.5 * t]
            })
            .collect();
        let a = analyze_linear(&px);
        assert!(a.depletion > 0.9);
        assert_eq!(a.strength, 1.0);
        let m = a.correction.m;
        assert!(m[0][1] > 0.5, "red should draw on green: {:?}", m[0]);
        assert!(m[0][2] < 0.0, "red should subtract blue: {:?}", m[0]);
        assert!(m.iter().all(|row| row.iter().all(|v| v.is_finite())));
    }

    /// A frame filled by scene (no open water) without any red: the result
    /// must stay close to neutral instead of splitting into orange and blue.
    #[test]
    fn red_less_frame_without_open_water_stays_near_neutral() {
        // Green/blue ratio over 0.4..0.95, independent of brightness; most of
        // the frame is at the green end, the blue end is a thin tail.
        let px: Vec<[f32; 3]> = (0..4000)
            .map(|i| {
                let ratio = 0.4 + 0.55 * (((i * 61) % 4000) as f32 / 4000.0).powf(0.4);
                let blue = 0.1 + 0.6 * i as f32 / 4000.0;
                [0.0, ratio * blue, blue]
            })
            .collect();
        let a = analyze_linear(&px);
        assert_eq!(a.depletion, 1.0);
        assert!(a.scene_fraction > 0.7, "scene fraction {}", a.scene_fraction);
        let m = a.correction.m;
        let out = |p: [f32; 3]| -> Vec<f32> {
            (0..3).map(|ch| (m[ch][0] * p[0] + m[ch][1] * p[1] + m[ch][2] * p[2] + m[ch][3]).max(0.0)).collect()
        };
        // The upper and the lower quartile of the green/blue ratio, at mid brightness.
        let (warm, cool) = (out([0.0, 0.89 * 0.4, 0.4]), out([0.0, 0.72 * 0.4, 0.4]));
        assert!(warm[0] / warm[1] < 1.2, "greenest part too orange: {warm:?}");
        assert!(cool[0] / cool[1] > 0.7, "bluest part lost its red: {cool:?}");
    }

    /// Red is weak but present everywhere (shallow to medium depth): the
    /// cast must be removed in full, mostly by raising the real red channel.
    #[test]
    fn partial_cast_is_fully_corrected() {
        // A neutral scene (sand, rock) seen through water: red at 32 % of green.
        // Darker parts are further away and therefore bluer, as in real footage.
        let px: Vec<[f32; 3]> = (0..3000)
            .map(|i| {
                let t = i as f32 / 3000.0;
                let v = 0.03 + 0.5 * t;
                [0.32 * v, v, v * (2.2 - 1.1 * t)]
            })
            .collect();
        let a = analyze_linear(&px);
        assert!(a.depletion > 0.2 && a.depletion < 0.6, "depletion {}", a.depletion);
        assert_eq!(a.strength, 1.0);
        // A bright neutral pixel went in with red at 0.32 x green and blue at 1.15 x green.
        // It must come out without the cast; slightly warm highlights are intended.
        let m = a.correction.m;
        let p = [0.32 * 0.5, 0.5, 1.15 * 0.5];
        let out: Vec<f32> = (0..3).map(|ch| m[ch][0] * p[0] + m[ch][1] * p[1] + m[ch][2] * p[2] + m[ch][3]).collect();
        let (red, blue) = (out[0] / out[1], out[2] / out[1]);
        assert!((0.8..=1.35).contains(&red), "red/green after correction: {out:?}");
        assert!((0.65..=1.1).contains(&blue), "blue/green after correction: {out:?}");
    }

    /// Properly coloured content somewhere in the frame means there is no cast to remove.
    #[test]
    fn warm_content_blocks_the_correction() {
        let mut px: Vec<[f32; 3]> = (0..2000).map(|i| [0.01, 0.1 + 0.2 * (i as f32 / 2000.0), 0.6]).collect();
        px.extend((0..400).map(|i| [0.5 + 0.2 * (i as f32 / 400.0), 0.3, 0.25])); // lit, red subject
        let a = analyze_linear(&px);
        assert_eq!(a.strength, 0.0);
        assert_eq!(a.correction, Correction::IDENTITY);
    }

    /// Mostly shadow with a few bright parts: gains cannot brighten it, the tone curve must.
    #[test]
    fn dark_frame_with_highlights_gets_a_tone_lift() {
        let mut px: Vec<[f32; 3]> = (0..3000)
            .map(|i| {
                let v = 0.005 + 0.03 * i as f32 / 3000.0;
                [0.3 * v, v, v * (2.0 - 0.8 * i as f32 / 3000.0)]
            })
            .collect();
        px.extend((0..300).map(|i| {
            let v = 0.5 + 0.4 * i as f32 / 300.0;
            [0.3 * v, v, 1.1 * v]
        }));
        let a = analyze_linear(&px);
        assert!(a.correction.tone > 1.5 && a.correction.tone <= MAX_TONE, "tone {}", a.correction.tone);
        // A frame that is bright enough gets none.
        let bright: Vec<[f32; 3]> = (0..3000)
            .map(|i| {
                let v = 0.1 + 0.6 * i as f32 / 3000.0;
                [0.3 * v, v, v * (1.6 - 0.5 * i as f32 / 3000.0)]
            })
            .collect();
        assert_eq!(analyze_linear(&bright).correction.tone, 1.0);
    }

    #[test]
    fn gains_are_capped() {
        // Very dark scene: uncapped gains would be enormous.
        let px: Vec<[f32; 3]> = (0..2000)
            .map(|i| {
                let t = i as f32 / 2000.0;
                [0.0, 0.001 + 0.004 * t, 0.01 + 0.01 * t]
            })
            .collect();
        let m = analyze_linear(&px).correction.m;
        assert!(m[1][1] <= MAX_GAIN + 1e-3 && m[2][2] <= MAX_GAIN + 1e-3);
    }

    #[test]
    fn percentiles() {
        let v: Vec<f32> = (0..=100).map(|i| i as f32).collect();
        assert_eq!(percentile(&v, 0.0), 0.0);
        assert_eq!(percentile(&v, 50.0), 50.0);
        assert_eq!(percentile(&v, 100.0), 100.0);
        let w = vec![1.0; v.len()];
        assert!((weighted_percentile(&v, &w, 50.0) - 50.0).abs() <= 1.0);
    }
}
