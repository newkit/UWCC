# M0 device spike

Throwaway test page for milestone M0 (`SPECIFICATION.md` §9). It answers one
question: do WebCodecs, WebGL2 and WASM work well enough on real phones to
build UWCC on web technology?

It is not the start of the app. Do not build on it.

## What it tests

1. Device and browser capabilities, codec support as reported by the browser.
2. A generated clip: encode, then demux → decode → shader → encode → mux, at
   1080p and 4K, in H.264, HEVC and VP9.
3. A generated 12 MP and 48 MP image: rendered in GPU tiles, encoded to JPEG
   in WASM.
4. The same video and photo pipelines on files the tester picks.
5. Writing a file into a user-chosen folder (File System Access API).

Results collect in a text report that the tester copies back. The report
survives a page reload, so a tab killed for memory still leaves a trace of
the step it died in.

## Run

```
npm install
npm run dev        # local
npm run build      # output in dist/
```

Deployed by `.github/workflows/pages.yml` to
`https://newkit.github.io/UWCC/spike/m0/`.

## Dependencies

- `mediabunny` (MPL-2.0): container demux/mux and WebCodecs plumbing.
- `@jsquash/jpeg` (Apache-2.0): MozJPEG encoder compiled to WASM.
