import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Load the fake-indexeddb polyfill before any test imports the
    // store factories. `setupFiles` is the only Vitest hook that runs
    // before the module graph evaluates.
    setupFiles: ['./test/idb-setup.ts'],
    // Each test file runs in its own worker so fake-indexeddb state from
    // one test doesn't leak into the next.
    isolate: true,
  },
});
