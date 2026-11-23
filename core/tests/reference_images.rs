//! Regression tests against the reference pairs in `testdata/photos`.
//!
//! The "after" images are the target look. The thresholds record how close
//! the automatic correction currently gets; they guard against regressions
//! and are not a claim that the targets are matched exactly.

use std::path::PathBuf;

use uwcc_core::reference::apply_rgba8;
use uwcc_core::{analyze_srgb8, Adjustments};

const WIDTH: u32 = 256;

fn load(name: &str) -> (Vec<u8>, u32, u32) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testdata/photos").join(name);
    let img = image::open(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())).to_rgba8();
    let h = (img.height() as f32 * WIDTH as f32 / img.width() as f32).round() as u32;
    let small = image::imageops::thumbnail(&img, WIDTH, h);
    (small.into_raw(), WIDTH, h)
}

/// Root-mean-square difference per channel, on 0..1 sRGB values.
fn rmse(a: &[u8], b: &[u8]) -> [f32; 3] {
    let mut sum = [0.0f64; 3];
    for (p, q) in a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0.iter()) {
        for ch in 0..3 {
            let d = (p[ch] as f64 - q[ch] as f64) / 255.0;
            sum[ch] += d * d;
        }
    }
    let n = (a.len() / 4) as f64;
    [(sum[0] / n).sqrt() as f32, (sum[1] / n).sqrt() as f32, (sum[2] / n).sqrt() as f32]
}

fn corrected(name: &str) -> (Vec<u8>, Vec<u8>, uwcc_core::Analysis) {
    let (before, _, _) = load(name);
    let analysis = analyze_srgb8(&before);
    let mut out = before.clone();
    apply_rgba8(&mut out, &analysis.correction, &Adjustments::default());
    (before, out, analysis)
}

fn check_pair(name: &str, max_mean_rmse: f32) {
    let (before, out, analysis) = corrected(&format!("{name}_before.jpg"));
    let (target, _, _) = load(&format!("{name}_after.jpg"));
    let e = rmse(&out, &target);
    let untouched = rmse(&before, &target);
    let mean = (e[0] + e[1] + e[2]) / 3.0;
    let mean_untouched = (untouched[0] + untouched[1] + untouched[2]) / 3.0;
    println!(
        "{name}: rmse {e:?} mean {mean:.4} (uncorrected {mean_untouched:.4}) depletion {:.2} scene {:.2}",
        analysis.depletion, analysis.scene_fraction
    );
    assert!(analysis.depletion > 0.9, "{name}: red should be detected as depleted");
    assert!(mean < max_mean_rmse, "{name}: mean rmse {mean:.4} exceeds {max_mean_rmse}");
    assert!(mean < 0.35 * mean_untouched, "{name}: correction should remove most of the difference to the target");
}

#[test]
fn turtle_matches_target() {
    check_pair("turtle", 0.035);
}

#[test]
fn dolphins_match_target() {
    check_pair("dolphins", 0.05);
}

#[test]
fn coral_matches_target() {
    check_pair("coral", 0.065);
}

/// Open water must stay blue: the correction must not balance the whole frame to grey.
#[test]
fn coral_water_stays_blue() {
    let (_, out, _) = corrected("coral_before.jpg");
    // Top-left corner of the frame is open water.
    let (w, h) = (WIDTH as usize, out.len() / 4 / WIDTH as usize);
    let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
    for y in 0..h / 6 {
        for x in 0..w / 6 {
            let p = &out[(y * w + x) * 4..];
            r += p[0] as u32;
            g += p[1] as u32;
            b += p[2] as u32;
        }
    }
    assert!(b > g && g > r, "water should be blue > green > red, got r={r} g={g} b={b}");
    assert!(b as f32 > 1.3 * g as f32, "water should be clearly blue, got g={g} b={b}");
}

/// A flash photo is already well coloured: the automatic result must be close to no change.
#[test]
fn flash_photo_is_left_alone() {
    let (before, out, analysis) = corrected("coral_flash.jpg");
    let e = rmse(&before, &out);
    println!("flash: change {e:?} depletion {:.2}", analysis.depletion);
    assert!(e.iter().all(|&v| v < 0.02), "flash photo changed too much: {e:?}");
}
