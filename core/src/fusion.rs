//! The fusion stage of Ancuti, Ancuti, De Vleeschouwer and Bekaert, "Color
//! Balance and Fusion for Underwater Image Enhancement" (IEEE TIP 2018),
//! implemented from the paper (sections IV.A to IV.D).
//!
//! Two inputs are derived from the white-balanced image `I` (`ancuti`):
//!
//! - `I1`, gamma-corrected: `I ^ gamma`, for global contrast;
//! - `I2`, sharpened by normalised unsharp masking, eq. 6:
//!   `(I + N{I - G * I}) / 2`, where `G * I` is `I` blurred and `N` stretches
//!   its argument linearly to the full range.
//!
//! Each input gets a weight map, the sum of three measures: Laplacian
//! contrast (absolute Laplacian of the luminance), saliency (Achanta et al.
//! 2009: distance in Lab between the image's mean colour and its slightly
//! blurred version) and saturation (eq. 7: deviation of the channels from
//! the luminance). The weights are normalised per pixel as
//! `(W_k + delta) / (W_1 + W_2 + 2 delta)` with `delta = 0.1`. The inputs are
//! blended level by level over Laplacian pyramids, with Gaussian pyramids of
//! the weights (eq. 10), which avoids the halos of blending at one scale.
//!
//! How it fits UWCC's per-pixel pipeline, and where that departs from the paper:
//!
//! - **The multi-scale fusion runs on a small copy of the image** (at most
//!   `FUSION_MAX` cells on the longer side), exactly as described above. Its
//!   result is handed to the pipeline as maps: the weight of the first
//!   input, the blurred image, and an offset. At full resolution the
//!   pipeline computes both inputs per pixel and blends them with the
//!   interpolated weight, then adds the offset, which is the difference
//!   between the multi-scale result and that plain blend on the small copy.
//!   So everything down to the scale of the copy's cells is the paper's
//!   multi-scale fusion; detail finer than that is blended with smooth
//!   weights, not with weights that follow it. This keeps the method inside
//!   one per-pixel pass, tiled export and per-frame video included.
//! - For the same reason the blur of the unsharp mask has the scale of the
//!   copy (about half a percent of the image side), not of a few pixels.
//!
//! Choices the paper leaves open:
//!
//! - `gamma` is not given; `GAMMA` is UWCC's choice.
//! - The blur `G` is not specified; here two passes of a 5-tap binomial.
//! - `N` is taken between the 0.5th and 99.5th percentile, so that a few
//!   extreme pixels do not flatten the rest.
//! - The scale of the three weight measures relative to each other is not
//!   given. Here all are on values in 0..1, with Lab distances divided by 100.
//! - Pyramid depth: the paper lets the smallest level reach "a few tens of
//!   pixels"; here levels are added while the shorter side stays at or above
//!   `MIN_LEVEL_SIDE`.

use crate::analysis::percentile;
use crate::color::{srgb_to_linear, LUMA};
use crate::model::Correction;
use crate::reference::{balanced, fusion_inputs};

/// The fusion maps are at most this many cells on their longer side.
pub const FUSION_MAX: usize = 256;
/// Exponent of the gamma-corrected input.
pub const GAMMA: f32 = 1.5;
/// Regularisation of the normalised weights (the paper's delta).
const DELTA: f32 = 0.1;
/// Percentiles between which the detail of the sharpened input is stretched.
const STRETCH_PERCENTILES: (f32, f32) = (0.5, 99.5);
/// The coarsest pyramid level has at least this many cells on its shorter side.
const MIN_LEVEL_SIDE: usize = 10;
/// Lab distances are divided by this for the saliency weight.
const LAB_SCALE: f32 = 100.0;

/// The fusion maps at one position.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FusionSample {
    /// Added after blending: what multi-scale fusion gives beyond the plain blend.
    pub offset: [f32; 3],
    /// Weight of the gamma-corrected input; the sharpened one gets the rest.
    pub weight: f32,
    /// The balanced image, blurred: the low-frequency part the sharpened input is measured against.
    pub blur: [f32; 3],
}

/// Fusion maps of an image, one sample per grid cell, rows top to bottom.
#[derive(Clone, Debug, PartialEq)]
pub struct FusionMaps {
    pub width: usize,
    pub height: usize,
    pub cells: Vec<FusionSample>,
}

