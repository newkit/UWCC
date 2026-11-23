//! The "colour matrix" method widely used by dive tools: borrow red from the
//! other channels by rotating the hue until the average red is acceptable,
//! then stretch each channel between a low and a high point of its histogram.
//!
//! No paper describes it. This is an independent implementation of the idea
//! as summarised in SPECIFICATION.md §6.3; no code is taken from the
//! GPL-licensed projects that popularised it, and the results are not meant
//! to be identical to theirs. The hue rotation is the standard
//! luminance-preserving one (the `hueRotate` matrix of the W3C Filter Effects
//! specification).
//!
//! Like those tools it works on sRGB-encoded values, always applies, and has
//! no protection for frames that are already well coloured.

use crate::analysis::{percentile, Analysis};
use crate::model::Correction;

/// The hue is rotated until the mean of red reaches this encoded value.
const MIN_MEAN_RED: f32 = 60.0 / 255.0;
const MAX_ROTATION_DEGREES: u32 = 120;
/// Histogram percentiles mapped to black and white.
const LEVELS: (f32, f32) = (0.5, 99.5);

/// How red is mixed from red, green and blue at a hue rotation of `degrees`.
fn red_row(degrees: f32) -> [f32; 3] {
    let (sin, cos) = degrees.to_radians().sin_cos();
    [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928]
}

/// Analyse an RGBA8 sRGB buffer.
pub fn analyze(rgba: &[u8]) -> Analysis {
    let px: Vec<[f32; 3]> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
        .collect();
    if px.is_empty() {
        return Analysis::NEUTRAL;
    }
    let mut mean = [0.0f64; 3];
    for p in &px {
        for ch in 0..3 {
            mean[ch] += p[ch] as f64;
        }
    }
    let mean = mean.map(|m| (m / px.len() as f64) as f32);

    let mut row = red_row(0.0);
    for degrees in 0..=MAX_ROTATION_DEGREES {
        row = red_row(degrees as f32);
        if row[0] * mean[0] + row[1] * mean[1] + row[2] * mean[2] >= MIN_MEAN_RED {
            break;
        }
    }

    let channels: [Vec<f32>; 3] = [
        px.iter().map(|p| (row[0] * p[0] + row[1] * p[1] + row[2] * p[2]).clamp(0.0, 1.0)).collect(),
        px.iter().map(|p| p[1]).collect(),
        px.iter().map(|p| p[2]).collect(),
    ];
    let mut m = Correction::IDENTITY.m;
    for ch in 0..3 {
        let lo = percentile(&channels[ch], LEVELS.0);
        let hi = percentile(&channels[ch], LEVELS.1);
        let gain = 1.0 / (hi - lo).max(1.0 / 255.0);
        let mix = if ch == 0 { row } else { [(ch == 0) as u8 as f32, (ch == 1) as u8 as f32, (ch == 2) as u8 as f32] };
        m[ch] = [mix[0] * gain, mix[1] * gain, mix[2] * gain, -lo * gain];
    }
    Analysis::plain(Correction { encoded: true, ..Correction::affine(m) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Adjustments;
    use crate::reference::apply_pixel;

    fn frame(colours: &[[u8; 3]]) -> Vec<u8> {
        let mut out = Vec::new();
        for i in 0..4096 {
            let c = colours[i % colours.len()];
            out.extend_from_slice(&[c[0], c[1], c[2], 255]);
        }
        out
    }

    #[test]
    fn no_rotation_at_zero_degrees() {
        let row = red_row(0.0);
        assert!((row[0] - 1.0).abs() < 1e-6 && row[1].abs() < 1e-6 && row[2].abs() < 1e-6);
    }

    #[test]
    fn missing_red_is_borrowed() {
        let rgba = frame(&[[2, 60, 90], [6, 140, 170], [10, 200, 210], [4, 100, 150]]);
        let a = analyze(&rgba);
        assert!(a.correction.encoded);
        assert!(a.correction.m[0][1] > 0.1 || a.correction.m[0][2] > 0.1, "red must draw on green or blue");
        // The brightest colour comes out with clearly more red than it went in with.
        let out =
            apply_pixel([10.0 / 255.0, 200.0 / 255.0, 210.0 / 255.0], &a.correction, &Adjustments::default(), 0.0);
        assert!(out[0] > 0.5, "{out:?}");
    }

    #[test]
    fn healthy_red_only_gets_levels() {
        let rgba = frame(&[[40, 50, 60], [120, 110, 100], [200, 190, 180]]);
        let m = analyze(&rgba).correction.m;
        assert!(m[0][1].abs() < 1e-6 && m[0][2].abs() < 1e-6);
        assert!(m[0][0] > 1.0);
    }
}
