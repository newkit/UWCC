//! Sea-thru: Akkaynak and Treibitz, "Sea-thru: A Method for Removing Water
//! from Underwater Images" (CVPR 2019), implemented from the paper.
//!
//! The paper's image formation model, per colour channel and in linear light:
//!
//! ```text
//! I = J * exp(-beta_D(z) * z) + B_inf * (1 - exp(-beta_B * z))
//! ```
//!
//! `I` is the captured image, `J` the scene without water, `z` the range.
//! The estimation follows the paper's steps:
//!
//! 1. Backscatter: in ten range bins, take the darkest 1 % of pixels and fit
//!    `B(z) = B_inf * (1 - exp(-beta_B * z)) + J' * exp(-beta_D' * z)`
//!    (the second term absorbs what the dark pixels still reflect).
//! 2. Illuminant map: local space average colour of the backscatter-free
//!    image, averaged only over neighbours at a similar range.
//! 3. Attenuation: `beta_D(z) = -ln(illuminant) / z`, fitted as
//!    `a * exp(b * z) + c * exp(d * z)`.
//! 4. Recover `J = (I - B(z)) * exp(beta_D(z) * z)` and white-balance it.
//!
//! Differences from the paper, all forced by what the app has to work with:
//!
//! - **Range is estimated, not measured.** The paper uses range maps from
//!   stereo or structure from motion; here the range comes from a prior on a
//!   single image (`range`). This is the largest deviation and bounds the quality.
//! - Input is 8-bit sRGB JPEG or video, linearised, not linear RAW.
//! - The attenuation fit minimises the error in `beta_D` on range-binned
//!   medians; the paper minimises the error of the range reconstructed from
//!   it. The fit may also grow with range, which the paper excludes: the
//!   estimated range is not proportional to the true one.
//! - The gain that undoes attenuation is capped (`MAX_LOG_GAIN`),
//!   and so are the white-balance gains. Where a channel holds no signal the
//!   paper's method amplifies noise without limit.
//! - The output level maps bright scene content to a fixed white level; the
//!   paper leaves display scaling open.
//!
//! The fitted curves are handed on as tables over range, not as function
//! parameters, so that video can blend the corrections of neighbouring
//! analysed frames (see `Correction::backscatter`).
//!
//! No code is taken from the authors' implementation, which is not
//! open-source licensed.

use crate::analysis::{percentile, Analysis};
use crate::color::{srgb_to_linear, LUMA};
use crate::model::{Correction, RANGE_NODES};
use crate::range::{metres, RangeMap};

/// The estimation runs on a copy of at most this many pixels on the longer side.
const WORK_MAX: usize = 128;
const BACKSCATTER_BINS: usize = 10;
/// Share of each range bin, darkest first, taken as backscatter samples.
const DARK_FRACTION: f32 = 0.01;
/// Candidate coefficients (per metre) for the backscatter fit; the paper bounds them to 0..5.
const BETA_STEPS: usize = 24;
const BETA_MAX: f32 = 5.0;
/// Local space average colour: share of the pixel itself per iteration, and iterations.
const LSAC_P: f32 = 0.02;
const LSAC_ITERATIONS: usize = 150;
/// Neighbours farther apart in range than this (metres) do not share an illuminant.
const LSAC_RANGE_STEP: f32 = 0.5;
/// The paper's factor between the local average and the illuminant.
const ILLUMINANT_FACTOR: f32 = 2.0;
const ATTENUATION_BINS: usize = 24;
/// Candidate rates of change of the attenuation coefficient with range. The
/// paper allows only decay; with an estimated range the coefficient can also
/// appear to grow, so a few positive rates are included.
const RATES: [f32; 11] = [0.3, 0.2, 0.1, 0.05, 0.0, -0.05, -0.1, -0.2, -0.4, -0.8, -1.6];
/// Upper bound on each term of the attenuation fit, per metre.
const MAX_COEFFICIENT: f32 = 8.0;
/// Upper bound on the exponent that undoes attenuation (a gain of about 55),
/// so that an empty channel is not turned into noise.
const MAX_LOG_GAIN: f32 = 4.0;
const MAX_BALANCE: f32 = 8.0;
const WHITE_PERCENTILE: f32 = 99.5;
const WHITE_LEVEL: f32 = 0.68;

