//! Relative range (camera-to-scene distance) estimated from a single image.
//!
//! Sea-thru needs a range map, which the original work takes from stereo or
//! structure from motion. UWCC has only the image, so the range is estimated
//! with the underwater light attenuation prior of Song et al. 2018 ("A Rapid
//! Scene Depth Estimation Model Based on Underwater Light Attenuation Prior
//! for Underwater Image Restoration"): red fades with distance faster than
//! green and blue, so relative range is modelled as linear in the red value
//! and the larger of green and blue.
//!
//! Two changes from that paper:
//!
//! - The colour is divided by its brightest channel first. On the raw values
//!   the estimate follows brightness (bright sand reads as far, a dark fish
//!   as near), and Sea-thru's backscatter step, which looks for the darkest
//!   pixels at each range, then removes the image itself.
//! - Song et al. refine the map with a guided filter; here it is computed on
//!   a coarse grid and blurred instead, which keeps it cheap enough to redo
//!   for every video frame.
//!
//! It is a prior, not a measurement. Where red is completely absent it
//! carries no information and the map is flat; a subject that is red by
//! nature reads as near.

/// The map is at most this many cells on its longer side.
pub const GRID_MAX: usize = 24;
/// Nominal range in metres at map values 0 and 1.
pub const Z_NEAR: f32 = 1.0;
pub const Z_FAR: f32 = 10.0;
/// Coefficients of the prior: constant, max(green, blue), red; on sRGB-encoded values.
const PRIOR: [f32; 3] = [0.532, 0.513, -0.911];
/// Added to the brightest channel before dividing, so that near-black cells do not amplify noise.
const DARK_FLOOR: f32 = 0.02;
const BLUR_PASSES: usize = 4;
/// A map made from a depth model's output is at most this many cells on its longer side.
pub const DEPTH_MAX: usize = 160;

/// Relative range per grid cell, 0 (near) to 1 (far), rows top to bottom.
#[derive(Clone, Debug, PartialEq)]
pub struct RangeMap {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

/// Nominal range in metres for a map value.
pub fn metres(value: f32) -> f32 {
    Z_NEAR + (Z_FAR - Z_NEAR) * value
}

impl RangeMap {
    /// Estimate the map from an RGBA8 sRGB image of `width` x `height` pixels.
    pub fn from_srgb8(rgba: &[u8], width: usize, height: usize) -> RangeMap {
        if width == 0 || height == 0 || rgba.len() < width * height * 4 {
            return RangeMap { width: 1, height: 1, data: vec![0.5] };
        }
        let scale = (GRID_MAX as f32 / width.max(height) as f32).min(1.0);
        let gw = ((width as f32 * scale).round() as usize).max(1);
        let gh = ((height as f32 * scale).round() as usize).max(1);

        // Mean colour per cell.
        let mut sum = vec![[0.0f32; 3]; gw * gh];
        let mut count = vec![0u32; gw * gh];
        for y in 0..height {
            let gy = y * gh / height;
            for x in 0..width {
                let cell = gy * gw + x * gw / width;
                let p = &rgba[(y * width + x) * 4..];
                for ch in 0..3 {
                    sum[cell][ch] += p[ch] as f32;
                }
                count[cell] += 1;
            }
        }
        let mut data: Vec<f32> = sum
            .iter()
            .zip(&count)
            .map(|(s, &n)| {
                let k = 1.0 / (255.0 * n.max(1) as f32);
                let (r, g, b) = (s[0] * k, s[1] * k, s[2] * k);
                let peak = r.max(g).max(b) + DARK_FLOOR;
                (PRIOR[0] + PRIOR[1] * g.max(b) / peak + PRIOR[2] * r / peak).clamp(0.0, 1.0)
            })
            .collect();

        // 3x3 box blur, edges repeated.
        for _ in 0..BLUR_PASSES {
            let src = data.clone();
            for y in 0..gh {
                for x in 0..gw {
                    let mut acc = 0.0;
                    for dy in [-1i32, 0, 1] {
                        for dx in [-1i32, 0, 1] {
                            let yy = (y as i32 + dy).clamp(0, gh as i32 - 1) as usize;
                            let xx = (x as i32 + dx).clamp(0, gw as i32 - 1) as usize;
                            acc += src[yy * gw + xx];
                        }
                    }
                    data[y * gw + x] = acc / 9.0;
                }
            }
        }
        RangeMap { width: gw, height: gh, data }
    }

    /// Range map from the output of a monocular depth model: relative
    /// inverse depth ("disparity", larger = nearer) per pixel, rows top to
    /// bottom. Such models give depth only up to an unknown scale and shift,
    /// so the map is anchored by assumption: the nearest content (99th
    /// percentile of disparity) is taken to be at `Z_NEAR`, the farthest
    /// (1st percentile) at `Z_FAR`, and range is the reciprocal of disparity
    /// in between. The result is reduced to at most `DEPTH_MAX` cells on its
    /// longer side.
    pub fn from_disparity(disparity: &[f32], width: usize, height: usize) -> RangeMap {
        if width == 0 || height == 0 || disparity.len() < width * height {
            return RangeMap { width: 1, height: 1, data: vec![0.5] };
        }
        // Block average down to the stored size.
        let scale = (DEPTH_MAX as f32 / width.max(height) as f32).min(1.0);
        let gw = ((width as f32 * scale).round() as usize).max(1);
        let gh = ((height as f32 * scale).round() as usize).max(1);
        let mut sum = vec![0.0f32; gw * gh];
        let mut count = vec![0u32; gw * gh];
        for y in 0..height {
            let gy = y * gh / height;
            for x in 0..width {
                let v = disparity[y * width + x];
                if v.is_finite() {
                    sum[gy * gw + x * gw / width] += v;
                    count[gy * gw + x * gw / width] += 1;
                }
            }
        }
        let cells: Vec<f32> = sum.iter().zip(&count).map(|(s, &n)| s / n.max(1) as f32).collect();
        let near = crate::analysis::percentile(&cells, 99.0);
        let far = crate::analysis::percentile(&cells, 1.0);
        if near - far < 1e-6 {
            return RangeMap { width: gw, height: gh, data: vec![0.5; gw * gh] };
        }
        // Disparity is linear in 1/range between the two anchors.
        let (inv_near, inv_far) = (1.0 / Z_NEAR, 1.0 / Z_FAR);
        let data = cells
            .iter()
            .map(|&c| {
                let t = ((c - far) / (near - far)).clamp(0.0, 1.0);
                let z = 1.0 / (inv_far + (inv_near - inv_far) * t);
                (z - Z_NEAR) / (Z_FAR - Z_NEAR)
            })
            .collect();
        RangeMap { width: gw, height: gh, data }
    }

