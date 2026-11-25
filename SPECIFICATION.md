# UWCC — UnderWater Color Correction: Specification

Status: **draft** — the technology choice in §5 is confirmed by the owner,
subject to the outcome of the device spike in milestone M0.

## 1. Purpose

Water absorbs light unevenly: red disappears within the first few metres, then
orange and yellow, leaving photos and videos blue-green, flat and hazy. UWCC
restores natural colour with one tap, and offers manual controls for
fine-tuning. It runs on iOS, Android and the web from one codebase.

Target users: snorkellers and recreational divers shooting with phones in
housings, action cameras and compact cameras, who do not want to learn a full
photo or video editor.

## 2. Scope

### In scope for v1

- Open one or many photos and videos from the gallery / file picker (web: also drag and drop).
- Batch processing: correct a mixed selection of photos and videos in one go (§7).
- Configurable output location: next to the source (default) or overwriting the source (§7).
- Automatic correction computed from the content.
- Manual adjustment with live preview, for photos and for playing video.
- Before/after comparison.
- Export: photos at full resolution, videos at source resolution and frame
  rate with the original audio.
- System share sheet for single results.
- Fully on-device: no account, no upload, works offline.

### Out of scope for v1 (candidates for later)

- Video editing beyond correction (trim, cut, join, titles, music).
- True dehazing and local contrast enhancement (spatial filtering).
- Sharpening control (default off; see §6.5 on why it must not be on by default).
- HDR / 10-bit output; v1 exports 8-bit SDR.
- RAW (DNG etc.) photo input.
- Saved presets, per-dive profiles, LUT (.cube) export for other editors.
- ML-based enhancement or depth estimation.
- In-app camera capture.
- Cloud sync, accounts, social features.

## 3. Functional requirements

| ID | Requirement |
|----|-------------|
| F1 | Import JPEG and PNG everywhere; HEIC wherever the platform can decode it. |
| F2 | Import MP4/MOV with H.264 everywhere; HEVC wherever the device can decode it. Unsupported files give a clear message, not a failure mid-export. |
| F3 | Respect EXIF orientation (photos) and rotation metadata (videos). |
| F4 | Auto-correct runs on import and yields a parameter set, not baked pixels, so every edit stays non-destructive. |
| F5 | For video, auto-correct samples a frame every 1-2 seconds and yields a smoothed, interpolated series of parameter sets, so the correction follows depth and light changes without flicker. |
| F6 | Manual controls: correction strength, temperature, tint, exposure, contrast, saturation, vibrance; reset per control and reset all. Colour modes (Natural, Vivid, Deep, Soft, Warm, Cool, Black & white) set those sliders to named positions (§6.4). |
| F7 | Neutral picker: tap something that should be white/grey to set white balance (on the current frame for video). |
| F8 | Before/after: press-and-hold for the original, plus a draggable split view. |
| F9 | Video preview: play, pause, scrub, with the correction applied live. |
| F10 | Photo export as JPEG (quality selectable) at original resolution, EXIF preserved, orientation normalised. |
| F11 | Video export as MP4 at source resolution and frame rate, audio copied unchanged, capture-time metadata preserved; progress shown, cancellable. |
| F12 | By default the original file is never modified; results are written next to it. Overwriting the source happens only when the user has enabled that setting (§7.3). |
| F14 | Multi-select of photos and videos, mixed, in one selection. |
| F15 | Batch run: every selected item is auto-corrected and exported without further interaction; per-item and overall progress; cancellable; one failed item does not stop the rest; a summary lists what succeeded, what failed and why. |
| F16 | Before starting a batch the user may open any item, adjust it, and optionally apply those manual adjustments to all items. Auto-correct parameters stay per item. |
| F17 | Settings, stored on the device: output location (next to source / overwrite source), file-name suffix, JPEG quality, video quality. |
| F18 | Files already produced by UWCC are recognised (metadata tag, and the suffix) and skipped by default, so nothing is corrected twice. |
| F13 | Zoom and pan in the photo editor. |
| F19 | The correction method is selectable per item in the editor (§6.7): UWCC's own (default), and re-implementations of published methods for comparison. The choice is applied in preview and export, for photos and videos, and can be applied to all items of a batch. A setting chooses the method new items start with, and queue thumbnails show each item's method and adjustments. |

## 4. Non-functional requirements

| ID | Requirement |
|----|-------------|
| N1 | Slider changes update the preview within one frame on mid-range phones (GPU path). |
| N2 | Video preview plays 1080p30 without dropped frames on mid-range phones. |
| N3 | Auto-correct analysis: under 500 ms for a 12 MP photo. For video, a corrected preview of the first frame within 1 s; analysis of the rest of the clip runs in the background and must finish before export starts. |
| N4 | Photo export: under 3 s for 12 MP; 48 MP must export without running out of memory. |
| N5 | Video export: at least real-time for 1080p30 on mid-range phones; 4K where the device's hardware codec supports it. Memory use is independent of clip length (streaming). |
| N6 | The same input and parameters produce visually identical output on all three platforms. |
| N7 | Standalone: there is no backend. No server-side processing, API, account system or database. The mobile apps bundle everything and never need the network. The web version needs only static file hosting to deliver the app, and works offline after the first load. No analytics in v1. |
| N8 | Usable one-handed on a phone; responsive layout for tablet and desktop web. |
| N9 | Controls are labelled for screen readers; the interface is in English; text is kept in one place so other languages can be added later. |

## 5. Technology decision

### What the app demands

1. One correction implementation shared by all platforms (N6).
2. A GPU shader path for live preview of photos and video (N1, N2).
3. Hardware video decode and encode. Software codecs are too slow on phones
   and bring patent and licence problems; this rules out an ffmpeg-in-WASM
   approach.
4. Large-photo handling and native gallery / share access.
5. A first-class web target.

Video is what dominates the cost. The colour maths is small; a pipeline of
demux → hardware decode → shader → hardware encode → mux, plus a corrected
live player, is not. Whatever stack is chosen, the question is how many times
that pipeline must be built.

### Where WebAssembly fits

WebAssembly is the right tool for part of the processing, not all of it.

| Work | Best place | Why |
|------|-----------|-----|
| Per-pixel correction (preview, export, every video frame) | GPU shader | A 4K frame is 8 MP, 30 times a second. A shader does this trivially; WASM on the CPU would also pay for copying every frame off and back onto the GPU. |
| Analysis: statistics → correction parameters | **WASM** | Small input, branchy numeric code, runs once. Easy to test natively. |
| Decode / encode of large photos, EXIF | **WASM** | Avoids browser canvas size limits by streaming tiles through the encoder. |
| Video decode / encode | Platform hardware codecs (WebCodecs) | See point 3 above. |