/// Analyse an RGBA8 sRGB image.
pub fn analyze(rgba: &[u8], width: usize, height: usize) -> Analysis {
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return Analysis::NEUTRAL;
    }
    let map = RangeMap::from_srgb8(rgba, width, height);

    // Working copy: linear light, block-averaged.
    let k = width.max(height).div_ceil(WORK_MAX).max(1);
    let (w, h) = (width.div_ceil(k), height.div_ceil(k));
    let mut px = vec![[0.0f32; 3]; w * h];
    let mut count = vec![0u32; w * h];
    for y in 0..height {
        for x in 0..width {
            let cell = (y / k) * w + x / k;
            let p = &rgba[(y * width + x) * 4..];
            for ch in 0..3 {
                px[cell][ch] += srgb_to_linear(p[ch] as f32 / 255.0);
            }
            count[cell] += 1;
        }
    }
    for (p, &n) in px.iter_mut().zip(&count) {
        for v in p.iter_mut() {
            *v /= n.max(1) as f32;
        }
    }
    let relative: Vec<f32> =
        (0..w * h).map(|i| map.sample(((i % w) as f32 + 0.5) / w as f32, ((i / w) as f32 + 0.5) / h as f32)).collect();
    let z: Vec<f32> = relative.iter().map(|&d| metres(d)).collect();

    // 1. Backscatter.
    let dark = dark_samples(&px, &z);
    let mut scatter_fit = [[0.0f32; 4]; 3];
    for ch in 0..3 {
        let points: Vec<(f32, f32)> = dark.iter().map(|&i| (z[i], px[i][ch])).collect();
        scatter_fit[ch] = fit_backscatter(&points);
    }
    let scatter = |ch: usize, z: f32| {
        let b = &scatter_fit[ch];
        b[0] * (1.0 - (-b[1] * z).exp()) + b[2] * (-b[3] * z).exp()
    };
    let direct: Vec<[f32; 3]> =
        px.iter().zip(&z).map(|(p, &z)| [0, 1, 2].map(|ch| (p[ch] - scatter(ch, z)).max(0.0))).collect();

    // 2. Illuminant map.
    let illuminant = local_average(&direct, &z, w, h);

    // 3. Attenuation coefficient as a function of range.
    let mut attenuation_fit = [[0.0f32; 4]; 3];
    for ch in 0..3 {
        let beta: Vec<(f32, f32)> = illuminant
            .iter()
            .zip(&z)
            .map(|(e, &z)| (z, (-(ILLUMINANT_FACTOR * e[ch]).clamp(1e-3, 1.0).ln() / z).max(0.0)))
            .collect();
        attenuation_fit[ch] = fit_attenuation(&beta);
    }

    // Tabulate both curves over range. Beyond the samples that enclose the
    // ranges seen in this image the fits are extrapolations, so the tables
    // repeat the value of the enclosing sample there.
    let steps = (RANGE_NODES - 1) as f32;
    let seen = relative.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &d| (lo.min(d), hi.max(d)));
    let (first, last) = ((seen.0 * steps).floor() / steps, (seen.1 * steps).ceil() / steps);
    let mut backscatter = [[0.0f32; RANGE_NODES]; 3];
    let mut log_gain = [[0.0f32; RANGE_NODES]; 3];
    for ch in 0..3 {
        for node in 0..RANGE_NODES {
            let zn = metres((node as f32 / steps).clamp(first, last));
            let t = &attenuation_fit[ch];
            backscatter[ch][node] = scatter(ch, zn);
            log_gain[ch][node] = ((t[0] * (t[1] * zn).exp() + t[2] * (t[3] * zn).exp()) * zn).min(MAX_LOG_GAIN);
        }
    }

    // 4. Recover exactly as the pipeline will, then balance and set the level through the affine part.
    let recovered: Vec<[f32; 3]> = px
        .iter()
        .zip(&relative)
        .map(|(p, &d)| {
            [0, 1, 2].map(|ch| {
                (p[ch] - Correction::lookup(&backscatter[ch], d)).max(0.0) * Correction::lookup(&log_gain[ch], d).exp()
            })
        })
        .collect();
    let mut mean = [0.0f64; 3];
    for p in &recovered {
        for ch in 0..3 {
            mean[ch] += p[ch] as f64;
        }
    }
    let grey = mean.iter().sum::<f64>() / 3.0;
    if grey <= 0.0 {
        return Analysis::NEUTRAL;
    }
    // Grey world, relative to the strongest channel so that the cap limits amplification only.
    let mut balance = mean.map(|m| (grey / m.max(1e-9)) as f32);
    let least = balance.iter().cloned().fold(f32::MAX, f32::min);
    balance = balance.map(|b| (b / least).min(MAX_BALANCE));
    // The level is taken from brightness, not per channel: a channel that is mostly amplified noise must not set it.
    let luma: Vec<f32> = recovered.iter().map(|p| (0..3).map(|ch| LUMA[ch] * p[ch] * balance[ch]).sum()).collect();
    let hi = percentile(&luma, WHITE_PERCENTILE);
    if hi <= 0.0 {
        return Analysis::NEUTRAL;
    }
    let mut m = Correction::IDENTITY.m;
    for ch in 0..3 {
        m[ch][ch] = balance[ch] * WHITE_LEVEL / hi;
    }
    Analysis::plain(Correction { backscatter, log_gain, ranged: true, ..Correction::affine(m) })
}

