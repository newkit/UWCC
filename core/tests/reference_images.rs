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
    apply_rgba8(&mut out, WIDTH as usize, &analysis.correction, &Adjustments::default(), None);
    (before, out, analysis)
}

fn check_pair(name: &str, max_mean_rmse: f32, min_depletion: f32, max_remaining: f32) {
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
    assert!(analysis.depletion > min_depletion, "{name}: red should be detected as depleted");
    assert_eq!(analysis.strength, 1.0, "{name}: the full correction should apply");
    assert!(mean < max_mean_rmse, "{name}: mean rmse {mean:.4} exceeds {max_mean_rmse}");
    assert!(
        mean < max_remaining * mean_untouched,
        "{name}: correction should remove most of the difference to the target"
    );
}

#[test]
fn turtle_matches_target() {
    check_pair("turtle", 0.035, 0.9, 0.35);
}

#[test]
fn dolphins_match_target() {
    check_pair("dolphins", 0.05, 0.9, 0.35);
}

#[test]
fn coral_matches_target() {
    check_pair("coral", 0.065, 0.9, 0.35);
}

/// A frame of shadow with a few sunlit parts and some red left. The target
/// is brighter and has more contrast than the pipeline reaches, so the
/// thresholds are wider than for the other pairs.
#[test]
fn bannerfish_approaches_target() {
    check_pair("bannerfish", 0.105, 0.5, 0.75);
}

/// The same frame must come out brighter than it went in: its highlights are
/// already bright, so only the tone curve can lift it.
#[test]
fn bannerfish_is_lifted_by_the_tone_curve() {
    let (before, out, analysis) = corrected("bannerfish_before.jpg");
    assert!(analysis.correction.tone > 2.0, "tone {}", analysis.correction.tone);
    let median = |buf: &[u8]| {
        let mut green: Vec<u8> = buf.as_chunks::<4>().0.iter().map(|p| p[1]).collect();
        green.sort_unstable();
        green[green.len() / 2]
    };
    assert!(median(&out) > median(&before) + 15, "median green {} -> {}", median(&before), median(&out));
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
    println!("flash: change {e:?} depletion {:.2} strength {:.2}", analysis.depletion, analysis.strength);
    assert!(e.iter().all(|&v| v < 0.02), "flash photo changed too much: {e:?}");
}

/// Every selectable method must produce usable parameters and a visible image on real photos.
#[test]
fn every_method_gives_a_sane_result() {
    use uwcc_core::{analyze, Algorithm, RangeMap};
    for name in
        ["turtle_before.jpg", "dolphins_before.jpg", "coral_before.jpg", "coral_flash.jpg", "bannerfish_before.jpg"]
    {
        let (before, w, h) = load(name);
        for algorithm in Algorithm::ALL {
            let analysis = analyze(algorithm, &before, w as usize, h as usize);
            assert!(
                analysis.correction.to_array().iter().all(|v| v.is_finite()),
                "{name} {algorithm:?}: parameters not finite"
            );
            let map = RangeMap::for_correction(&before, w as usize, h as usize, &analysis.correction);
            assert!(map.data.iter().all(|v| (0.0..=1.0).contains(v)), "{name} {algorithm:?}: map out of bounds");
            let mut out = before.clone();
            let fusion = uwcc_core::fusion::maps(&before, w as usize, h as usize, &analysis.correction);
            uwcc_core::reference::apply_rgba8_with(
                &mut out,
                w as usize,
                &analysis.correction,
                &Adjustments::default(),
                Some(&map),
                Some(&fusion),
            );
            let mean = out.as_chunks::<4>().0.iter().map(|p| p[0] as f64 + p[1] as f64 + p[2] as f64).sum::<f64>()
                / (3.0 * (out.len() / 4) as f64);
            println!("{name} {algorithm:?}: mean level {mean:.0}");
            assert!((25.0..=230.0).contains(&mean), "{name} {algorithm:?}: mean level {mean:.0} is not a usable image");
        }
    }
}
