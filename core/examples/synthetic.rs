//! Synthetic underwater test set: takes photos taken in air, adds water with a
//! physical model, and scores every correction method by how well it gets the
//! original back.
//!
//! ```text
//! cargo run --release --example synthetic -- make  OUT_DIR CLEAN.png...
//! cargo run --release --example synthetic -- score OUT_DIR [SHEET.jpg]
//! ```
//!
//! `make` needs `CLEAN.png.disparity` next to every clean image: the output of
//! the app's depth model (little-endian width and height as u32, then one f32
//! per pixel, larger = nearer), the same format `examples/sheet.rs` reads. It
//! writes for every image and water condition `NAME__WATER__DEPTHm.jpg`, plus
//! `NAME__truth.png` (the clean image) and `NAME__WATER__DEPTHm.weight`
//! (one byte per pixel: 255 where the scene, not the water, dominates).
//!
//! `score` corrects every underwater image with every method, the way the app
//! does (analysis and maps on a 256 px copy, applied at full size), and
//! compares the result with the clean image. For the method that takes its
//! range from the depth model it uses `NAME__WATER__DEPTHm.jpg.disparity`
//! when present: the model run on the underwater image, as in the app, not
//! the depth the water was made from.
//!
//! ## Image formation
//!
//! The revised model of Akkaynak and Treibitz (CVPR 2018), per channel, in
//! linear light:
//!
//! `I = J * E * exp(-c z) + E * (b / c) * (1 - exp(-c z))`
//!
//! `J` is the clean image, `z` the distance to the camera, `E = exp(-Kd d)`
//! the daylight left at depth `d` below the surface, `c = a + b` the beam
//! attenuation and `b` the scattering coefficient. The same coefficient is
//! used for the direct signal and the backscatter (the revised model allows
//! them to differ). Coefficients are broadband values for the red, green and
//! blue bands, ordered like Jerlov's ocean and coastal water types. They are
//! not measured: the ocean types are tuned so that open water comes out as
//! blue as in the owner's reference photos (green/blue 0.15-0.45 in linear
//! light, red near zero), which is bluer than the band averages of measured
//! spectra suggest, as camera sensitivities and processing also shift it. Range comes from the depth model's relative
//! disparity, anchored at 0.8 m (nearest) and 12 m (farthest; sky becomes
//! open water). The camera keeps a daylight white balance and exposes for a
//! mean luminance of 0.18. Mild noise is added and the result stored as
//! JPEG, quality 92.

use std::path::{Path, PathBuf};

use uwcc_core::reference::apply_rgba8_with;
use uwcc_core::{analyze_with_range, Adjustments, Algorithm, RangeMap};

struct Water {
    name: &'static str,
    kd: [f32; 3],
    a: [f32; 3],
    b: [f32; 3],
}

const WATERS: [Water; 5] = [
    Water { name: "ocean1", kd: [0.45, 0.10, 0.03], a: [0.45, 0.09, 0.02], b: [0.005, 0.02, 0.04] },
    Water { name: "ocean2", kd: [0.47, 0.12, 0.06], a: [0.45, 0.10, 0.04], b: [0.02, 0.04, 0.07] },
    Water { name: "ocean3", kd: [0.50, 0.15, 0.10], a: [0.46, 0.11, 0.07], b: [0.05, 0.08, 0.11] },
    Water { name: "coastal1", kd: [0.55, 0.18, 0.20], a: [0.48, 0.12, 0.15], b: [0.15, 0.18, 0.20] },
    Water { name: "coastal3", kd: [0.65, 0.28, 0.38], a: [0.55, 0.18, 0.30], b: [0.30, 0.32, 0.34] },
];
const DEPTHS: [f32; 3] = [3.0, 8.0, 15.0];
const Z_NEAR: f32 = 0.8;
const Z_FAR: f32 = 12.0;
const ANALYSIS: u32 = 256;

