//! Derives the automatic correction from image statistics.
//!
//! Works in linear light on a small copy of the image. The method is UWCC's
//! own, built from measurements on reference pairs (SPECIFICATION.md §6.5):
//!
//! 1. Measure how depleted red is. A healthy red channel (shallow water,
//!    flash, video light) scales the whole correction down to nothing.
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

/// Red counts as fully healthy when mean red reaches this share of mean green.
const HEALTHY_RED_RATIO: f32 = 0.5;
/// Share of blue removed from the rebuilt red, relative to the water ratio.
const WATER_SUBTRACT: f32 = 1.5;
/// Scene weight ramps up between these positions in the green/blue ratio range.
const SCENE_RAMP: (f32, f32) = (0.2, 0.6);
/// Below this relative spread of the ratio, the frame has no distinct open water.
const MIN_RATIO_SPREAD: f32 = 0.15;
/// Black-point percentiles: rebuilt red, green, blue.
const BLACK_PERCENTILE: [f32; 3] = [20.0, 0.5, 0.5];
/// The brightest channel's scene highlights (this percentile) map to `WHITE_LEVEL`.
const WHITE_PERCENTILE: f32 = 99.5;
const WHITE_LEVEL: f32 = 0.68;
/// Upper bound on any channel gain; trades brightness for less amplified noise.
const MAX_GAIN: f32 = 8.0;

#[derive(Clone, Copy, Debug)]
pub struct Analysis {
    /// Ready to use: already scaled by `depletion`.
    pub correction: Correction,
    /// 0 = red is healthy, 1 = red is absent.
    pub depletion: f32,
    /// Share of the frame treated as scene rather than open water.
    pub scene_fraction: f32,
    /// Green/blue ratio of open water.
    pub water_ratio: f32,
}

impl Analysis {
    const NEUTRAL: Analysis =
        Analysis { correction: Correction::IDENTITY, depletion: 0.0, scene_fraction: 1.0, water_ratio: 0.0 };
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

    // 1. Red health.
    let depletion = (1.0 - (mean_r / mean_g) as f32 / HEALTHY_RED_RATIO).clamp(0.0, 1.0);

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
        lo[ch] = percentile(&values, BLACK_PERCENTILE[ch]);
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
    Analysis { correction: full.scaled(depletion), depletion, scene_fraction, water_ratio }
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
        let m = a.correction.m;
        assert!(m[0][1] > 0.5, "red should draw on green: {:?}", m[0]);
        assert!(m[0][2] < 0.0, "red should subtract blue: {:?}", m[0]);
        assert!(m.iter().all(|row| row.iter().all(|v| v.is_finite())));
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
