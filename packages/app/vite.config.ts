import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { contentHotReload } from './vite/content-hot-reload.js';

const contentDir = fileURLToPath(new URL('../core/content', import.meta.url));

/**
 * The web build (spec §9: "PWA from day one", §11: content hot-reload in dev).
 *
 * `base: './'` keeps the bundle portable: the same artefact is served from a
 * GitHub Pages sub-path, from itch.io's zip host and from a Tauri `file://`
 * shell without a rebuild (spec §17).
 */
export default defineConfig({
  base: './',
  plugins: [
    react(),
    contentHotReload({ contentDir }),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // The whole game is a static bundle: once it is cached it runs with no
        // network at all, which is what an idle game left open for hours needs.
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'PRINTHEAD',
        short_name: 'PRINTHEAD',
        description: 'A finite idle game about a 3D printer that eventually prints everything.',
        theme_color: '#05090d',
        background_color: '#05090d',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