A WASM module only runs inside a browser engine. So "processing in WASM"
pairs naturally with a web-technology app, where the same module runs in the
browser and in the WebView of the mobile apps.

### Options considered

| Option | Video pipeline built | Strengths | Weaknesses |
|--------|---------------------|-----------|------------|
| **Web stack: TypeScript + WebGL2 + WebCodecs + Rust/WASM core, packaged with Capacitor** | Once | Everything written once; best web experience; app is also a PWA; WASM core as asked | Depends on WebCodecs behaving in iOS and Android WebViews; WebView memory limits; export stops if the app is backgrounded; weak HDR story |
| Flutter + native video plugins | Three times (AVFoundation, Media3, WebCodecs) | Most robust video on mobile; background export; native feel | Three pipelines and three corrected players to build and keep identical; needs Swift, Kotlin and JS alongside Dart |
| React Native (Expo) + Skia + native video | Three times | TypeScript UI | Same triple video work as Flutter, weaker web target |
| Kotlin Multiplatform + Compose | Two to three times | Native performance | Web and shader support least mature |
| Two native apps + web app | Three times, plus three UIs | Best platform fidelity | Everything written three times |

### Recommendation: web stack with a Rust/WASM core, packaged with Capacitor

This reverses the earlier Flutter recommendation, which was made for a
photo-only app. With video in scope, WebCodecs is the only route where the
video pipeline, the shader and the live player are written once. The earlier
objection to this stack — canvas size limits for large photos in a WebView —
is addressed by rendering in tiles and encoding in WASM.

The risk is concentrated in one place: how reliably WebCodecs works inside the
mobile WebViews (codec coverage, 4K, memory, speed). That is not verified yet
and must be measured on real devices before anything else is built — this is
milestone M0 and it is a go / no-go gate.

Fallback if M0 fails on a platform: keep the web app, and replace only video
export on that platform with a native Capacitor plugin (AVFoundation on iOS,
Media3 Transformer on Android) driven by the same correction parameters. If it
fails on both, Flutter with native video becomes the better choice.

### Proposed stack

| Concern | Choice |
|---------|--------|
| UI | TypeScript, React, Vite |
| Core (analysis, parameters, CPU reference) | Rust, compiled to WASM with wasm-bindgen (built with wasm-pack); run in a Web Worker |
| JPEG encoding | MozJPEG compiled to WASM (`@jsquash/jpeg`, Apache-2.0), in the same worker |
| Preview and export rendering | WebGL2, one GLSL ES 3.0 fragment shader (WebGPU can come later) |
| Video decode / encode | WebCodecs |
| Video container demux / mux | Mediabunny (MPL-2.0, used unmodified) |
| Video preview | `<video>` element as shader input |
| Mobile packaging | Capacitor (iOS, Android); plugins for gallery save and share |
| Source repository | `github.com/newkit/UWCC` (public) |
| Web delivery | GitHub Pages from that repository, deployed by a GitHub Actions workflow on release; installable PWA with offline cache. The app is served under the `/UWCC/` path, so all asset URLs must be relative to a configurable base |
| Tests | `cargo test` for the core; Vitest for TS; shader-vs-reference image comparison; Playwright for end-to-end |
| CI | GitHub Actions: lint, tests, web build |

## 6. Correction algorithm

### 6.1 What goes wrong underwater

Two separate effects, with different cures:

| Effect | Cause | Looks like | Cure |
|--------|-------|-----------|------|
| Colour cast | Water absorbs red first, then orange and yellow; the loss grows with depth and with distance to the subject | Blue or green image, missing reds | Rebuild and rebalance the colour channels (a per-pixel colour mapping) |
| Haze | Particles scatter light back into the lens | Low contrast, milky veil that gets worse with distance | Contrast stretch; true dehazing needs spatial filtering |

The correction therefore does not so much remove blue as restore the missing
red and then rebalance. v1 targets the colour cast and uses a levels stretch
against haze. True dehazing is a later option.

Hard limits that no algorithm removes:

- Where red is completely gone (deep, no lights) it can only be estimated
  from the other channels: plausible, not true, colour.
- The red channel of 8-bit JPEG and compressed video is noisy and blocky;
  strong red gain makes that visible. Gain must be capped.
- The loss depends on distance, so one global correction cannot be exact for
  near and far objects at once. Distant open water staying blue is expected
  and desirable.

### 6.2 Approaches surveyed

| Family | Examples | Works per pixel (shader, video-ready) | Verdict |
|--------|----------|----------------------------------------|---------|
| White balance and levels | Grey-world, per-channel histogram stretch | Yes | Baseline; fails when red is nearly absent, because it multiplies noise |
| Red rebuilt from other channels + levels, as one colour matrix | `nikolajbech/underwater-image-color-correction` (JS), `bornfree/dive-color-corrector` (Python, video) | Yes | Closest to what divers expect from existing tools; simple and fast. Both implementations are GPL-3.0 |
| Red-channel compensation + grey-world | Ancuti et al. 2018, white-balance stage: `R' = R + a * (mean(G) - mean(R)) * (1 - R) * G` | Yes | Adapts per pixel: bright or already-red areas get less, so less overcorrection |
| Multi-scale fusion | Ancuti et al. 2012 / 2018, full method | No (spatial pyramids) | Better local contrast, far more expensive; later option for photos |
| Physical model, dehazing priors | UDCP, IBLA, red-channel prior | No | Slow, fragile, artefacts on video |
| Physical model with depth | Sea-thru (Akkaynak and Treibitz 2019) | No, and needs a depth map and ideally RAW | Best quality in research, not applicable to ordinary phone and action-camera files. Licence terms not checked |
| Deep learning | WaterNet, FUnIE-GAN and successors | No | Heavy model download, unpredictable colours, hard to make identical across platforms; not for v1 |

Published benchmark scores are not a reliable guide: surveys report that
results depend strongly on the test setup, and that the no-reference metrics
(UCIQE, UIQM) reward images that look bad. Selection will be by eye on real
footage, with the UIEB dataset (890 underwater images with reference
versions) as a secondary check.

### 6.3 How the existing open-source matrix method works

Read from the source of the two GPL projects, to understand the idea:

1. Shrink the image and take the average colour.
2. If average red is below a threshold (60 of 255), build a new red channel as
   a weighted mix of red, green and blue, increasing the borrowed share until
   the average reaches the threshold or a maximum is hit.
3. Take histograms of new red, green and blue, and pick a low and high point
   per channel.
4. Stretch each channel between those points.
5. Express all of it as one 4x5 colour matrix; only the red row mixes channels.
6. Video: compute a matrix every 2 seconds and interpolate linearly between
   them for the frames in between.

