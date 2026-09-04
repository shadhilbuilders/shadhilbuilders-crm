import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Backend vitest config.
 *
 * CI resilience (run 33892679873): `@shadhil/database` resolves through
 * its package.json `exports` -> `./dist/index.js`, which only exists
 * after `tsc -p tsconfig.build.json` emits it. That emit has proven
 * flaky in CI (stale tsbuildinfo skip-emit, cache-restore timing, and
 * web#build's prebuild wiping sibling dist mid-turbo-run). Rather than
 * chase CI-only races, alias the workspace package to its TS source —
 * the generated Prisma client is TypeScript (packages/database/
 * src/generated/prisma/) and `pnpm --filter @shadhil/database generate`
 * runs BEFORE this job's test step, so `src/` is always complete here.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@shadhil\/database$/,
        replacement: fileURLToPath(
          new URL('../../packages/database/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    passWithNoTests: true,
  },
});