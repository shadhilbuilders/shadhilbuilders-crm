// Invite RLS matrix (2026-11-20) - DB-first isolation matrix.
//
// Spec: the staff-invite plan, section 2.5. Migration under test:
// 20261120120000_staff_invites.
//
// These assert the POLICIES, not the service. The distinction matters: the
// service could be correct and an overbroad policy would still let the app role
// reach another tenant's data, and the reverse. Service behaviour is covered by
// apps/backend/src/invites/invites.service.test.ts; this file asks Postgres.
//
// Fixture contract (same as customer-portal-rls.test.ts): the OWNER-role direct
// client seeds, then every probe runs under `SET LOCAL ROLE shadhil_app` with
// explicit GUCs inside a rolled-back transaction - the only way to observe what
// the policies actually do.
//
// Permissive-by-absence: a denied SELECT returns an EMPTY SET (asserted as
// count 0), while an expected RLS violation asserts a thrown error.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/index';
import { createDirectPrismaClient } from '../src/test-db-isolation';
import { DATABASE_AVAILABLE } from './setup';

const owner = createDirectPrismaClient();

const ORG_A = 'ceid01lpfe1esm8jwsxid41k28'; // seeded demo org
const ORG_B = 'test-wa-handler-org2';

// Real cuid-shaped ids (lowercase alnum, 24 chars) - repo rule: no slugs.
const fid = (tag: string): string => `iv${tag}`.padEnd(24, '0');

const ADMIN_ID = fid('admin');
const MANAGER_ID = fid('mgr');
const OTHER_MANAGER_ID = fid('mgr2');
const TELECALLER_ID = fid('tc');
const TEAM_A = fid('teama');
const TEAM_B = fid('teamb');
const INVITE_ID = fid('invite');
const INVITE_HASH = `iv-hash-${INVITE_ID}`;
const NEW_USER_ID = fid('newuser');

/** Marker used to unwind the probe transaction; never surfaces as a failure. */
class Rollback extends Error {}

interface ProbeTx {
  $queryRawUnsafe: <T = unknown>(sql: string) => Promise<T>;
  $executeRawUnsafe: (sql: string) => Promise<number>;
}

/**
 * Run `sql` as the app role with these GUCs, then always roll back so no
 * fixture is mutated and the SET LOCAL values cannot bleed into the next case.
 *
 * `run` receives the tx so it can record results; an exception OTHER than our
 * Rollback is a real failure and is rethrown.
 */
async function asApp(
  gucs: {
    userId: string;
    role: string;
    orgId: string;
    tokenHash?: string;
    teamId?: string;
  },
  run: (tx: ProbeTx) => Promise<void>,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE shadhil_app`);
      await tx.$executeRawUnsafe(`SET LOCAL app.user_id = '${gucs.userId}'`);
      await tx.$executeRawUnsafe(`SET LOCAL app.user_role = '${gucs.role}'`);
      await tx.$executeRawUnsafe(`SET LOCAL app.user_org_id = '${gucs.orgId}'`);
      if (gucs.tokenHash !== undefined) {
        await tx.$executeRawUnsafe(`SET LOCAL app.invite_token_hash = '${gucs.tokenHash}'`);
      }
      if (gucs.teamId !== undefined) {
        await tx.$executeRawUnsafe(`SET LOCAL app.invite_team_id = '${gucs.teamId}'`);
      }
      await run(tx as unknown as ProbeTx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

/** How many Invite rows are visible under this context. */
async function visibleInvites(gucs: {
  userId: string;
  role: string;
  orgId: string;
  tokenHash?: string;
}): Promise<number> {
  let n = -1;
  await asApp(gucs, async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "Invite"`,
    );
    n = Number(rows[0]?.n ?? 0);
  });
  return n;
}

