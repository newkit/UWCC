# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

UWCC (UnderWater Color Correction) is an app for colour-correcting underwater photos and videos on iOS,
Android and web from one codebase. `SPECIFICATION.md` is the source of truth
for scope, requirements, architecture and milestones — read it before making
design decisions, and update it when a decision changes.

## Status

The stack is confirmed by the owner (`SPECIFICATION.md` §5): a TypeScript web
app with WebGL2 and WebCodecs, a Rust core compiled to WebAssembly, packaged
for mobile with Capacitor. Progress per milestone is listed at the end of
`SPECIFICATION.md` §9; keep that list current.

## Layout

- `core/` - Rust crate `uwcc-core`: parameter model, CPU reference implementation, WASM bindings, and one module per correction method: `analysis` (UWCC's own, the default; also its always-applied variant), `matrix`, `ancuti` (with `fusion`, its fusion stage and the maps that needs), `seathru` (with `range`, the estimated range map it needs), `udcp` (with its haze map). `examples/sheet.rs` renders all methods side by side; `examples/before_after.rs` renders the README examples in `docs/images/` (rerun it when the default method changes).
- `web/` - the app: React + TypeScript + Vite. `src/render/` shader and renderer, `src/worker/` WASM core and JPEG encoder off the main thread, `src/io/` sources, import, export and output targets, `src/batch/` the job queue, `src/depth/` the depth model for the Sea-thru variant that uses one (loaded on demand, in its own worker; fetched into `public/models/` by `scripts/fetch-model.mjs`, not committed), `src/video/` clip analysis and WebCodecs export (loaded on demand; keep `mediabunny` imports inside `video.ts`), `src/settings/` persisted settings, `src/ui/` components.
- `spike/m0/` - throwaway device test page for M0. Do not build the app on it.
- `testdata/photos/` - reference pairs used by the core's tests and as in-app samples. `testdata/local/` is git-ignored.

## Repository and release

- Remote: `git@github.com:newkit/UWCC.git` (public), default branch `main`.
- The web app is released to GitHub Pages from this repository (served under `/UWCC/`). Pages cannot set custom headers, so do not rely on `SharedArrayBuffer` or WASM threads.

## Commands

Rust comes from rustup (`rust-toolchain.toml` pins stable plus the
`wasm32-unknown-unknown` target). In a fresh shell run `. "$HOME/.cargo/env"`
first if `cargo` resolves to the system one in `/usr/bin`.

```
# core/
cargo test                                  # unit tests + reference-image regression tests
cargo test --test reference_images -- --nocapture   # prints the error against each target
cargo fmt && cargo clippy --all-targets -- -D warnings

# web/
npm install
npm run dev          # builds the core to WASM, then starts Vite
npm run typecheck
npm run build        # core -> WASM, type-check, production build in dist/
```

After changing anything in `core/`, rerun `npm run build:core` in `web/`
(`dev` and `build` do it for you). CI (`.github/workflows/ci.yml`) runs the
core checks, builds the app and the spike, and deploys to GitHub Pages on
pushes to `main`.

Checking the shader against the reference: in the running app,
`await window.uwccSelfTest()` in the browser console returns the largest
per-channel difference (0-255) between GPU and CPU on a generated image.
Expect 0 or 1; `cases` in the result gives the difference per branch of the pipeline.

## Architecture rules

- `core/` (Rust) has no browser dependencies and must build and test natively.
- Per-pixel work belongs in the shader, not in WASM or JavaScript.
- The shader (`web/src/render/shader.ts`), the uniform maths in `web/src/model.ts` and the Rust reference (`core/src/reference.rs`) implement the same per-pixel steps; change them together and run the self-test.
- Every correction method only produces parameters (`Correction` in `core/src/model.rs`) for that one pipeline. A new method is a new analysis module plus an entry in `Algorithm` (core) and `ALGORITHMS` (`web/src/model.ts`); it must not get its own shader, export or preview path. If it needs a new per-pixel step, add the step to the shared pipeline, neutral by default. Spatial work (anything that looks at neighbouring pixels) is done by the core on a small copy of the frame and handed to the pipeline as maps (`RangeMap`, `FusionMaps`), never as extra render passes.
- Parameters must stay meaningful when two corrections are blended value by value, because video interpolates between analysed frames. Store curves as tables, not as fitted function parameters (`SPECIFICATION.md` §6.7).
- Published methods are implemented from their papers, with every deviation listed at the top of the module. Do not describe a partial implementation as the full method, in code or in the interface.
- Edits are non-destructive: parameters applied to the original, baked only at export.
- Video is streamed frame by frame and written to a temporary file (`web/src/io/tempFiles.ts`); never hold a whole clip in memory.
- Heavy work runs off the main thread.
- Platform-specific code lives only in `web/src/io/` (behind interfaces) and the native media plugin under `mobile/plugins/media/`. The plugin does media access only, never processing.
- The single-item editor and batch runs share one path: every file is a job in `web/src/batch/queue.ts`, analysed through `loadAnalysisCopy` and exported through `process`. Do not add a second analysis or export path.
- Every JPEG written goes through `tagJpeg` (`web/src/io/jpegMarker.ts`); the marker is what prevents correcting a file twice.
- Never modify or replace a source file unless the overwrite setting is on, and then only after the result was fully written and checked (`SPECIFICATION.md` §7.3). Never delete source files.
- The app is standalone with no backend: all processing is on-device. Do not add network calls, server components, analytics or telemetry, and do not load code, fonts or assets from CDNs at runtime. Large assets that cannot live in the repository (the depth model) are fetched at build time, pinned and hash-checked, and served from the app's own origin.

## Licensing

UWCC is dual-licensed MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`). No GPL code. Do not copy or port from the GPL-3.0 projects named in `SPECIFICATION.md` §6.3, and do not add GPL-licensed dependencies. Check a dependency's licence before adding it.

## Conventions

The user interface is in English.

To be defined at scaffold time (lint rules, formatting, commit style, branch flow).
