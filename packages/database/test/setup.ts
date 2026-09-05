// ────────────────────────────────────────────────────────────────────────────
// Test setup - load env vars + fail fast if the security suite runs without DB
// ────────────────────────────────────────────────────────────────────────────
// AR-4 companion: RLS tests SKIP silently when DATABASE_URL is unset, which
// lets CI show green while the security matrix enforces nothing. When CI sets
// RLS_MATRIX_REQUIRED=true (see .github/workflows/ci.yml rls-matrix job), a
// missing database is a HARD FAILURE instead of a skip.

import 'dotenv/config';

import { beforeAll, afterAll } from 'vitest';

export const DATABASE_AVAILABLE = Boolean(process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL);

beforeAll(() => {
  if (!DATABASE_AVAILABLE) {
    if (process.env.RLS_MATRIX_REQUIRED === 'true') {
      throw new Error(
        '[test] RLS_MATRIX_REQUIRED is set but DIRECT_DATABASE_URL/DATABASE_URL is missing. ' +
          'The RLS isolation matrix must never run without a database - fix the CI service ' +
          'container instead of letting the security suite silently no-op.',
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[test] No DIRECT_DATABASE_URL / DATABASE_URL set - DB-dependent tests will be skipped.',
    );
  }
});

afterAll(() => {
  /* teardown happens per-test */
});