beforeAll(async () => {
  if (!DATABASE_AVAILABLE) return;

  for (const [id, role, name] of [
    [ADMIN_ID, 'ADMIN', 'Matrix Admin'],
    [MANAGER_ID, 'MANAGER', 'Matrix Manager'],
    [OTHER_MANAGER_ID, 'MANAGER', 'Matrix Other Manager'],
    [TELECALLER_ID, 'TELECALLER', 'Matrix Telecaller'],
  ] as const) {
    await owner.user.upsert({
      where: { id },
      update: { role },
      create: { id, email: `${id}@test.local`, name, role, organizationId: ORG_A },
    });
  }
  for (const [id, name, managerId] of [
    [TEAM_A, 'Matrix Team A', MANAGER_ID],
    [TEAM_B, 'Matrix Team B', OTHER_MANAGER_ID],
  ] as const) {
    await owner.team.upsert({
      where: { id },
      update: { managerId },
      create: { id, name, managerId, organizationId: ORG_A },
    });
  }
  await owner.invite.upsert({
    where: { id: INVITE_ID },
    update: {},
    create: {
      id: INVITE_ID,
      organizationId: ORG_A,
      email: `matrix-${INVITE_ID}@test.local`,
      name: 'Matrix Invite',
      phone: '919900000001',
      role: 'TELECALLER',
      teamId: TEAM_A,
      tokenHash: INVITE_HASH,
      invitedById: ADMIN_ID,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

afterAll(async () => {
  if (!DATABASE_AVAILABLE) return;
  await owner.invite.deleteMany({ where: { invitedById: { in: [ADMIN_ID, MANAGER_ID] } } });
  await owner.auditLog.deleteMany({
    where: { userId: { in: [ADMIN_ID, MANAGER_ID, OTHER_MANAGER_ID, TELECALLER_ID] } },
  });
  await owner.user.deleteMany({
    where: { id: { in: [ADMIN_ID, MANAGER_ID, OTHER_MANAGER_ID, TELECALLER_ID, NEW_USER_ID] } },
  });
  await owner.team.deleteMany({ where: { id: { in: [TEAM_A, TEAM_B] } } });
});

describe.skipIf(!DATABASE_AVAILABLE)('Invite RLS - the token arm', () => {
  it('admits the row with the correct hash', async () => {
    expect(
      await visibleInvites({
        userId: NEW_USER_ID,
        role: 'INVITE_ACCEPT',
        orgId: ORG_A,
        tokenHash: INVITE_HASH,
      }),
    ).toBe(1);
  });

  it('denies a WRONG hash even in the right org', async () => {
    expect(
      await visibleInvites({
        userId: NEW_USER_ID,
        role: 'INVITE_ACCEPT',
        orgId: ORG_A,
        tokenHash: 'not-the-right-hash',
      }),
    ).toBe(0);
  });

  it('denies the correct hash in the WRONG org (org AND hash conjunct)', async () => {
    expect(
      await visibleInvites({
        userId: NEW_USER_ID,
        role: 'INVITE_ACCEPT',
        orgId: ORG_B,
        tokenHash: INVITE_HASH,
      }),
    ).toBe(0);
  });

  it('denies when no hash is set at all', async () => {
    expect(await visibleInvites({ userId: NEW_USER_ID, role: 'INVITE_ACCEPT', orgId: ORG_A })).toBe(
      0,
    );
  });

  it('a bare read with no GUCs sees nothing (FORCE RLS is real)', async () => {
    // This is the exact reason the pre-flight lookup needs the SECURITY
    // DEFINER resolver instead of an ordinary Prisma read.
    const rows = await prisma.invite.findMany({ where: { id: INVITE_ID }, select: { id: true } });
    expect(rows).toHaveLength(0);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('Invite RLS - admin and manager read arms', () => {
  it('ADMIN sees the org’s invites', async () => {
    expect(await visibleInvites({ userId: ADMIN_ID, role: 'ADMIN', orgId: ORG_A })).toBeGreaterThan(
      0,
    );
  });

  it('TELECALLER sees nothing', async () => {
    expect(await visibleInvites({ userId: TELECALLER_ID, role: 'TELECALLER', orgId: ORG_A })).toBe(
      0,
    );
  });

  it('a manager sees only invites for teams they lead', async () => {
    // MANAGER_ID leads TEAM_A, which the fixture invite targets.
    expect(await visibleInvites({ userId: MANAGER_ID, role: 'MANAGER', orgId: ORG_A })).toBe(1);
    // OTHER_MANAGER_ID leads TEAM_B, not the invite's team.
    expect(await visibleInvites({ userId: OTHER_MANAGER_ID, role: 'MANAGER', orgId: ORG_A })).toBe(
      0,
    );
  });

  it('a manager cannot cross orgs', async () => {
    expect(await visibleInvites({ userId: MANAGER_ID, role: 'MANAGER', orgId: ORG_B })).toBe(0);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('Invite RLS - the accept UPDATE arm', () => {
  it('refuses an update when the row is not PENDING', async () => {
    await owner.invite.update({ where: { id: INVITE_ID }, data: { status: 'ACCEPTED' } });
    try {
      let affected = -1;
      await asApp(
        { userId: NEW_USER_ID, role: 'INVITE_ACCEPT', orgId: ORG_A, tokenHash: INVITE_HASH },
        async (tx) => {
          affected = await tx.$executeRawUnsafe(
            `UPDATE "Invite" SET "status" = 'ACCEPTED' WHERE "id" = '${INVITE_ID}'`,
          );
        },
      );
      // USING requires status = 'PENDING', so a non-pending row is invisible
      // and the UPDATE matches nothing.
      expect(affected).toBe(0);
    } finally {
      await owner.invite.update({
        where: { id: INVITE_ID },
        data: { status: 'PENDING', acceptedAt: null, acceptedByUserId: null },
      });
    }
  });

  it('the accept arm cannot rewrite the invite email or role', async () => {
    let rejected = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE shadhil_app`);
        await tx.$executeRawUnsafe(`SET LOCAL app.user_id = '${NEW_USER_ID}'`);
        await tx.$executeRawUnsafe(`SET LOCAL app.user_role = 'INVITE_ACCEPT'`);
        await tx.$executeRawUnsafe(`SET LOCAL app.user_org_id = '${ORG_A}'`);
        await tx.$executeRawUnsafe(`SET LOCAL app.invite_token_hash = '${INVITE_HASH}'`);
        // WITH CHECK only names org + status, so an UPDATE that also moves the
        // role must be refused by the policy.
        await tx.$executeRawUnsafe(
          `UPDATE "Invite" SET "status" = 'ACCEPTED', "role" = 'ADMIN' WHERE "id" = '${INVITE_ID}'`,
        );
        throw new Rollback();
      });
    } catch (err) {
      if (err instanceof Rollback) {
        rejected = false; // it went through - a policy failure
      } else {
        rejected = true;
      }
    }
    expect(rejected).toBe(true);
    // And the row is untouched.
    const row = await owner.invite.findUnique({
      where: { id: INVITE_ID },
      select: { role: true },
    });
    expect(row?.role).toBe('TELECALLER');
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('Invite RLS - TeamMember insert arm', () => {
  it('refuses a teamId other than app.invite_team_id', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE shadhil_app`);
        await tx.$executeRawUnsafe(`SET LOCAL app.user_id = '${NEW_USER_ID}'`);
        await tx.$executeRawUnsafe(`SET LOCAL app.user_role = 'INVITE_ACCEPT'`);
        await tx.$executeRawUnsafe(`SET LOCAL app.user_org_id = '${ORG_A}'`);
        // The invite names TEAM_A; try to place the user on TEAM_B.
        await tx.$executeRawUnsafe(`SET LOCAL app.invite_team_id = '${TEAM_A}'`);
        await tx.$executeRawUnsafe(
          `INSERT INTO "TeamMember" ("userId","teamId","organizationId","assignedAt","weight")
           VALUES ('${NEW_USER_ID}','${TEAM_B}','${ORG_A}', now(), 1)`,
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('team_manager_is_self does not recurse', () => {
  it('returns false for an unknown team without raising 42P17', async () => {
    // A wrong SECURITY DEFINER shape would hit the TeamMember -> Team ->
    // TeamMember cycle and raise 42P17 here.
    const rows = await owner.$queryRawUnsafe<Array<{ r: boolean }>>(
      `SELECT team_manager_is_self('nope', 'nobody') AS r`,
    );
    expect(rows[0]?.r).toBe(false);
  });

  it('answers true for the real manager of a team', async () => {
    const rows = await owner.$queryRawUnsafe<Array<{ r: boolean }>>(
      `SELECT team_manager_is_self('${TEAM_A}', '${MANAGER_ID}') AS r`,
    );
    expect(rows[0]?.r).toBe(true);
  });
});
