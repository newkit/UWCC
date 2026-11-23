//! JavaScript bindings. Flat float arrays keep the boundary trivial.

use wasm_bindgen::prelude::*;

use crate::model::{Adjustments, Algorithm, Correction, ADJUSTMENTS_LEN, CORRECTION_LEN};
use crate::range::RangeMap;

/// Analyse an RGBA8 sRGB image (a small copy is enough, about 256 px on the
/// long side) with the method `algorithm` (see `Algorithm` for the ids).
///
/// Returns `CORRECTION_LEN` + 4 values: the correction in its flat form, then
/// red depletion (0..1), the share of the frame treated as scene rather than
/// open water (0..1), the green/blue ratio of open water, and the strength
/// (0..1) at which the correction was applied. Only UWCC's own method
/// measures the first three.
///
/// `range` is a range map in its flat form for the methods that take one
/// from outside, or empty.
#[wasm_bindgen]
pub fn analyze(rgba: &[u8], width: u32, height: u32, algorithm: u32, range: &[f32]) -> Vec<f32> {
    let algorithm = Algorithm::from_id(algorithm).unwrap_or(Algorithm::Uwcc);
    let map = RangeMap::from_flat(range);
    let a = crate::analyze_with_range(algorithm, rgba, width as usize, height as usize, map.as_ref());
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

/// Range map from a depth model's output (relative inverse depth, larger =
/// nearer, `width` x `height` values), in the same flat form as `range_map`.
#[wasm_bindgen]
pub fn range_from_disparity(disparity: &[f32], width: u32, height: u32) -> Vec<f32> {
    RangeMap::from_disparity(disparity, width as usize, height as usize).to_flat()
}

/// Apply the reference implementation in place to an RGBA8 buffer.
///
/// `params` holds the correction in its flat form (`CORRECTION_LEN` values),
/// then the adjustments in theirs (`ADJUSTMENTS_LEN` values).
/// `range` is a range map as returned by `range_map`, or empty.
#[wasm_bindgen]
pub fn apply_reference(rgba: &mut [u8], width: u32, params: &[f32], range: &[f32]) {
    if params.len() < CORRECTION_LEN + ADJUSTMENTS_LEN {
        return;
    }
    let c = Correction::from_array(&params[..CORRECTION_LEN]);
    let a = Adjustments::from_array(&params[CORRECTION_LEN..CORRECTION_LEN + ADJUSTMENTS_LEN]);
    let map = RangeMap::from_flat(range);
    crate::reference::apply_rgba8(rgba, width as usize, &c, &a, map.as_ref());
}

/// The neutral picker: channel gains that turn an RGBA8 patch of the source
/// image grey. `correction` is in its flat form; `range` is the range-map
/// value at the patch. Returns three gains, or nothing when the patch is too
/// dark or clipped.
#[wasm_bindgen]
pub fn neutral_gains(patch: &[u8], correction: &[f32], strength: f32, range: f32) -> Vec<f32> {
    if correction.len() < CORRECTION_LEN {
        return Vec::new();
    }
    let c = Correction::from_array(&correction[..CORRECTION_LEN]);
    crate::reference::neutral_gains(patch, &c, strength, range).map(|g| g.to_vec()).unwrap_or_default()
}
