// The owner split's invariants (docs/planning/OWNER-ROLE-MIGRATION.md, W14).
//
// Three tests, three failure modes that are all silent in production:
//
// (a) ATTRIBUTES. If `shadhil_owner` regains BYPASSRLS, or `shadhil_rls` loses it, every
//     policy in the database is either decoration or bypassed. Nothing breaks visibly;
//     one role's attributes is the whole difference.
// (b) OWNERSHIP. A single `CREATE OR REPLACE FUNCTION` in a later migration re-owns a
//     helper as whoever ran it. If that is the owner role, the helper stops bypassing RLS
//     and quietly answers with the caller's own visibility, which is exactly what
//     `project_unit_ids` was written to avoid. Measured on 2026-11-28: no error, one row
//     instead of two.
// (c) THE ROLE SET. A fourth role with SUPERUSER or BYPASSRLS is a fourth credential that
//     can read every tenant. Named, counted, so adding one is a decision rather than an
//     accident.
//
// These are schema-wide questions asked of the catalogue, not lists in a file, for the
// same reason `rls-force.test.ts` asks `pg_class`: a list rots and a catalogue does not.
import { describe, expect, it } from 'vitest';

import { prisma } from '../src/index';

const HAS_DB = Boolean(process.env.DATABASE_URL);

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
}

async function roles(names: string[]): Promise<Map<string, RoleRow>> {
  const rows = await prisma.$queryRawUnsafe<RoleRow[]>(
    `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
       FROM pg_roles
      WHERE rolname = ANY($1)`,
    names,
  );
  return new Map(rows.map((r) => [r.rolname, r]));
}

describe.skipIf(!HAS_DB)('owner split', () => {
  it('gives the three roles the attributes their job needs', async () => {
    const found = await roles(['shadhil_owner', 'shadhil_rls', 'shadhil_seed']);

    expect(found.get('shadhil_owner')).toMatchObject({
      // The migration role must NOT bypass RLS: it is the role whose FORCEd policies the
      // whole design rests on, and it is the one whose credential ships in .env files.
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
    expect(found.get('shadhil_rls')).toMatchObject({
      // The helper owner MUST bypass: a SECURITY DEFINER function owned by a non-bypass
      // role silently returns the caller's visibility.
      rolsuper: false,
      rolbypassrls: true,
      // No login. It is a function owner, not a credential, so there is no password to
      // rotate and nothing to leak.
      rolcanlogin: false,
    });
    expect(found.get('shadhil_seed')).toMatchObject({
      rolsuper: false,
      rolbypassrls: true,
      rolcanlogin: true,
    });
  });

  it('leaves every SECURITY DEFINER helper owned by the bypass role', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ proname: string; owner: string }>>(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY 1`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.filter((r) => r.owner !== 'shadhil_rls').map((r) => `${r.proname}=${r.owner}`),
    ).toEqual([]);
  });

  it('knows every role that can cross a tenant boundary', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ rolname: string }>>(
      `SELECT rolname
         FROM pg_roles
        WHERE (rolsuper OR rolbypassrls)
          AND rolname NOT LIKE 'pg\\_%'
        ORDER BY 1`,
    );

    // Four, and each one is named here so a fifth is a test failure rather than a
    // discovery: the bootstrap superuser (break-glass), the helper owner, the seed, and
    // pg_monitor-adjacent built-ins are excluded by the pg_ prefix filter above.
    expect(rows.map((r) => r.rolname)).toEqual(['shadhil', 'shadhil_rls', 'shadhil_seed']);
  });
});
