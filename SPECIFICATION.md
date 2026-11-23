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
| F6 | Manual controls: correction strength, temperature, tint, exposure, contrast, saturation; reset per control and reset all. |
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
4. the manual adjustments (temperature, tint, exposure, contrast, saturation),
5. a global `strength` blending original and corrected.

This covers the matrix method and the Ancuti-style compensation with the same
shader, so the two can be compared by changing only the analysis.

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

### 6.5 Findings from the owner's reference pairs

`testdata/photos/` holds three before/after pairs supplied by the owner
(`dolphins_*`, `turtle_*`, `coral_*`; 1500x2000 and 2000x1500 JPEG) and one
flash photo of the coral scene (`coral_flash.jpg`). The "after" images
are the target look. Measured on them:

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

1. Red health: mean red relative to mean green. At half of green or more,
   red counts as healthy and the whole correction scales to nothing.
2. Water colour: the 2nd percentile of the green/blue ratio.
3. Rebuilt red: green minus 1.5 x that ratio x blue.
4. Black points: 20th percentile for rebuilt red (so open water and deep
   shadows get no red), 0.5th for green and blue.
5. Channel balance on scene content only: pixels are weighted by where their
   green/blue ratio lies between water and scene; open water gets weight 0.
6. Common white level (scene highlights to 0.68 linear), gains capped at 8.

Mean error against the targets, per channel RMS on 0..1 sRGB values, with the
uncorrected original in brackets: turtle 0.023 (0.235), dolphins 0.035
(0.299), coral 0.048 (0.236). The flash photo is left unchanged. These numbers
are regression thresholds in `core/tests/reference_images.rs`.

Caveat: the constants were tuned on these three pairs, all deep-blue water
from similar conditions. They are a starting point and will need revisiting
with green water, shallow shots and partially depleted red.

### 6.6 Validation plan (M1)

1. Collect real examples: unedited originals, covering shallow and deep, blue
   and green water, with and without lights, photos and clips. Where
   available, a version the owner considers well corrected as a target.
2. Prototype the candidates (plain white balance, matrix method, Ancuti-style
   compensation) in the Rust core and render contact sheets side by side.
3. Pick the default by eye together with the owner; tune the safeguards.
4. Freeze the chosen examples as regression images in `testdata/`.

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
| Desktop Safari / Firefox, mobile browsers | No. Results go to the browser's download folder | No (setting shown as unavailable, with the reason) | Plain downloads |
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

### 7.5 Robustness

- The run keeps the screen awake. On mobile, a run interrupted by the app
  going to the background stops after the current item at the latest;
  finished items stay finished, the rest stay queued and can be resumed.
- Free space is checked before the run against an estimate of the output
  size.
- Videos are streamed (§8), so batch size is limited by storage, not memory.

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

Status on 2026-11-23:

- M0: test page published at `/spike/m0/`; waiting for reports from real
  phones. The Capacitor wrapper and native file access are not started.
- M1: done for the available reference images (§6.5). The shader matches the
  CPU reference exactly in a software-rendered browser; real GPUs still to
  be checked through the in-app self-test.
- M2: first version live: open or drop a photo, automatic correction, six
  manual controls with reset, split view, hold for original. Missing: zoom
  and pan, neutral picker.
- M3: full-resolution tiled JPEG export works. Missing: EXIF metadata is not
  copied yet, quality is fixed at 92, PNG output.
- M4 onwards: not started.

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