type Plane = Vec<f32>;

impl FusionMaps {
    /// Bilinear lookup at image position `u`, `v` (0..1, origin top left);
    /// the same arithmetic as `RangeMap::sample` and as the shader.
    pub fn sample(&self, u: f32, v: f32) -> FusionSample {
        let x = (u * self.width as f32 - 0.5).clamp(0.0, (self.width - 1) as f32);
        let y = (v * self.height as f32 - 0.5).clamp(0.0, (self.height - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.width - 1), (y0 + 1).min(self.height - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let at = |xx: usize, yy: usize| &self.cells[yy * self.width + xx];
        let mix = |f: &dyn Fn(&FusionSample) -> f32| {
            let top = f(at(x0, y0)) + (f(at(x1, y0)) - f(at(x0, y0))) * fx;
            let bottom = f(at(x0, y1)) + (f(at(x1, y1)) - f(at(x0, y1))) * fx;
            top + (bottom - top) * fy
        };
        FusionSample {
            offset: [0, 1, 2].map(|ch| mix(&|s| s.offset[ch])),
            weight: mix(&|s| s.weight),
            blur: [0, 1, 2].map(|ch| mix(&|s| s.blur[ch])),
        }
    }

    /// Flat form for the WASM boundary: width, height, then per cell offset
    /// (3) and weight, then per cell blur (3) and a zero: two RGBA float textures.
    pub fn to_flat(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.cells.len() * 8 + 2);
        out.push(self.width as f32);
        out.push(self.height as f32);
        for c in &self.cells {
            out.extend_from_slice(&[c.offset[0], c.offset[1], c.offset[2], c.weight]);
        }
        for c in &self.cells {
            out.extend_from_slice(&[c.blur[0], c.blur[1], c.blur[2], 0.0]);
        }
        out
    }

    pub fn from_flat(flat: &[f32]) -> Option<FusionMaps> {
        let (width, height) = (*flat.first()? as usize, *flat.get(1)? as usize);
        let n = width * height;
        if n == 0 || flat.len() != n * 8 + 2 {
            return None;
        }
        let (a, b) = flat[2..].split_at(n * 4);
        let cells = (0..n)
            .map(|i| FusionSample {
                offset: [a[i * 4], a[i * 4 + 1], a[i * 4 + 2]],
                weight: a[i * 4 + 3],
                blur: [b[i * 4], b[i * 4 + 1], b[i * 4 + 2]],
            })
            .collect();
        Some(FusionMaps { width, height, cells })
    }
}

/// The white-balanced image on the map grid: the source averaged per cell,
/// then steps 1 to 4 of the correction, clamped to 0..1. One plane per channel.
fn balanced_copy(rgba: &[u8], width: usize, height: usize, c: &Correction) -> (usize, usize, [Plane; 3]) {
    let scale = (FUSION_MAX as f32 / width.max(height) as f32).min(1.0);
    let gw = ((width as f32 * scale).round() as usize).max(1);
    let gh = ((height as f32 * scale).round() as usize).max(1);
    let mut sum = vec![[0.0f32; 3]; gw * gh];
    let mut count = vec![0u32; gw * gh];
    for y in 0..height {
        let gy = y * gh / height;
        for x in 0..width {
            let cell = gy * gw + x * gw / width;
            let p = &rgba[(y * width + x) * 4..];
            for ch in 0..3 {
                sum[cell][ch] += p[ch] as f32 / 255.0;
            }
            count[cell] += 1;
        }
    }
    let mut planes = [vec![0.0; gw * gh], vec![0.0; gw * gh], vec![0.0; gw * gh]];
    for (i, (s, &n)) in sum.iter().zip(&count).enumerate() {
        let y = balanced(s.map(|v| v / n.max(1) as f32), c, 0.5);
        for ch in 0..3 {
            planes[ch][i] = y[ch].clamp(0.0, 1.0);
        }
    }
    (gw, gh, planes)
}

/// One pass of the separable 5-tap binomial filter, edges repeated.
fn binomial(src: &[f32], w: usize, h: usize) -> Plane {
    const K: [f32; 5] = [1.0 / 16.0, 4.0 / 16.0, 6.0 / 16.0, 4.0 / 16.0, 1.0 / 16.0];
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (k, weight) in K.iter().enumerate() {
                let xx = (x as i32 + k as i32 - 2).clamp(0, w as i32 - 1) as usize;
                acc += weight * src[y * w + xx];
            }
            tmp[y * w + x] = acc;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (k, weight) in K.iter().enumerate() {
                let yy = (y as i32 + k as i32 - 2).clamp(0, h as i32 - 1) as usize;
                acc += weight * tmp[yy * w + x];
            }
            out[y * w + x] = acc;
        }
    }
    out
}

