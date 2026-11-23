//! Renders a contact sheet: every image given on the command line, corrected
//! by every method, side by side (original first).
//!
//! `cargo run --release --example sheet -- out.jpg a.jpg b.jpg ...`
//!
//! The method that takes its range from a depth model uses the file
//! `IMAGE.disparity` when there is one (little-endian: width and height as
//! u32, then one f32 per pixel, larger = nearer); otherwise it falls back to
//! the range estimated from colour, like the app does for video.

use uwcc_core::reference::apply_rgba8;
use uwcc_core::{analyze_with_range, Adjustments, Algorithm, RangeMap};

const WIDTH: u32 = 256;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [out, inputs @ ..] = args.as_slice() else { panic!("usage: sheet OUT.jpg IMAGE...") };
    let mut rows = Vec::new();
    for path in inputs {
        let img = image::open(path).unwrap_or_else(|e| panic!("{path}: {e}")).to_rgba8();
        let h = (img.height() as f32 * WIDTH as f32 / img.width() as f32).round() as u32;
        let small = image::imageops::thumbnail(&img, WIDTH, h);
        let (w, h) = (WIDTH as usize, h as usize);
        let map = RangeMap::from_srgb8(&small, w, h);
        let depth = std::fs::read(format!("{path}.disparity")).ok().map(|bytes| {
            let int = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
            let values: Vec<f32> = bytes[8..].as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
            RangeMap::from_disparity(&values, int(0), int(4))
        });
        let mut row = vec![small.to_vec()];
        for algorithm in Algorithm::ALL {
            let start = std::time::Instant::now();
            let range = if algorithm == Algorithm::SeaThruDepth { depth.as_ref().unwrap_or(&map) } else { &map };
            let analysis = analyze_with_range(algorithm, &small, w, h, Some(range));
            let elapsed = start.elapsed();
            let mut buf = small.to_vec();
            apply_rgba8(&mut buf, w, &analysis.correction, &Adjustments::default(), Some(range));
            println!("{path} {algorithm:?} {elapsed:.1?} {:?}", analysis.correction);
            row.push(buf);
        }
        // The range maps themselves, as grey images: from colour, then from the depth model.
        for map in [Some(&map), depth.as_ref()].into_iter().flatten() {
            let mut grey = Vec::with_capacity(w * h * 4);
            for i in 0..w * h {
                let v =
                    (map.sample(((i % w) as f32 + 0.5) / w as f32, ((i / w) as f32 + 0.5) / h as f32) * 255.0) as u8;
                grey.extend_from_slice(&[v, v, v, 255]);
            }
            row.push(grey);
        }
        rows.push((row, h));
    }
    let columns = rows.iter().map(|r| r.0.len()).max().unwrap_or(0);
    let total: usize = rows.iter().map(|r| r.1).sum();
    let mut sheet = image::RgbImage::new(WIDTH * columns as u32, total as u32);
    let mut top = 0;
    for (row, h) in rows {
        for (column, buf) in row.iter().enumerate() {
            for (i, p) in buf.as_chunks::<4>().0.iter().enumerate() {
                let (x, y) = (i % WIDTH as usize + column * WIDTH as usize, i / WIDTH as usize + top);
                sheet.put_pixel(x as u32, y as u32, image::Rgb([p[0], p[1], p[2]]));
            }
        }
        top += h;
    }
    sheet.save(out).unwrap_or_else(|e| panic!("{out}: {e}"));
}
