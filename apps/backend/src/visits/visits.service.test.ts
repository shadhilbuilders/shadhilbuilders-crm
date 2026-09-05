// T-D4 — visit outcome conflict rule: idempotent replay + real conflict.
//
// Real-DB tests (no mocks). Fixture pattern mirrors the T-E2b
// whatsapp-unknown-contacts service test: bare prisma (via
// withRlsContext as ADMIN) for seeding/cleanup; the service under test
// runs its own withRlsContext inside each method.
//
// Conflict rule (visits.service.ts, updateOutcome):
//   - Exact replay (visit already has status+outcome === dto.outcome):
//     no-op — returns the current row, writes ONE audit row marked
//     "Idempotent replay … no state change".
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
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const RUN = Date.now();
const ADMIN_ID = `test-voc-admin-${RUN}`;
const SE_ID = `test-voc-se-${RUN}`;
const TEAM_ID = `test-voc-team-${RUN}`;

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', teamId: TEAM_ID },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function actorFor(userId: string, role: 'ADMIN' | 'SALES_EXEC'): JwtPayload {
  return {
    sub: userId,
    email: `${userId}@example.com`,
    role,
    teamId: TEAM_ID,
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
      },
    });
    await db.siteVisit.create({
      data: {
        id: visitId,
        leadId,
        userId: SE_ID,
        scheduledFor: new Date(),
        status: 'SCHEDULED',
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

describe.skipIf(!HAS_DB)('VisitsService.updateOutcome — T-D4 idempotent replay', () => {
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
      await db.team.upsert({
        where: { id: TEAM_ID },
        update: {},
        create: { id: TEAM_ID, name: 'VOC Test Team' },
      });
      await db.user.upsert({
        where: { id: ADMIN_ID },
        update: { teamId: TEAM_ID, role: 'ADMIN' },
        create: {
          id: ADMIN_ID,
          email: `${ADMIN_ID}@example.com`,
          name: 'VOC Test Admin',
          role: 'ADMIN',
          teamId: TEAM_ID,
          mustChangePassword: false,
        },
      });
      await db.user.upsert({
        where: { id: SE_ID },
        update: { teamId: TEAM_ID, role: 'SALES_EXEC' },
        create: {
          id: SE_ID,
          email: `${SE_ID}@example.com`,
          name: 'VOC Test SE',
          role: 'SALES_EXEC',
          teamId: TEAM_ID,
          mustChangePassword: false,
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

    // Replay arrives (same payload — the offline queue re-sent it).
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
});