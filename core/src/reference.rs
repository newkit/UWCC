//! CPU reference implementation of the per-pixel pipeline.
//!
//! The fragment shader in `web/src/render/shader.ts` implements the
//! same steps in the same order. Change both together.

use crate::color::{linear_to_srgb, srgb_to_linear, LUMA};
use crate::model::{Adjustments, Correction};

/// How strongly temperature and tint move the channel gains at the slider ends.
pub const WB_RANGE: f32 = 0.4;

/// One pixel: sRGB-encoded 0..1 in, sRGB-encoded 0..1 out.
pub fn apply_pixel(srgb: [f32; 3], c: &Correction, a: &Adjustments) -> [f32; 3] {
    let lin = [srgb_to_linear(srgb[0]), srgb_to_linear(srgb[1]), srgb_to_linear(srgb[2])];

    // 1. Automatic correction, blended with the original by `strength`.
    let mut v = [0.0f32; 3];
    for ch in 0..3 {
        let m = &c.m[ch];
        let corrected = (m[0] * lin[0] + m[1] * lin[1] + m[2] * lin[2] + m[3]).max(0.0);
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

/// Apply in place to an RGBA8 buffer. Alpha is left untouched.
pub fn apply_rgba8(rgba: &mut [u8], c: &Correction, a: &Adjustments) {
    for px in rgba.as_chunks_mut::<4>().0.iter_mut() {
        let out = apply_pixel([px[0] as f32 / 255.0, px[1] as f32 / 255.0, px[2] as f32 / 255.0], c, a);
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
        apply_rgba8(&mut px, &Correction::IDENTITY, &Adjustments::default());
        assert_eq!(px, before);
    }

    #[test]
    fn strength_zero_ignores_correction() {
        let c = Correction { m: [[0.0, 2.0, -0.2, 0.01], [0.0, 1.5, 0.0, -0.02], [0.0, 0.0, 0.4, -0.05]] };
        let a = Adjustments { strength: 0.0, ..Default::default() };
        let out = apply_pixel([0.1, 0.5, 0.8], &c, &a);
        for (o, i) in out.iter().zip([0.1, 0.5, 0.8]) {
            assert!((o - i).abs() < 1e-5);
        }
    }

    #[test]
    fn warmer_raises_red_and_lowers_blue() {
        let a = Adjustments { temperature: 1.0, ..Default::default() };
        let out = apply_pixel([0.5, 0.5, 0.5], &Correction::IDENTITY, &a);
        assert!(out[0] > 0.5 && out[2] < 0.5);
    }

    #[test]
    fn saturation_minus_one_is_grey() {
        let a = Adjustments { saturation: -1.0, ..Default::default() };
        let out = apply_pixel([0.9, 0.3, 0.1], &Correction::IDENTITY, &a);
        assert!((out[0] - out[1]).abs() < 1e-5 && (out[1] - out[2]).abs() < 1e-5);
    }
}