Its weaknesses: fixed magic constants, works on gamma-encoded values, no
protection for subjects lit by a strobe or video light, nothing specific for
green water, and red noise is amplified without limit.

Licence decision: UWCC is dual-licensed under MIT or Apache-2.0, at the
user's choice (`LICENSE-MIT`, `LICENSE-APACHE`), and does not use GPL-3.0 code. Nothing from these two
projects is copied or ported; UWCC implements its own method, derived from the
published literature and from measurements on its own reference images (§6.5).
Dependencies must be checked for licence compatibility before they are added.

### 6.4 UWCC design

**Representation.** A correction is a small set of numbers applied per pixel:

1. red compensation (strength, and the mix of green and blue it borrows from),
2. a 3x3 colour matrix plus offset (white balance and channel mixing),
3. per-channel black and white points,
4. the manual adjustments (temperature, tint, exposure, contrast, saturation, vibrance),
5. a global `strength` blending original and corrected.

This covers the matrix method and the Ancuti-style compensation with the same
shader, so the two can be compared by changing only the analysis. As built,
the representation also carries a flag for working on encoded instead of
linear values and two range-dependent tables per channel; see §6.7.

**Analysis (WASM, on a ~256-512 px copy).** Work in linear light. Measure
channel means and histograms; estimate how depleted red is; derive the
compensation, the white balance (grey-world on the compensated statistics,
with limits), and the levels from histogram percentiles. Safeguards: cap the
red gain, reduce the correction when red is already healthy (shallow water,
strobe or video light, red filter on the lens), and never push a channel into
clipping across large areas.

**Video.** Analyse a frame every 1-2 seconds, smooth the resulting parameter
sets over time to prevent flicker, and interpolate between them per frame.
This follows depth and lighting changes within a clip at no extra per-frame
cost. Manual adjustments apply on top for the whole clip.

**Application (GPU).** One fragment shader, identical for photo preview, photo
export tiles, video preview and video export.

**Reference implementation.** The same maths in Rust on a pixel buffer; the
ground truth for tests.

**Colour modes.** A colour mode is a named position of the look sliders
(temperature, tint, exposure, contrast, saturation, vibrance) and nothing
else: `COLOR_MODES` in `web/src/model.ts`. Choosing a mode moves the
sliders; the mode shown for a file is read back from where its sliders
stand, and reads "Custom" once one of them is moved. Correction strength and
the neutral point are not part of a mode. "Natural" leaves all sliders at
zero and is the default; the mode new files start with is a setting. The
modes are a matter of taste, not of measurement, with one exception: the
"Vivid" values were chosen where they bring the bannerfish pair closest to
its target (§6.5). Vibrance is saturation scaled by how colourless a pixel
is (one minus the spread of its encoded channels), so muted colours gain
and strong ones are hardly moved.

### 6.5 Findings from the owner's reference pairs

`testdata/photos/` holds six before/after pairs supplied by the owner
(`dolphins_*`, `turtle_*`, `coral_*`, since 2026-11-24 `bannerfish_*`, and
since 2026-11-25 `batfish_*` and `surface_*`;
1500x2000 and 2000x1500 JPEG) and one flash photo of the coral scene
(`coral_flash.jpg`). The "after" images are the target look. Measured on
the first three:

- **Red is absent in the originals**: mean red is 0.3 % and 1.7 % of full
  scale (0.7 % in the coral pair). The corrected red is therefore built almost
  entirely from green, minus a share of blue. In linear light the pairs fit
  `R' ≈ k * (G - c * B)` with `c` between 0.08 and 0.145.
- **A single global colour transform reproduces the target**: a fitted 3x4
  matrix explains 97-99.7 % of the variance per channel, with no dependence on
  position in the image. This confirms the representation in §6.4; no spatial
  processing is needed for this look.
- **Green** is close to a plain gain and offset. **Blue** is reduced: its
  black point is raised substantially and its gain is below that of the other
  channels. The result is balanced only partly towards grey: whites come out
  warm, shadows and open water stay blue.
- **The targets are much grainier than the originals** (3 to 15 times more
  fine-detail energy). The owner confirmed this is an unwanted side effect.
  The tool that produced them applies sharpening at a medium default setting,
  which is the likely cause: sharpening a rebuilt, noisy red channel.
  UWCC targets the colours of these references, not their grain: red gain is
  capped and noise amplification is measured as part of M1.

A first blind prototype (no access to the target) estimates the water colour
from the pixels with the lowest green/blue ratio, rebuilds red as green minus
that share of blue, subtracts a per-channel black point, and applies partial
grey-world gains with a common white scale. Results:

- `turtle`, `dolphins` (scene fills the frame): right region, but cooler,
  flatter and less saturated than the targets.
- `coral` (half the frame is open water): **fails**. Grey-world balancing
  sees all that blue, over-suppresses the blue channel, and turns the reef
  yellow and the water grey-purple. The target keeps the water clearly blue.

`coral_flash.jpg` shows nearly the same scene as the coral pair, taken with
flash. It has no "after" version; it serves two purposes:

- **Ground truth.** The large soft coral is pink-red. In the unlit shot it
  contains no red signal at all, and the reference correction renders it
  grey-brown. No correction based on the image alone can know it was red:
  this is the limit described in §6.1, and UWCC should not be judged against
  it. Rebuilt red restores neutral tones (sand, rock, white coral), not the
  true colour of red subjects.
- **Must-not-harm case.** The photo is already well coloured in the lit
  foreground (mean red 26 % of full scale, against 0.7 % unlit; red is the
  strongest channel in 11 % of pixels, against none). The prototype correctly
  skips the red rebuild, but its balancing step still darkens the image and
  shifts it yellow-green. The expected automatic result here is close to no
  change. The unlit background stays blue; a global correction cannot treat
  flash-lit and unlit regions differently, and should not try.

Conclusion for M1: the measured health of the red channel must scale the
whole correction, not only the red rebuild. And white balance must not be
estimated from the whole frame.
Open water has to be excluded or down-weighted (it is identifiable by its low
green/blue ratio and low detail), and the balance taken from the nearer,
brighter scene content. Three pairs, all deep-blue water without red, are
still too few to tune on.

**Implemented method** (`core/src/analysis.rs`, constants at the top of the
file). In linear light, on a copy of about 256 px:

1. Red health, measured two ways:
   - *Depletion*: mean red relative to mean green. Below half of green, red
     is increasingly rebuilt from green; at half or more, the real red
     channel is used.
   - *Cast*: the red/green ratio of the warmest 5 % of the brighter pixels.
     If even those lack red (ratio at or below 0.6), the full correction is
     applied. If they are properly coloured (0.95 or above), nothing is
     applied. This is what leaves flash and shallow shots alone.
