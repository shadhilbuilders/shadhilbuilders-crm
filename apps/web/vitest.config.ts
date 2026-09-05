import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: [
      // CI resilience (runs 33892679873/33893618023): @shadhil/auth
      // resolves through dist/ which is flaky on GH runners (stale
      // tsbuildinfo skip-emit + cache-restore timing). Alias to the
      // package's TS source - always present after pnpm install.
      {
        find: /^@shadhil\/auth\/auth-client$/,
        replacement: fileURLToPath(
          new URL('../../packages/auth-client/src/auth-client.ts', import.meta.url),
        ),
      },
      {
        find: /^@shadhil\/auth$/,
        replacement: fileURLToPath(
          new URL('../../packages/auth-client/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // Nothing fails CI just because a fresh feature area hasn't grown tests
    // yet - coverage is opt-in per module, not enforced repo-wide.
    passWithNoTests: true,
    // Playwright e2e tests live in src/test/e2e/ - they have their
    // own runner (`pnpm test:e2e` → `playwright test`) and must not
    // be picked up by vitest, which would try to execute
    // `test.describe(...)` and fail with "Playwright Test did not
    // expect test.describe() to be called here".
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      'node_modules',
      'dist',
      '.next',
      '.idea',
      '.git',
      '.cache',
      'src/test/e2e/**',
    ],
    // Polyfill IndexedDB for tests that use @shadhil/offline-store.
    setupFiles: ['./src/test/idb-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json', 'lcov', 'cobertura'],
      exclude: [
        'node_modules/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/*.test.*',
        '**/*.spec.*',
        'dist/',
        '.next/',
        'src/app/layout.tsx',
        'src/**/index.ts',
      ],
    },
  },
});
