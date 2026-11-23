//! JavaScript bindings. Flat float arrays keep the boundary trivial.

use wasm_bindgen::prelude::*;

use crate::model::{Adjustments, Algorithm, Correction, CORRECTION_LEN};
use crate::range::RangeMap;

/// Analyse an RGBA8 sRGB image (a small copy is enough, about 256 px on the
/// long side) with the method `algorithm` (see `Algorithm` for the ids).
///
/// Returns `CORRECTION_LEN` + 4 values: the correction in its flat form, then
/// red depletion (0..1), the share of the frame treated as scene rather than
/// open water (0..1), the green/blue ratio of open water, and the strength
/// (0..1) at which the correction was applied. Only UWCC's own method
/// measures the first three.
#[wasm_bindgen]
pub fn analyze(rgba: &[u8], width: u32, height: u32, algorithm: u32) -> Vec<f32> {
    let algorithm = Algorithm::from_id(algorithm).unwrap_or(Algorithm::Uwcc);
    let a = crate::analyze(algorithm, rgba, width as usize, height as usize);
    let mut out = a.correction.to_array().to_vec();
    out.extend_from_slice(&[a.depletion, a.scene_fraction, a.water_ratio, a.strength]);
    out
}

/// Estimate the range map of an RGBA8 sRGB image. Returns its width and
/// height in cells, then one value (0 near .. 1 far) per cell, rows top to bottom.
#[wasm_bindgen]
pub fn range_map(rgba: &[u8], width: u32, height: u32) -> Vec<f32> {
    RangeMap::from_srgb8(rgba, width as usize, height as usize).to_flat()
}

/// Apply the reference implementation in place to an RGBA8 buffer.
///
/// `params` holds the correction in its flat form (`CORRECTION_LEN` values),
/// then strength, temperature, tint, exposure, contrast, saturation.
/// `range` is a range map as returned by `range_map`, or empty.
#[wasm_bindgen]
pub fn apply_reference(rgba: &mut [u8], width: u32, params: &[f32], range: &[f32]) {
    if params.len() < CORRECTION_LEN + 6 {
        return;
    }
    let c = Correction::from_array(&params[..CORRECTION_LEN]);
    let a = Adjustments::from_array(&params[CORRECTION_LEN..CORRECTION_LEN + 6]);
    let map = RangeMap::from_flat(range);
    crate::reference::apply_rgba8(rgba, width as usize, &c, &a, map.as_ref());
}
