//! UDCP: Drews Jr, do Nascimento, Moraes, Botelho and Campos, "Transmission
//! Estimation in Underwater Single Images" (ICCV Workshops 2013), implemented
//! from the paper.
//!
//! The haze model, per colour channel:
//!
//! ```text
//! I = J * t + A * (1 - t)
//! ```
//!
//! `I` is the captured image, `J` the scene without haze, `A` the colour of
//! the water (the "airlight" of the dehazing literature) and `t` the
//! transmission. The underwater dark channel prior: in a haze-free image
//! most small patches hold a pixel that is nearly black in green or blue.
//! Red is left out, because water absorbs it whether or not there is haze.
//! Hence
//!
//! ```text
//! t(x) = 1 - omega * min over the patch around x of min(I_g / A_g, I_b / A_b)
//! J    = (I - A) / max(t, t0) + A
//! ```
//!
//! with `A` taken where the dark channel is brightest.
//!
//! In UWCC's pipeline the map of the image holds the haze `d = 1 - t`, the
//! backscatter table is `A * min(d, 1 - t0)` and the gain table
//! `1 / max(1 - d, t0)`, which is the same formula rearranged.
//!
//! Differences from the paper:
//!
//! - The transmission map is computed on a small copy of the image (a grid
//!   of at most `MAP_MAX` cells, the minimum taken over 3 x 3 cells) and
//!   smoothed with a box blur. The paper works at full resolution and
//!   refines the map by image matting. Edges of the map are therefore soft
//!   and can leave a faint halo around near objects in front of open water.
//! - The water colour is the mean over the brightest 0.1 % of the dark
//!   channel, not the single brightest pixel there, to be robust against noise.
//! - The gain `1 / t` is tabulated at `RANGE_NODES` points and interpolated
//!   (up to about 6 % off between the last points).
//!
//! The method removes haze and nothing else: the colour cast stays, as in
//! the paper. No code is taken from any implementation.

use crate::analysis::{percentile, Analysis};
use crate::model::{Correction, RANGE_NODES};
use crate::range::RangeMap;

/// Share of the haze that is removed; the paper keeps a little for a natural look.
const OMEGA: f32 = 0.95;
/// Lower bound on the transmission.
const T0: f32 = 0.1;
/// The water colour is taken from this share of the cells, those with the brightest dark channel.
const AIRLIGHT_FRACTION: f32 = 0.001;
/// The water colour is not allowed below this, so that the division stays meaningful.
const MIN_AIRLIGHT: f32 = 0.05;
/// The map is at most this many cells on its longer side.
pub const MAP_MAX: usize = 96;

/// Per grid cell: the minimum of min(green / norm[0], blue / norm[1]) over
/// the cell's pixels and its eight neighbours (the dark channel), and the
/// cell's mean colour. Encoded values, 0..1.
fn dark_channel(rgba: &[u8], width: usize, height: usize, norm: [f32; 2]) -> (usize, usize, Vec<f32>, Vec<[f32; 3]>) {
    let scale = (MAP_MAX as f32 / width.max(height) as f32).min(1.0);
    let gw = ((width as f32 * scale).round() as usize).max(1);
    let gh = ((height as f32 * scale).round() as usize).max(1);
    let mut low = vec![f32::MAX; gw * gh];
    let mut sum = vec![[0.0f32; 3]; gw * gh];
    let mut count = vec![0u32; gw * gh];
    for y in 0..height {
        let gy = y * gh / height;
        for x in 0..width {
            let cell = gy * gw + x * gw / width;
            let p = &rgba[(y * width + x) * 4..];
            let (r, g, b) = (p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0);
            low[cell] = low[cell].min((g / norm[0]).min(b / norm[1]));
            for (s, v) in sum[cell].iter_mut().zip([r, g, b]) {
                *s += v;
            }
            count[cell] += 1;
        }
    }
    let mut dark = vec![0.0f32; gw * gh];
    for y in 0..gh {
        for x in 0..gw {
            let mut m = f32::MAX;
            for yy in y.saturating_sub(1)..(y + 2).min(gh) {
                for xx in x.saturating_sub(1)..(x + 2).min(gw) {
                    m = m.min(low[yy * gw + xx]);
                }
            }
            dark[y * gw + x] = if m == f32::MAX { 0.0 } else { m };
        }
    }
    let mean = sum.iter().zip(&count).map(|(s, &n)| s.map(|v| v / n.max(1) as f32)).collect();
    (gw, gh, dark, mean)
}

/// The haze map: `1 - t` per cell, for water colour `airlight` (green, blue).
pub fn haze_map(rgba: &[u8], width: usize, height: usize, airlight: [f32; 2]) -> RangeMap {
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return RangeMap { width: 1, height: 1, data: vec![0.0] };
    }
    let norm = airlight.map(|a| a.max(MIN_AIRLIGHT));
    let (gw, gh, dark, _) = dark_channel(rgba, width, height, norm);
    // One 3 x 3 box blur, edges repeated, in place of the paper's matting.
    let mut data = vec![0.0f32; gw * gh];
    for y in 0..gh {
        for x in 0..gw {
            let mut acc = 0.0;
            for dy in [-1i32, 0, 1] {
                for dx in [-1i32, 0, 1] {
                    let yy = (y as i32 + dy).clamp(0, gh as i32 - 1) as usize;
                    let xx = (x as i32 + dx).clamp(0, gw as i32 - 1) as usize;
                    acc += dark[yy * gw + xx];
                }
            }
            data[y * gw + x] = (OMEGA * acc / 9.0).clamp(0.0, 1.0);
        }
    }
    RangeMap { width: gw, height: gh, data }
}

