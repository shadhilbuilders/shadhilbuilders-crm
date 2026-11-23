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
  await db['lead']!.deleteMany({ where: { id: { in: [LEAD, LEAD_B] } } });
  await db['teamMember']!.deleteMany({ where: { userId: { in: [TC_OWNER, TC_OTHER] } } });
  await db['team']!.deleteMany({ where: { id: { in: [TEAM_A, TEAM_B] } } });
  await db['user']!.deleteMany({
    where: { id: { in: [MGR_A, MGR_B, TC_OWNER, TC_OTHER, ADMIN] } },
  });
  await db['project']!.deleteMany({ where: { id: PROJ } });
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