2. Water colour: the 2nd percentile of the green/blue ratio.
3. Rebuilt red: green minus 1.5 x that ratio x blue. Where the frame shows
   no open water, only 60 % of that subtraction is used (see below).
4. Black points: 0.5th percentile for green and blue; for red between the
   0.5th (real red) and the 20th (fully rebuilt red, so open water and deep
   shadows get no red), by depletion and by how much open water the frame
   has.
5. Channel balance on scene content only: pixels are weighted by where their
   green/blue ratio lies between water and scene; open water gets weight 0.
6. Common white level (scene highlights to 0.68 linear), gains capped at 8.
7. Tone: if the median luminance of the result is below 0.09 (linear), the
   tone curve of the pipeline (§6.7) lifts it to that level, by at most a
   factor of 4 at black.

Mean error against the targets, per channel RMS on 0..1 sRGB values, with the
uncorrected original in brackets: turtle 0.021 (0.235), dolphins 0.035
(0.299), coral 0.050 (0.236), bannerfish 0.095 (0.163), batfish 0.050
(0.189), surface 0.058 (0.309). The flash photo is
left unchanged. `core/tests/reference_images.rs` holds regression thresholds
a little above these numbers.

Step 7 came from the fourth pair (`bannerfish`: a reef mostly in shadow
with a few sunlit rocks, red at about a fifth of green). Its highlights
are already bright, so gains cannot brighten it; steps 1 to 6 alone made it
darker than the original and further from the target than no correction at
all (0.208). The target lifts shadows and mid-tones about threefold and
keeps the highlights, which is what the tone curve does. The first three
pairs are bright enough to get little or no lift: turtle and dolphins are
unchanged, coral moved from 0.047 to 0.050 because its dark open water is
lifted slightly. What remains on the bannerfish pair: the target has deeper
blacks, more contrast and a more saturated blue than the pipeline produces.

That remainder was looked at for an automatic rule and none was found that
holds on all four pairs. Fitting contrast and saturation on top of the
automatic result per pair gives: turtle and coral want slightly less
saturation, dolphins slightly more, bannerfish much more (contrast +20 %,
saturation +45 %). Applying the tone curve to luminance or to the brightest
channel instead of per channel, and measuring the water colour on brighter
pixels only, moved the bannerfish error by less than 0.01 and made other
pairs worse. Contrast and colourfulness are therefore left to the user as
colour modes (§6.4): with "Vivid" the bannerfish error falls from 0.095 to
0.079, while the same mode moves turtle to 0.045 and coral to 0.085. The
violet cast of that photo's water in UWCC's result is not addressed.

The split into depletion and cast came from the first real video clip from
the owner (a reef seen from above, red at about a third of green, kept in
the git-ignored `testdata/local/`). An earlier version scaled the whole
correction by depletion and removed only a third of that clip's blue cast.
With the cast measure the sand comes out neutral and the corals brown, while
the first three pairs and the flash photo are unaffected. There is no target image
for this clip; the result was judged by eye.

The open-water measure came from the second clip from the owner (a reef
close up in blue-green water, no red at all, no open water; also in
`testdata/local/`). Steps 3 and 4 exist to keep open water blue. On this
clip the "water" was only the bluest part of the reef, and both steps
removed its red: the reef came out salmon-orange, sand and shadows
blue-grey. The frame now counts as having open water as the share of
water-weighted pixels (step 5) rises from 20 % to 45 %; below that the
subtraction is reduced and the high red black point is not used. The clip
comes out with beige reef and light grey sand; the first three pairs give exactly
the same numbers as before. Limit: a subject that fills most of the frame
in front of a little open water falls below that range, and its water then
gets some red and turns greyer.

The all-water rule came from the `surface_*` pair: a turtle seen from below
against the surface, so the whole frame is water and its green/blue ratio
hardly varies. Rebuilding red there gives the bluest pixels a negative red
value, the red black point (step 4) came out negative, and its offset added
red to every dark pixel: the turtle turned red-brown. A frame now counts as
water throughout as the relative spread of its green/blue ratio
(`(p90 - p2) / p90`) falls from 0.45 to 0.3; on such a frame no black point
is below zero. Error on the pair 0.087 before, 0.058 after. The target keeps
the water close to neutral grey, so the water is still balanced to grey
like any scene. An earlier version of the rule (one day, from a reference
of a different frame) balanced such water to light blue instead; the pixel
pair showed that to be wrong and it was removed. Clamping the black point
on every frame was tried as well: it made dolphins worse (0.035 to 0.048),
because there the negative red black point lifts the shadows the target
lifts too. All other pairs and clips have a spread of 0.58 or more and are
unchanged.

Caveat: the constants were tuned on six pairs, five of them from similar
deep-blue conditions, plus those two clips. They are a starting point and will need
revisiting with green water and more shallow footage. When the automatic
correction decides to apply nothing, the Correction slider cannot force it
on; that override is not built yet.

### 6.6 Validation plan (M1)

1. Collect real examples: unedited originals, covering shallow and deep, blue
   and green water, with and without lights, photos and clips. Where
   available, a version the owner considers well corrected as a target.
2. Prototype the candidates (plain white balance, matrix method, Ancuti-style
   compensation) in the Rust core and render contact sheets side by side.
3. Pick the default by eye together with the owner; tune the safeguards.
4. Freeze the chosen examples as regression images in `testdata/`.

### 6.7 Selectable methods

The editor offers the correction method as a drop-down (F19). All methods
produce parameters for the same per-pixel pipeline (`Correction` in
`core/src/model.rs`), so preview, tiled photo export, video export, batch and
the CPU reference work for every one of them without a second code path.
Every file is analysed by all methods at import, so switching is immediate.

