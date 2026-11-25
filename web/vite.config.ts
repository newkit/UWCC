import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (args: string) => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const commit = git('rev-parse --short=7 HEAD') || process.env.GITHUB_SHA?.slice(0, 7) || 'unknown';
const dirty = git('status --porcelain') ? '-dirty' : '';
const version = `${pkg.version}+${commit}${dirty}`;

// Relative base so the build works under any path (GitHub Pages, Capacitor).
export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __UWCC_VERSION__: JSON.stringify(version), __UWCC_COMMIT__: JSON.stringify(commit) },
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@jsquash/jpeg'] },
  server: { fs: { allow: ['..'] } },
});