    /// Bilinear lookup at image position `u`, `v` (0..1, origin top left).
    /// The shader does the same arithmetic on the map as a texture.
    pub fn sample(&self, u: f32, v: f32) -> f32 {
        let x = (u * self.width as f32 - 0.5).clamp(0.0, (self.width - 1) as f32);
        let y = (v * self.height as f32 - 0.5).clamp(0.0, (self.height - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.width - 1), (y0 + 1).min(self.height - 1));
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let at = |xx: usize, yy: usize| self.data[yy * self.width + xx];
        let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
        let bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
        top + (bottom - top) * fy
    }

    /// Flat form for the WASM boundary: width, height, then the values.
    pub fn to_flat(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.data.len() + 2);
        out.push(self.width as f32);
        out.push(self.height as f32);
        out.extend_from_slice(&self.data);
        out
    }

    pub fn from_flat(flat: &[f32]) -> Option<RangeMap> {
        let (width, height) = (*flat.first()? as usize, *flat.get(1)? as usize);
        if width == 0 || height == 0 || flat.len() != width * height + 2 {
            return None;
        }
        Some(RangeMap { width, height, data: flat[2..].to_vec() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disparity_maps_near_and_far_to_the_ends_and_is_reciprocal_in_between() {
        // Disparity falls linearly from left (near) to right (far).
        let (w, h) = (100, 4);
        let disparity: Vec<f32> = (0..w * h).map(|i| 5.0 - 4.0 * (i % w) as f32 / (w - 1) as f32).collect();
        let map = RangeMap::from_disparity(&disparity, w, h);
        assert_eq!((map.width, map.height), (w, h));
        assert!(map.data[0] < 0.01 && map.data[w - 1] > 0.99);
        assert!(map.data.windows(2).take(w - 1).all(|p| p[1] >= p[0]));
        // Half-way in disparity is 1 / mean(1/1, 1/10) = 1.82 m, far nearer than half-way in range.
        let mid = metres(map.data[w / 2]);
        assert!((mid - 1.82).abs() < 0.1, "{mid}");
    }

    #[test]
    fn disparity_without_spread_or_data_gives_a_flat_map() {
        assert!(RangeMap::from_disparity(&[2.0; 64], 8, 8).data.iter().all(|&v| v == 0.5));
        assert_eq!(RangeMap::from_disparity(&[], 8, 8).data, vec![0.5]);
        let big = RangeMap::from_disparity(&vec![1.0; 400 * 200], 400, 200);
        assert_eq!((big.width, big.height), (DEPTH_MAX, DEPTH_MAX / 2));
    }

    fn image(width: usize, height: usize, f: impl Fn(usize, usize) -> [u8; 3]) -> Vec<u8> {
        let mut out = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                let c = f(x, y);
                out.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        out
    }

    #[test]
    fn less_red_reads_as_farther() {
        // Left half keeps some red, right half has lost it.
        let rgba = image(128, 64, |x, _| if x < 64 { [90, 120, 130] } else { [5, 120, 130] });
        let map = RangeMap::from_srgb8(&rgba, 128, 64);
        assert_eq!((map.width, map.height), (GRID_MAX, GRID_MAX / 2));
        assert!(map.sample(0.1, 0.5) + 0.2 < map.sample(0.9, 0.5));
    }

    #[test]
    fn brightness_alone_does_not_change_the_range() {
        let rgba = image(128, 64, |x, _| if x < 64 { [20, 60, 65] } else { [60, 180, 195] });
        let map = RangeMap::from_srgb8(&rgba, 128, 64);
        assert!((map.sample(0.1, 0.5) - map.sample(0.9, 0.5)).abs() < 0.05);
    }

    #[test]
    fn sampling_is_smooth_and_bounded() {
        let rgba = image(100, 80, |x, y| [(x * 2) as u8, (y * 3) as u8, 128]);
        let map = RangeMap::from_srgb8(&rgba, 100, 80);
        let mut previous = map.sample(0.0, 0.3);
        for i in 1..=200 {
            let value = map.sample(i as f32 / 200.0, 0.3);
            assert!((0.0..=1.0).contains(&value));
            assert!((value - previous).abs() < 0.05);
            previous = value;
        }
    }

    #[test]
    fn flat_round_trip() {
        let map = RangeMap { width: 2, height: 2, data: vec![0.1, 0.2, 0.3, 0.4] };
        assert_eq!(RangeMap::from_flat(&map.to_flat()), Some(map));
        assert_eq!(RangeMap::from_flat(&[2.0, 2.0, 0.5]), None);
    }
}