/// Indices of the darkest pixels in each range bin.
fn dark_samples(px: &[[f32; 3]], z: &[f32]) -> Vec<usize> {
    let lo = z.iter().cloned().fold(f32::MAX, f32::min);
    let hi = z.iter().cloned().fold(f32::MIN, f32::max);
    let span = (hi - lo).max(1e-6);
    let mut bins: Vec<Vec<usize>> = vec![Vec::new(); BACKSCATTER_BINS];
    for (i, &zi) in z.iter().enumerate() {
        let bin = (((zi - lo) / span) * BACKSCATTER_BINS as f32) as usize;
        bins[bin.min(BACKSCATTER_BINS - 1)].push(i);
    }
    let mut out = Vec::new();
    for mut bin in bins {
        if bin.is_empty() {
            continue;
        }
        let brightness = |i: usize| px[i][0] + px[i][1] + px[i][2];
        bin.sort_unstable_by(|&a, &b| brightness(a).total_cmp(&brightness(b)));
        let take = ((bin.len() as f32 * DARK_FRACTION).ceil() as usize).max(1);
        out.extend_from_slice(&bin[..take]);
    }
    out
}

/// Least squares for `y = p * f + q * g` with both coefficients inside `0..=limit`.
/// Returns `(p, q, squared error)`.
fn bounded_pair(f: &[f32], g: &[f32], y: &[f32], weights: Option<&[f32]>, limit: f32) -> (f32, f32, f32) {
    let (mut ff, mut gg, mut fg, mut fy, mut gy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for i in 0..y.len() {
        let wt = weights.map_or(1.0, |w| w[i]) as f64;
        let (a, b, t) = (f[i] as f64, g[i] as f64, y[i] as f64);
        ff += wt * a * a;
        gg += wt * b * b;
        fg += wt * a * b;
        fy += wt * a * t;
        gy += wt * b * t;
    }
    let limit = limit as f64;
    let mut candidates: Vec<(f64, f64)> = Vec::with_capacity(5);
    let det = ff * gg - fg * fg;
    if det.abs() > 1e-12 {
        candidates.push(((fy * gg - gy * fg) / det, (gy * ff - fy * fg) / det));
    }
    // On the edges of the allowed square one coefficient is fixed and the other is a 1-D fit.
    for fixed in [0.0, limit] {
        if gg > 1e-12 {
            candidates.push((fixed, (gy - fixed * fg) / gg));
        }
        if ff > 1e-12 {
            candidates.push(((fy - fixed * fg) / ff, fixed));
        }
    }
    candidates.push((0.0, 0.0));
    let mut best = (0.0f32, 0.0f32, f32::MAX);
    for (p, q) in candidates {
        if !(-1e-9..=limit + 1e-9).contains(&p) && !(-1e-9..=limit + 1e-9).contains(&q) {
            continue;
        }
        let (p, q) = (p.clamp(0.0, limit) as f32, q.clamp(0.0, limit) as f32);
        let mut error = 0.0f32;
        for i in 0..y.len() {
            let d = p * f[i] + q * g[i] - y[i];
            error += weights.map_or(1.0, |w| w[i]) * d * d;
        }
        if error < best.2 {
            best = (p, q, error);
        }
    }
    best
}

/// Fit `[b_inf, beta_b, j, beta_d]` to `(range, value)` samples of the darkest pixels.
fn fit_backscatter(points: &[(f32, f32)]) -> [f32; 4] {
    if points.is_empty() {
        return [0.0; 4];
    }
    let y: Vec<f32> = points.iter().map(|p| p.1).collect();
    let betas: Vec<f32> = (1..=BETA_STEPS).map(|i| BETA_MAX * (i as f32 / BETA_STEPS as f32).powi(3)).collect();
    let rising: Vec<Vec<f32>> =
        betas.iter().map(|&b| points.iter().map(|p| 1.0 - (-b * p.0).exp()).collect()).collect();
    let falling: Vec<Vec<f32>> = betas.iter().map(|&b| points.iter().map(|p| (-b * p.0).exp()).collect()).collect();
    let mut best = ([0.0f32; 4], f32::MAX);
    for (i, f) in rising.iter().enumerate() {
        for (j, g) in falling.iter().enumerate() {
            let (b_inf, residual, error) = bounded_pair(f, g, &y, None, 1.0);
            if error < best.1 {
                best = ([b_inf, betas[i], residual, betas[j]], error);
            }
        }
    }
    best.0
}

/// Local space average colour, restricted to neighbours at a similar range.
fn local_average(direct: &[[f32; 3]], z: &[f32], w: usize, h: usize) -> Vec<[f32; 3]> {
    // Neighbour lists once; the averaging then only reads them.
    let mut neighbours: Vec<[usize; 4]> = Vec::with_capacity(w * h);
    let mut counts: Vec<u8> = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let mut list = [i; 4];
            let mut n = 0;
            let mut consider = |j: usize| {
                if (z[i] - z[j]).abs() <= LSAC_RANGE_STEP {
                    list[n] = j;
                    n += 1;
                }
            };
            if x > 0 {
                consider(i - 1);
            }
            if x + 1 < w {
                consider(i + 1);
            }
            if y > 0 {
                consider(i - w);
            }
            if y + 1 < h {
                consider(i + w);
            }
            neighbours.push(list);
            counts.push(n as u8);
        }
    }
    let mut a = direct.to_vec();
    let mut next = a.clone();
    for _ in 0..LSAC_ITERATIONS {
        for i in 0..w * h {
            let n = counts[i] as usize;
            for ch in 0..3 {
                let around = if n == 0 {
                    a[i][ch]
                } else {
                    neighbours[i][..n].iter().map(|&j| a[j][ch]).sum::<f32>() / n as f32
                };
                next[i][ch] = direct[i][ch] * LSAC_P + around * (1.0 - LSAC_P);
            }
        }
        std::mem::swap(&mut a, &mut next);
    }
    a
}

