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
const TEAM_ID = `test-voc-team-${RUN}`;

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: 'ceid01lpfe1esm8jwsxid41k28' },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function actorFor(userId: string, role: 'ADMIN' | 'SALES_EXEC'): JwtPayload {
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
async function seedLeadWithVisit(): Promise<{ leadId: string; visitId: string }> {
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
        ownerId: SE_ID,
        ownerType: 'SALES_EXEC',
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
          select: { leadId: true },
        });
        if (visit === null) continue;
        await db.siteVisit.update({
          where: { id: visitId },
          data: { status: 'SCHEDULED', outcome: null, notes: null },
        });
        await db.lead.update({
          where: { id: visit.leadId },
          data: { state: 'VISIT_SCHEDULED' },
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
    expect(lead?.state).toBe('VISIT_SCHEDULED');
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

    // Reset, then attempt the telecaller's NO_SHOW (the only outcome the ruling
    // grants them) and assert the lead does NOT advance to VISITED.
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
});
