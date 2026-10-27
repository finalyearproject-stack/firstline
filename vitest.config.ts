import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rhm/shared': r('./packages/shared/src/index.ts'),
      '@rhm/triage': r('./packages/triage/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'apps/api/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
