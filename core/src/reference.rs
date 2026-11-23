//! CPU reference implementation of the per-pixel pipeline.
//!
//! The fragment shader in `web/src/render/shader.ts` implements the
//! same steps in the same order. Change both together.

use crate::color::{linear_to_srgb, srgb_to_linear, LUMA};
use crate::fusion::{FusionMaps, FusionSample};
use crate::model::{Adjustments, Correction};
use crate::range::RangeMap;

/// How strongly temperature and tint move the channel gains at the slider ends.
pub const WB_RANGE: f32 = 0.4;

/// Largest and smallest gain the neutral picker may set on a channel.
pub const NEUTRAL_GAIN_LIMIT: f32 = 8.0;
/// A picked patch must be brighter than this (linear luminance) to carry a colour worth balancing.
const NEUTRAL_MIN_LUMA: f32 = 0.004;
/// ... and no channel of its mean may exceed this: a clipped patch has lost its colour.
const NEUTRAL_MAX_VALUE: f32 = 0.95;

/// What the pipeline reads from the maps of the image at one pixel.
#[derive(Clone, Copy, Debug)]
pub struct Local {
    /// Value of the range (or haze) map; only used when the correction has `ranged` set.
    pub range: f32,
    /// Values of the fusion maps; without them the fusion step is skipped.
    pub fusion: Option<FusionSample>,
}

impl Local {
    /// A pixel at the given range, without fusion maps.
    pub const fn at(range: f32) -> Local {
        Local { range, fusion: None }
    }
}

/// Steps 1 to 4 of the correction for one pixel, on working values (encoded
/// or linear, as the correction says): what the fusion step starts from.
pub fn balanced(srgb: [f32; 3], c: &Correction, range: f32) -> [f32; 3] {
    let x = prepared(srgb, c, range);
    [0, 1, 2].map(|ch| {
        let m = &c.m[ch];
        (m[0] * x[0] + m[1] * x[1] + m[2] * x[2] + m[3]).max(0.0)
    })
}

/// The two inputs of the fusion step for a balanced value `y` (one channel)
/// and the low-frequency part `blur` of the balanced image at the pixel:
/// gamma-corrected, and sharpened by normalised unsharp masking.
pub fn fusion_inputs(y: f32, blur: f32, c: &Correction) -> [f32; 2] {
    let y = y.clamp(0.0, 1.0);
    [y.powf(c.gamma), 0.5 * (y + ((y - blur - c.sharpen[0]) * c.sharpen[1]).clamp(0.0, 1.0))]
}

/// Step 1 of the pipeline for one pixel: the automatic correction, blended
/// with the original by `strength`. sRGB-encoded 0..1 in, linear light out.
pub fn corrected_linear(srgb: [f32; 3], c: &Correction, strength: f32, local: &Local) -> [f32; 3] {
    let lin = [srgb_to_linear(srgb[0]), srgb_to_linear(srgb[1]), srgb_to_linear(srgb[2])];
    // 1a to 1d.
    let mut y = balanced(srgb, c, local.range);
    // 1e. Fusion of a gamma-corrected and a sharpened version.
    if let (true, Some(f)) = (c.fusion, &local.fusion) {
        for ch in 0..3 {
            let [first, second] = fusion_inputs(y[ch], f.blur[ch], c);
            y[ch] = (f.weight * first + (1.0 - f.weight) * second + f.offset[ch]).max(0.0);
        }
    }
    // Back to linear light, and blend with the original by `strength`.
    [0, 1, 2].map(|ch| {
        let corrected = if c.encoded { srgb_to_linear(y[ch].min(1.0)) } else { y[ch] };
        lin[ch] + (corrected - lin[ch]) * strength
    })
}

/// Steps 1a to 1c: working values, compensation, range step.
fn prepared(srgb: [f32; 3], c: &Correction, range: f32) -> [f32; 3] {
    // 1a. Working values: encoded or linear.
    let mut x = if c.encoded { srgb } else { srgb.map(srgb_to_linear) };
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
    x
}

/// The neutral picker: channel gains that turn the mean colour of a patch
/// grey at unchanged luminance. The patch is RGBA8 from the source image; its
/// colour is taken after the automatic correction, where the gains apply.
/// `None` when the patch is too dark or clipped to tell its colour.
pub fn neutral_gains(patch: &[u8], c: &Correction, strength: f32, local: &Local) -> Option<[f32; 3]> {
    let pixels = patch.as_chunks::<4>().0;
    if pixels.is_empty() {
        return None;
    }
    let mut mean = [0.0f32; 3];
    for p in pixels {
        let v = corrected_linear([p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0], c, strength, local);
        for ch in 0..3 {
            mean[ch] += v[ch] / pixels.len() as f32;
        }
    }
    let luma = LUMA[0] * mean[0] + LUMA[1] * mean[1] + LUMA[2] * mean[2];
    if luma < NEUTRAL_MIN_LUMA || mean.iter().any(|&m| m > NEUTRAL_MAX_VALUE) {
        return None;
    }
    Some(mean.map(|m| (luma / m.max(1e-6)).clamp(1.0 / NEUTRAL_GAIN_LIMIT, NEUTRAL_GAIN_LIMIT)))
}

