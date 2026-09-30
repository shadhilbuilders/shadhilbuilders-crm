// ────────────────────────────────────────────────────────────────────────────
// Test setup - load env vars + fail fast if the security suite runs without DB
// ────────────────────────────────────────────────────────────────────────────
// AR-4 companion: RLS tests SKIP silently when DATABASE_URL is unset, which
// lets CI show green while the security matrix enforces nothing. When CI sets
// RLS_MATRIX_REQUIRED=true (see .github/workflows/ci.yml rls-matrix job), a
// missing database is a HARD FAILURE instead of a skip.

// T-TEST-ENV-LOAD (2026-09-30): load the repo-root `.env` by ABSOLUTE PATH.
//
// This used to be `import 'dotenv/config'`, which reads `.env` from
// `process.cwd()`. Vitest runs with CWD = `packages/database`, and there is no
// `.env` in this package - so the root `.env` was never opened, DATABASE_URL
// stayed undefined, and the whole suite silently degraded: 157 of 169 tests
// took their `describe.skipIf(!HAS_DB)` path and the security RLS matrix
// enforced nothing while the run looked green.
//
// It also crashed the two files that build a Prisma client at MODULE scope
// (`const OWNER = createDirectPrismaClient()`) - with no URL the adapter
// connected as the postgres default user with an empty password, failing at
// import with `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a
// string`. A module-scope throw happens before any `beforeAll`/guard can skip,
// which is why the failure was a hard FAIL rather than a skip.
//
// Same class of bug as the documented Prisma-7 env pitfall (`dotenv/config`
// reads CWD; pnpm --filter sets CWD to packages/database). `prisma.config.ts`
// already solves it with `resolve(__dirname, ...)`; this mirrors that exactly.
//
// `process.loadEnvFile` (Node >= 20.6) is used rather than adding `dotenv`: it
// does NOT overwrite variables that are already set, so CI's injected
// DATABASE_URL / DIRECT_DATABASE_URL stay authoritative. The package declares
// `dotenv` as a devDep too, so either would work - matching the sibling
// `prisma.config.ts` is the lower-surprise choice.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, afterAll } from 'vitest';

import { isolateTestDatabase } from '../src/test-db-isolation';

const rootEnv = resolve(__dirname, '..', '..', '..', '.env');

if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    // Non-fatal: a malformed or unreadable `.env` must not break the suites
    // that do not need the database. DB-backed suites skip themselves when the
    // vars are missing, and RLS_MATRIX_REQUIRED still hard-fails in CI.
  }
}

// T-TEST-DB-ISOLATION (2026-09-16): the `.env` loaded above points at the
// DEVELOPMENT database. Redirect the matrix at `shadhil_crm_test` before
// anything connects - its INSERT probes write real rows and are how 140
// `matrix-test` leads ended up in dev.
//
// Throws rather than warns: if the redirect does not take effect, the suite must
// not run at all, because the whole point is that dev is unreachable from tests.
isolateTestDatabase();

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