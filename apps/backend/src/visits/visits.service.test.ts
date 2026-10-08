// T-D4 - visit outcome conflict rule: idempotent replay + real conflict.
//
// Real-DB tests (no mocks). Fixture pattern mirrors the T-E2b
// whatsapp-unknown-contacts service test: bare prisma (via
// withRlsContext as ADMIN) for seeding/cleanup; the service under test
// runs its own withRlsContext inside each method.
//
// Conflict rule (visits.service.ts, updateOutcome):
//   - Exact replay (visit already has status+outcome === dto.outcome):
//     no-op - returns the current row, writes ONE audit row marked
//     "Idempotent replay ... no state change".
//   - Different outcome on an advanced visit: falls through to the
//     state machine → rejected (server-wins per offline-store LWW).
//   - COMPLETED still drives the parent lead to VISITED exactly once.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { LEAD_STATES } from '../leads/leads.state-machine';
import { LeadsService } from '../leads/leads.service';

import { VisitsService } from './visits.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
// T-LEAD-PROJECT-REQUIRED (2026-09-16): Lead.projectId is NOT NULL, so the
// fixture leads below need a project.
const TEST_PROJECT_ID = 'testprojvisits' + Date.now().toString();
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const RUN = Date.now();
const ADMIN_ID = `test-voc-admin-${RUN}`;
const SE_ID = `test-voc-se-${RUN}`;
// T-VISIT-OWNER-LABEL (2026-09-28): a SECOND person, distinct from SE_ID, so the
// fixture can express the real scheduled-visit shape (plan §3 keeps the
// telecaller as OWNER while a sales exec CONDUCTS the visit) instead of having
// `Lead.ownerId` and `SiteVisit.userId` collapse to the same row. Without this
// the two names could never differ in a test, which is exactly why the
// dashboard's mislabelling went unnoticed.
const TC_ID = `test-voc-tc-${RUN}`;
const SE2_ID = `test-voc-se2-${RUN}`;
const TEAM_ID = `test-voc-team-${RUN}`;

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function actorFor(userId: string, role: 'ADMIN' | 'SALES_EXEC' | 'TELECALLER'): JwtPayload {
  return {
    sub: userId,
    email: `${userId}@example.com`,
    role,
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

const TEST_LEAD_IDS: string[] = [];
const TEST_VISIT_IDS: string[] = [];

let seq = 0;
async function seedLeadWithVisit(
  /**
   * T-VISIT-OWNER-LABEL (2026-09-28): when true the lead is owned by the
   * TELECALLER and the visit is conducted by the SALES_EXEC - the real
   * VISIT_SCHEDULED shape per plan §3. Off by default because the rest of this
   * suite tests the exec's own lanes, where owner and exec are one person.
   */
  { splitOwnerFromExec = false }: { splitOwnerFromExec?: boolean } = {},
): Promise<{ leadId: string; visitId: string }> {
  if (prisma === null) throw new Error('prisma missing');
  seq += 1;
  const leadId = `test-voc-lead-${RUN}-${seq}`;
  const visitId = `test-voc-visit-${RUN}-${seq}`;
  await adminSeed(async (db) => {
    await db.lead.create({
      data: {
        id: leadId,
        name: `VOC Lead ${seq}`,
        phone: `91${String(RUN).slice(-8)}${String(seq).padStart(3, '0')}`,
        phoneE164: `919${String(RUN).slice(-8)}${String(seq).padStart(3, '0')}`,
        source: 'WHATSAPP',
        state: 'VISIT_SCHEDULED',
        // Default stays `SE_ID` for both: most of this suite exercises the
        // exec's own lanes (they act on a visit they both own and conduct), so
        // changing it globally would rewrite their subject. The owner/exec
        // SPLIT is opt-in via `splitOwnerFromExec` below - see
        // T-VISIT-OWNER-LABEL (2026-09-28).
        ownerId: splitOwnerFromExec ? TC_ID : SE_ID,
        ownerType: splitOwnerFromExec ? 'TELECALLER' : 'SALES_EXEC',
        // T-VISIT-OWNER-LABEL (2026-09-28): the exec's access to this lead comes
        // from `coOwnerId`, which is the plan §3 "shared visibility at
        // VISIT_SCHEDULED" mechanism (schema comment on Lead.coOwnerId). Without
        // it the exec sees the VISIT but not its LEAD - `lead_select_telecaller`
        // matches on ownerId/coOwnerId only - and `list()`'s `lead` relation
        // resolves to null. Pinned here because it is a real coupling, not a
        // fixture convenience: see the gap reported with this change.
        coOwnerId: splitOwnerFromExec ? SE_ID : null,
        teamId: TEAM_ID,
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',

        projectId: TEST_PROJECT_ID,
      },
    });
    await db.siteVisit.create({
      data: {
        id: visitId,
        leadId,
        userId: SE_ID,
        scheduledFor: new Date(),
        status: 'SCHEDULED',
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      },
    });
  });
  TEST_LEAD_IDS.push(leadId);
  TEST_VISIT_IDS.push(visitId);
  return { leadId, visitId };
}

async function cleanupAll(): Promise<void> {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    const ids = [...TEST_VISIT_IDS];
    if (ids.length > 0) {
      await db.$executeRawUnsafe(
        `DELETE FROM "SiteVisit" WHERE id = ANY($1::text[])`,
        ids,
      );
    }
    // Any visit still hanging off a test lead. The create-eligibility suite
    // (T-VISIT-NO-SHOW-SCHEDULING) creates visits through the SERVICE, so their
    // ids are not in TEST_VISIT_IDS - and `SiteVisit.leadId` is a required FK,
    // so deleting the lead first would fail on the constraint rather than
    // silently leave rows behind. Scoped by the lead ids this suite owns, so it
    // can never reach into another suite's fixtures.
    if (TEST_LEAD_IDS.length > 0) {
      await db.$executeRawUnsafe(
        `DELETE FROM "SiteVisit" WHERE "leadId" = ANY($1::text[])`,
        [...TEST_LEAD_IDS],
      );
    }
    const leadIds = [...TEST_LEAD_IDS];
    if (leadIds.length > 0) {
      await db.$executeRawUnsafe(
        `DELETE FROM "Lead" WHERE id = ANY($1::text[])`,
        leadIds,
      );
    }
  });
  TEST_LEAD_IDS.length = 0;
  TEST_VISIT_IDS.length = 0;
}

