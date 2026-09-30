// The nested-transaction self-deadlock (2026-09-30).
//
// THE BUG THIS PINS: `POST /api/visits` hung for 30s then 500'd with
//   "Transaction API error: query cannot be executed on expired transaction"
// reported at `tx.auditLog.create` in visits.service.ts - a line with nothing to
// do with the cause.
//
// Cause: `VisitsService.create()` runs inside `withRlsContext` (a Prisma
// interactive transaction) and called `LeadsService.transition()`, which opens its
// OWN `withRlsContext` transaction on a SECOND pooled connection. When the outer
// transaction has already WRITTEN the Lead row it holds that row's lock, so the
// nested transaction waits on it while the outer awaits the nested one: a
// self-deadlock that expires as a transaction timeout, not a lock error. That is
// why the stack named an unrelated statement - whichever one the outer
// transaction attempted next.
//
// It only bit when the Lead row was written first (a SALES_EXEC scheduling on a
// lead they do not own, where `grantExecLeadVisibility` sets coOwnerId). A bare
// `findUnique` takes no row lock under READ COMMITTED, so the same call usually
// succeeded - hence an intermittent hang.
//
// HOW THIS IS PROVEN, deterministically and without load:
//   1. `transitionInTransaction` must participate in the CALLER's transaction. A
//      rolled-back outer transaction must therefore roll the transition BACK too.
//   2. The old shape (a bare `withRlsContext` nested inside the caller's) must NOT
//      roll back - it is a separate transaction on a separate connection, which is
//      exactly what makes it contend with the caller's locks. Asserting the
//      contrast is what keeps this a test of the DEFECT rather than of the fix.
//   3. The real journey end to end: a non-owner exec schedules a visit and BOTH
//      the visit and the lead transition land.
//
// Assertions (1) and (2) are the load-independent proofs; (3) is the behaviour.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import { Prisma, prisma as runtimePrisma, withRlsContext } from '@shadhil/database';
import type { PrismaClient } from '@shadhil/database';

import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.module';

import { VisitsService } from './visits.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const ORG_ID = 'ceid01lpfe1esm8jwsxid41k28';

const RUN = Date.now();
const ADMIN_ID = `test-nesttx-admin-${RUN}`;
const TC_ID = `test-nesttx-tc-${RUN}`;
const SE_ID = `test-nesttx-se-${RUN}`;
const TEAM_ID = `test-nesttx-team-${RUN}`;
const PROJECT_ID = `test-nesttx-proj-${RUN}`;
const SEED_LEAD_ID = `test-nesttx-lead-${RUN}`;
const JOURNEY_LEAD_ID = `test-nesttx-journey-${RUN}`;

const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

