// T-TEST-ENV-LOAD (2026-09-30): the setup file must actually deliver the env.
//
// THE BUG THIS PINS
//
// `test/setup.ts` loaded the repo-root `.env` with `import 'dotenv/config'`,
// which reads `.env` from `process.cwd()`. Vitest runs with CWD =
// `packages/database`, which has no `.env`, so the root file was never opened and
// DATABASE_URL stayed undefined.
//
// The damage was silent and enormous: 157 of 169 tests in this package took their
// `describe.skipIf(!HAS_DB)` path. That includes the ENTIRE RLS security matrix
// (128 cases - 4 roles x 8 tables x 4 actions), so the package reported a green
// run while enforcing no security policy whatsoever. Two files with a
// module-scope Prisma client threw instead of skipping, which was the only
// visible symptom - and it pointed at the database, not at the missing env.
//
// WHY THIS TEST IS SHAPED THIS WAY
//
// It asserts the SETUP FILE's contract, not the helper's internals: a missing
// `.env` must be the only reason the vars are absent. It deliberately does NOT
// read the value (the URL carries credentials); it asserts the var is non-empty
// and points at a `_test` database, which is exactly the state the suite needs to
// be meaningful.
//
// A future refactor that drops the explicit path, or moves the setup file, breaks
// this test loudly - instead of quietly turning the security suite into a no-op
// again, which is the failure mode that costs nothing to introduce and months to
// notice.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { databaseNameOf } from '../src/test-db-isolation';

// Mirrors setup.ts: the repo-root `.env`, resolved from THIS file's directory.
// `__dirname` is stable across CWD changes, which is the whole point - see the
// comment in setup.ts.
const HAS_ENV_FILE = existsSync(resolve(__dirname, '..', '..', '..', '.env'));

describe('T-TEST-ENV-LOAD: the setup file delivers DATABASE_URL to every suite', () => {
  it.skipIf(!HAS_ENV_FILE)('DATABASE_URL is populated by the time a test file runs', () => {
    // If this fails, the root `.env` was not loaded - every DB-backed suite in
    // this package is silently skipping, including the RLS security matrix.
    expect(process.env.DATABASE_URL ?? '').not.toBe('');
  });

  it.skipIf(!HAS_ENV_FILE)('the env points at a _test database, never development', () => {
    // The isolation guard in setup.ts throws rather than letting this pass, but
    // assert it here too: this is the property that keeps orphan rows from being
    // written into dev again.
    const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
    expect(databaseNameOf(url)).toMatch(/_test$/);
  });
});