/// The blur `G` of the unsharp mask.
fn unsharp_blur(src: &[f32], w: usize, h: usize) -> Plane {
    binomial(&binomial(src, w, h), w, h)
}

/// Pyramid step down: low-pass, then every second cell.
fn reduce(src: &[f32], w: usize, h: usize) -> (Plane, usize, usize) {
    let low = binomial(src, w, h);
    let (w2, h2) = (w.div_ceil(2), h.div_ceil(2));
    let mut out = Vec::with_capacity(w2 * h2);
    for y in 0..h2 {
        for x in 0..w2 {
            out.push(low[(y * 2) * w + x * 2]);
        }
    }
    (out, w2, h2)
}

/// Pyramid step up: bilinear interpolation back to `w` x `h`.
fn expand(src: &[f32], w2: usize, h2: usize, w: usize, h: usize) -> Plane {
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        let fy = y as f32 / 2.0;
        let (y0, ty) = ((fy.floor() as usize).min(h2 - 1), fy.fract());
        let y1 = (y0 + 1).min(h2 - 1);
        for x in 0..w {
            let fx = x as f32 / 2.0;
            let (x0, tx) = ((fx.floor() as usize).min(w2 - 1), fx.fract());
            let x1 = (x0 + 1).min(w2 - 1);
            let top = src[y0 * w2 + x0] + (src[y0 * w2 + x1] - src[y0 * w2 + x0]) * tx;
            let bottom = src[y1 * w2 + x0] + (src[y1 * w2 + x1] - src[y1 * w2 + x0]) * tx;
            out.push(top + (bottom - top) * ty);
        }
    }
    out
}

/// Shift and scale that stretch the detail `image - blur` to 0..1 (the paper's `N`).
fn stretch(image: &[Plane; 3], blurred: &[Plane; 3]) -> [f32; 2] {
    let detail: Vec<f32> = (0..3).flat_map(|ch| image[ch].iter().zip(&blurred[ch]).map(|(i, b)| i - b)).collect();
    let lo = percentile(&detail, STRETCH_PERCENTILES.0);
    let hi = percentile(&detail, STRETCH_PERCENTILES.1);
    if hi - lo < 1e-4 {
        // No detail to speak of: the sharpened input becomes the image itself.
        return [-0.5, 1.0];
    }
    [lo, 1.0 / (hi - lo)]
}

/// The parameters of the sharpened input for this image under `c` (white balance only).
pub fn sharpen_parameters(rgba: &[u8], width: usize, height: usize, c: &Correction) -> [f32; 2] {
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return [0.0, 1.0];
    }
    let (gw, gh, image) = balanced_copy(rgba, width, height, c);
    let blurred = [0, 1, 2].map(|ch| unsharp_blur(&image[ch], gw, gh));
    stretch(&image, &blurred)
}

