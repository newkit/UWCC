import { defineConfig } from 'vite';

// Relative base so the build works under any path (GitHub Pages, Capacitor).
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
  optimizeDeps: { exclude: ['@jsquash/jpeg'] },
});
