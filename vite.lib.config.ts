/**
 * The package build (`npm run build:lib`), into dist-lib/:
 * - neuroform.js: an ES module for bundlers, with three and lil-gui left as
 *   imports, so a page that already uses three shares it;
 * - neuroform.standalone.js: everything in one file, for a plain
 *   `<script type="module">` and for the snapshot tool.
 * The worker and the scan brain's grid are inlined into both, so they work
 * wherever the module ends up, whatever the bundler does with node_modules.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Modules swapped for their inlined versions in the package.
const inline = (name: string) => fileURLToPath(new URL(`src/${name}.inline.ts`, import.meta.url));

export default defineConfig(({ mode }) => {
  const standalone = mode === 'standalone';
  return {
    publicDir: false,
    assetsInclude: ['**/*.gz'],
    resolve: {
      alias: [
        { find: /^\.\/worker-factory$/, replacement: inline('graph/worker-factory') },
        { find: /^\.\/brain\/scan-url$/, replacement: inline('brain/scan-url') },
      ],
    },
    build: {
      target: 'es2022',
      outDir: 'dist-lib',
      emptyOutDir: !standalone,
      chunkSizeWarningLimit: 1200,
      lib: {
        entry: 'src/index.ts',
        formats: ['es'],
        fileName: () => (standalone ? 'neuroform.standalone.js' : 'neuroform.js'),
      },
      rollupOptions: {
        external: standalone ? [] : [/^three(\/.*)?$/, 'lil-gui'],
        output: { inlineDynamicImports: true },
      },
    },
    worker: { format: 'es' },
  };
});
