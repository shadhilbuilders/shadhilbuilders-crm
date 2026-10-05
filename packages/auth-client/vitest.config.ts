import { defineConfig } from 'vitest/config';

/**
 * @shadhil/auth (auth-client) vitest config.
 *
 * T-AUTH-TIMEOUT (2026-09-30): the load-sensitive 5s default.
 *
 * `auth.test.ts` imports modules that validate the auth env and construct the
 * better-auth instance, all via dynamic `await import(...)`. Under the full
 * parallel `pnpm test` run - turbo starts one worker per core, concurrently
 * with the web suite whose import phase alone has measured 763s - a test that
 * takes ~1s alone blows past vitest's 5s default and fails with a timeout. The
 * failing test NAME moves run to run, which is the signature of contention
 * rather than a regression.
 *
 * Both sibling packages already raised this ceiling for the same reason:
 * `apps/backend/vitest.config.ts` (`scryptSync` allocates ~33MB synchronously)
 * and `packages/database/vitest.config.ts` (DB round-trips). This package was
 * simply missed - and a package that is green alone but red in the full run is
 * the worst version of it, because the failure looks like a real defect in CI.
 *
 * Raising the ceiling costs a passing test nothing (it still finishes just as
 * fast); it only changes how long a genuinely hung test takes to fail.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: [],
    // build-emits-all-files.test.ts runs `clean` + rebuild on the dists that
    // auth.test.ts imports (@shadhil/database/dist). Parallel files made
    // auth.test.ts fail with 'Failed to resolve entry for package
    // "@shadhil/database"' whenever the clean landed mid-import. Serialize.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
