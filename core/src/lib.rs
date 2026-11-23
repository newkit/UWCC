//! UWCC core: analysis of underwater images and the reference implementation
//! of the colour correction.
//!
//! A correction is a set of parameters for one per-pixel pipeline
//! (`model::Correction`). Several methods can derive those parameters from a
//! small copy of the image: UWCC's own (`analysis`), and re-implementations
//! of published ones (`matrix`, `ancuti`, `seathru`, `udcp`). `reference` applies the
//! parameters on the CPU and is the ground truth for the GPU shader in the
//! web app, which must implement exactly the same maths.
//!
//! This crate has no browser dependencies apart from the thin `wasm` module.

pub mod analysis;
pub mod ancuti;
pub mod color;
pub mod fusion;
pub mod matrix;
pub mod model;
pub mod range;
pub mod reference;
pub mod seathru;
pub mod udcp;
mod wasm;

pub use analysis::{analyze_linear, analyze_srgb8, Analysis};
pub use fusion::FusionMaps;
pub use model::{Adjustments, Algorithm, Correction, ADJUSTMENTS_LEN, CORRECTION_LEN};
pub use range::RangeMap;

/// Analyse an RGBA8 sRGB image of `width` x `height` pixels with the chosen method.
pub fn analyze(algorithm: Algorithm, rgba: &[u8], width: usize, height: usize) -> Analysis {
    analyze_with_range(algorithm, rgba, width, height, None)
}

/// As [`analyze`], with a range map for the methods that take one from
/// outside (`Algorithm::SeaThruDepth`). Without a map those fall back to the
/// range estimated from the image's colours.
pub fn analyze_with_range(
    algorithm: Algorithm,
    rgba: &[u8],
    width: usize,
    height: usize,
    range: Option<&RangeMap>,
) -> Analysis {
    match algorithm {
        Algorithm::Uwcc => analysis::analyze_srgb8(rgba),
        Algorithm::Matrix => matrix::analyze(rgba),
        Algorithm::Ancuti => ancuti::analyze(rgba),
        Algorithm::SeaThru => seathru::analyze(rgba, width, height),
        Algorithm::UwccAlways => analysis::analyze_srgb8_always(rgba),
        Algorithm::AncutiFusion => ancuti::analyze_fusion(rgba, width, height),
        Algorithm::Udcp => udcp::analyze(rgba, width, height),
        Algorithm::SeaThruDepth => match range {
            Some(map) => seathru::analyze_with_range(rgba, width, height, map),
            None => seathru::analyze(rgba, width, height),
        },
    }
}
