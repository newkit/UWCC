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
