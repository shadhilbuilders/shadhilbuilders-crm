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
 * chase CI-only races, alias the workspace package to its TS source -
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
    // T-ENVSETUP (2026-09-16): without this, DATABASE_URL is undefined inside
    // every test (vitest does not read `tsx --env-file`), so all DB-backed
    // suites silently skipped and a real RLS gap went unnoticed. See
    // src/test-setup-env.ts.
    setupFiles: ['src/test-setup-env.ts'],
    // Load-sensitive timeout headroom (2026-09-25). Several suites do REAL
    // work on vitest's 5s default: the changePassword tests run real scrypt
    // (N=16384, r=16 -> a ~33 MB synchronous allocation EACH, and scryptSync
    // blocks the event loop), and the DB-backed suites do several
    // withRlsContext round-trips per test. Under the full parallel run (one
    // worker per core, 51 files, DB pool shared with the dev server) a test
    // that takes ~0.8s alone blows past 5s.
    //
    // Reproduced under the old default: the full suite, run concurrently with
    // `pnpm type-check` + `pnpm lint`, failed with the happy-path
    // changePassword test at 19691ms. Note the failing test NAME changes run to
    // run (first seen: OWNER-reset at 10806ms, then VISITED-baseline at
    // 8490ms, then happy-path at 19691ms) - the signature of a load-sensitive
    // timeout, not a regression, and the reason a per-test patch would never
    // have held.
    //
    // Matches `packages/database/vitest.config.ts`, which already sets 30s for
    // the same reason. Raising the ceiling costs nothing for a passing test
    // (it finishes just as fast); it only changes how long a genuinely hung
    // test takes to fail. Verified: 3/3 full-suite runs green under the same
    // type-check + lint contention that produced the failure.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: true,
  },
});