/// One pixel: sRGB-encoded 0..1 in, sRGB-encoded 0..1 out. `range` is the
/// range-map value at the pixel; it is only used when `c.ranged` is set.
pub fn apply_pixel(srgb: [f32; 3], c: &Correction, a: &Adjustments, range: f32) -> [f32; 3] {
    apply_pixel_at(srgb, c, a, &Local::at(range))
}

/// As [`apply_pixel`], with everything the maps of the image hold at the pixel.
pub fn apply_pixel_at(srgb: [f32; 3], c: &Correction, a: &Adjustments, local: &Local) -> [f32; 3] {
    // 1. Automatic correction.
    let v = corrected_linear(srgb, c, a.strength, local);

    // 2. White balance: channel gains from temperature and tint, normalised
    // to keep brightness, times the gains of the neutral picker.
    let mut g = [(WB_RANGE * a.temperature).exp(), (-WB_RANGE * a.tint).exp(), (-WB_RANGE * a.temperature).exp()];
    let norm = LUMA[0] * g[0] + LUMA[1] * g[1] + LUMA[2] * g[2];
    for (x, n) in g.iter_mut().zip(a.neutral) {
        *x *= n / norm;
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
    apply_rgba8_with(rgba, width, c, a, range, None);
}

/// As [`apply_rgba8`], with the fusion maps corrections with `fusion` set need.
pub fn apply_rgba8_with(
    rgba: &mut [u8],
    width: usize,
    c: &Correction,
    a: &Adjustments,
    range: Option<&RangeMap>,
    fusion: Option<&FusionMaps>,
) {
    let width = width.max(1);
    let height = (rgba.len() / 4 / width).max(1);
    for (i, px) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let (u, v) = (((i % width) as f32 + 0.5) / width as f32, ((i / width) as f32 + 0.5) / height as f32);
        let local = Local {
            range: match range {
                Some(map) if c.ranged => map.sample(u, v),
                _ => 0.5,
            },
            fusion: fusion.filter(|_| c.fusion).map(|maps| maps.sample(u, v)),
        };
        let out = apply_pixel_at([px[0] as f32 / 255.0, px[1] as f32 / 255.0, px[2] as f32 / 255.0], c, a, &local);
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
    fn neutral_gains_turn_the_patch_grey() {
        let c = Correction::affine([[0.2, 0.8, 0.0, 0.0], [0.0, 1.1, 0.0, 0.0], [0.0, 0.0, 0.7, 0.0]]);
        let patch: Vec<u8> = [[40u8, 150, 190, 255], [50, 160, 180, 255], [45, 140, 200, 255]].concat();
        let neutral = neutral_gains(&patch, &c, 1.0, &Local::at(0.0)).expect("usable patch");
        let a = Adjustments { neutral, ..Default::default() };
        // The patch's mean comes out grey; single pixels keep their small differences.
        let mut mean = [0.0f32; 3];
        for p in patch.as_chunks::<4>().0 {
            let v = corrected_linear(
                [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0],
                &c,
                1.0,
                &Local::at(0.0),
            );
            for ch in 0..3 {
                mean[ch] += v[ch] * a.neutral[ch] / 3.0;
            }
        }
        assert!((mean[0] - mean[1]).abs() < 1e-4 && (mean[1] - mean[2]).abs() < 1e-4, "{mean:?}");
        // Luminance is kept.
        let before = corrected_linear([45.0 / 255.0, 150.0 / 255.0, 190.0 / 255.0], &c, 1.0, &Local::at(0.0));
        let luma = |v: [f32; 3]| LUMA[0] * v[0] + LUMA[1] * v[1] + LUMA[2] * v[2];
        assert!((luma(mean) / luma(before) - 1.0).abs() < 0.05);
    }

    #[test]
    fn neutral_gains_refuse_black_and_clipped_patches_and_are_bounded() {
        assert!(neutral_gains(&[0, 0, 0, 255], &Correction::IDENTITY, 1.0, &Local::at(0.0)).is_none());
        assert!(neutral_gains(&[255, 255, 255, 255], &Correction::IDENTITY, 1.0, &Local::at(0.0)).is_none());
        assert!(neutral_gains(&[], &Correction::IDENTITY, 1.0, &Local::at(0.0)).is_none());
        let g = neutral_gains(&[0, 120, 200, 255], &Correction::IDENTITY, 1.0, &Local::at(0.0)).unwrap();
        assert_eq!(g[0], NEUTRAL_GAIN_LIMIT);
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
