//! CPU reference implementation of the per-pixel pipeline.
//!
//! The fragment shader in `web/src/render/shader.ts` implements the
//! same steps in the same order. Change both together.

use crate::color::{linear_to_srgb, srgb_to_linear, LUMA};
use crate::model::{Adjustments, Correction};
use crate::range::RangeMap;

/// How strongly temperature and tint move the channel gains at the slider ends.
pub const WB_RANGE: f32 = 0.4;

/// One pixel: sRGB-encoded 0..1 in, sRGB-encoded 0..1 out. `range` is the
/// range-map value at the pixel; it is only used when `c.ranged` is set.
pub fn apply_pixel(srgb: [f32; 3], c: &Correction, a: &Adjustments, range: f32) -> [f32; 3] {
    let lin = [srgb_to_linear(srgb[0]), srgb_to_linear(srgb[1]), srgb_to_linear(srgb[2])];

    // 1. Automatic correction.
    // 1a. Working values: encoded or linear.
    let mut x = if c.encoded { srgb } else { lin };
    // 1b. Compensation of red and blue from green.
    let green = x[1];
    x[0] += c.comp[0] * (1.0 - x[0]) * green;
    x[2] += c.comp[1] * (1.0 - x[2]) * green;
    // 1c. Range-dependent backscatter removal and attenuation recovery.
    if c.ranged {
        for ch in 0..3 {
            let scatter = Correction::lookup(&c.backscatter[ch], range);
            let log_gain = Correction::lookup(&c.log_gain[ch], range);
            x[ch] = (x[ch] - scatter).max(0.0) * log_gain.exp();
        }
    }
    // 1d. Affine transform, then back to linear light and blend with the original by `strength`.
    let mut v = [0.0f32; 3];
    for ch in 0..3 {
        let m = &c.m[ch];
        let mut corrected = (m[0] * x[0] + m[1] * x[1] + m[2] * x[2] + m[3]).max(0.0);
        if c.encoded {
            corrected = srgb_to_linear(corrected.min(1.0));
        }
        v[ch] = lin[ch] + (corrected - lin[ch]) * a.strength;
    }

    // 2. White balance: channel gains, normalised to keep brightness.
    let mut g = [(WB_RANGE * a.temperature).exp(), (-WB_RANGE * a.tint).exp(), (-WB_RANGE * a.temperature).exp()];
    let norm = LUMA[0] * g[0] + LUMA[1] * g[1] + LUMA[2] * g[2];
    for x in g.iter_mut() {
        *x /= norm;
    }

    // 3. Exposure, then encode.
    let ev = a.exposure.exp2();
    let mut s = [0.0f32; 3];
    for ch in 0..3 {
        s[ch] = linear_to_srgb(v[ch] * g[ch] * ev);
    }

    // 4. Contrast around mid grey, 5. saturation, both on encoded values.
    let k = a.contrast.exp2();
    for x in s.iter_mut() {
        *x = (*x - 0.5) * k + 0.5;
    }
    let luma = LUMA[0] * s[0] + LUMA[1] * s[1] + LUMA[2] * s[2];
    for x in s.iter_mut() {
        *x = (luma + (*x - luma) * (1.0 + a.saturation)).clamp(0.0, 1.0);
    }
    s
}

/// Apply in place to an RGBA8 buffer of `width` pixels per row. Alpha is left
/// untouched. `range` is required by corrections with `ranged` set; without
/// it they see a constant middle range.
pub fn apply_rgba8(rgba: &mut [u8], width: usize, c: &Correction, a: &Adjustments, range: Option<&RangeMap>) {
    let width = width.max(1);
    let height = (rgba.len() / 4 / width).max(1);
    for (i, px) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let d = match range {
            Some(map) if c.ranged => {
                map.sample(((i % width) as f32 + 0.5) / width as f32, ((i / width) as f32 + 0.5) / height as f32)
            }
            _ => 0.5,
        };
        let out = apply_pixel([px[0] as f32 / 255.0, px[1] as f32 / 255.0, px[2] as f32 / 255.0], c, a, d);
        for ch in 0..3 {
            px[ch] = (out[ch] * 255.0 + 0.5) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_leaves_pixels_unchanged() {
        let mut px = vec![0u8; 256 * 4];
        for (i, p) in px.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            p.copy_from_slice(&[i as u8, (255 - i) as u8, (i * 7 % 256) as u8, 200]);
        }
        let before = px.clone();
        apply_rgba8(&mut px, 16, &Correction::IDENTITY, &Adjustments::default(), None);
        assert_eq!(px, before);
    }

    #[test]
    fn strength_zero_ignores_correction() {
        let c = Correction::affine([[0.0, 2.0, -0.2, 0.01], [0.0, 1.5, 0.0, -0.02], [0.0, 0.0, 0.4, -0.05]]);
        let a = Adjustments { strength: 0.0, ..Default::default() };
        let out = apply_pixel([0.1, 0.5, 0.8], &c, &a, 0.0);
        for (o, i) in out.iter().zip([0.1, 0.5, 0.8]) {
            assert!((o - i).abs() < 1e-5);
        }
    }

    #[test]
    fn encoded_identity_is_identity() {
        let c = Correction { encoded: true, ..Correction::IDENTITY };
        let out = apply_pixel([0.1, 0.5, 0.8], &c, &Adjustments::default(), 0.0);
        for (o, i) in out.iter().zip([0.1, 0.5, 0.8]) {
            assert!((o - i).abs() < 1e-5);
        }
    }

    #[test]
    fn ranged_step_removes_scatter_and_restores_with_distance() {
        // Constant backscatter of 0.1; the gain rises from 1 (near) to e (far).
        let mut log_gain = [0.0; crate::model::RANGE_NODES];
        for (i, v) in log_gain.iter_mut().enumerate() {
            *v = i as f32 / (crate::model::RANGE_NODES - 1) as f32;
        }
        let c = Correction {
            ranged: true,
            backscatter: [[0.1; crate::model::RANGE_NODES]; 3],
            log_gain: [log_gain; 3],
            ..Correction::IDENTITY
        };
        let a = Adjustments::default();
        let lin = srgb_to_linear(0.5);
        for d in [0.0f32, 0.31, 0.5, 1.0] {
            let out = apply_pixel([0.5; 3], &c, &a, d);
            assert!((out[0] - linear_to_srgb((lin - 0.1) * d.exp())).abs() < 1e-5, "range {d}");
        }
    }

    #[test]
    fn warmer_raises_red_and_lowers_blue() {
        let a = Adjustments { temperature: 1.0, ..Default::default() };
        let out = apply_pixel([0.5, 0.5, 0.5], &Correction::IDENTITY, &a, 0.0);
        assert!(out[0] > 0.5 && out[2] < 0.5);
    }

    #[test]
    fn saturation_minus_one_is_grey() {
        let a = Adjustments { saturation: -1.0, ..Default::default() };
        let out = apply_pixel([0.9, 0.3, 0.1], &Correction::IDENTITY, &a, 0.0);
        assert!((out[0] - out[1]).abs() < 1e-5 && (out[1] - out[2]).abs() < 1e-5);
    }
}