fn to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}
fn to_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}
fn luma(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

fn read_disparity(path: &str) -> (Vec<f32>, usize, usize) {
    let bytes = std::fs::read(format!("{path}.disparity")).unwrap_or_else(|e| panic!("{path}.disparity: {e}"));
    let int = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    let values = bytes[8..].as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
    (values, int(0), int(4))
}

fn percentile(values: &[f32], p: f32) -> f32 {
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    v[((v.len() - 1) as f32 * p) as usize]
}

/// Distance to the camera in metres at every pixel of a `w` x `h` image.
fn ranges(path: &str, w: usize, h: usize) -> Vec<f32> {
    let (disp, dw, dh) = read_disparity(path);
    let (lo, hi) = (percentile(&disp, 0.01), percentile(&disp, 0.99));
    let at = |x: usize, y: usize| disp[y.min(dh - 1) * dw + x.min(dw - 1)];
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            // Bilinear sample at the pixel centre.
            let fx = ((x as f32 + 0.5) * dw as f32 / w as f32 - 0.5).max(0.0);
            let fy = ((y as f32 + 0.5) * dh as f32 / h as f32 - 0.5).max(0.0);
            let (x0, y0) = (fx as usize, fy as usize);
            let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
            let top = at(x0, y0) * (1.0 - tx) + at(x0 + 1, y0) * tx;
            let bottom = at(x0, y0 + 1) * (1.0 - tx) + at(x0 + 1, y0 + 1) * tx;
            let n = (((top * (1.0 - ty) + bottom * ty) - lo) / (hi - lo).max(1e-6)).clamp(0.0, 1.0);
            out.push(1.0 / (n / Z_NEAR + (1.0 - n) / Z_FAR));
        }
    }
    out
}

/// Small deterministic generator for the sensor noise.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 40) as f32) / (1u64 << 24) as f32
    }
    /// Roughly normal, mean 0, standard deviation 1.
    fn normal(&mut self) -> f32 {
        (0..4).map(|_| self.next()).sum::<f32>().mul_add(3.0f32.sqrt(), -2.0 * 3.0f32.sqrt())
    }
}

fn stem(path: &str) -> String {
    Path::new(path).file_stem().unwrap().to_string_lossy().into_owned()
}

fn make(out_dir: &Path, cleans: &[String]) {
    std::fs::create_dir_all(out_dir).unwrap();
    for (index, path) in cleans.iter().enumerate() {
        let img = image::open(path).unwrap_or_else(|e| panic!("{path}: {e}")).to_rgb8();
        let (w, h) = (img.width() as usize, img.height() as usize);
        let name = stem(path);
        img.save(out_dir.join(format!("{name}__truth.png"))).unwrap();
        let z = ranges(path, w, h);
        let clean: Vec<[f32; 3]> = img.pixels().map(|p| p.0.map(|v| to_linear(v as f32 / 255.0))).collect();
        for (wi, water) in WATERS.iter().enumerate() {
            for (di, &depth) in DEPTHS.iter().enumerate() {
                let e = water.kd.map(|k| (-k * depth).exp());
                let mut raw = Vec::with_capacity(w * h);
                let mut weight = Vec::with_capacity(w * h);
                for (j, &z) in clean.iter().zip(&z) {
                    let mut direct = [0.0; 3];
                    let mut back = [0.0; 3];
                    for ch in 0..3 {
                        let c = water.a[ch] + water.b[ch];
                        let t = (-c * z).exp();
                        direct[ch] = j[ch] * e[ch] * t;
                        back[ch] = e[ch] * water.b[ch] / c * (1.0 - t);
                    }
                    let total = [direct[0] + back[0], direct[1] + back[1], direct[2] + back[2]];
                    weight.push(if luma(direct) >= 0.5 * luma(total) { 255u8 } else { 0 });
                    raw.push(total);
                }
                let mean = raw.iter().map(|&p| luma(p)).sum::<f32>() / raw.len() as f32;
                let gain = 0.18 / mean.max(1e-6);
                let mut rng = Lcg((index * 100 + wi * 10 + di) as u64 + 1);
                let mut out = image::RgbImage::new(w as u32, h as u32);
                for (px, p) in out.pixels_mut().zip(&raw) {
                    px.0 = p.map(|v| {
                        let v = v * gain;
                        let noisy = v + rng.normal() * (0.002 + 0.01 * v.max(0.0).sqrt());
                        (to_srgb(noisy) * 255.0).round() as u8
                    });
                }
                let base = format!("{name}__{}__{}m", water.name, depth as u32);
                let file = std::fs::File::create(out_dir.join(format!("{base}.jpg"))).unwrap();
                image::codecs::jpeg::JpegEncoder::new_with_quality(file, 92).encode_image(&out).unwrap();
                std::fs::write(out_dir.join(format!("{base}.weight")), &weight).unwrap();
            }
        }
        println!("{name}");
    }
}