/// The water colour (red, green, blue; encoded): mean over the cells where the dark channel is brightest.
fn airlight(rgba: &[u8], width: usize, height: usize) -> [f32; 3] {
    let (_, _, dark, mean) = dark_channel(rgba, width, height, [1.0, 1.0]);
    let threshold = percentile(&dark, 100.0 * (1.0 - AIRLIGHT_FRACTION));
    let mut sum = [0.0f32; 3];
    let mut n = 0.0f32;
    for (d, colour) in dark.iter().zip(&mean) {
        if *d >= threshold {
            for ch in 0..3 {
                sum[ch] += colour[ch];
            }
            n += 1.0;
        }
    }
    sum.map(|s| s / n.max(1.0))
}

/// Analyse an RGBA8 sRGB image.
pub fn analyze(rgba: &[u8], width: usize, height: usize) -> Analysis {
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return Analysis::NEUTRAL;
    }
    let a = airlight(rgba, width, height);
    let mut backscatter = [[0.0f32; RANGE_NODES]; 3];
    let mut log_gain = [[0.0f32; RANGE_NODES]; 3];
    for node in 0..RANGE_NODES {
        let d = node as f32 / (RANGE_NODES - 1) as f32;
        for ch in 0..3 {
            backscatter[ch][node] = a[ch] * d.min(1.0 - T0);
            log_gain[ch][node] = -(1.0 - d).max(T0).ln();
        }
    }
    Analysis::plain(Correction {
        encoded: true,
        ranged: true,
        haze: true,
        airlight: [a[1].max(MIN_AIRLIGHT), a[2].max(MIN_AIRLIGHT)],
        backscatter,
        log_gain,
        ..Correction::IDENTITY
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Adjustments;
    use crate::reference::apply_rgba8;

    /// A textured scene (every patch has dark and bright pixels) seen through
    /// haze that thickens from left to right, ending in a strip of plain water.
    fn hazy(w: usize, h: usize, water: [f32; 3]) -> (Vec<u8>, Vec<[f32; 3]>) {
        let mut rgba = Vec::with_capacity(w * h * 4);
        let mut scene = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                let bright = (x + y) % 2 == 0;
                let j = if bright { [0.5, 0.7, 0.6] } else { [0.05, 0.02, 0.03] };
                let t = if x >= w * 9 / 10 { 0.0 } else { 1.0 - 0.7 * (x * 10 / w) as f32 / 9.0 };
                scene.push(j);
                for ch in 0..3 {
                    rgba.push(((j[ch] * t + water[ch] * (1.0 - t)) * 255.0 + 0.5) as u8);
                }
                rgba.push(255);
            }
        }
        (rgba, scene)
    }

    #[test]
    fn finds_the_water_colour() {
        let water = [0.1, 0.55, 0.8];
        let (rgba, _) = hazy(200, 100, water);
        let a = airlight(&rgba, 200, 100);
        for ch in 0..3 {
            assert!((a[ch] - water[ch]).abs() < 0.02, "{a:?}");
        }
    }

    #[test]
    fn removes_synthetic_haze() {
        let (w, h) = (200, 100);
        let (rgba, scene) = hazy(w, h, [0.1, 0.55, 0.8]);
        let analysis = analyze(&rgba, w, h);
        let c = analysis.correction;
        assert!(c.ranged && c.haze && c.encoded);
        let map = RangeMap::for_correction(&rgba, w, h, &c);
        let mut out = rgba.clone();
        apply_rgba8(&mut out, w, &c, &Adjustments::default(), Some(&map));
        // Mean error against the haze-free scene, in the hazy middle of the frame
        // (away from the strip of water and from the borders between haze levels).
        let error = |buf: &[u8]| {
            let (mut sum, mut n) = (0.0f32, 0.0f32);
            for y in 4..h - 4 {
                for x in (w / 2 + 4)..(w * 6 / 10 - 4) {
                    for ch in 0..3 {
                        sum += (buf[(y * w + x) * 4 + ch] as f32 / 255.0 - scene[y * w + x][ch]).abs();
                        n += 1.0;
                    }
                }
            }
            sum / n
        };
        let (before, after) = (error(&rgba), error(&out));
        assert!(after < before * 0.35, "before {before}, after {after}");
    }

    #[test]
    fn haze_free_image_is_left_nearly_alone() {
        // Every patch has black pixels: the dark channel is zero, so nothing is removed.
        let (w, h) = (64, 64);
        let rgba: Vec<u8> = (0..w * h)
            .flat_map(|i| if (i % w + i / w) % 2 == 0 { [200, 180, 160, 255] } else { [0, 0, 0, 255] })
            .collect();
        let c = analyze(&rgba, w, h).correction;
        let map = RangeMap::for_correction(&rgba, w, h, &c);
        let mut out = rgba.clone();
        apply_rgba8(&mut out, w, &c, &Adjustments::default(), Some(&map));
        assert!(out.iter().zip(&rgba).all(|(a, b)| a.abs_diff(*b) <= 1));
    }

    #[test]
    fn empty_input_is_neutral() {
        assert_eq!(analyze(&[], 0, 0).correction, Correction::IDENTITY);
    }
}
