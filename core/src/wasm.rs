//! JavaScript bindings. Flat float arrays keep the boundary trivial.

use wasm_bindgen::prelude::*;

use crate::fusion::FusionMaps;
use crate::model::{Adjustments, Algorithm, Correction, ADJUSTMENTS_LEN, CORRECTION_LEN};
use crate::range::RangeMap;
use crate::reference::Local;

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

/// Estimate the map the pipeline needs for `correction` (flat form) from an
/// RGBA8 sRGB image: its range map, or for haze removal its haze map.
/// Returns width and height in cells, then one value (0..1) per cell, rows
/// top to bottom.
#[wasm_bindgen]
pub fn range_map(rgba: &[u8], width: u32, height: u32, correction: &[f32]) -> Vec<f32> {
    let c = if correction.len() < CORRECTION_LEN { Correction::IDENTITY } else { Correction::from_array(correction) };
    RangeMap::for_correction(rgba, width as usize, height as usize, &c).to_flat()
}

/// The fusion maps `correction` (flat form) needs of an RGBA8 sRGB image:
/// width and height in cells, then two blocks of four values per cell
/// (offset and weight; blur and a zero), rows top to bottom.
#[wasm_bindgen]
pub fn fusion_maps(rgba: &[u8], width: u32, height: u32, correction: &[f32]) -> Vec<f32> {
    if correction.len() < CORRECTION_LEN {
        return Vec::new();
    }
    let c = Correction::from_array(correction);
    crate::fusion::maps(rgba, width as usize, height as usize, &c).to_flat()
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
/// `range` is a range map as returned by `range_map`, and `fusion` fusion
/// maps as returned by `fusion_maps`; either may be empty.
#[wasm_bindgen]
pub fn apply_reference(rgba: &mut [u8], width: u32, params: &[f32], range: &[f32], fusion: &[f32]) {
    if params.len() < CORRECTION_LEN + ADJUSTMENTS_LEN {
        return;
    }
    let c = Correction::from_array(&params[..CORRECTION_LEN]);
    let a = Adjustments::from_array(&params[CORRECTION_LEN..CORRECTION_LEN + ADJUSTMENTS_LEN]);
    let map = RangeMap::from_flat(range);
    let fusion = FusionMaps::from_flat(fusion);
    crate::reference::apply_rgba8_with(rgba, width as usize, &c, &a, map.as_ref(), fusion.as_ref());
}

/// The neutral picker: channel gains that turn an RGBA8 patch of the source
/// image grey. `correction` is in its flat form. The patch lies at `u`, `v`
/// (0..1 from the top left) of the image; `range` and `fusion` are the maps
/// in use, as for `apply_reference`. Returns three gains, or nothing when the
/// patch is too dark or clipped.
#[wasm_bindgen]
pub fn neutral_gains(
    patch: &[u8],
    correction: &[f32],
    strength: f32,
    u: f32,
    v: f32,
    range: &[f32],
    fusion: &[f32],
) -> Vec<f32> {
    if correction.len() < CORRECTION_LEN {
        return Vec::new();
    }
    let c = Correction::from_array(&correction[..CORRECTION_LEN]);
    let local = Local {
        range: RangeMap::from_flat(range).map_or(0.5, |map| map.sample(u, v)),
        fusion: FusionMaps::from_flat(fusion).map(|maps| maps.sample(u, v)),
    };
    crate::reference::neutral_gains(patch, &c, strength, &local).map(|g| g.to_vec()).unwrap_or_default()
}