describe.skipIf(!HAS_DB)('VisitsService.updateOutcome - T-D4 idempotent replay', () => {
  let service: VisitsService;
  let prismaService: PrismaService;

  beforeAll(async () => {
    if (prisma === null) return;
    prismaService = {
      $client: prisma as unknown as PrismaClient,
    } as PrismaService;
    const leadsService = new LeadsService(prismaService);
    service = new VisitsService(prismaService, leadsService);

    await adminSeed(async (db) => {
      // T-LEAD-PROJECT-REQUIRED (2026-09-16): the lead fixtures below point
      // at this project (Lead.projectId is NOT NULL).
      await db.project.upsert({
        where: { id: TEST_PROJECT_ID },
        update: {},
        create: {
          id: TEST_PROJECT_ID,
          name: `Test Project ${TEST_PROJECT_ID}`,
          slug: TEST_PROJECT_ID,
          address: 'test',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
      await db.team.upsert({
        where: { id: TEAM_ID },
        update: {},
        create: { id: TEAM_ID, name: `VOC Test Team ${RUN}`, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      });
      await db.user.upsert({
        where: { id: ADMIN_ID },
        update: { role: 'ADMIN' },
        create: {
          id: ADMIN_ID,
          email: `${ADMIN_ID}@example.com`,
          name: 'VOC Test Admin',
          role: 'ADMIN',
          mustChangePassword: false,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
      await db.user.upsert({
        where: { id: SE_ID },
        update: { role: 'SALES_EXEC' },
        create: {
          id: SE_ID,
          email: `${SE_ID}@example.com`,
          name: 'VOC Test SE',
          role: 'SALES_EXEC',
          mustChangePassword: false,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
      await db.user.upsert({
        where: { id: TC_ID },
        update: { role: 'TELECALLER' },
        create: {
          id: TC_ID,
          email: `${TC_ID}@example.com`,
          name: 'VOC Test Telecaller',
          role: 'TELECALLER',
          mustChangePassword: false,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
      // A SECOND exec, so a re-schedule can move a visit from one exec to
      // another (T-VISIT-EXEC-LEAD-VISIBILITY): the co-owner slot has to follow
      // the exec actually conducting the visit.
      await db.user.upsert({
        where: { id: SE2_ID },
        update: { role: 'SALES_EXEC' },
        create: {
          id: SE2_ID,
          email: `${SE2_ID}@example.com`,
          name: 'VOC Test SE Two',
          role: 'SALES_EXEC',
          mustChangePassword: false,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
      await db.teamMember.upsert({
        where: { userId_teamId: { userId: SE_ID, teamId: TEAM_ID } },
        update: {},
        create: {
          userId: SE_ID,
          teamId: TEAM_ID,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
    });
  }, 30_000);

  beforeEach(async () => {
    // Reset visits + leads to the canonical pre-write state before
    // each test: visit SCHEDULED (no outcome), lead VISIT_SCHEDULED.
    if (prisma === null) return;
    if (TEST_VISIT_IDS.length === 0) return;
    await adminSeed(async (db) => {
      for (const visitId of TEST_VISIT_IDS) {
        const visit = await db.siteVisit.findUnique({
          where: { id: visitId },
          select: { leadId: true, userId: true },
        });
        if (visit === null) continue;
        // One open visit per lead (partial unique index): a visit a previous
        // test created through create() must be closed before the canonical
        // fixture visit is re-opened.
        await db.siteVisit.updateMany({
          where: { leadId: visit.leadId, status: 'SCHEDULED', id: { not: visitId } },
          data: { status: 'CANCELLED' },
        });
        await db.siteVisit.update({
          where: { id: visitId },
          data: { status: 'SCHEDULED', outcome: null, notes: null },
        });
        // T-VISIT-EXEC-LEAD-VISIBILITY (2026-09-28): restore the co-owner grant
        // too. `create()` grants the conducting exec the co-owner slot and the
        // tests below assert the exec can then reach the lead; a reset that
        // only restored state would leave a stale grant and hide a regression
        // in the grant itself.
        const seeded = await db.lead.findUnique({
          where: { id: visit.leadId },
          select: { ownerId: true, coOwnerId: true },
        });
        await db.lead.update({
          where: { id: visit.leadId },
          data: {
            state: 'VISIT_SCHEDULED',
            coOwnerId:
              seeded !== null &&
              seeded.ownerId === visit.userId
                ? null
                : visit.userId,
          },
        });
      }
    });
  });

  afterAll(async () => {
    await cleanupAll();
  }, 30_000);

  it('COMPLETED outcome drives the parent lead to VISITED (baseline)', async () => {
    const { leadId, visitId } = await seedLeadWithVisit();
    const row = await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'on-site visit done',
    });
    expect(row.status).toBe('COMPLETED');
    expect(row.outcome).toBe('COMPLETED');

    // Parent lead auto-advanced.
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISITED');

    // One audit row for the state change.
    const audits = await adminSeed((db) =>
      db.auditLog.findMany({
        where: { entityId: visitId, action: 'visit.outcome' },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toContain('COMPLETED');
  });

  it('exact replay (same outcome) is a no-op: row unchanged, ONE "Idempotent replay" audit row, lead stays VISITED', async () => {
    const { leadId, visitId } = await seedLeadWithVisit();

    // First write lands.
    await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'first write',
    });

    // Replay arrives (same payload - the offline queue re-sent it).
    const row = await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'replayed write',
    });
    // No-op: the ORIGINAL notes are preserved (replayed body ignored).
    expect(row.status).toBe('COMPLETED');
    expect(row.notes).toBe('first write');

    // Lead was transitioned exactly once.
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISITED');

    // Two audit rows total: the original write + the idempotent-replay
    // marker. The replay row must say no state change.
    const audits = await adminSeed((db) =>
      db.auditLog.findMany({
        where: { entityId: visitId, action: 'visit.outcome' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]?.reason).toContain('COMPLETED');
    expect(audits[0]?.reason).not.toContain('Idempotent replay');
    expect(audits[1]?.reason).toContain('Idempotent replay');
    expect(audits[1]?.reason).toContain('no state change');
  });

  it('replay is also a no-op for SALES_EXEC actors (RLS scoping intact)', async () => {
    const { visitId } = await seedLeadWithVisit();
    await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'first',
    });
    const row = await service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'replay from SE',
    });
    expect(row.status).toBe('COMPLETED');
    expect(row.notes).toBe('first');
  });

  it('different outcome on advanced visit is rejected by the state machine (server-wins conflict)', async () => {
    const { visitId } = await seedLeadWithVisit();
    await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'manager landed COMPLETED first',
    });
    // Queued NO_SHOW replays after COMPLETED already landed.
    await expect(
      service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
        visitId,
        outcome: 'NO_SHOW',
        notes: 'stale queued write',
      }),
    ).rejects.toBeTruthy();
  });

  it('NO_SHOW outcome does NOT touch the lead state', async () => {
    const { leadId, visitId } = await seedLeadWithVisit();
    const row = await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'NO_SHOW',
    });
    expect(row.status).toBe('NO_SHOW');
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('NO_SHOW');
  });

  /**
   * T-VISIT-ASSIGNEE (2026-09-16 owner ruling). The baseline above runs as
   * ADMIN, which is exactly why the handoff bug hid for so long: ADMIN is the
   * only role whose lead-lane gate admitted VISIT_SCHEDULED -> VISITED. These
   * two tests run the SAME flow as a real SALES_EXEC and as the lead's
   * TELECALLER owner, and pin the ruling in both directions:
   *   - the assigned exec CAN complete the handoff;
   *   - the telecaller CANNOT, even though they own the lead.
   */
  it('the ASSIGNED sales exec can drive VISIT_SCHEDULED -> VISITED (the handoff)', async () => {
    const { leadId, visitId } = await seedLeadWithVisit();
    // The fixture assigns the visit to SE_ID, who is a SALES_EXEC and does NOT
    // own the lead - precisely the Model C handoff shape.
    const row = await service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'conducted by the assigned exec',
    });
    expect(row.status).toBe('COMPLETED');

    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISITED');
  });

  it('the lead-owning TELECALLER cannot mark a visit COMPLETED', async () => {
    // SE_ID owns the lead in the fixture; reuse the same visit but act as a
    // TELECALLER. The owner ruling reserves COMPLETED for the exec (and
    // manager/admin), so this must be refused - before the gate was corrected
    // the visit panel offered this button to telecallers and the server
    // answered 403.
    const { visitId } = await seedLeadWithVisit();
    await expect(
      service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), visitId, {
        visitId,
        outcome: 'COMPLETED',
      }),
    ).resolves.toBeTruthy(); // exec: allowed (sanity - same call, exec lane)

    // Reset, then attempt the exec's NO_SHOW and assert the lead does NOT advance
    // to VISITED. (The visit IS recorded - see the role-deferral note below.)
    const { leadId, visitId: visit2 } = await seedLeadWithVisit();
    const row = await service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), visit2, {
      visitId: visit2,
      outcome: 'NO_SHOW',
    });
    expect(row.status).toBe('NO_SHOW');
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISIT_SCHEDULED'); // not VISITED
  });

  /**
   * T-VISIT-LEAD-SYNC (2026-09-29): the visit outcome and the lead state are
   * allowed to DISAGREE when the two state machines' role lanes differ.
   *
   * `visits.state-machine` lets a SALES_EXEC record NO_SHOW on a visit.
   * `leads.state-machine` reserves VISIT_SCHEDULED -> NO_SHOW for the telecaller
   * or a manager - the exec's one out-of-lane edge is VISITED, the handoff, and
   * the file is explicit that this is "deliberately ONE edge, not 'add
   * VISIT_SCHEDULED to the exec lane'".
   *
   * So an exec has a legitimate visit outcome their role may not mirror onto the
   * lead. The lead sync therefore DEFERS to the lead machine: the outcome is
   * recorded, the lead stays put, and nothing throws. Before the pre-check the
   * valid NO_SHOW threw ForbiddenException and the whole outcome write was LOST -
   * a regression this test now prevents.
   */
  it('records an exec NO_SHOW without moving the lead (role deferral, not failure)', async () => {
    const { leadId, visitId } = await seedLeadWithVisit();

    const row = await service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), visitId, {
      visitId,
      outcome: 'NO_SHOW',
    });

    // The visit write lands - the exec is allowed this outcome.
    expect(row.status).toBe('NO_SHOW');
    expect(row.outcome).toBe('NO_SHOW');

    // The lead does NOT follow, because the exec may not drive that edge. It is
    // not an error, just an authority boundary.
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISIT_SCHEDULED');
  });

  it('DOES move the lead to NO_SHOW when a MANAGER records it', async () => {
    // The counterpart: where the role IS allowed the lead edge, the sync must
    // actually fire - otherwise the deferral above could be hiding a sync that
    // never works for anyone.
    const { leadId, visitId } = await seedLeadWithVisit();
    const row = await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'NO_SHOW',
    });
    expect(row.status).toBe('NO_SHOW');
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('NO_SHOW');
  });

  it('RESCHEDULED moves the lead to VISIT_SCHEDULED, never to RESCHEDULED', async () => {
    // `RESCHEDULED` on a visit must NOT put the LEAD into RESCHEDULED: that state
    // has no edge to VISITED, so the exec's handoff would be permanently broken.
    // The lead is normalised to VISIT_SCHEDULED - the state that matches the live
    // visit - exactly as `reschedule()` does.
    //
    // NOTE this goes through `updateOutcome` on a SCHEDULED visit deliberately:
    // the service hard-refuses an outcome write on any visit that is not
    // SCHEDULED (the stale-write 409), so RESCHEDULED-after-NO_SHOW is not
    // reachable here at all. The NO_SHOW -> VISIT_SCHEDULED heal lives in
    // `reschedule()` (see the reschedule suite).
    const { leadId, visitId } = await seedLeadWithVisit({ splitOwnerFromExec: true });

    const row = await service.updateOutcome(actorFor(TC_ID, 'TELECALLER'), visitId, {
      visitId,
      outcome: 'RESCHEDULED',
    });
    expect(row.status).toBe('RESCHEDULED');

    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    // Stays VISIT_SCHEDULED. NOT RESCHEDULED - that would strand the handoff.
    expect(lead?.state).toBe('VISIT_SCHEDULED');
  });

  it('a rescheduled visit does not strand the lead: COMPLETED can still fire afterwards', async () => {
    // The point of targeting VISIT_SCHEDULED rather than RESCHEDULED: the handoff
    // must survive a reschedule. Had the lead been parked in RESCHEDULED this
    // COMPLETED would throw (no RESCHEDULED -> VISITED edge) and the deal could
    // never be settled.
    const { leadId, visitId } = await seedLeadWithVisit({ splitOwnerFromExec: true });

    await service.updateOutcome(actorFor(TC_ID, 'TELECALLER'), visitId, {
      visitId,
      outcome: 'RESCHEDULED',
    });

    // A real reschedule creates a NEW visit; model that so the COMPLETED below
    // has an open visit to act on (updateOutcome only accepts SCHEDULED).
    const newVisitId = `${visitId}-next`;
    await adminSeed((db) =>
      db.siteVisit.create({
        data: {
          id: newVisitId,
          leadId,
          userId: SE_ID,
          scheduledFor: new Date(Date.now() + 86_400_000),
          status: 'SCHEDULED',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      }),
    );
    TEST_VISIT_IDS.push(newVisitId);

    const row = await service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), newVisitId, {
      visitId: newVisitId,
      outcome: 'COMPLETED',
    });
    expect(row.status).toBe('COMPLETED');

    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    // The handoff still works after a reschedule - the whole reason for the
    // VISIT_SCHEDULED target.
    expect(lead?.state).toBe('VISITED');
  });

  it('CANCELLED never moves the lead, even for an ADMIN (owner ruling)', async () => {
    // Owner ruling, 2026-09-29: "cancelling one visit isn't cancelling the deal".
    // A cancelled visit is a cancelled MEETING; the telecaller still owns the
    // lead and will arrange another. Asserted over the WIDEST role so a future
    // ADMIN-override cannot quietly start corrupting the pipeline here.
    const { leadId, visitId } = await seedLeadWithVisit();
    const row = await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'CANCELLED',
    });
    expect(row.status).toBe('CANCELLED');
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISIT_SCHEDULED');
  });

});

