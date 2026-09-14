import { defineConfig } from 'vite';

// The production build is published with GitHub Pages from the repository's `docs/` folder
// (Settings → Pages → Source: main branch, /docs). `base: './'` keeps every asset reference relative so the
// same build works at https://<user>.github.io/<repo>/ and from a file:// copy. `public/.nojekyll` stops
// GitHub's Jekyll step from dropping files whose names start with an underscore.
export default defineConfig({
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/src/astro/data/vsop87a.js')) return 'vsop87a';
          if (id.includes('/node_modules/three/')) return 'three';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
});
