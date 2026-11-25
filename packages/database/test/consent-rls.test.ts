// ────────────────────────────────────────────────────────────────────────────
// Consent ledger: RLS access control (2026-11-23)
// ────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS: the Consent table carried SELECT + INSERT policies and
// no test had ever exercised either, so "a staff member can record an opt-in"
// was an assumption. It is now load-bearing: the site-update WhatsApp templates
// are approved as MARKETING, and every send decision reads the newest MARKETING
// row (apps/backend/src/customer-progress/site-update-consent.ts).
//
// WHAT IS PINNED HERE:
//   1. The lead's owner and co-owner can append a row; their manager can;
//      an ADMIN can. Nobody else in the org can, and another org cannot.
//   2. There is NO UPDATE and NO DELETE path - not even for an ADMIN. A ledger
//      an admin can rewrite is not evidence of what the buyer agreed to.
//   3. An opt-out does not erase the opt-in before it: both rows survive, which
//      is the property the "newest row wins" rule depends on.
//
// Seeding runs through the owner role (BYPASSRLS) because the INSERT policies
// gate on app.user_role, and a fixture that seeds consent rows would be proving
// its own policy.
import { existsSync, readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/index';
import { withRlsContext, type RlsContext } from '../src/rls';
import { createDirectPrismaClient } from '../src/test-db-isolation';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const ORG_B = `crls${Date.now().toString()}b`.padEnd(24, '0');
const TAG = `crls${Date.now().toString()}`;

const TEAM_A = `${TAG}team`;
const TEAM_B = `${TAG}teab`;
const PROJ = `${TAG}proj`;
const MGR_A = `${TAG}mgra`; // manages TEAM_A
const MGR_B = `${TAG}mgrb`; // manages TEAM_B
const TC_OWNER = `${TAG}tco`; // owns the lead
const TC_OTHER = `${TAG}tcx`; // same team, not the owner
const ADMIN = `${TAG}adm`;
const LEAD = `${TAG}lead`;
const LEAD_B = `${TAG}leadb`;
// A lead in the OTHER org, plus the staff it needs (Lead requires owner, team
// and project). Used to prove the lead-org predicate rather than the actor-org
// one: the actor below is an ADMIN of ORG writing a row stamped ORG, so only a
// check against the LEAD's org can refuse it.
const PROJ_B = `${TAG}prjb`;
const TEAM_C = `${TAG}teamc`;
const MGR_C = `${TAG}mgrc`;
const LEAD_C = `${TAG}leadc`;

const ownerPrisma = createDirectPrismaClient();

const ctxOf = (userId: string, role: RlsContext['role'], organizationId = ORG): RlsContext => ({
  userId,
  role,
  organizationId,
});

/** Append one consent row as the given actor. Returns the Prisma error, or null. */
async function tryInsertConsent(
  ctx: RlsContext,
  leadId: string,
  granted: boolean,
  rowOrg = ctx.organizationId,
): Promise<unknown | null> {
  try {
    await withRlsContext(prisma, ctx, async (tx) =>
      tx.consent.create({
        data: {
          leadId,
          organizationId: rowOrg,
          consentType: 'MARKETING',
          granted,
          grantedAt: new Date(),
          source: 'call_verbal',
        },
      }),
    );
    return null;
  } catch (err) {
    return err;
  }
}

beforeAll(async () => {
  const db = ownerPrisma as unknown as Record<string, { create: (a: unknown) => Promise<unknown> }>;
  await db['organization']!.create({
    data: { id: ORG_B, name: `Consent RLS other org ${ORG_B}`, slug: ORG_B.slice(0, 20) },
  });
  await db['project']!.create({
    data: {
      id: PROJ,
      name: `Consent RLS ${PROJ}`,
      slug: PROJ,
      address: 'x',
      organizationId: ORG,
    },
  });
  // Users before teams: Team.managerId is an FK, so a manager row must exist
  // before the team it manages.
  for (const [id, role, org] of [
    [MGR_A, 'MANAGER', ORG],
    [MGR_B, 'MANAGER', ORG],
    [TC_OWNER, 'TELECALLER', ORG],
    [TC_OTHER, 'TELECALLER', ORG],
    [ADMIN, 'ADMIN', ORG],
  ] as const) {
    await db['user']!.create({
      data: {
        id,
        email: `${id}@test.local`,
        name: `Consent RLS ${id}`,
        role,
        organizationId: org,
        mustChangePassword: false,
      },
    });
  }
  await db['team']!.create({
    data: { id: TEAM_A, name: `Consent RLS A ${TEAM_A}`, organizationId: ORG, managerId: MGR_A },
  });
  await db['team']!.create({
    data: { id: TEAM_B, name: `Consent RLS B ${TEAM_B}`, organizationId: ORG, managerId: MGR_B },
  });
  for (const [userId, teamId] of [
    [TC_OWNER, TEAM_A],
    [TC_OTHER, TEAM_A],
  ] as const) {
    await db['teamMember']!.create({
      data: { userId, teamId, organizationId: ORG },
    });
  }
  const leadRows = [
    {
      id: LEAD,
      phone: `91${TAG.slice(4, 12)}001`.slice(0, 15),
      teamId: TEAM_A,
      ownerId: TC_OWNER,
    },
    {
      id: LEAD_B,
      phone: `91${TAG.slice(4, 12)}002`.slice(0, 15),
      teamId: TEAM_B,
      ownerId: MGR_B,
    },
  ];
  for (const row of leadRows) {
    await db['lead']!.create({
      data: {
        id: row.id,
        name: `Consent RLS ${row.id}`,
        phone: row.phone,
        phoneE164: row.phone,
        source: 'WEBSITE',
        state: 'NEW',
        teamId: row.teamId,
        ownerId: row.ownerId,
        ownerType: 'TELECALLER',
        organizationId: ORG,
        projectId: PROJ,
      },
    });
  }

  // The other tenant's own staff, so LEAD_C is a real lead rather than a bare id.
  await db['project']!.create({
    data: {
      id: PROJ_B,
      name: `Consent RLS B ${PROJ_B}`,
      slug: PROJ_B,
      address: 'x',
      organizationId: ORG_B,
    },
  });
  await db['user']!.create({
    data: {
      id: MGR_C,
      email: `${MGR_C}@test.local`,
      name: `Consent RLS ${MGR_C}`,
      role: 'MANAGER',
      organizationId: ORG_B,
      mustChangePassword: false,
    },
  });
  await db['team']!.create({
    data: { id: TEAM_C, name: `Consent RLS C ${TEAM_C}`, organizationId: ORG_B, managerId: MGR_C },
  });
  await db['lead']!.create({
    data: {
      id: LEAD_C,
      name: `Consent RLS ${LEAD_C}`,
      phone: `91${TAG.slice(4, 12)}003`.slice(0, 15),
      phoneE164: `91${TAG.slice(4, 12)}003`.slice(0, 15),
      source: 'WEBSITE',
      state: 'NEW',
      teamId: TEAM_C,
      ownerId: MGR_C,
      ownerType: 'MANAGER',
      organizationId: ORG_B,
      projectId: PROJ_B,
    },
  });
}, 60_000);

afterAll(async () => {
  const db = ownerPrisma as unknown as Record<
    string,
    { deleteMany: (a: unknown) => Promise<unknown> }
  >;
  await db['consent']!.deleteMany({
    where: { organizationId: ORG, leadId: { in: [LEAD, LEAD_B] } },
  });
  await db['auditLog']!.deleteMany({
    where: { organizationId: ORG, entityId: { in: [LEAD, LEAD_B] } },
  });
  await db['lead']!.deleteMany({ where: { id: { in: [LEAD, LEAD_B, LEAD_C] } } });
  await db['teamMember']!.deleteMany({ where: { userId: { in: [TC_OWNER, TC_OTHER] } } });
  await db['team']!.deleteMany({ where: { id: { in: [TEAM_A, TEAM_B, TEAM_C] } } });
  await db['user']!.deleteMany({
    where: { id: { in: [MGR_A, MGR_B, MGR_C, TC_OWNER, TC_OTHER, ADMIN] } },
  });
  await db['project']!.deleteMany({ where: { id: { in: [PROJ, PROJ_B] } } });
  await db['organization']!.deleteMany({ where: { id: ORG_B } });
  await ownerPrisma.$disconnect();
}, 60_000);

describe('Consent RLS', () => {
  it('lets the lead owner append an opt-in, which then reads back as visible', async () => {
    const err = await tryInsertConsent(ctxOf(TC_OWNER, 'TELECALLER'), LEAD, true);
    expect(err).toBeNull();

    const count = await withRlsContext(prisma, ctxOf(TC_OWNER, 'TELECALLER'), async (tx) =>
      tx.consent.count({ where: { leadId: LEAD } }),
    );
    expect(count).toBe(1);
  });

  it('refuses a telecaller who does not own the lead', async () => {
    // Same team, same org, not the owner and not the co-owner. The lead select
    // policy would hide it; the insert policy must refuse it too.
    const err = await tryInsertConsent(ctxOf(TC_OTHER, 'TELECALLER'), LEAD, true);
    expect(err).not.toBeNull();
  });

  it("lets the team's manager append a row", async () => {
    expect(await tryInsertConsent(ctxOf(MGR_A, 'MANAGER'), LEAD, true)).toBeNull();
  });

  it('refuses a manager from another team, and an admin from another org', async () => {
    expect(await tryInsertConsent(ctxOf(MGR_B, 'MANAGER'), LEAD, true)).not.toBeNull();
    // The attack that matters: an admin of another org writing INTO this org's
    // ledger (a row stamped with this org). The policy's org equality refuses
    // it. A row stamped with their OWN org against this lead is permitted by
    // the current policy but is invisible to this org, so it cannot influence a
    // send decision here - it is clutter in their own tenant, and tightening
    // the policy to require lead-org equality is a follow-up, not this feature.
    expect(await tryInsertConsent(ctxOf(ADMIN, 'ADMIN', ORG_B), LEAD, true, ORG)).not.toBeNull();
  });

  it('lets an admin append a row in their own org', async () => {
    expect(await tryInsertConsent(ctxOf(ADMIN, 'ADMIN'), LEAD_B, true)).toBeNull();
  });

  it('has no update or delete path, so an opt-in cannot be rewritten', async () => {
    // The append-only property: an UPDATE that would turn a stored opt-in into
    // an opt-out must affect ZERO rows for every role, the admin included. If
    // this ever returns >0, consent history is mutable and the "newest row
    // wins" rule stops meaning what the send decision assumes.
    for (const ctx of [
      ctxOf(TC_OWNER, 'TELECALLER'),
      ctxOf(MGR_A, 'MANAGER'),
      ctxOf(ADMIN, 'ADMIN'),
    ]) {
      const updated = await withRlsContext(prisma, ctx, async (tx) =>
        tx.consent.updateMany({ where: { leadId: LEAD }, data: { granted: false } }),
      );
      expect(updated.count).toBe(0);

      const deleted = await withRlsContext(prisma, ctx, async (tx) =>
        tx.consent.deleteMany({ where: { leadId: LEAD } }),
      );
      expect(deleted.count).toBe(0);
    }
  });

  it('hides the ledger from a staff member outside the lead', async () => {
    const seen = await withRlsContext(prisma, ctxOf(TC_OTHER, 'TELECALLER'), async (tx) =>
      tx.consent.count({ where: { leadId: LEAD } }),
    );
    expect(seen).toBe(0);
  });

  it('keeps both rows when an opt-out follows an opt-in', async () => {
    // The service appends; this asserts the table does not quietly replace. The
    // earlier opt-in has to survive for the ledger to show what happened.
    expect(await tryInsertConsent(ctxOf(TC_OWNER, 'TELECALLER'), LEAD, false)).toBeNull();
    const rows = await withRlsContext(prisma, ctxOf(ADMIN, 'ADMIN'), async (tx) =>
      tx.consent.findMany({
        where: { leadId: LEAD },
        orderBy: [{ grantedAt: 'asc' }, { createdAt: 'asc' }],
        select: { granted: true },
      }),
    );
    expect(rows.map((r) => r.granted)).toEqual([true, true, false]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-CONSENT-ORG (2026-11-26): a consent row belongs to its lead's tenant.
// ────────────────────────────────────────────────────────────────────────────
// The bug this pins: both INSERT policies compared the row to the ACTOR's org
// and never to the LEAD's, so an ADMIN could append a marketing opt-in to
// another tenant's lead by stamping their own org on it. The newest MARKETING
// row decides whether a buyer may be mailed, so that row would have answered
// for the wrong person.
class RolledBack extends Error {}

/** The shipping repair statement, read from the migration rather than copied. */
function repairStatement(): string {
  const candidates = [
    'prisma/migrations/20261126033000_consent_org_matches_lead/migration.sql',
    '../prisma/migrations/20261126033000_consent_org_matches_lead/migration.sql',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) throw new Error('consent migration not found from ' + process.cwd());
  const sql = readFileSync(found, 'utf8');
  const start = sql.indexOf('UPDATE "Consent" c');
  if (start === -1) throw new Error('the repair UPDATE is gone from the migration');
  return sql.slice(start, sql.indexOf(';', start) + 1);
}

describe('T-CONSENT-ORG: a Consent row belongs to its lead org', () => {
  it("refuses an ADMIN stamping their own org onto another tenant's lead", async () => {
    // Row org = the ACTOR's org, so the old policy was satisfied; only a check
    // against LEAD_C's org (ORG_B) can refuse this. Which wall answers first is
    // Postgres's business (measured: the trigger does, error 23514); the
    // assertion is the refusal itself, and the policy is pinned separately
    // below, because a behind-the-trigger wall never gets to speak.
    const err = await tryInsertConsent(ctxOf(ADMIN, 'ADMIN'), LEAD_C, true);
    expect(err).not.toBeNull();
  });

  it('the admin insert policy carries the lead-org predicate too (defence in depth)', async () => {
    // The trigger refuses first today. If it were ever dropped, the policy is
    // what would still be standing, so its text is asserted rather than assumed.
    const rows = await ownerPrisma.$queryRaw<{ with_check: string | null }[]>`
      SELECT with_check FROM pg_policies
       WHERE tablename = 'Consent' AND policyname = 'consent_insert_admin'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.with_check).toContain('"Lead" l');
  });

  it('still lets an ADMIN append a row to a lead in their own org', async () => {
    expect(await tryInsertConsent(ctxOf(ADMIN, 'ADMIN'), LEAD, true)).toBeNull();
  });

  it('refuses a mismatched row even through the owner role, which no policy binds', async () => {
    // The policy gate only binds the app role. Every seed and every script runs
    // as the owner, so without the trigger the invariant would be advisory.
    await expect(
      ownerPrisma.consent.create({
        data: {
          leadId: LEAD,
          organizationId: ORG_B,
          consentType: 'MARKETING',
          granted: true,
          grantedAt: new Date(),
          source: 'trigger_test',
        },
      }),
    ).rejects.toThrow(/is not its lead|23514/);
  });

  it('allows the owner role to write a consistent row', async () => {
    const row = await ownerPrisma.consent.create({
      data: {
        leadId: LEAD,
        organizationId: ORG,
        consentType: 'MARKETING',
        granted: true,
        grantedAt: new Date(),
        source: 'trigger_ok_test',
      },
    });
    expect(row.organizationId).toBe(ORG);
    await ownerPrisma.consent.delete({ where: { id: row.id } });
  });

  it('the repair relinks a mismatched row instead of deleting it', async () => {
    // The trigger now refuses the rows the repair exists to fix, so the
    // statement is proved in a transaction that is rolled back: trigger off,
    // a mismatched row in, the shipped UPDATE, the assertion, then ROLLBACK.
    await expect(
      ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "Consent" DISABLE TRIGGER consent_org_matches_lead_trg',
        );
        await tx.consent.create({
          data: {
            leadId: LEAD,
            organizationId: ORG_B,
            consentType: 'MARKETING',
            granted: true,
            grantedAt: new Date(),
            source: 'repair_test',
          },
        });

        const affected = await tx.$executeRawUnsafe(repairStatement());
        const row = await tx.consent.findFirst({
          where: { leadId: LEAD, source: 'repair_test' },
          select: { organizationId: true },
        });

        expect(affected).toBeGreaterThan(0);
        expect(row?.organizationId).toBe(ORG);
        throw new RolledBack('rollback: the repair was proved, not applied');
      }),
    ).rejects.toBeInstanceOf(RolledBack);
  });
});