/**
 * T-VISIT-ASSIGNEE / T-PROJFILTER (2026-09-16): `visits.list` scoping.
 *
 * This method had NO test coverage before - which is why the exec's invisible
 * visit and the silently-overwritten projectId filter both survived. Pins:
 *   - a SALES_EXEC sees the visit assigned to them even though the lead belongs
 *     to the telecaller (the handoff shape);
 *   - a SALES_EXEC does NOT see a colleague's visit;
 *   - the projectId filter is actually applied for a staff role (it used to be
 *     written into `where.lead` and then overwritten by the role branch, so it
 *     was silently dropped).
 */
describe.skipIf(!HAS_DB)('VisitsService.list - assignee + project scoping', () => {
  let service: VisitsService;
  let prismaService: PrismaService;

  beforeAll(async () => {
    if (prisma === null) return;
    prismaService = {
      $client: prisma as unknown as PrismaClient,
    } as PrismaService;
    const leadsService = new LeadsService(prismaService);
    service = new VisitsService(prismaService, leadsService);
  });

  afterAll(async () => {
    await cleanupAll();
  }, 30_000);

  it('the exec sees the visit assigned to them, on a lead they do NOT own', async () => {
    const { visitId } = await seedLeadWithVisit(); // visit assigned to SE_ID
    const page = await service.list(actorFor(SE_ID, 'SALES_EXEC'), {
      limit: 200,
      offset: 0,
    });
    expect(page.rows.map((r) => r.id)).toContain(visitId);
  });

  it('the projectId filter is applied, not silently dropped, for a staff role', async () => {
    const { visitId } = await seedLeadWithVisit();
    const other = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: TEST_LEAD_IDS[TEST_LEAD_IDS.length - 1] }, select: { projectId: true } }),
    );
    // Filter on a projectId that is definitely NOT this lead's. Before the fix
    // the filter was overwritten for staff roles and the visit came back anyway.
    const page = await service.list(actorFor(SE_ID, 'SALES_EXEC'), {
      projectId: '__not_this_project__',
      limit: 200,
      offset: 0,
    });
    expect(page.rows.map((r) => r.id)).not.toContain(visitId);
    expect(other).not.toBeNull();
  });

  /**
   * T-VISIT-OWNER-LABEL (2026-09-28). The dashboard's "Today's visits" card
   * printed `userName` bare, which read as the lead's owner and contradicted the
   * lead page (which shows `Lead.ownerId`). On a SCHEDULED visit those are two
   * different, correct people, so `list()` must carry BOTH - and carry the
   * lead's owner, not a second copy of the exec.
   */
  it('reports the lead owner and the visit exec as two different people', async () => {
    const { visitId } = await seedLeadWithVisit({ splitOwnerFromExec: true });
    const page = await service.list(actorFor(SE_ID, 'SALES_EXEC'), {
      limit: 200,
      offset: 0,
    });
    const row = page.rows.find((r) => r.id === visitId);
    expect(row).toBeDefined();
    // The fixture deliberately gives the lead and the visit DIFFERENT people:
    // telecaller owns, sales exec conducts (plan §3).
    expect(row?.leadOwnerName).toBe('VOC Test Telecaller');
    expect(row?.userName).toBe('VOC Test SE');
    // The whole point: these must not be the same value. If a future change
    // wires leadOwnerName to the visit's user (or drops it), this fails.
    expect(row?.leadOwnerName).not.toBe(row?.userName);
  });

  it('always reports the lead owner (Lead.ownerId is NOT NULL)', async () => {
    const { visitId } = await seedLeadWithVisit({ splitOwnerFromExec: true });
    const page = await service.list(actorFor(SE_ID, 'SALES_EXEC'), {
      limit: 200,
      offset: 0,
    });
    const row = page.rows.find((r) => r.id === visitId);
    // Non-null on both rows: the schema makes Lead.ownerId a required relation,
    // so the dashboard can rely on the value existing rather than rendering a
    // fallback that would look like a data gap.
    expect(row?.leadOwnerName).toBe('VOC Test Telecaller');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T-VISIT-EXEC-LEAD-VISIBILITY (2026-09-28)
  // ──────────────────────────────────────────────────────────────────────────
  // The exec's access to a lead they do not own is carried by `Lead.coOwnerId`.
  // Before this, the exec could read the SiteVisit assigned to them and NOT its
  // parent Lead: `lead_select_telecaller` matches ownerId/coOwnerId only, so
  // every `lead` relation resolved to null and `list()` threw a TypeError -
  // i.e. the dashboard card was broken for the very role it is built for.

  it('create() grants the conducting exec access to a lead they do not own', async () => {
    // TC_ID owns the lead; SE_ID conducts. Start with NO co-owner.
    const { leadId, visitId } = await seedLeadWithVisit({ splitOwnerFromExec: true });
    // One open visit per lead: close the fixture's visit so create() books a
    // genuinely new one (the 409 rule has its own test).
    await adminSeed((db) =>
      db.siteVisit.updateMany({ where: { leadId }, data: { status: 'COMPLETED' } }),
    );
    await adminSeed((db) =>
      db.lead.update({ where: { id: leadId }, data: { coOwnerId: null } }),
    );
    // Schedule a fresh visit as the telecaller, naming the exec.
    await service.create(actorFor(TC_ID, 'SALES_EXEC') as never, {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: SE_ID,
    } as never);

    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { ownerId: true, coOwnerId: true } }),
    );
    // The grant is what makes the exec able to read the lead at all.
    expect(lead?.coOwnerId).toBe(SE_ID);
    // Ownership is untouched - §3 keeps the telecaller as owner at this state.
    expect(lead?.ownerId).toBe(TC_ID);
    expect(visitId).toBeTruthy();
  });

  it('the exec can then actually READ the lead and its visits (the regression)', async () => {
    const { leadId, visitId } = await seedLeadWithVisit({ splitOwnerFromExec: true });
    await adminSeed((db) =>
      db.lead.update({ where: { id: leadId }, data: { coOwnerId: SE_ID } }),
    );
    // list() as the exec: this is the call that used to throw because `lead`
    // resolved to null for a lead they did not own.
    const page = await service.list(actorFor(SE_ID, 'SALES_EXEC'), {
      limit: 200,
      offset: 0,
    });
    const row = page.rows.find((r) => r.id === visitId);
    expect(row).toBeDefined();
    // Both names come off the parent lead - proving the join resolved.
    expect(row?.leadName).toBeTruthy();
    expect(row?.leadOwnerName).toBe('VOC Test Telecaller');
  });

  it('does NOT grant co-ownership to a non-exec assignee', async () => {
    // A manager/admin can already read the lead through their own policy, so
    // writing coOwnerId for them would be an unnecessary, wider grant.
    const { leadId } = await seedLeadWithVisit({ splitOwnerFromExec: true });
    // One open visit per lead: close the fixture's visit so create() books a
    // genuinely new one (the 409 rule has its own test).
    await adminSeed((db) =>
      db.siteVisit.updateMany({ where: { leadId }, data: { status: 'COMPLETED' } }),
    );
    await adminSeed((db) =>
      db.lead.update({ where: { id: leadId }, data: { coOwnerId: null } }),
    );
    await service.create(actorFor(TC_ID, 'SALES_EXEC') as never, {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: ADMIN_ID,
    } as never);
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { coOwnerId: true } }),
    );
    expect(lead?.coOwnerId).toBeNull();
  });

  it('refuses to clobber an existing co-owner instead of half-granting access', async () => {
    // Lead.coOwnerId is a single slot. Silently overwriting it would revoke an
    // access the operator granted, so scheduling a DIFFERENT exec has to fail
    // loudly rather than create a visit whose exec cannot see its lead.
    const { leadId } = await seedLeadWithVisit({ splitOwnerFromExec: true });
    await adminSeed((db) =>
      db.lead.update({ where: { id: leadId }, data: { coOwnerId: ADMIN_ID } }),
    );
    await expect(
      service.create(actorFor(TC_ID, 'SALES_EXEC') as never, {
        leadId,
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        salesExecId: SE_ID,
      } as never),
    ).rejects.toMatchObject({ name: 'ConflictException' });
    // The pre-existing co-owner is untouched.
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { coOwnerId: true } }),
    );
    expect(lead?.coOwnerId).toBe(ADMIN_ID);
  });

  it('is idempotent - re-scheduling for the SAME exec needs no new grant', async () => {
    const { leadId } = await seedLeadWithVisit({ splitOwnerFromExec: true });
    // One open visit per lead: close the fixture's visit so create() books a
    // genuinely new one (the 409 rule has its own test).
    await adminSeed((db) =>
      db.siteVisit.updateMany({ where: { leadId }, data: { status: 'COMPLETED' } }),
    );
    await adminSeed((db) =>
      db.lead.update({ where: { id: leadId }, data: { coOwnerId: SE_ID } }),
    );
    await service.create(actorFor(TC_ID, 'SALES_EXEC') as never, {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: SE_ID,
    } as never);
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { coOwnerId: true } }),
    );
    expect(lead?.coOwnerId).toBe(SE_ID);
  });
  it('re-schedule moves the lead access to the NEW exec (the slot follows the visit)', async () => {
    // The real drag-and-drop flow: a visit conducted by SE_ID is rescheduled
    // onto SE2_ID. The slot must transfer, otherwise either the new exec
    // inherits a visit whose lead they cannot read, or the reschedule is
    // rejected outright.
    const { leadId, visitId } = await seedLeadWithVisit({ splitOwnerFromExec: true });
    await adminSeed(async (db) => {
      await db.lead.update({ where: { id: leadId }, data: { coOwnerId: SE_ID } });
      await db.siteVisit.update({ where: { id: visitId }, data: { userId: SE_ID } });
    });
    await service.reschedule(actorFor(TC_ID, 'SALES_EXEC') as never, visitId, {
      visitId,
      scheduledFor: new Date(Date.now() + 172_800_000).toISOString(),
      salesExecId: SE2_ID,
    } as never);
    const lead = await adminSeed((db) =>
      db.lead.findUnique({
        where: { id: leadId },
        select: { ownerId: true, coOwnerId: true },
      }),
    );
    expect(lead?.coOwnerId).toBe(SE2_ID);
    expect(lead?.ownerId).toBe(TC_ID);
  });
  it('an exec conducting a visit can record the outcome on a lead they do not own (end-to-end)', async () => {
    // The integration this whole change exists for. `lead_update_telecaller`
    // gates UPDATE on owner-OR-co-owner, and the outcome path advances the lead
    // to VISITED - so without the co-owner grant the exec's own write on a lead
    // owned by the telecaller is refused by RLS (42501), and the visit can never
    // be completed by the person who conducted it.
    const { leadId, visitId } = await seedLeadWithVisit({ splitOwnerFromExec: true });
    await adminSeed(async (db) => {
      await db.lead.update({
        where: { id: leadId },
        data: { coOwnerId: SE_ID, state: 'VISIT_SCHEDULED' },
      });
      await db.siteVisit.update({ where: { id: visitId }, data: { userId: SE_ID } });
    });

    const row = await service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'conducted by the exec',
    } as never);
    expect(row.status).toBe('COMPLETED');

    // The lead advanced - proving the exec's UPDATE landed through RLS, and the
    // telecaller remains the owner (the grant is access, not a handover).
    const lead = await adminSeed((db) =>
      db.lead.findUnique({
        where: { id: leadId },
        select: { state: true, ownerId: true, coOwnerId: true },
      }),
    );
    expect(lead?.state).toBe('VISITED');
    expect(lead?.ownerId).toBe(TC_ID);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-VISIT-NO-SHOW-SCHEDULING (2026-09-30) - create() eligibility.
