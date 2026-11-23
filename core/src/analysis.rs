//! Derives the automatic correction from image statistics.
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
//!    red and stays blue.
//! 4. Subtract a black point per channel.
//! 5. Balance the channels on scene content only; open water is excluded so
//!    that a frame full of blue does not turn the reef yellow.
//! 6. Scale to a common white level, with a cap on the gains to limit noise.

use crate::color::srgb_to_linear;
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
/// Scene weight ramps up between these positions in the green/blue ratio range.
const SCENE_RAMP: (f32, f32) = (0.2, 0.6);
/// Below this relative spread of the ratio, the frame has no distinct open water.
const MIN_RATIO_SPREAD: f32 = 0.15;
/// Black-point percentile for green and blue, and for red that is not rebuilt.
const BLACK_PERCENTILE: f32 = 0.5;
/// Black-point percentile for fully rebuilt red: high, so that open water
/// and deep shadows get no red. Interpolated by depletion.
const BLACK_PERCENTILE_REBUILT_RED: f32 = 20.0;
/// The brightest channel's scene highlights (this percentile) map to `WHITE_LEVEL`.
const WHITE_PERCENTILE: f32 = 99.5;
const WHITE_LEVEL: f32 = 0.68;
/// Upper bound on any channel gain; trades brightness for less amplified noise.
const MAX_GAIN: f32 = 8.0;

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
    const NEUTRAL: Analysis = Analysis {
        correction: Correction::IDENTITY,
        depletion: 0.0,
        strength: 0.0,
        scene_fraction: 1.0,
        water_ratio: 0.0,
    };
}

/// Analyse an RGBA8 sRGB buffer.
pub fn analyze_srgb8(rgba: &[u8]) -> Analysis {
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
    analyze_linear(&px)
}

/// Analyse linear-light RGB pixels.
pub fn analyze_linear(px: &[[f32; 3]]) -> Analysis {
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
    let strength = if warmth.is_empty() {
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
    let c = WATER_SUBTRACT * water_ratio;
    let red_row = [1.0 - depletion, depletion, -depletion * c];
    let mixed: Vec<[f32; 3]> =
        px.iter().map(|p| [red_row[0] * p[0] + red_row[1] * p[1] + red_row[2] * p[2], p[1], p[2]]).collect();

    // 4. Black points.
    let mut lo = [0.0f32; 3];
    for ch in 0..3 {
        let values: Vec<f32> = mixed.iter().map(|p| p[ch]).collect();
        let q = if ch == 0 {
            BLACK_PERCENTILE + (BLACK_PERCENTILE_REBUILT_RED - BLACK_PERCENTILE) * depletion
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

    let full = Correction {
        m: [
            [red_row[0] * gain[0], red_row[1] * gain[0], red_row[2] * gain[0], -lo[0] * gain[0]],
            [0.0, gain[1], 0.0, -lo[1] * gain[1]],
            [0.0, 0.0, gain[2], -lo[2] * gain[2]],
        ],
    };
    Analysis { correction: full.scaled(strength), depletion, strength, scene_fraction, water_ratio }
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a).max(1e-9)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Linear-interpolated percentile, `q` in 0..100.
fn percentile(values: &[f32], q: f32) -> f32 {
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