/// CIE L*a*b* of an sRGB-encoded colour (D65).
fn lab(rgb: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = rgb.map(srgb_to_linear);
    let xyz = [
        (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505,
        0.2126 * r + 0.7152 * g + 0.0722 * b,
        (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089,
    ];
    let f = xyz.map(|t| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 });
    [116.0 * f[1] - 16.0, 500.0 * (f[0] - f[1]), 200.0 * (f[1] - f[2])]
}

/// The aggregated weight map of one input: Laplacian contrast + saliency + saturation.
fn weight(input: &[Plane; 3], w: usize, h: usize) -> Plane {
    let n = w * h;
    let luma: Plane = (0..n).map(|i| (0..3).map(|ch| LUMA[ch] * input[ch][i]).sum()).collect();
    // Saliency: distance in Lab between the mean colour and the slightly blurred image.
    let soft = [0, 1, 2].map(|ch| binomial(&input[ch], w, h));
    let labs: Vec<[f32; 3]> = (0..n).map(|i| lab([soft[0][i], soft[1][i], soft[2][i]])).collect();
    let mut mean = [0.0f32; 3];
    for i in 0..n {
        let l = lab([input[0][i], input[1][i], input[2][i]]);
        for ch in 0..3 {
            mean[ch] += l[ch] / n as f32;
        }
    }
    (0..n)
        .map(|i| {
            let (x, y) = (i % w, i / w);
            let at = |dx: i32, dy: i32| {
                let xx = (x as i32 + dx).clamp(0, w as i32 - 1) as usize;
                let yy = (y as i32 + dy).clamp(0, h as i32 - 1) as usize;
                luma[yy * w + xx]
            };
            let contrast = (at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1) - 4.0 * luma[i]).abs();
            let saliency = (0..3).map(|ch| (labs[i][ch] - mean[ch]).powi(2)).sum::<f32>().sqrt() / LAB_SCALE;
            let saturation = ((0..3).map(|ch| (input[ch][i] - luma[i]).powi(2)).sum::<f32>() / 3.0).sqrt();
            contrast + saliency + saturation
        })
        .collect()
}

/// Number of pyramid levels for a grid of this size, the base included.
fn levels(w: usize, h: usize) -> usize {
    let (mut side, mut n) = (w.min(h), 1);
    while side.div_ceil(2) >= MIN_LEVEL_SIDE {
        side = side.div_ceil(2);
        n += 1;
    }
    n
}

/// Multi-scale fusion of two single-channel inputs with the first one's normalised weight (eq. 10).
fn fuse(first: &[f32], second: &[f32], weight: &[f32], w: usize, h: usize, levels: usize) -> Plane {
    if levels <= 1 {
        return (0..w * h).map(|i| weight[i] * first[i] + (1.0 - weight[i]) * second[i]).collect();
    }
    let (a, w2, h2) = reduce(first, w, h);
    let (b, _, _) = reduce(second, w, h);
    let (g, _, _) = reduce(weight, w, h);
    let coarse = expand(&fuse(&a, &b, &g, w2, h2, levels - 1), w2, h2, w, h);
    let (up_a, up_b) = (expand(&a, w2, h2, w, h), expand(&b, w2, h2, w, h));
    (0..w * h)
        .map(|i| coarse[i] + weight[i] * (first[i] - up_a[i]) + (1.0 - weight[i]) * (second[i] - up_b[i]))
        .collect()
}

