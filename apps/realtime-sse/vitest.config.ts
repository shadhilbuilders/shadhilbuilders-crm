import { defineConfig } from 'vitest/config';

// apps/realtime-sse had no test runner until 2026-11-21 (the `test` script was
// `echo 'tests pending' && exit 0`, so CI reported green with zero coverage of
// the stream pipeline). The cursor logic added here decides whether a message
// reaches the client at all, so it needs real tests.
//
// No jsdom: this service is pure Node, and the tests exercise plain functions
// (no timers, no sockets). A fake Prisma client stands in for the DB, which
// keeps the suite fast and lets us assert the exact WHERE/ORDER BY each
// fetcher sends - that is the contract the cursor fix depends on.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
