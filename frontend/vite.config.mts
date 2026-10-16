import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
// `npm run dev` proxies the API to the backend running standalone (`node bin/code-share.js serve`).
const backend = process.env.PLUGIN_BACKEND || 'http://127.0.0.1:9420';

export default defineConfig({
  root: here,
  base: './',
  // Inside frontend/, so a symlinked node_modules is never written through.
  cacheDir: path.join(here, '.vite-cache'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.join(here, 'src') } },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    // The git server reads the manifest to serve connect.html's files and nothing else.
    manifest: true,
    rolldownOptions: {
      input: { index: path.join(here, 'index.html'), connect: path.join(here, 'connect.html') },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/chunk-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { proxy: { '/api': { target: backend, ws: true } } },
});
