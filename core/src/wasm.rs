//! JavaScript bindings. Flat float arrays keep the boundary trivial.

use wasm_bindgen::prelude::*;

use crate::model::{Adjustments, Correction};

/// Analyse an RGBA8 sRGB image (a small copy is enough, about 256 px on the
/// long side).
///
/// Returns 16 values: the correction matrix (12, row-major, rows are
/// `[from_r, from_g, from_b, offset]`), then red depletion (0..1), the share
/// of the frame treated as scene rather than open water (0..1), the
/// green/blue ratio of open water, and the strength (0..1) at which the
/// correction was applied.
#[wasm_bindgen]
pub fn analyze(rgba: &[u8]) -> Vec<f32> {
    let a = crate::analysis::analyze_srgb8(rgba);
    let mut out = a.correction.to_array().to_vec();
    out.extend_from_slice(&[a.depletion, a.scene_fraction, a.water_ratio, a.strength]);
    out
}

/// Apply the reference implementation in place to an RGBA8 buffer.
///
/// `params` holds 18 values: the correction matrix (12), then strength,
/// temperature, tint, exposure, contrast, saturation.
#[wasm_bindgen]
pub fn apply_reference(rgba: &mut [u8], params: &[f32]) {
    if params.len() < 18 {
        return;
    }
    let c = Correction::from_array(&params[..12]);
    let a = Adjustments::from_array(&params[12..18]);
    crate::reference::apply_rgba8(rgba, &c, &a);
}
