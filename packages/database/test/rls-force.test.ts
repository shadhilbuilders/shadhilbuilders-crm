// AR-1 (2026-08-31): FORCE ROW LEVEL SECURITY on every table that carries RLS.
//
// The header of src/rls.ts states this as an invariant. On 2026-11-28 it was not
// true: seven tables had RLS enabled and FORCE off, and nothing failed, because
// the claim lived in a comment and in a hand-maintained array in policies.sql.
// A catalogue that lists table names rots the moment a table is added; this test
// asks Postgres instead, so the invariant is checked rather than asserted.
//
// The test is deliberately schema-wide: it does not name any table, so a new
// table with ENABLE and no FORCE fails here without anyone remembering to add it.
//
// What this does NOT prove: the FORCEd state constrains the table owner only when
// that role is not a superuser. `shadhil` is SUPERUSER with BYPASSRLS today, so
// this guard protects the invariant, not the data, until that role changes. See
// TODOS.md.
import { describe, expect, it } from 'vitest';

import { prisma } from '../src/index';

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)('RLS invariants', () => {
  it('forces RLS on every table that enables it', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity
          AND NOT c.relforcerowsecurity
        ORDER BY 1`,
    );

    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});