/// Fit `[a, b, c, d]` of `beta(z) = a * exp(b * z) + c * exp(d * z)` to `(range, beta)` samples.
fn fit_attenuation(samples: &[(f32, f32)]) -> [f32; 4] {
    if samples.is_empty() {
        return [0.0; 4];
    }
    // Median per range bin: robust against the spread within a bin, and small enough to search over.
    let lo = samples.iter().map(|s| s.0).fold(f32::MAX, f32::min);
    let hi = samples.iter().map(|s| s.0).fold(f32::MIN, f32::max);
    let span = (hi - lo).max(1e-6);
    let mut bins: Vec<Vec<f32>> = vec![Vec::new(); ATTENUATION_BINS];
    for &(z, beta) in samples {
        let bin = (((z - lo) / span) * ATTENUATION_BINS as f32) as usize;
        bins[bin.min(ATTENUATION_BINS - 1)].push(beta);
    }
    let (mut zs, mut ys, mut ws) = (Vec::new(), Vec::new(), Vec::new());
    for (i, bin) in bins.iter().enumerate() {
        if bin.is_empty() {
            continue;
        }
        zs.push(lo + span * (i as f32 + 0.5) / ATTENUATION_BINS as f32);
        ys.push(percentile(bin, 50.0));
        ws.push(bin.len() as f32);
    }
    let curves: Vec<Vec<f32>> = RATES.iter().map(|&rate| zs.iter().map(|&z| (rate * z).exp()).collect()).collect();
    let mut best = ([0.0f32; 4], f32::MAX);
    for i in 0..RATES.len() {
        for j in i + 1..RATES.len() {
            let (a, c, error) = bounded_pair(&curves[i], &curves[j], &ys, Some(&ws), MAX_COEFFICIENT);
            if error < best.1 {
                best = ([a, RATES[i], c, RATES[j]], error);
            }
        }
    }
    best.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::linear_to_srgb;
    use crate::model::Adjustments;
    use crate::reference::apply_rgba8;

    #[test]
    fn backscatter_fit_recovers_a_saturating_curve() {
        let truth = |z: f32| 0.3 * (1.0 - (-0.4 * z).exp());
        let points: Vec<(f32, f32)> = (0..40).map(|i| 1.0 + i as f32 * 0.2).map(|z| (z, truth(z))).collect();
        let p = fit_backscatter(&points);
        for &(z, y) in &points {
            let fitted = p[0] * (1.0 - (-p[1] * z).exp()) + p[2] * (-p[3] * z).exp();
            assert!((fitted - y).abs() < 0.01, "z {z}: {fitted} vs {y}");
        }
    }

    #[test]
    fn attenuation_fit_follows_a_decaying_coefficient() {
        let samples: Vec<(f32, f32)> =
            (0..200).map(|i| 1.0 + i as f32 * 0.04).map(|z| (z, 0.1 + 0.5 * (-0.4 * z).exp())).collect();
        let p = fit_attenuation(&samples);
        for &(z, y) in samples.iter().step_by(20) {
            let fitted = p[0] * (p[1] * z).exp() + p[2] * (p[3] * z).exp();
            assert!((fitted - y).abs() < 0.03, "z {z}: {fitted} vs {y}");
        }
    }

    #[test]
    fn bounded_fit_respects_the_bounds() {
        // The unconstrained answer is (2, -1); with a limit of 1 both must stay inside 0..=1.
        let f = [1.0, 0.0, 1.0];
        let g = [0.0, 1.0, 1.0];
        let y = [2.0, -1.0, 1.0];
        let (p, q, _) = bounded_pair(&f, &g, &y, None, 1.0);
        assert!((0.0..=1.0).contains(&p) && (0.0..=1.0).contains(&q));
        assert!((p - 1.0).abs() < 1e-5 && q.abs() < 1e-5);
    }

    /// A scene rendered through the paper's own image formation model: grey
    /// patches of different brightness, farther away towards the right.
    #[test]
    fn removes_a_synthetic_water_column() {
        let (w, h) = (128usize, 96usize);
        let beta = [0.45f32, 0.12, 0.08];
        let (b_inf, beta_b) = ([0.02f32, 0.18, 0.28], [0.25f32, 0.2, 0.18]);
        let mut rgba = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                let z = 1.0 + 4.0 * x as f32 / w as f32;
                let albedo = 0.15 + 0.7 * (((x / 8 + y / 8) * 37 % 11) as f32 / 10.0);
                for ch in 0..3 {
                    let v = albedo * (-beta[ch] * z).exp() + b_inf[ch] * (1.0 - (-beta_b[ch] * z).exp());
                    rgba.push((linear_to_srgb(v) * 255.0 + 0.5) as u8);
                }
                rgba.push(255);
            }
        }
        let analysis = analyze(&rgba, w, h);
        assert!(analysis.correction.ranged);
        let map = RangeMap::from_srgb8(&rgba, w, h);
        let mut out = rgba.clone();
        apply_rgba8(&mut out, w, &analysis.correction, &Adjustments::default(), Some(&map));

        // The scene is grey at every range, so each vertical band should come out grey
        // on average, where the input goes from slightly to strongly blue-green.
        let band_cast = |buf: &[u8], band: usize| {
            let mut mean = [0.0f32; 3];
            for y in 0..h {
                for x in band * 16..band * 16 + 16 {
                    for ch in 0..3 {
                        mean[ch] += buf[(y * w + x) * 4 + ch] as f32;
                    }
                }
            }
            ((mean[0] - mean[1]).abs() + (mean[2] - mean[1]).abs()) / mean[1]
        };
        for band in 0..w / 16 {
            let (before, after) = (band_cast(&rgba, band), band_cast(&out, band));
            assert!(after < 0.08, "band {band}: cast {after:.3} (input {before:.3})");
        }
        assert!(band_cast(&rgba, w / 16 - 1) > 0.5, "the far side of the input should be strongly cast");
    }
}
