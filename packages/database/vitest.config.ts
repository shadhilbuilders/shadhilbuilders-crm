import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // T-VITEST4-SERIAL (2026-09-30): every suite in this package shares ONE
    // physical database (`shadhil_crm_test`). Running two files concurrently
    // means two writers on the same rows, which is how the package went red
    // when its suite was run alongside a heavy neighbour - an isolation
    // failure that looks exactly like a product bug.
    //
    // This was `poolOptions: { forks: { singleFork: true } }`. Vitest 4
    // REMOVED `poolOptions` outright, and an unknown key is silently ignored -
    // so the serialisation this package asked for had not been in effect for
    // as long as Vitest 4 has been installed. The intent was documented and
    // unenforced at the same time, which is the worst combination: the config
    // reads as if the race is handled.
    //
    // Vitest 4's documented equivalent is `maxWorkers: 1` (plus `isolate: false`
    // for the old module-reset behaviour - deliberately NOT set here, because
    // per-file isolation is what keeps one suite's fixtures out of the next).
    // Verified: `pnpm --filter @shadhil/database test` green, and green under
    // the full parallel `pnpm test` run.
    maxWorkers: 1,
    reporters: process.env.CI ? ['default'] : ['default'],
  },
});
