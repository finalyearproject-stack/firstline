import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // '/' in development; '/dashboard/' when the API serves it alongside the VHT app.
  base: process.env.DASHBOARD_BASE ?? '/',
  resolve: {
    alias: {
      '@rhm/shared': r('../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { target: 'es2020' },
  plugins: [react()],
});
