import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // three.js alone is most of the bundle; splitting it buys nothing here.
  build: { target: 'es2022', chunkSizeWarningLimit: 800 },
});