//
// THERE WAS NO TEST FOR THIS AT ALL, which is why the defect survived: the
// dashboard queue offered "Schedule visit" on a NO_SHOW lead (pinned as correct
// by apps/web/src/lib/queue-actions.test.ts) while `create()` refused it with
// "Lead state NO_SHOW cannot accept a visit". Each side was covered against its
// own assumption and nothing compared them.
//
// This suite drives the REAL create() over a real database for every lead state,
// so the guard, the supersede step and the auto-advance are exercised together -
// a mocked client cannot show that the transaction commits or that the lead
// actually moves.
// ────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('VisitsService.create - which leads accept a visit', () => {
  let service: VisitsService;
  let prismaService: PrismaService;

  beforeAll(async () => {
    if (prisma === null) return;
    prismaService = { $client: prisma as unknown as PrismaClient } as PrismaService;
    const leadsService = new LeadsService(prismaService);
    service = new VisitsService(prismaService, leadsService);

    await adminSeed(async (db) => {
      await db.project.upsert({
        where: { id: TEST_PROJECT_ID },
        update: {},
        create: {
          id: TEST_PROJECT_ID,
          name: `Test Project ${TEST_PROJECT_ID}`,
          slug: TEST_PROJECT_ID,
          address: 'test',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      });
      await db.team.upsert({
        where: { id: TEAM_ID },
        update: {},
        create: { id: TEAM_ID, name: `VOC Test Team ${RUN}`, organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
      });
      for (const [id, role, name] of [
        [ADMIN_ID, 'ADMIN', 'VOC Test Admin'],
        [SE_ID, 'SALES_EXEC', 'VOC Test SE'],
        [TC_ID, 'TELECALLER', 'VOC Test Telecaller'],
      ] as const) {
        await db.user.upsert({
          where: { id },
          update: { role },
          create: {
            id,
            email: `${id}@example.com`,
            name,
            role,
            mustChangePassword: false,
            organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          },
        });
      }
    });
  }, 30_000);

  afterAll(async () => {
    await cleanupAll();
  }, 30_000);

  let eligibilitySeq = 0;

  /**
   * A bare lead in `state`, owned by the telecaller, with NO visit rows - so
   * each state is measured on its own terms and a previous test's visit cannot
   * flatter the result.
   */
  async function seedLeadInState(state: string): Promise<string> {
    if (prisma === null) throw new Error('prisma missing');
    eligibilitySeq += 1;
    const leadId = `test-cve-lead-${RUN}-${eligibilitySeq}`;
    TEST_LEAD_IDS.push(leadId);
    await adminSeed((db) =>
      db.lead.create({
        data: {
          id: leadId,
          name: `CVE Lead ${eligibilitySeq} (${state})`,
          phone: `92${String(RUN).slice(-8)}${String(eligibilitySeq).padStart(3, '0')}`,
          phoneE164: `9192${String(RUN).slice(-8)}${String(eligibilitySeq).padStart(3, '0')}`,
          source: 'WHATSAPP',
          state: state as never,
          ownerId: TC_ID,
          ownerType: 'TELECALLER',
          teamId: TEAM_ID,
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
          projectId: TEST_PROJECT_ID,
        },
      }),
    );
    return leadId;
  }

  const ACCEPTED = ['VISIT_REQUESTED', 'VISIT_SCHEDULED', 'RESCHEDULED', 'NO_SHOW'];
  const REFUSED = [
    'NEW',
    'CONTACTED',
    'VISITED',
    'NEGOTIATION',
    'BOOKING_INITIATED',
    'WON',
    'LOST',
    'RNR',
  ];

  it('the two lists are exhaustive over every LeadState', () => {
    // Drift tripwire: a state added to the enum must be classified here (and
    // therefore against SCHEDULABLE_LEAD_STATES) rather than silently untested.
    expect([...ACCEPTED, ...REFUSED].sort()).toEqual([...LEAD_STATES].sort());
  });

  for (const state of REFUSED) {
    it(`refuses a lead in ${state}`, async () => {
      const leadId = await seedLeadInState(state);
      await expect(
        service.create(actorFor(TC_ID, 'TELECALLER') as never, {
          leadId,
          scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
          salesExecId: SE_ID,
        } as never),
      ).rejects.toMatchObject({ name: 'BadRequestException' });
    });
  }

  it('ACCEPTS a NO_SHOW lead - the reported defect', async () => {
    // The exact user report: scheduling from the dashboard queue on a NO_SHOW
    // lead returned 400. The queue was right; the guard was wrong.
    const leadId = await seedLeadInState('NO_SHOW');
    const row = await service.create(actorFor(TC_ID, 'TELECALLER') as never, {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: SE_ID,
    } as never);

    expect(row.status).toBe('SCHEDULED');

    // The lead is normalised onto the live-visit state (the re-engagement edge
    // NO_SHOW -> VISIT_SCHEDULED), so the two surfaces tell one story again.
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISIT_SCHEDULED');
  });

  it('ACCEPTS a RESCHEDULED lead and normalises it to VISIT_SCHEDULED', async () => {
    const leadId = await seedLeadInState('RESCHEDULED');
    await service.create(actorFor(TC_ID, 'TELECALLER') as never, {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: SE_ID,
    } as never);
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISIT_SCHEDULED');
  });

  it('ACCEPTS a VISIT_REQUESTED lead and advances it (the pre-existing behaviour)', async () => {
    const leadId = await seedLeadInState('VISIT_REQUESTED');
    await service.create(actorFor(TC_ID, 'TELECALLER') as never, {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: SE_ID,
    } as never);
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISIT_SCHEDULED');
  });

  it('leaves a VISIT_SCHEDULED lead on VISIT_SCHEDULED (no-op, not a bounce)', async () => {
    // The second-visit path (the calendar can schedule a parallel visit). The
    // lead is already where it needs to be, so the transition must not fire.
    const leadId = await seedLeadInState('VISIT_SCHEDULED');
    await service.create(actorFor(TC_ID, 'TELECALLER') as never, {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: SE_ID,
    } as never);
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    expect(lead?.state).toBe('VISIT_SCHEDULED');
  });

  // ── Supersede: never two open visits on one lead ──────────────────────────

  it('supersedes the no-show visit when re-booking a NO_SHOW lead', async () => {
    const leadId = await seedLeadInState('NO_SHOW');
    // The real shape of a no-show: a visit recorded as NO_SHOW (status AND
    // outcome), which drove the lead to NO_SHOW and left that row in place.
    const firstVisitId = `test-cve-noshow-visit-${RUN}`;
    await adminSeed((db) =>
      db.siteVisit.create({
        data: {
          id: firstVisitId,
          leadId,
          userId: SE_ID,
          scheduledFor: new Date(),
          status: 'NO_SHOW',
          outcome: 'NO_SHOW',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      }),
    );

    const row = await service.create(actorFor(TC_ID, 'TELECALLER') as never, {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: SE_ID,
    } as never);
    expect(row.status).toBe('SCHEDULED');

    // Exactly ONE row the lead panel can pick as the visit to record against:
    // the new SCHEDULED one. The old row is closed, so the operator's next
    // outcome cannot land on a visit that is already history.
    const pickable = await adminSeed((db) =>
      db.siteVisit.findMany({
        where: { leadId, status: { in: ['SCHEDULED', 'NO_SHOW'] } },
        select: { id: true },
      }),
    );
    expect(pickable.map((v) => v.id)).toEqual([row.id]);

    const closed = await adminSeed((db) =>
      db.siteVisit.findUnique({
        where: { id: firstVisitId },
        select: { status: true, outcome: true },
      }),
    );
    expect(closed?.status).toBe('RESCHEDULED');
    // The OUTCOME is preserved: the row must keep saying the customer did not
    // turn up, or the history it carries is destroyed.
    expect(closed?.outcome).toBe('NO_SHOW');
  });

  it('refuses (409) a second visit while the lead already has a live SCHEDULED one', async () => {
    // T-VISIT-LEAD-SYNC (2026-10-09) replaces the old carve-out that allowed two
    // open rows - the source of duplicate rows in Today's visits. The live visit
    // must also be left untouched.
    const leadId = await seedLeadInState('VISIT_SCHEDULED');
    const liveVisitId = `test-cve-live-visit-${RUN}`;
    await adminSeed((db) =>
      db.siteVisit.create({
        data: {
          id: liveVisitId,
          leadId,
          userId: SE_ID,
          scheduledFor: new Date(Date.now() + 3_600_000),
          status: 'SCHEDULED',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      }),
    );

    await expect(
      service.create(actorFor(TC_ID, 'TELECALLER') as never, {
        leadId,
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        salesExecId: SE_ID,
      } as never),
    ).rejects.toMatchObject({ name: 'ConflictException' });

    const live = await adminSeed((db) =>
      db.siteVisit.findUnique({ where: { id: liveVisitId }, select: { status: true } }),
    );
    expect(live?.status).toBe('SCHEDULED');
    const count = await adminSeed((db) => db.siteVisit.count({ where: { leadId } }));
    expect(count).toBe(1);
  });

  it('audits the supersede with the reason a reader needs', async () => {
    const leadId = await seedLeadInState('NO_SHOW');
    const staleVisitId = `test-cve-audit-visit-${RUN}`;
    await adminSeed((db) =>
      db.siteVisit.create({
        data: {
          id: staleVisitId,
          leadId,
          userId: SE_ID,
          scheduledFor: new Date(),
          status: 'NO_SHOW',
          outcome: 'NO_SHOW',
          organizationId: 'ceid01lpfe1esm8jwsxid41k28',
        },
      }),
    );

    await service.create(actorFor(TC_ID, 'TELECALLER') as never, {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: SE_ID,
    } as never);

    const audits = await adminSeed((db) =>
      db.auditLog.findMany({
        where: { entityId: staleVisitId, action: 'visit.reschedule' },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toContain('Superseded');
    expect(audits[0]?.reason).toContain(leadId);
  });
});