/// The fusion maps of an RGBA8 sRGB image for correction `c`.
pub fn maps(rgba: &[u8], width: usize, height: usize, c: &Correction) -> FusionMaps {
    let neutral = FusionSample { offset: [0.0; 3], weight: 1.0, blur: [0.0; 3] };
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return FusionMaps { width: 1, height: 1, cells: vec![neutral] };
    }
    let (gw, gh, image) = balanced_copy(rgba, width, height, c);
    let n = gw * gh;
    let blurred = [0, 1, 2].map(|ch| unsharp_blur(&image[ch], gw, gh));
    let mut first = [vec![0.0; n], vec![0.0; n], vec![0.0; n]];
    let mut second = [vec![0.0; n], vec![0.0; n], vec![0.0; n]];
    for ch in 0..3 {
        for i in 0..n {
            let [a, b] = fusion_inputs(image[ch][i], blurred[ch][i], c);
            first[ch][i] = a;
            second[ch][i] = b;
        }
    }
    let (wa, wb) = (weight(&first, gw, gh), weight(&second, gw, gh));
    let normalised: Plane = (0..n).map(|i| (wa[i] + DELTA) / (wa[i] + wb[i] + 2.0 * DELTA)).collect();
    let depth = levels(gw, gh);
    let fused = [0, 1, 2].map(|ch| fuse(&first[ch], &second[ch], &normalised, gw, gh, depth));
    let cells = (0..n)
        .map(|i| FusionSample {
            offset: [0, 1, 2]
                .map(|ch| fused[ch][i] - (normalised[i] * first[ch][i] + (1.0 - normalised[i]) * second[ch][i])),
            weight: normalised[i],
            blur: [0, 1, 2].map(|ch| blurred[ch][i]),
        })
        .collect();
    FusionMaps { width: gw, height: gh, cells }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Adjustments;
    use crate::reference::apply_rgba8_with;

    fn fusion_only() -> Correction {
        Correction { encoded: true, fusion: true, gamma: GAMMA, ..Correction::IDENTITY }
    }

    fn textured(w: usize, h: usize) -> Vec<u8> {
        (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                let v = 60 + ((x * 7 + y * 13) % 120) as u8;
                [v, (v / 2 + (x % 50) as u8), 200 - v, 255]
            })
            .collect()
    }

    #[test]
    fn pyramid_of_equal_inputs_returns_the_input() {
        // Whatever the weights, fusing an image with itself must give it back.
        let (w, h) = (90, 61);
        let image: Plane = (0..w * h).map(|i| ((i * 37) % 101) as f32 / 100.0).collect();
        let weight: Plane = (0..w * h).map(|i| ((i * 11) % 7) as f32 / 6.0).collect();
        let out = fuse(&image, &image, &weight, w, h, levels(w, h));
        assert!(levels(w, h) >= 3);
        assert!(out.iter().zip(&image).all(|(a, b)| (a - b).abs() < 1e-4));
    }

    #[test]
    fn weights_stay_between_the_regularised_bounds() {
        let (w, h) = (128, 96);
        let rgba = textured(w, h);
        let mut c = fusion_only();
        c.sharpen = sharpen_parameters(&rgba, w, h, &c);
        let m = maps(&rgba, w, h, &c);
        assert_eq!((m.width, m.height), (w, h));
        assert!(m.cells.iter().all(|s| s.weight > 0.0 && s.weight < 1.0));
        assert!(m.cells.iter().all(|s| s.offset.iter().all(|v| v.is_finite() && v.abs() < 1.0)));
    }

    #[test]
    fn pipeline_reproduces_the_multi_scale_result_on_the_map_grid() {
        // On an image of the maps' own size, the per-pixel step plus offset is the multi-scale fusion itself.
        let (w, h) = (96, 64);
        let rgba = textured(w, h);
        let mut c = fusion_only();
        c.sharpen = sharpen_parameters(&rgba, w, h, &c);
        let m = maps(&rgba, w, h, &c);
        let (_, _, image) = balanced_copy(&rgba, w, h, &c);
        let blurred = [0, 1, 2].map(|ch| unsharp_blur(&image[ch], w, h));
        let mut out = rgba.clone();
        apply_rgba8_with(&mut out, w, &c, &Adjustments::default(), None, Some(&m));
        for ch in 0..3 {
            let (a, b): (Plane, Plane) = (0..w * h)
                .map(|i| {
                    let [a, b] = fusion_inputs(image[ch][i], blurred[ch][i], &c);
                    (a, b)
                })
                .unzip();
            let weight: Plane = m.cells.iter().map(|s| s.weight).collect();
            let expected = fuse(&a, &b, &weight, w, h, levels(w, h));
            for i in 0..w * h {
                let got = out[i * 4 + ch] as f32 / 255.0;
                assert!((got - expected[i].clamp(0.0, 1.0)).abs() < 1.5 / 255.0, "pixel {i} channel {ch}");
            }
        }
    }

    #[test]
    fn flat_form_round_trips() {
        let rgba = textured(40, 30);
        let m = maps(&rgba, 40, 30, &fusion_only());
        assert_eq!(FusionMaps::from_flat(&m.to_flat()), Some(m));
        assert_eq!(FusionMaps::from_flat(&[2.0, 2.0, 0.0]), None);
    }

    #[test]
    fn sharpened_input_has_more_local_contrast() {
        let c = Correction { sharpen: [-0.1, 5.0], ..fusion_only() };
        // A value above its surroundings is pushed up, one below is pushed down.
        assert!(fusion_inputs(0.6, 0.5, &c)[1] > 0.6);
        assert!(fusion_inputs(0.4, 0.5, &c)[1] < 0.5);
        assert!(fusion_inputs(0.5, 0.5, &c)[0] < 0.5); // gamma darkens
    }
}
