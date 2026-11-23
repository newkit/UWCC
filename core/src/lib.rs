//! UWCC core: analysis of underwater images and the reference implementation
//! of the colour correction.
//!
//! The correction is a per-pixel colour mapping with no spatial filtering.
//! `analysis` derives its parameters from a small copy of the image;
//! `reference` applies them on the CPU and is the ground truth for the GPU
//! shader in the web app, which must implement exactly the same maths.
//!
//! This crate has no browser dependencies apart from the thin `wasm` module.

pub mod analysis;
pub mod color;
pub mod model;
pub mod reference;
mod wasm;

pub use analysis::{analyze_linear, analyze_srgb8, Analysis};
pub use model::{Adjustments, Correction};
