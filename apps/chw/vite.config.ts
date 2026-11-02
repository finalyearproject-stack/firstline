import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rhm/shared': r('../../packages/shared/src/index.ts'),
      '@rhm/triage': r('../../packages/triage/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Dev-only convenience so the app and API share an origin and CORS stays simple.
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  preview: {
    // `vite preview` serves the production build with its service worker; it needs the
    // same proxy as dev so the installed app can sign in and sync against a local API.
    port: 4173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    // The APK-equivalent budget in spec s21 is 50 MB; this app targets a fraction of
    // that, and the warning limit is set low so a regression is noticed at build time.
    chunkSizeWarningLimit: 600,
    target: 'es2020',
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'audio/**/*'],
      manifest: {
        name: 'FirstLine — VHT Screening',
        short_name: 'FirstLine',
        description: 'Health screening and referral for Village Health Teams, with offline support',
        // Installed on Android, the app keeps ONE colour for its system navigation bar and
        // launch screen; it cannot follow light and dark. Iris read as a cheap frame, and the
        // light canvas left a white band under the dark theme, so both are the dark canvas: a
        // dark bar sits naturally under either theme. The status bar is not stuck with this:
        // index.html sets it per theme as soon as the page loads.
        theme_color: '#09090b',
        background_color: '#09090b',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Everything the app needs to run is precached, so a cold start in airplane
        // mode loads from the cache and never waits on a network that is not there.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,mp3}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        // The dashboard and the API share this origin when hosted together; the VHT
        // app's offline shell must never answer for them.
        navigateFallbackDenylist: [/^\/dashboard/, /^\/api\//, /^\/health$/, /^\/ready$/],
        runtimeCaching: [
          {
            // Awareness audio: cache-first, because it never changes for a given
            // version and must play with no network at all.
            urlPattern: /\/audio\/.*\.mp3$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'awareness-audio',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            // API reads: network-first with a cache fallback. Clinical writes never
            // come through here; they go to the local database and the outbox.
            urlPattern: /\/api\/v1\/(awareness|triage\/ruleset|reference)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-reference',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
});
