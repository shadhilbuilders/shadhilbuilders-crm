// ────────────────────────────────────────────────────────────────────────────
// Test setup — load env vars + skip cleanly if DB is unavailable
// ────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';

import { beforeAll, afterAll } from 'vitest';

export const DATABASE_AVAILABLE = Boolean(process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL);

beforeAll(() => {
  if (!DATABASE_AVAILABLE) {
    // eslint-disable-next-line no-console
    console.warn(
      '[test] No DIRECT_DATABASE_URL / DATABASE_URL set — DB-dependent tests will be skipped.',
    );
  }
});

afterAll(() => {
  /* teardown happens per-test */
});