The pipeline, per pixel: take the value encoded or in linear light; add red
and blue in proportion to green (compensation); optionally subtract
backscatter and multiply by an attenuation gain, both looked up by the
pixel's range or haze; apply a 3x4 matrix; optionally blend a
gamma-corrected and a sharpened version (fusion); in linear light, apply
the tone curve `x * t / (1 + (t - 1) * x)` per channel, which raises
shadows and mid-tones by up to the factor `t` and leaves white at white
(`t` = 1: no change; so far only UWCC's own method sets it); then the
manual adjustments as before.

| Method | Source | What is implemented | What is not |
|--------|--------|---------------------|-------------|
| UWCC | This project, §6.5 | Everything | |
| UWCC, always applied | This project | The same correction without the cast check of §6.5: applied in full on every frame. The manual override for files the check leaves uncorrected | |
| Hue-shift matrix | The idea of the GPL tools in §6.3. There is no paper | Red borrowed from green and blue by rotating the hue (the standard hue-rotation matrix of the W3C Filter Effects specification) until mean red reaches 60/255, at most 120 degrees; then each channel stretched between its 0.5th and 99.5th percentile. On encoded values | Written from the description in §6.3, not from the GPL sources; constants and the choice of levels are UWCC's, so results differ from those tools |
| Ancuti white balance | Ancuti, Ancuti, De Vleeschouwer, Bekaert: "Color Balance and Fusion for Underwater Image Enhancement", IEEE TIP 2018 | The white-balance stage: red compensation `r + (mean_g - mean_r)(1 - r) g`, blue compensation in green water, grey-world gains. On encoded values | The multi-scale fusion (gamma-corrected and sharpened inputs blended over Laplacian pyramids): spatial, not per-pixel |
| Sea-thru (estimated range) | Akkaynak, Treibitz: "Sea-thru: A Method for Removing Water from Underwater Images", CVPR 2019 | The paper's image formation model and estimation steps: backscatter fitted to the darkest 1 % of pixels in ten range bins; illuminant by local space average colour among neighbours of similar range; attenuation coefficient as a two-term exponential of range; recovery and grey-world balance. In linear light | **The range map.** The paper measures range with stereo or structure from motion. UWCC has one image and estimates relative range from colour (below). Also: 8-bit JPEG or video instead of linear RAW; a simpler attenuation fit; caps on the gains. Listed at the top of `core/src/seathru.rs` |
| Sea-thru (depth model) | The same, with range from a monocular depth network: Yang et al., "Depth Anything V2", 2024 (Small model, Apache-2.0) | As above, on a range map made from the network's output (below). Photos only | For video it falls back to the range estimated from colour: the network is too slow to run on every frame. The network gives relative depth, not metres |
| UDCP haze removal | Drews Jr, do Nascimento, Moraes, Botelho, Campos: "Transmission Estimation in Underwater Single Images", ICCV Workshops 2013 | The underwater dark channel prior: transmission from the minimum of green and blue over a patch, relative to the water colour found where that minimum is brightest; recovery `(I - A) / max(t, 0.1) + A`. On encoded values. The map of the image holds the haze `1 - t` in place of range | The map is computed on a grid of at most 96 cells and blurred; the paper works at full resolution with image matting, so UWCC's map has soft edges. Water colour averaged over the brightest 0.1 %, not one pixel. Listed at the top of `core/src/udcp.rs` |
| Ancuti balance and fusion | Ancuti et al. 2018, as above | The white balance, then the paper's fusion stage: a gamma-corrected and a sharpened input (normalised unsharp masking), weights from Laplacian contrast, saliency (Achanta et al. 2009) and saturation, normalised with delta = 0.1, blended over Laplacian and Gaussian pyramids | The multi-scale blend is computed on a copy of at most 256 cells per side and applied to the full image per pixel (below), so detail finer than the copy is blended with smooth weights. Gamma (1.5), the blur and the relative scale of the weights are not given in the paper and are UWCC's choices. Listed at the top of `core/src/fusion.rs` |

**Estimated range** (`core/src/range.rs`). After the underwater light
attenuation prior of Song et al. 2018: range grows with max(green, blue) and
falls with red, as a fixed linear function. Two changes: the colour is first
divided by its brightest channel, because on raw values the estimate follows
brightness and Sea-thru's backscatter step then removes the image itself
(seen on the reference photos); and instead of a guided filter the map is
computed on a grid of at most 24 cells and blurred, so that it can be redone
for every video frame. The linear coefficients (0.532, 0.513, -0.911) are
written from memory of the paper and were not re-checked against it. The
consequences are plain: where red is completely absent the map is flat and
Sea-thru reduces to a global correction; a subject that is red by nature
reads as near.

**Range from the depth model** (`web/src/depth/`, `RangeMap::from_disparity`).
The network (27 MB, 8-bit quantised ONNX, run with onnxruntime-web on one
WASM thread) is served from the app's own origin and loaded the first time
the method is chosen; nothing leaves the device. It is fetched at build time
by `web/scripts/fetch-model.mjs`, pinned to a revision and checked by hash,
because it is too large for the repository. A photo is analysed with it only
when the method is chosen for that photo (about 1 to 2.5 s on a desktop CPU
at 378 px on the long side). The network returns relative inverse depth with
unknown scale and shift, so the map is anchored by assumption: the nearest
1 % of the frame is taken as 1 m away, the farthest 1 % as 10 m, reciprocal
in between. The map is stored with the item at up to 160 cells per side and
used for preview, thumbnail and export alike.

What it changes, by eye on the contact sheet: the depth maps themselves are
plausible on all seven test images (subjects separate cleanly from open
water). On the clip the result is close to the colour-based variant, with a
little more colour in the distance. On the deep photos it does not help:
with red absent the model has nothing to restore, and where the map says
"far" (open water behind the dolphins) nearly everything is removed as
backscatter and the remainder amplified, which gives dark, noisy water.
That is the method's behaviour without a signal, not a fault of the depth.

**Fusion in the pipeline** (`core/src/fusion.rs`). The paper's fusion is
spatial: pyramids of two images and their weight maps. To keep one per-pixel
pipeline (tiled export, per-frame video, CPU reference), it is split in two.
The core runs the complete multi-scale fusion on a small copy of the frame
and returns three maps: the weight of the first input, the blurred image the
sharpened input is measured against, and an offset. The pipeline's fusion
step (off by default) then computes both inputs for each full-resolution
pixel, blends them with the interpolated weight and adds the offset, which
is the difference between the multi-scale result and that plain blend on the
copy. On an image of the copy's size this reproduces the multi-scale result
exactly (a unit test checks it). The maps are two small float textures,
recomputed for every video frame like the range map.

By eye: against the white balance alone, the result is darker (the gamma
input), with clearly more local contrast and sharper detail; the colours are
those of the white balance, so the yellowish cast on the deep photos stays.
On the clip it is steady over time, and a multi-tile export shows no seam.
On a low-quality or enlarged source the sharpening brings out compression
artefacts.

**UDCP results**, by eye: contrast comes back and the water turns a deeper
blue, and as in the paper the colour cast stays, so it is a companion to the
neutral picker more than a correction on its own. Two weaknesses show on the
test images: a soft halo around near subjects in front of open water (the
dolphins), from the coarse map; and bright sand, whose colour is close to
the water colour, is read as haze and darkened (the clip). The second is a
known limit of dark-channel methods. An export of the clip is steady over
time.

**The map in the pipeline.** Corrections that use the range step carry which
map they read (`haze`) and, for the haze map, the water colour it is
measured against, so the same analysed value is used for every frame of a
clip. `RangeMap::for_correction` in the core returns the right map.

**Range in the pipeline.** The map is a small float texture. The shader
interpolates it by hand so that GPU and CPU agree, and export tiles pass
their position in the whole image. For video the map is recomputed for every
frame (preview and export); the fitted curves come from the analysed frames
and are interpolated in between. They are stored as tables of 8 samples over
range, not as function parameters: blending the parameters of two fits gives
a curve unrelated to either, which showed as violent colour swings in the
first video export.

**Results** on the reference photos, the flash photo and three frames of the
owner's clip, judged by eye on a contact sheet
(`cargo run --release --example sheet -- out.jpg images...` in `core/`):

- On the clip, where red is weak but present, all four methods give a usable
  result: UWCC and Ancuti similar, the matrix slightly pink, Sea-thru more
  neutral and with more contrast.
- On the three deep photos, where red is absent, only UWCC comes close to
  the targets. The matrix turns open water pink (it borrows red from blue).
  Ancuti is flat and yellowish, the known look of plain grey-world. Sea-thru
  stays blue-green: it restores what was attenuated and cannot rebuild a
  channel that holds no signal, and its gain cap stops it from amplifying
  noise instead.
- On the flash photo, which needs no correction, UWCC alone leaves the image
  unchanged. The others always apply.

Only UWCC's own method has numeric regression thresholds. The others are
covered by unit tests on synthetic input (including a scene rendered through
Sea-thru's own model, which it must turn grey again) and by a check that
each gives finite parameters and a usable image on the reference photos.

**Neutral picker** (F7). Works on top of every method. The user clicks a
spot that should be grey or white; the core averages a patch there (2 % of
the image's short side) after the automatic correction, in linear light, and
returns the channel gains that make the mean grey at unchanged luminance
(`reference::neutral_gains`). The gains are part of the adjustments and
multiply into the white-balance step, so there is no new pipeline step.
Each gain is limited to 1/8 .. 8: where a channel holds no signal the patch
does not become fully grey. Spots that are nearly black or clipped are
refused. For video the gains are picked on the frame shown and apply to the
whole clip. They are copied by "apply to all" like the other adjustments.

**In the queue.** The setting "Correction method for new files" chooses the
method items start with (UWCC unless changed). Thumbnails are rendered by the
CPU reference from a small uncorrected copy kept with the item, and again
whenever the item's method or adjustments change (after leaving the editor,
or at once for "apply to all").

Not done: depth from the model for video, measured depth (dual-camera
phones), and the model on the GPU (WebGPU).

## 7. Batch processing and output location

### 7.1 Flow

1. **Select** any number of photos and videos (picker, drag and drop, or a
   whole folder where the platform allows).
2. **Queue** screen: a list with thumbnail, type, size and status per item.
   Auto-correct analysis runs in the background and thumbnails show the
   corrected preview. Unsupported files are flagged here, before the run.
3. **Optional review**: open an item in the editor, adjust, return; optionally
   apply the manual adjustments to all.
4. **Run**: items are processed one at a time (hardware video encoders and
   phone memory do not tolerate parallel exports). Photos first, then videos,
   so quick results appear early.
5. **Summary**: counts, where the results went, failures with reasons, and a
   retry for the failed items.

Selecting a single item opens the editor directly; the batch queue is the
same code path with one entry.

### 7.2 Output naming (mode "next to source")

- Result name: source name plus suffix, default `_uwcc`
  (`GOPR0042.JPG` → `GOPR0042_uwcc.jpg`). The suffix is configurable.
- An existing file of that name is never replaced silently: a counter is
  appended (`_uwcc-2`).
- Format follows the source where possible: JPEG → JPEG, PNG → PNG,
  HEIC → JPEG, MP4/MOV → MP4.
- Capture date and other metadata are copied, so results sort beside their
  sources in galleries.
- Every JPEG UWCC writes carries a comment segment `UWCC corrected`. Together
  with the suffix this is how earlier results are recognised (F18); the
  marker also covers originals that were replaced in overwrite mode.

### 7.3 Overwrite mode

Overwriting destroys the original, and for video it also replaces it with a
re-encoded (lossy) copy. Safeguards:

- Off by default. Enabling it in settings shows a one-time explanation.
- Every batch run in this mode states "N originals will be replaced" on the
  start button's confirmation.
- A result is written completely to a temporary location and checked first;
  the source is replaced only after that succeeded. A failed or cancelled
  item leaves its source untouched.
- Where the platform offers a revertible in-place edit (iOS photo library),
  that mechanism is used, so the original stays recoverable.
- If the result format differs from the source (HEIC, MOV) and the platform
  cannot replace it in place, the item falls back to "next to source" and the
  summary says so. UWCC does not delete source files itself.

### 7.4 What each platform can do

"Next to the source" needs write access to the place the file came from,
which platforms grant very differently. This has not been verified on devices
and becomes part of the M0 spike.

| Platform | Next to source | Overwrite | Mechanism |
|----------|----------------|-----------|-----------|
| Desktop Chrome / Edge | Yes, when the user opens a folder or drops files / folders and grants write access | Yes | File System Access API |
| Safari and other browsers on iPhone / iPad (web app) | No. Results go to the photo library through the share sheet ("Save Image" / "Save Video"); the user confirms each run with one tap | No | Web Share API with files (`web/src/io/photos.ts`) |
| Desktop Safari / Firefox, Android browsers | No. Results go to the browser's download folder | No (setting shown as unavailable, with the reason) | Plain downloads |
| iOS app, photo library | Yes: saved to the library with the source's date, and into the same album where there is one | Yes, as a revertible edit; iOS asks the user once per batch | PhotoKit, via a native plugin |
| iOS app, Files | Yes, when a folder is picked | Yes | Document picker with folder access |
| Android app, gallery | Yes: same folder (e.g. `DCIM/Camera`) | Yes; Android asks the user once per batch | MediaStore with a write request, via a native plugin |
| Android app, other folders | Yes, when a folder is picked | Yes | Storage Access Framework |

Consequences:

- The mobile apps need a small native media plugin each (Swift, Kotlin) for
  listing, reading and writing library items. The standard system photo
  pickers return copies without write access, so they are not enough.
- The apps need photo-library permissions (iOS: read-write library access;
  Android: media read permissions). The store listings must justify them;
  photo and video editing is an accepted reason, to be confirmed against
  current store policy.
- The UI always states where results will go before a run starts, because the
  answer differs per platform.
- iOS web app: a page cannot write to Photos itself, and a download on iOS
  lands in the Files app. The share sheet can save to Photos, but opens only
  in response to a tap. After a single photo is saved, UWCC tries to open it
  at once on the tap of "Save"; if that tap has expired (long exports,
  batches), a "Save to Photos" bar hands all waiting results to one share
  sheet. Results stay in memory until then (exported videos as their
  temporary file, removed after 30 minutes or at the next start). The share
  sheet does not say which target was chosen, so the app reports "passed to
  the share sheet", not "saved". Used only where `navigator.canShare`
  accepts files and the device is an iPhone or iPad; elsewhere results are
  downloaded as before.

### 7.5 Robustness

- The run keeps the screen awake. On mobile, a run interrupted by the app
  going to the background stops after the current item at the latest;
  finished items stay finished, the rest stay queued and can be resumed.
- Free space is checked before the run against an estimate of the output
  size.
- Videos are streamed (§8), so batch size is limited by storage, not memory.

### 7.6 Version

The app's version is the version in `web/package.json` plus the short id of
the commit it was built from, e.g. `0.1.0+9e5a8cd` (`-dirty` for a build with
uncommitted changes). It is filled in at build time (`web/vite.config.ts`,
`web/src/version.ts`), shown in the header, on the start page and in Settings, and written into
every JPEG after UWCC's marker ("UWCC corrected by UWCC 0.1.0+9e5a8cd"), so a
result records which build made it.

## 8. Architecture

```
core/                Rust crate -> WASM (also runs natively for tests)
  src/analysis.rs      statistics -> Correction
  src/model.rs         Correction, Adjustments
  src/reference.rs     CPU implementation of the shader maths
  src/wasm.rs          JavaScript bindings
  tests/               regression tests against testdata/photos
web/                 TypeScript app
  src/render/          WebGL2 renderer and the correction shader
  src/worker/          WASM core and JPEG encoder off the main thread
  src/io/              import, export; later: source handles and output targets per platform
  src/ui/              screens and components
  src/video/           (planned) demux, WebCodecs decode/encode, mux, export loop
  src/batch/           (planned) job queue, run loop, summary
  src/settings/        (planned) persisted settings
mobile/              Capacitor iOS and Android projects
  plugins/media/       native media plugin (Swift, Kotlin): library access, save next to source, in-place edit
testdata/
  photos/              before/after reference pairs (committed, public)
  local/               private examples, git-ignored
```

Photo export: decode (browser) → tiles through WebGL → one JPEG encoded in
WASM (MozJPEG) in the worker; EXIF copied from the source (not implemented yet).

Video export: demux → `VideoDecoder` → frame as texture → shader →
`VideoEncoder` → mux, with audio packets copied through untouched. Frames are
streamed with back-pressure; the clip is never held in memory.

Batch: a queue of jobs, each `{source handle, kind, CorrectionParams,
Adjustments, status}`. The queue drives the same photo and video export
functions as the single-item editor, and hands results to an `OutputTarget`
interface with one implementation per row of the table in §7.4.

Rules:

- `core/` has no browser dependencies; it must build and test natively.
- Edits are parameters applied to the untouched original; nothing is baked until export.
- Platform differences live only in `web/src/io/` and the native media plugin.
- A source is replaced only after its result was fully written and checked (§7.3).
- Heavy work (WASM, export loops) runs off the main thread.

## 9. Milestones

| # | Goal | Done when |
|---|------|-----------|
| M0 | Device spike (go / no-go) | A throwaway page inside Capacitor on a real iPhone and Android phone decodes, shades, encodes and muxes 1080p and 4K H.264 and HEVC clips, and exports a 48 MP photo; speed and memory recorded. File access checked per platform: read a library item, write a result beside it, replace an item (§7.4). Stack confirmed or changed |
| M1 | Algorithm | Rust core and shader agree; auto-correct gives good results on the test set |
| M2 | Photo editor | Import, live preview, manual controls, before/after in the browser |
| M3 | Photo export | Full resolution with metadata, including 48 MP |
| M4 | Video | Corrected live preview, clip analysis, export with audio and progress |
| M5 | Batch and settings (web) | Multi-select, queue, run, summary; next-to-source and overwrite on desktop Chrome, downloads elsewhere |
| M6 | Mobile apps | Capacitor builds with the native media plugin: multi-select from the library, save next to source, in-place edit, share |
| M7 | Polish | Performance targets met, accessibility, localisation scaffolding, icons, offline PWA |
| M8 | Release | Web deployed; TestFlight and Play internal testing |

Status on 2026-11-24:

- M0: test page published at `/spike/m0/`. First report received
  (2026-11-24): iPhone, iOS 18.7, Firefox for iOS (which uses the system
  WebKit engine, the same one a Capacitor app runs in), built-in tests only.
  Everything passed:
  - WebCodecs, WebGL2 (16384 px textures), WebAssembly, OffscreenCanvas and
    OPFS are present. H.264, HEVC, VP9 and AV1 decode and H.264 and HEVC
    encode up to 4K60 are reported as supported, with hardware.
  - Decode → shader → encode → mux: 1080p at 66-78 frames/s (2.2-2.6 times
    real time for 30 frames/s footage), 4K at 23 frames/s for H.264 and HEVC
    (0.77 times real time) and 17 frames/s for VP9. Every output was
    decodable.
  - Photo: 12 MP in 2.0 s and 48 MP in 4.0 s (render plus JPEG encoding),
    in 4 and 12 tiles.
  - As expected, there are no file or folder pickers of the File System
    Access API and no cross-origin isolation. Saving in the browser goes
    through the share sheet or a download; writing beside the source needs
    the native plugin (§7.4).

  - One camera clip of the tester's (4K H.264 High, 25 frames/s,
    88 Mbit/s, full range, PCM audio, QuickTime) went through at
    23.8 frames/s (0.95 times real time); picture intact, audio kept. The
    spike wrote H.264 Baseline at about 22 Mbit/s; which profile and bitrate
    the app gets on iOS is not yet checked.

  Still open for the gate: an Android phone, more of the tester's own
  clips and photos on both platforms (10-bit HEVC, long clips, memory), and
  the same tests inside the Capacitor wrapper. Memory use could not be
  measured on iOS (the browser does not report it). The Capacitor wrapper
  and native file access are not started.
- M1: done for the available reference images (§6.5). The shader matches the
  CPU reference exactly in a software-rendered browser; real GPUs still to
  be checked through the in-app self-test.
- First run of the app on a real phone (2026-11-24, iPhone, iOS 18.7): the
  owner reports that the video preview works and the export of a 4K H.264
  clip was fast. No figures, self-test result or exported file yet.
- Colour modes and a vibrance slider were added on 2026-11-24 (F6, §6.4);
  checked in headless Chromium only.
- 2026-11-25: version number with commit id (§7.6); on iPhone and iPad the
  web app saves results to Photos through the share sheet (§7.4). Checked in
  headless Chromium with an iPhone user agent and a simulated share sheet;
  not yet on a real iPhone.
- M2: first version live: open or drop a photo, automatic correction, six
  manual controls with reset, split view, hold for original, neutral picker.
  Missing: zoom and pan.
- M3: full-resolution tiled JPEG export works, with quality from the
  settings. Missing: EXIF metadata is not copied yet, PNG output.
- M5 (done before M4 at the owner's request), photos only:
  - multi-select by picker, folder or drag and drop; queue with corrected
    thumbnails; edit any item and apply its adjustments to all; run with
    per-item and overall progress, cancel, retry of failed items, summary;
  - settings: output mode, suffix, JPEG quality, skip already corrected;
  - output: next to the source and overwrite through the File System Access
    API (desktop Chrome / Edge), downloads elsewhere; an existing file is
    never replaced silently; overwrite asks for confirmation per run;
  - every JPEG UWCC writes carries a comment segment `UWCC corrected`, and
    files with that marker or with the suffix in their name are skipped.
  - Verified in a headless Chromium, with the origin-private file system
    standing in for a user-picked folder. Not yet tried with the real system
    pickers on a desktop browser.
  - Missing: free-space check, resuming a queue after the page was closed,
    sub-folders, videos (shown as "not supported yet").
- M4 (after M5 at the owner's request): first version.
  - Analysis: a frame every 2 seconds (at most 60 per clip) goes through the
    same analysis as photos; the resulting corrections are lightly smoothed
    and interpolated per frame.
  - Editor: the clip plays through the correction shader with play, pause
    and scrubbing; all manual controls, split view and hold-for-original
    work on video.
  - Export: demux → decode → shader → encode → mux with WebCodecs. Audio is
    copied unchanged, frame count and timing are kept, rotation metadata is
    applied to the pixels. The source codec is kept where the device can
    encode it, otherwise H.264; the bitrate follows the source. The result is
    written to a temporary file in the browser's private storage and
    delivered from there, so clip length is not limited by memory.
  - Videos run through the same queue, settings and output modes as photos
    (after the photos in a batch). Results carry the metadata comment
    `UWCC corrected` and are skipped when added again. Overwrite replaces
    MP4 sources only.
  - Verified in a headless Chromium with software codecs on generated
    H.264 clips, including one with rotation metadata, and on one real clip
    from the owner (QuickTime, H.264, 1024x576, variable frame rate): all
    frames, their timestamps and the audio came through unchanged. Not
    verified: original camera files, HEVC, 4K, hardware codecs, speed,
    Safari, phones.
  - Missing: HDR / 10-bit handling (not detected yet), a video quality
    setting, and the smoothing can soften the correction for about 2 seconds
    around an abrupt change such as a light switching on.
- Selectable methods (F19, §6.7): drop-down in the editor with UWCC, hue-shift
  matrix, Ancuti white balance and Sea-thru on an estimated range map; all
  work in preview, photo and video export and batch. The shader matches the
  CPU reference to within 1 of 255 on every branch of the pipeline, in a
  software-rendered browser. Verified headless on photos (including a
  multi-tile export) and on the owner's clip. Not verified on real GPUs.
- Ancuti fusion stage (§6.7): done. The shader matches the CPU reference to
  within 1 of 255 on the fusion step too; verified headless on photos
  (including a multi-tile export) and the clip.
- UDCP haze removal (§6.7): done, verified headless on photos and the clip.
- Sea-thru on a depth model (§6.7): done for photos, verified headless
  (model loaded on first use only, preview, export, batch, thumbnails).
  Not verified: speed and memory on phones.
- Neutral picker (F7) and the "UWCC, always applied" method as manual
  override (§6.7): done, verified headless on photos and a clip.
- Default-method setting and thumbnails that follow each item's method and
  adjustments (F19): done, verified headless.
- M6 onwards: not started.

## 10. Risks

| Risk | Mitigation |
|------|------------|
| WebCodecs missing codecs, slow or unstable in mobile WebViews | M0 gate; native export plugin per platform as fallback |
| Export interrupted when the app goes to the background | Keep screen awake, warn the user, make export resumable or restartable; native plugin later if needed |
| WebView memory limits with 48 MP photos or 4K video | Tiling and streaming; measured in M0 |
| HEVC / 10-bit / HDR sources (common from action cameras) | Detect on import; v1 converts to 8-bit SDR where the platform can decode, otherwise a clear message |
| Variable frame rate, rotation metadata, odd containers | Test clips from real cameras in `testdata/`; preserve timestamps instead of assuming a fixed rate |
| Colour changes within a clip (depth, lights on/off) | Parameters sampled every 1-2 seconds, smoothed and interpolated (§6.4) |
| Existing open-source implementations are GPL-3.0 | Decided: own implementation, no GPL code or dependencies (§6.3) |
| Red noise and compression blocks amplified by the correction | Capped red gain; safeguards tuned on real footage in M1 |
| GitHub Pages cannot set custom HTTP headers, so cross-origin isolation (needed for WASM threads / `SharedArrayBuffer`) is unavailable | Keep the WASM core single-threaded in a Web Worker; the heavy per-pixel work is on the GPU anyway |
| HEIC not decodable in most browsers | Clear message on web for v1; WASM decoder later |
| Wide-gamut (Display P3) photos treated as sRGB | Detect the profile; v1 converts to sRGB |
| Writing next to the source or replacing it is impossible in some browsers and restricted on mobile | Capability table in §7.4; native media plugin; UI states the destination before each run; checked in M0 |
| Overwrite mode destroys originals | Off by default, confirmation per run, write-then-replace, revertible edits where the platform has them (§7.3) |
| Store rejection over broad photo-library permissions | Request the narrowest access that works; justify as a photo and video editor; verify current policy before M6 |
| The native plugins add Swift and Kotlin code to a web-only stack | Keep them small and limited to media access; all processing stays in the shared web code |
| App-store review of WebView-based apps | Ship real native value: gallery integration, share, offline |
| iOS builds need macOS | The owner can provide a macOS build machine; access to be set up before M0 |

## 11. Open questions

1. Outcome of the M0 spike (§9).
2. Which iPhone and Android devices are available for the M0 spike?
3. Which cameras matter most (GoPro, DJI, Insta360, phones)? This decides the
   codec and HDR priorities.
4. Bundle identifiers for the app stores.
5. Business model: free, paid, or freemium?
6. Minimum OS versions to support.
