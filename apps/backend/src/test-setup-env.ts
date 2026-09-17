// Backend vitest env bootstrap.
//
// WHY THIS EXISTS: the backend's dev/start scripts load env via
// `tsx --env-file=../../.env` (see package.json). Vitest does NOT - with no
// `setupFiles`, `process.env.DATABASE_URL` is undefined inside every test, and
// each DB-backed suite quietly takes its `describe.skipIf(!HAS_DB)` path.
//
// That is how a real defect hid: `visits.service.test.ts` skipped the handoff
// case entirely, so the only coverage of COMPLETED -> VISITED ran as ADMIN -
// the single role whose lane gate admitted that edge. A green-looking suite was
// a suite that never connected.
//
// Uses Node's own `process.loadEnvFile` (available since Node 20.6) rather than
// adding a `dotenv` dependency the backend does not have - `dotenv` is declared
// only in packages/database. Loads the monorepo root `.env` by absolute path
// (one source of truth, the same file the apps use).
//
// Keys are filled in only when absent, so CI's injected DATABASE_URL /
// DIRECT_DATABASE_URL stay authoritative: `process.loadEnvFile` does not
// overwrite variables that are already set.
//
// Lives under src/ (not test/) because this package's tsconfig sets
// `rootDir: ./src`; a file in test/ makes tsc fail with TS6059. Vitest
// discovers it via the `setupFiles` path in vitest.config.ts.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { isolateTestDatabase } from '@shadhil/database/test-db-isolation';

const rootEnv = resolve(__dirname, '..', '..', '..', '.env');

if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    // Non-fatal: a malformed or unreadable .env must not break the suites that
    // do not need the database. DB-backed suites skip themselves when the vars
    // are missing, and RLS_MATRIX_REQUIRED still hard-fails in CI.
  }
}

// T-TEST-DB-ISOLATION (2026-09-16): the `.env` above points at the DEVELOPMENT
// database. Redirect the test process at `shadhil_crm_test` and verify the result
// before any suite connects. DB-backed fixtures create and delete real rows, so
// running them against dev is how 141 orphan rows accumulated. The verify step
// throws if the rewrite did not take effect - a silent failure here would put us
// straight back in the dev database.
isolateTestDatabase();
