// The app's version: the package version plus the commit it was built from
// (`0.1.0+9e5a8cd`, with `-dirty` when the build had uncommitted changes).
// Filled in at build time by `vite.config.ts`.

declare const __UWCC_VERSION__: string;
declare const __UWCC_COMMIT__: string;

export const VERSION: string = __UWCC_VERSION__;
export const COMMIT: string = __UWCC_COMMIT__;