function actorFor(userId: string, role: 'ADMIN' | 'SALES_EXEC' | 'TELECALLER'): JwtPayload {
  return {
    sub: userId,
    email: `${userId}@example.com`,
    role,
    organizationId: ORG_ID,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG_ID },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

function leadFixture(id: string, seq: number): Prisma.LeadUncheckedCreateInput {
  return {
    id,
    name: `NestedTx Lead ${seq}`,
    phone: `9198${String(RUN).slice(-7)}${String(seq).padStart(3, '0')}`,
    phoneE164: `91988${String(RUN).slice(-7)}${String(seq).padStart(3, '0')}`,
    source: 'WHATSAPP',
    // VISIT_REQUESTED is what makes create() run the nested auto-advance.
    state: 'VISIT_REQUESTED',
    ownerId: TC_ID,
    ownerType: 'TELECALLER',
    coOwnerId: null,
    teamId: TEAM_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
  };
}

let leads: LeadsService;
let visits: VisitsService;
let prismaService: PrismaService;

describe.skipIf(!HAS_DB)('nested lead transition runs on the caller transaction (T-NESTED-TX)', () => {
  beforeAll(async () => {
    if (prisma === null) return;
    prismaService = { $client: prisma as unknown as PrismaClient } as PrismaService;
    leads = new LeadsService(prismaService);
    visits = new VisitsService(prismaService, leads);

    await adminSeed(async (db) => {
      await db.project.upsert({
        where: { id: PROJECT_ID },
        update: {},
        create: {
          id: PROJECT_ID,
          name: `NestedTx Project ${RUN}`,
          slug: PROJECT_ID,
          address: 'test',
          organizationId: ORG_ID,
        },
      });
      await db.team.upsert({
        where: { id: TEAM_ID },
        update: {},
        create: { id: TEAM_ID, name: `NestedTx Team ${RUN}`, organizationId: ORG_ID },
      });
      for (const [id, role] of [
        [ADMIN_ID, 'ADMIN'],
        [TC_ID, 'TELECALLER'],
        [SE_ID, 'SALES_EXEC'],
      ] as const) {
        await db.user.upsert({
          where: { id },
          update: { role },
          create: {
            id,
            email: `${id}@example.com`,
            name: id,
            role,
            mustChangePassword: false,
            organizationId: ORG_ID,
          },
        });
      }
      await db.lead.upsert({
        where: { id: SEED_LEAD_ID },
        update: { state: 'VISIT_REQUESTED' },
        create: leadFixture(SEED_LEAD_ID, 1),
      });
      await db.lead.upsert({
        where: { id: JOURNEY_LEAD_ID },
        update: { state: 'VISIT_REQUESTED', coOwnerId: null },
        create: leadFixture(JOURNEY_LEAD_ID, 2),
      });
    });
  });

  afterAll(async () => {
    if (prisma === null) return;
    await adminSeed(async (db) => {
      const leadIds = [SEED_LEAD_ID, JOURNEY_LEAD_ID];
      await db.$executeRawUnsafe(`DELETE FROM "SiteVisit" WHERE "leadId" = ANY($1::text[])`, leadIds);
      await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "entityId" = ANY($1::text[])`, leadIds);
      await db.$executeRawUnsafe(`DELETE FROM "Lead" WHERE id = ANY($1::text[])`, leadIds);
      await db.$executeRawUnsafe(`DELETE FROM "User" WHERE id = ANY($1::text[])`, [
        ADMIN_ID,
        TC_ID,
        SE_ID,
      ]);
      await db.$executeRawUnsafe(`DELETE FROM "Team" WHERE id = $1`, TEAM_ID);
      await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE id = $1`, PROJECT_ID);
    });
  });

  it('rolls the transition BACK when the caller transaction rolls back', async () => {
    if (prisma === null) throw new Error('prisma missing');

    // Outer transaction: transition the lead on ITS client, then abort.
    await expect(
      withRlsContext(
        prisma,
        { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG_ID },
        async (tx) => {
          await leads.transitionInTransaction(
            actorFor(ADMIN_ID, 'ADMIN'),
            { leadId: SEED_LEAD_ID, toState: 'VISIT_SCHEDULED', notes: 'rollback probe' },
            tx as unknown as PrismaClient,
          );
          throw new Error('intentional abort');
        },
      ),
    ).rejects.toThrow('intentional abort');

    // THE PROOF it shared the caller's transaction: the committed state is
    // unchanged. A separate transaction would have committed VISIT_SCHEDULED.
    const after = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: SEED_LEAD_ID }, select: { state: true } }),
    );
    expect(after?.state).toBe('VISIT_REQUESTED');
  });

  it('the OLD shape (a bare nested withRlsContext) does NOT roll back - the defect', async () => {
    if (prisma === null) throw new Error('prisma missing');

    // Same outer transaction, but the nested work opens its OWN transaction - the
    // pre-fix shape. This is what contended with the caller's Lead lock.
    await expect(
      withRlsContext(
        prisma,
        { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG_ID },
        async () => {
          await withRlsContext(
            prisma,
            { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG_ID },
            async (inner) => {
              await (inner as unknown as PrismaClient).lead.update({
                where: { id: SEED_LEAD_ID },
                data: { state: 'VISIT_SCHEDULED' },
              });
            },
          );
          throw new Error('intentional abort');
        },
      ),
    ).rejects.toThrow('intentional abort');

    // SURVIVED the rollback: it was a second transaction, on a second connection.
    // That is precisely why the old code self-deadlocked once the caller had
    // written the Lead row, and why the fix must pass the caller's client.
    const after = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: SEED_LEAD_ID }, select: { state: true } }),
    );
    expect(after?.state).toBe('VISIT_SCHEDULED');

    // Reset so the journey test below starts from a clean state.
    await adminSeed(async (db) => {
      await db.lead.update({
        where: { id: SEED_LEAD_ID },
        data: { state: 'VISIT_REQUESTED' },
      });
    });
  });

  it('schedules a visit for a NON-OWNER exec and lands both effects', async () => {
    if (prisma === null) throw new Error('prisma missing');

    // The exact failing journey: the TELECALLER (who owns the lead and so can see
    // it) schedules the visit and assigns a SALES_EXEC. The exec is NOT the owner,
    // so grantExecLeadVisibility writes coOwnerId on the Lead row INSIDE the visit
    // transaction - the write that took the lock and deadlocked the nested
    // transition before the fix.
    //
    // The actor must be the TELECALLER, not the exec: `lead_select_telecaller`
    // hides a lead from anyone who is neither owner nor co-owner, so an exec
    // calling create() on a lead they do not own gets NotFoundException before any
    // of this runs. That visibility gap is exactly what coOwnerId exists to close,
    // and it is granted as a RESULT of this call - so the exec can only be the
    // assignee here, never the actor.
    const created = await visits.create(actorFor(TC_ID, 'TELECALLER'), {
      leadId: JOURNEY_LEAD_ID,
      salesExecId: SE_ID,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(created.leadId).toBe(JOURNEY_LEAD_ID);

    const after = await adminSeed((db) =>
      db.lead.findUnique({
        where: { id: JOURNEY_LEAD_ID },
        select: { state: true, coOwnerId: true },
      }),
    );
    // The nested transition ran (scheduling completes a VISIT_REQUESTED)...
    expect(after?.state).toBe('VISIT_SCHEDULED');
    // ...and the exec-visibility grant that caused the lock.
    expect(after?.coOwnerId).toBe(SE_ID);

    // Both audits present, so neither effect was skipped to dodge the deadlock.
    const audits = await adminSeed((db) =>
      db.auditLog.findMany({
        where: { entityId: { in: [JOURNEY_LEAD_ID, created.id] } },
        select: { action: true },
      }),
    );
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toContain('visit.create');
    expect(actions).toContain('lead.transition');
  });
});
