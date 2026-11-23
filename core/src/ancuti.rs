//! The white-balance stage of Ancuti, Ancuti, De Vleeschouwer and Bekaert,
//! "Color Balance and Fusion for Underwater Image Enhancement" (IEEE TIP
//! 2018), implemented from the paper:
//!
//! 1. Compensate red from green, per pixel:
//!    `r' = r + alpha * (mean_g - mean_r) * (1 - r) * g`, with `alpha = 1`.
//!    Bright or already red pixels get little, so lit areas do not turn red.
//! 2. Compensate blue the same way where blue is weaker than green (green,
//!    turbid water). The paper applies this "when blue is strongly
//!    attenuated"; here it scales with how far blue is below green.
//! 3. Grey-world balance: scale each channel to the common mean.
//!
//! The paper continues with a multi-scale fusion of a gamma-corrected and a
//! sharpened version of this result. That part needs spatial filtering and is
//! not implemented.
//!
//! Values are sRGB-encoded, as in the paper. The method always applies.

use crate::analysis::Analysis;
use crate::model::Correction;

const ALPHA: f32 = 1.0;

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
    let n = px.len() as f64;
    let mean = |f: &dyn Fn(&[f32; 3]) -> f32| (px.iter().map(|p| f(p) as f64).sum::<f64>() / n) as f32;
    let (mean_r, mean_g, mean_b) = (mean(&|p| p[0]), mean(&|p| p[1]), mean(&|p| p[2]));

    let comp = [ALPHA * (mean_g - mean_r).max(0.0), ALPHA * (mean_g - mean_b).max(0.0)];
    let after =
        [mean(&|p| p[0] + comp[0] * (1.0 - p[0]) * p[1]), mean_g, mean(&|p| p[2] + comp[1] * (1.0 - p[2]) * p[1])];
    if after.iter().any(|&m| m < 1e-4) {
        return Analysis::NEUTRAL; // a channel is empty even after compensation; nothing to balance
    }
    let grey = (after[0] + after[1] + after[2]) / 3.0;
    let mut m = Correction::IDENTITY.m;
    for ch in 0..3 {
        m[ch][ch] = grey / after[ch];
    }
    Analysis::plain(Correction { encoded: true, comp, ..Correction::affine(m) })
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
    fn balanced_frame_is_left_alone() {
        let a = analyze(&frame(&[[60, 60, 60], [180, 180, 180]]));
        assert_eq!(a.correction.comp, [0.0, 0.0]);
        for (ch, row) in a.correction.m.iter().enumerate() {
            assert!((row[ch] - 1.0).abs() < 1e-5);
        }
    }

    #[test]
    fn result_has_equal_channel_means() {
        let colours = [[10u8, 120, 170], [30, 200, 220], [5, 60, 110], [20, 150, 160]];
        let a = analyze(&frame(&colours));
        assert!(a.correction.comp[0] > 0.3 && a.correction.comp[1] == 0.0);
        // Grey world holds on the encoded values before the output transfer curve,
        // so check it there: compensated value times gain.
        let mut mean = [0.0f32; 3];
        for c in colours {
            let p = c.map(|v| v as f32 / 255.0);
            mean[0] += (p[0] + a.correction.comp[0] * (1.0 - p[0]) * p[1]) * a.correction.m[0][0];
            mean[1] += p[1] * a.correction.m[1][1];
            mean[2] += p[2] * a.correction.m[2][2];
        }
        assert!((mean[0] - mean[1]).abs() < 1e-3 && (mean[1] - mean[2]).abs() < 1e-3, "{mean:?}");
        // And the pipeline applies it: a blue-green pixel gains red.
        let out =
            apply_pixel([30.0 / 255.0, 200.0 / 255.0, 220.0 / 255.0], &a.correction, &Adjustments::default(), 0.0);
        assert!(out[0] > 0.4, "{out:?}");
    }

    #[test]
    fn green_water_gets_blue_compensation() {
        let a = analyze(&frame(&[[20, 150, 60], [40, 200, 90]]));
        assert!(a.correction.comp[1] > 0.1);
    }
}
