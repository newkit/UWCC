import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works under any path (GitHub Pages, Capacitor).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@jsquash/jpeg'] },
  server: { fs: { allow: ['..'] } },
});
