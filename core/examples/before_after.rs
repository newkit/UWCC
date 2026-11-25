//! Renders one before/after image per photo with UWCC's default method:
//! the original on the left, the corrected result on the right. Used for the
//! examples in the README.
//!
//! `cargo run --release --example before_after -- OUT_DIR IMAGE...`
//!
//! Each `IMAGE` gives `OUT_DIR/<name>.jpg`, where `<name>` is the file name
//! without `_before` and the extension.

use uwcc_core::reference::apply_rgba8_with;
use uwcc_core::{analyze, Adjustments, Algorithm, RangeMap};

/// Width of each half of the output.
const HALF: u32 = 640;
/// Width of the copy the analysis looks at, as in the app.
const ANALYSIS: u32 = 256;
const GAP: u32 = 6;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [out_dir, inputs @ ..] = args.as_slice() else { panic!("usage: before_after OUT_DIR IMAGE...") };
    for path in inputs {
        let img = image::open(path).unwrap_or_else(|e| panic!("{path}: {e}")).to_rgba8();
        let scaled = |width: u32| {
            let h = (img.height() as f32 * width as f32 / img.width() as f32).round() as u32;
            image::imageops::resize(&img, width, h, image::imageops::FilterType::Lanczos3)
        };
        let small = scaled(ANALYSIS);
        let (sw, sh) = (small.width() as usize, small.height() as usize);
        let correction = analyze(Algorithm::Uwcc, &small, sw, sh).correction;

        let before = scaled(HALF);
        let (w, h) = (before.width() as usize, before.height() as usize);
        let mut after = before.to_vec();
        let range = RangeMap::for_correction(&small, sw, sh, &correction);
        let fusion = uwcc_core::fusion::maps(&before, w, h, &correction);
        apply_rgba8_with(&mut after, w, &correction, &Adjustments::default(), Some(&range), Some(&fusion));

        let mut sheet = image::RgbImage::from_pixel(HALF * 2 + GAP, h as u32, image::Rgb([255, 255, 255]));
        for (i, px) in before.pixels().enumerate() {
            let (x, y) = ((i % w) as u32, (i / w) as u32);
            sheet.put_pixel(x, y, image::Rgb([px[0], px[1], px[2]]));
            let a = &after[i * 4..i * 4 + 3];
            sheet.put_pixel(HALF + GAP + x, y, image::Rgb([a[0], a[1], a[2]]));
        }
        let stem = std::path::Path::new(path).file_stem().unwrap().to_string_lossy();
        let name = stem.trim_end_matches("_before");
        let out = std::path::Path::new(out_dir).join(format!("{name}.jpg"));
        let file = std::fs::File::create(&out).unwrap_or_else(|e| panic!("{}: {e}", out.display()));
        image::codecs::jpeg::JpegEncoder::new_with_quality(file, 85).encode_image(&sheet).unwrap();
        println!("{}", out.display());
    }
}
