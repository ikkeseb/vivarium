/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Static, no-backend build. `base: './'` keeps the bundle relocatable so the
// dist/ folder works when served from any subpath (or opened via preview).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: 'dot',
  },
});
