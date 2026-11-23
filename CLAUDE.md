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
for mobile with Capacitor. Current milestone: M0, the device spike, in
`spike/m0/`. Spike code is throwaway; do not build the real app on top of it.

## Repository and release

- Remote: `git@github.com:newkit/UWCC.git` (public), default branch `main`.
- The web app is released to GitHub Pages from this repository (served under `/UWCC/`). Pages cannot set custom headers, so do not rely on `SharedArrayBuffer` or WASM threads.

## Commands

To be filled in once the project is scaffolded. Expected:

```
cargo test            # in core/
wasm-pack build       # in core/
npm install           # in web/
npm run dev
npm test
npm run build
npx cap sync          # mobile projects
```

## Architecture rules

- `core/` (Rust) has no browser dependencies and must build and test natively.
- Per-pixel work belongs in the shader, not in WASM or JavaScript.
- The shader (`web/src/shaders/correct.frag`) and the Rust reference implement the same maths; change them together and keep the comparison tests passing.
- Edits are non-destructive: parameters applied to the original, baked only at export.
- Video is streamed frame by frame; never hold a whole clip in memory.
- Heavy work runs off the main thread.
- Platform-specific code lives only in `web/src/io/` (behind interfaces) and the native media plugin under `mobile/plugins/media/`. The plugin does media access only, never processing.
- The single-item editor and batch runs share one export path; batch is a queue in front of it.
- Never modify or replace a source file unless the overwrite setting is on, and then only after the result was fully written and checked (`SPECIFICATION.md` §7.3). Never delete source files.
- The app is standalone with no backend: all processing is on-device. Do not add network calls, server components, analytics or telemetry, and do not load code, fonts or assets from CDNs at runtime.

## Licensing

UWCC is dual-licensed MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`). No GPL code. Do not copy or port from the GPL-3.0 projects named in `SPECIFICATION.md` §6.3, and do not add GPL-licensed dependencies. Check a dependency's licence before adding it.

## Conventions

The user interface is in English.

To be defined at scaffold time (lint rules, formatting, commit style, branch flow).