/// CIE L*a*b* (D65) of a linear RGB value.
fn lab(c: [f32; 3]) -> [f32; 3] {
    let x = (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047;
    let y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let z = (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883;
    let f = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

#[derive(Clone, Copy, Default)]
struct Score {
    /// Mean of the per-channel RMSE on 0..1 sRGB, as in the reference-pair tests.
    rmse: f64,
    /// The same after one exposure gain that matches the mean luminance.
    rmse_exp: f64,
    /// Mean CIE76 colour difference after that gain.
    delta_e: f64,
    /// Mean chroma (C*ab) of the result over that of the target: below 1 is duller.
    chroma: f64,
}

fn score_pixels(out: &[u8], truth: &[u8], weight: &[u8]) -> Score {
    let px = |buf: &[u8], i: usize| [0, 1, 2].map(|c| buf[i * 4 + c] as f32 / 255.0);
    let idx: Vec<usize> = (0..weight.len()).filter(|&i| weight[i] > 0).collect();
    if idx.is_empty() {
        return Score::default();
    }
    let (mut lo, mut lt) = (0.0f64, 0.0f64);
    for &i in &idx {
        lo += luma(px(out, i).map(to_linear)) as f64;
        lt += luma(px(truth, i).map(to_linear)) as f64;
    }
    let gain = (lt / lo.max(1e-9)) as f32;
    let (mut s, mut se, mut de) = ([0.0f64; 3], [0.0f64; 3], 0.0f64);
    let (mut co, mut ct) = (0.0f64, 0.0f64);
    for &i in &idx {
        let (o, t) = (px(out, i), px(truth, i));
        let oe = o.map(|v| to_srgb(to_linear(v) * gain));
        for c in 0..3 {
            s[c] += ((o[c] - t[c]) as f64).powi(2);
            se[c] += ((oe[c] - t[c]) as f64).powi(2);
        }
        let (a, b) = (lab(oe.map(to_linear)), lab(t.map(to_linear)));
        de += (((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)) as f64).sqrt();
        co += a[1].hypot(a[2]) as f64;
        ct += b[1].hypot(b[2]) as f64;
    }
    let n = idx.len() as f64;
    let mean_rmse = |s: [f64; 3]| s.iter().map(|v| (v / n).sqrt()).sum::<f64>() / 3.0;
    Score { rmse: mean_rmse(s), rmse_exp: mean_rmse(se), delta_e: de / n, chroma: co / ct.max(1e-9) }
}

struct Row {
    water: String,
    depth: String,
    /// Index 0: the uncorrected input; then one per method in `Algorithm::ALL`.
    scores: Vec<Score>,
    images: Vec<Vec<u8>>,
    size: (usize, usize),
    name: String,
}

fn rgba(img: &image::RgbaImage) -> Vec<u8> {
    img.as_raw().clone()
}

fn score_one(dir: &Path, file: &Path, keep_images: bool) -> Row {
    let base = file.file_stem().unwrap().to_string_lossy().into_owned();
    let mut parts = base.split("__");
    let (name, water, depth) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
    let input = image::open(file).unwrap().to_rgba8();
    let truth = image::open(dir.join(format!("{name}__truth.png"))).unwrap().to_rgba8();
    let weight = std::fs::read(dir.join(format!("{base}.weight"))).unwrap();
    let (w, h) = (input.width() as usize, input.height() as usize);
    let sh = (h as f32 * ANALYSIS as f32 / w as f32).round() as u32;
    let small = image::imageops::resize(&input, ANALYSIS, sh, image::imageops::FilterType::Triangle);
    let (sw, sh) = (ANALYSIS as usize, sh as usize);
    let depth_map = std::fs::read(format!("{}.disparity", file.display())).ok().map(|_| {
        let (d, dw, dh) = read_disparity(&file.to_string_lossy());
        RangeMap::from_disparity(&d, dw, dh)
    });
    let mut scores = vec![score_pixels(&rgba(&input), &rgba(&truth), &weight)];
    let mut images = vec![rgba(&truth), rgba(&input)];
    for algorithm in Algorithm::ALL {
        let given = if algorithm == Algorithm::SeaThruDepth { depth_map.as_ref() } else { None };
        let analysis = analyze_with_range(algorithm, &small, sw, sh, given);
        let own = RangeMap::for_correction(&small, sw, sh, &analysis.correction);
        let range = given.unwrap_or(&own);
        let fusion = uwcc_core::fusion::maps(&small, sw, sh, &analysis.correction);
        let mut buf = rgba(&input);
        apply_rgba8_with(&mut buf, w, &analysis.correction, &Adjustments::default(), Some(range), Some(&fusion));
        scores.push(score_pixels(&buf, &rgba(&truth), &weight));
        if keep_images {
            images.push(buf);
        }
    }
    if !keep_images {
        images.clear();
    }
    Row { water: water.into(), depth: depth.into(), scores, images, size: (w, h), name: name.into() }
}

fn label(i: usize) -> String {
    if i == 0 {
        "Uncorrected".into()
    } else {
        format!("{:?}", Algorithm::ALL[i - 1])
    }
}

fn table(title: &str, rows: &[&Row], groups: &[String], group_of: impl Fn(&Row) -> String, pick: fn(&Score) -> f64) {
    print!("\n{title}\n| Method |");
    for g in groups {
        print!(" {g} |");
    }
    println!(" all |");
    println!("|---|{}---|", "---|".repeat(groups.len()));
    let methods = rows[0].scores.len();
    for m in 0..methods {
        print!("| {} |", label(m));
        let mean = |rs: Vec<&&Row>| rs.iter().map(|r| pick(&r.scores[m])).sum::<f64>() / rs.len().max(1) as f64;
        for g in groups {
            print!(" {:.3} |", mean(rows.iter().filter(|r| &group_of(r) == g).collect()));
        }
        println!(" {:.3} |", mean(rows.iter().collect()));
    }
}

fn score(dir: &Path, sheet: Option<&str>) {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "jpg"))
        .collect();
    files.sort();
    // The sheet shows one image per water type at 8 m.
    let shown = |f: &Path| {
        sheet.is_some() && f.to_string_lossy().contains("__8m") && {
            let n = f.file_name().unwrap().to_string_lossy().into_owned();
            ["kodim03__ocean1", "kodim05__ocean2", "kodim14__ocean3", "kodim23__coastal1", "kodim21__coastal3"]
                .iter()
                .any(|p| n.starts_with(p))
        }
    };
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let chunks: Vec<Vec<PathBuf>> =
        (0..threads).map(|t| files.iter().skip(t).step_by(threads).cloned().collect()).collect();
    let mut rows: Vec<Row> = std::thread::scope(|s| {
        let handles: Vec<_> = chunks
            .iter()
            .map(|chunk| s.spawn(move || chunk.iter().map(|f| score_one(dir, f, shown(f))).collect::<Vec<_>>()))
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    rows.sort_by(|a, b| (&a.name, &a.water, &a.depth).cmp(&(&b.name, &b.water, &b.depth)));
    let refs: Vec<&Row> = rows.iter().collect();
    let waters: Vec<String> = WATERS.iter().map(|w| w.name.to_string()).collect();
    let depths: Vec<String> = DEPTHS.iter().map(|d| format!("{}m", *d as u32)).collect();
    println!("{} images; scored on pixels where the scene, not the water, dominates", rows.len());
    table("Mean RMSE by water type", &refs, &waters, |r| r.water.clone(), |s| s.rmse);
    table("Mean RMSE by depth", &refs, &depths, |r| r.depth.clone(), |s| s.rmse);
    table("RMSE after matching exposure, by water type", &refs, &waters, |r| r.water.clone(), |s| s.rmse_exp);
    table(
        "Colour difference (CIE76 ΔE) after matching exposure, by water type",
        &refs,
        &waters,
        |r| r.water.clone(),
        |s| s.delta_e,
    );
    table(
        "Chroma relative to the clean image (1 = as colourful), by water type",
        &refs,
        &waters,
        |r| r.water.clone(),
        |s| s.chroma,
    );
    // How often each method is the best one, and how often it makes things worse.
    println!("\n| Method | best (exp.-matched RMSE) | worse than uncorrected |\n|---|---|---|");
    for m in 0..rows[0].scores.len() {
        let best = rows
            .iter()
            .filter(|r| {
                (1..r.scores.len()).min_by(|&a, &b| r.scores[a].rmse_exp.total_cmp(&r.scores[b].rmse_exp)) == Some(m)
            })
            .count();
        let worse = rows.iter().filter(|r| r.scores[m].rmse_exp > r.scores[0].rmse_exp).count();
        println!("| {} | {best} | {worse} |", label(m));
    }
    if let Some(out) = sheet {
        let shown: Vec<&Row> = rows.iter().filter(|r| !r.images.is_empty()).collect();
        let tile = 220u32;
        let cols = shown.first().map_or(0, |r| r.images.len()) as u32;
        let heights: Vec<u32> =
            shown.iter().map(|r| (r.size.1 as f32 * tile as f32 / r.size.0 as f32) as u32).collect();
        let mut img = image::RgbImage::from_pixel(cols * tile, heights.iter().sum(), image::Rgb([255, 255, 255]));
        let mut y0 = 0;
        for (r, &th) in shown.iter().zip(&heights) {
            for (c, buf) in r.images.iter().enumerate() {
                let full = image::RgbaImage::from_raw(r.size.0 as u32, r.size.1 as u32, buf.clone()).unwrap();
                let t = image::imageops::resize(&full, tile - 2, th - 2, image::imageops::FilterType::Triangle);
                for (x, y, p) in t.enumerate_pixels() {
                    img.put_pixel(c as u32 * tile + x, y0 + y, image::Rgb([p[0], p[1], p[2]]));
                }
            }
            y0 += th;
        }
        img.save(out).unwrap();
        println!(
            "\nSheet columns: truth, underwater, {}",
            Algorithm::ALL.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>().join(", ")
        );
    }
}

/// The same scores on the owner's reference pairs (`testdata/photos`), all
/// pixels, the "after" image as the target, so the two rankings can be compared.
fn pairs(dir: &Path) {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.unwrap().file_name().to_string_lossy().strip_suffix("_after.jpg").map(String::from))
        .collect();
    names.sort();
    let mut rows = Vec::new();
    for name in &names {
        let load = |suffix: &str| {
            let img = image::open(dir.join(format!("{name}_{suffix}.jpg"))).unwrap();
            img.resize_exact(768, (768 * img.height() / img.width()).max(1), image::imageops::FilterType::Triangle)
                .to_rgba8()
        };
        let (input, truth) = (load("before"), load("after"));
        let (w, h) = (input.width() as usize, input.height() as usize);
        let sh = (h as f32 * ANALYSIS as f32 / w as f32).round() as u32;
        let small = image::imageops::resize(&input, ANALYSIS, sh, image::imageops::FilterType::Triangle);
        let (sw, sh) = (ANALYSIS as usize, sh as usize);
        let weight = vec![255u8; w * h];
        let mut scores = vec![score_pixels(&rgba(&input), &rgba(&truth), &weight)];
        for algorithm in Algorithm::ALL {
            // No depth-model output for these: that method falls back to the estimated range.
            let analysis = analyze_with_range(algorithm, &small, sw, sh, None);
            let range = RangeMap::for_correction(&small, sw, sh, &analysis.correction);
            let fusion = uwcc_core::fusion::maps(&small, sw, sh, &analysis.correction);
            let mut buf = rgba(&input);
            apply_rgba8_with(&mut buf, w, &analysis.correction, &Adjustments::default(), Some(&range), Some(&fusion));
            scores.push(score_pixels(&buf, &rgba(&truth), &weight));
        }
        rows.push(Row {
            water: name.clone(),
            depth: String::new(),
            scores,
            images: vec![],
            size: (w, h),
            name: name.clone(),
        });
    }
    let refs: Vec<&Row> = rows.iter().collect();
    table("Reference pairs: mean RMSE", &refs, &names, |r| r.water.clone(), |s| s.rmse);
    table("Reference pairs: RMSE after matching exposure", &refs, &names, |r| r.water.clone(), |s| s.rmse_exp);
    table("Reference pairs: ΔE after matching exposure", &refs, &names, |r| r.water.clone(), |s| s.delta_e);
    table("Reference pairs: chroma relative to the target", &refs, &names, |r| r.water.clone(), |s| s.chroma);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [cmd, dir] if cmd == "pairs" => pairs(Path::new(dir)),
        [cmd, out, cleans @ ..] if cmd == "make" => make(Path::new(out), cleans),
        [cmd, dir, rest @ ..] if cmd == "score" => score(Path::new(dir), rest.first().map(|s| s.as_str())),
        _ => panic!("usage: synthetic make OUT_DIR CLEAN.png... | synthetic score DIR [SHEET.jpg]"),
    }
}
