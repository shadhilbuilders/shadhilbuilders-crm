// T-LEAD-SYNC-COVERAGE (2026-09-30) - a visit status change must reach the lead,
// or must SAY that it did not.
//
// THE REPORT. "If we change status from visit page, we should update status in lead
// as well, can you check whether this logic present or not". It IS present - both
// `updateOutcome` and `reschedule` drive the parent lead in the same transaction -
// but it silently did nothing in three situations, two of them reachable from the
// visits page:
//
//   A. `reschedule` only mirrored the move for a hardcoded trio of lead states
//      (RESCHEDULED | NO_SHOW | VISIT_REQUESTED), so a visit moved on a lead in
//      CONTACTED left the lead reading "Talked" with a booked visit on the
//      calendar.
//   B. A role the lead machine does not allow to drive the edge got NO lead write
//      and NO WORD ABOUT IT. Reachable and normal: a SALES_EXEC may mark a visit
//      NO_SHOW (the visits dialog offers it) while the lead machine reserves
//      VISIT_SCHEDULED -> NO_SHOW to telecaller/manager - so the visit went red and
//      the lead stayed "Visit booked", with nothing anywhere connecting the two.
//   C. `reschedule` could THROW Forbidden where `updateOutcome` defers, failing the
//      whole move instead of recording it.
//
// These tests drive the real service against a real database, because none of the
// three is observable through a mock: they are all about what the transaction
// committed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';
import { prisma as runtimePrisma, type PrismaClient, withRlsContext } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';
import { allowedNextStates } from '../leads/leads.state-machine';
import { LeadsService } from '../leads/leads.service';

import { VisitsService } from './visits.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const ORG_ID = 'ceid01lpfe1esm8jwsxid41k28';
const RUN = Date.now();
const PROJECT_ID = `test-lsc-proj-${RUN}`;
const TEAM_ID = `test-lsc-team-${RUN}`;
const ADMIN_ID = `test-lsc-admin-${RUN}`;
const SE_ID = `test-lsc-se-${RUN}`;
const TC_ID = `test-lsc-tc-${RUN}`;

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(prisma, { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG_ID }, async (tx) =>
    fn(tx as unknown as PrismaClient),
  );
}

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

const LEAD_IDS: string[] = [];

describe.skipIf(!HAS_DB)('visit -> lead sync coverage (T-LEAD-SYNC-COVERAGE)', () => {
  let service: VisitsService;
  let seq = 0;

  beforeAll(async () => {
    if (prisma === null) return;
    const prismaService = { $client: prisma as unknown as PrismaClient } as PrismaService;
    service = new VisitsService(prismaService, new LeadsService(prismaService));

    await adminSeed(async (db) => {
      await db.project.upsert({
        where: { id: PROJECT_ID },
        update: {},
        create: {
          id: PROJECT_ID,
          name: `LSC Project ${RUN}`,
          slug: PROJECT_ID,
          address: 'test',
          organizationId: ORG_ID,
        },
      });
      await db.team.upsert({
        where: { id: TEAM_ID },
        update: {},
        create: { id: TEAM_ID, name: `LSC Team ${RUN}`, organizationId: ORG_ID },
      });
      for (const [id, role, name] of [
        [ADMIN_ID, 'ADMIN', 'LSC Admin'],
        [SE_ID, 'SALES_EXEC', 'LSC Exec'],
        [TC_ID, 'TELECALLER', 'LSC Telecaller'],
      ] as const) {
        await db.user.upsert({
          where: { id },
          update: { role },
          create: { id, email: `${id}@example.com`, name, role, mustChangePassword: false, organizationId: ORG_ID },
        });
      }
    });
  }, 30_000);

  afterAll(async () => {
    if (prisma === null) return;
    await adminSeed(async (db) => {
      if (LEAD_IDS.length > 0) {
        await db.$executeRawUnsafe(`DELETE FROM "SiteVisit" WHERE "leadId" = ANY($1::text[])`, [...LEAD_IDS]);
        await db.$executeRawUnsafe(`DELETE FROM "Lead" WHERE id = ANY($1::text[])`, [...LEAD_IDS]);
      }
    });
    LEAD_IDS.length = 0;
  }, 30_000);

  /** A lead in `state` owned by the TELEcaller, plus a visit in `visitStatus`. */
  async function seed(
    state: string,
    visitStatus: 'SCHEDULED' | 'NO_SHOW' = 'SCHEDULED',
  ): Promise<{ leadId: string; visitId: string }> {
    if (prisma === null) throw new Error('prisma missing');
    seq += 1;
    const leadId = `test-lsc-lead-${RUN}-${seq}`;
    const visitId = `test-lsc-visit-${RUN}-${seq}`;
    LEAD_IDS.push(leadId);
    await adminSeed(async (db) => {
      await db.lead.create({
        data: {
          id: leadId,
          name: `LSC Lead ${seq}`,
          phone: `93${String(RUN).slice(-8)}${String(seq).padStart(3, '0')}`,
          phoneE164: `9193${String(RUN).slice(-8)}${String(seq).padStart(3, '0')}`,
          source: 'WHATSAPP',
          state: state as never,
          ownerId: TC_ID,
          ownerType: 'TELECALLER',
          // T-VISIT-EXEC-LEAD-VISIBILITY (#79): the exec's access to this lead IS
          // the co-owner slot. Without it `lead_select_telecaller` hides the lead
          // from the conducting exec, `siteVisit.lead` resolves to null, and the
          // outcome path cannot read (or sync) the lead at all. Production sets
          // this at schedule time; the fixture must model it or the whole class of
          // exec-outcome behaviour is untestable - which is how #79 survived.
          coOwnerId: SE_ID,
          teamId: TEAM_ID,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
        },
      });
      await db.siteVisit.create({
        data: {
          id: visitId,
          leadId,
          userId: SE_ID,
          scheduledFor: new Date(Date.now() + 3_600_000),
          status: visitStatus,
          outcome: visitStatus === 'NO_SHOW' ? 'NO_SHOW' : null,
          organizationId: ORG_ID,
        },
      });
    });
    return { leadId, visitId };
  }

  async function leadState(leadId: string): Promise<string> {
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: leadId }, select: { state: true } }),
    );
    return lead?.state ?? '';
  }

  // ── GAP A: the reschedule coverage ────────────────────────────────────────

  it('reschedule from CONTACTED now advances the lead (was silently skipped)', async () => {
    // THE GAP. The old code matched a hardcoded trio and did nothing for CONTACTED,
    // leaving the lead at "Talked" while a booked visit sat on the calendar.
    const { leadId, visitId } = await seed('CONTACTED');
    await service.reschedule(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      scheduledFor: new Date(Date.now() + 172_800_000).toISOString(),
    } as never);
    expect(await leadState(leadId)).toBe('VISIT_SCHEDULED');
  });

  it('reschedule still normalises NO_SHOW and RESCHEDULED leads', async () => {
    // The states the old list DID cover must not regress.
    for (const state of ['NO_SHOW', 'RESCHEDULED', 'VISIT_REQUESTED'] as const) {
      const { leadId, visitId } = await seed(state);
      await service.reschedule(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
        visitId,
        scheduledFor: new Date(Date.now() + 172_800_000).toISOString(),
      } as never);
      expect(await leadState(leadId), `${state} was not normalised`).toBe('VISIT_SCHEDULED');
    }
  });

  it('does not carry the lead out of a state whose machine has no such edge', async () => {
    // VISITED has no -> VISIT_SCHEDULED edge. Computing the target from the machine
    // must not become "force it anyway" - the lead stays put, which is also what
    // keeps the reschedule from throwing.
    const { leadId, visitId } = await seed('VISITED');
    await service.reschedule(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      scheduledFor: new Date(Date.now() + 172_800_000).toISOString(),
    } as never);
    expect(await leadState(leadId)).toBe('VISITED');
  });

  // ── GAP B/C: the deferral is reported, and never throws ───────────────────

  it('an exec NO_SHOW records the visit WITHOUT moving the lead, and REPORTS it', async () => {
    // The reachable divergence: the visits dialog offers No-show to a SALES_EXEC,
    // but the lead machine reserves VISIT_SCHEDULED -> NO_SHOW to telecaller/
    // manager. The visit must be recorded (it is the exec's own outcome) and the
    // caller must be TOLD the lead did not follow - that report is the fix.
    const { leadId, visitId } = await seed('VISIT_SCHEDULED');
    const row = await service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), visitId, {
      visitId,
      outcome: 'NO_SHOW',
      notes: 'no-show, exec recorded',
    } as never);

    expect(row.status).toBe('NO_SHOW');
    // The lead is untouched, by design - the lead machine is the authority.
    expect(await leadState(leadId)).toBe('VISIT_SCHEDULED');
    // ... and the divergence is no longer silent.
    expect(row.leadSyncNote).toBeDefined();
    expect(row.leadSyncNote).toContain('VISIT_SCHEDULED');
    expect(row.leadSyncNote).toContain('SALES_EXEC');
  });

  it('a manager NO_SHOW moves the lead and reports NOTHING', async () => {
    // The complement: when the sync works there must be no note, or the UI would
    // cry wolf on every routine outcome.
    const { leadId, visitId } = await seed('VISIT_SCHEDULED');
    const row = await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'NO_SHOW',
      notes: 'manager recorded',
    } as never);
    expect(row.leadSyncNote).toBeUndefined();
    expect(await leadState(leadId)).toBe('NO_SHOW');
  });

  it('COMPLETED moves the lead to VISITED with no note', async () => {
    const { leadId, visitId } = await seed('VISIT_SCHEDULED');
    const row = await service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'conducted',
    } as never);
    expect(row.leadSyncNote).toBeUndefined();
    expect(await leadState(leadId)).toBe('VISITED');
  });

  it('CANCELLED never moves the lead AND does not nag about it', async () => {
    // Owner ruling: cancelling a meeting is not cancelling the deal. The visit
    // closes, the lead stays, and - because that is the DESIGNED behaviour - the
    // user is not told anything is wrong.
    const { leadId, visitId } = await seed('VISIT_SCHEDULED');
    const row = await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'CANCELLED',
      notes: 'customer called it off',
    } as never);
    expect(row.status).toBe('CANCELLED');
    expect(await leadState(leadId)).toBe('VISIT_SCHEDULED');
    expect(row.leadSyncNote).toBeUndefined();
  });

  it('a reschedule whose lead write is refused does NOT throw', async () => {
    // GAP C. `transitionInTransaction` throws Forbidden on a role/edge mismatch;
    // the reschedule path used to call it unconditionally for the states in its
    // list. Now the role is checked first, so the move is recorded instead of
    // failing - which is the whole point of a reschedule.
    const { leadId, visitId } = await seed('NO_SHOW');
    const row = await service.reschedule(actorFor(TC_ID, 'TELECALLER'), visitId, {
      visitId,
      scheduledFor: new Date(Date.now() + 172_800_000).toISOString(),
    } as never);

    // The visit moved.
    expect(row.status).toBe('SCHEDULED');
    // A telecaller CAN drive NO_SHOW -> VISIT_SCHEDULED, so the lead follows and
    // there is no note. (The role check is what makes this deterministic instead of
    // an exception.)
    expect(await leadState(leadId)).toBe('VISIT_SCHEDULED');
    expect(row.leadSyncNote).toBeUndefined();
  });

  // ── Timeline rows: one action, ONE Activity row ───────────────────────────

  async function timeline(leadId: string) {
    return adminSeed((db) =>
      db.activity.findMany({ where: { leadId }, orderBy: { createdAt: 'asc' } }),
    );
  }

  it('create books a visit and leaves ONE VISIT row (no duplicate STATUS_CHANGE)', async () => {
    const { leadId } = await seed('VISIT_REQUESTED');
    await service.create(actorFor(ADMIN_ID, 'ADMIN'), {
      leadId,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      salesExecId: SE_ID,
    } as never);
    expect(await leadState(leadId)).toBe('VISIT_SCHEDULED');
    const rows = await timeline(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('VISIT');
    expect(rows[0].body).toMatch(/^Visit booked for .+ with .+; lead moved to Visit booked/);
  });

  it('reschedule from CONTACTED leaves ONE VISIT row', async () => {
    const { leadId, visitId } = await seed('CONTACTED');
    await service.reschedule(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      scheduledFor: new Date(Date.now() + 172_800_000).toISOString(),
    } as never);
    const rows = await timeline(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('VISIT');
    expect(rows[0].body).toContain('Visit rescheduled to');
    expect(rows[0].body).toContain('lead moved to Visit booked');
  });

  it('COMPLETED outcome leaves ONE VISIT row that mentions the lead move', async () => {
    const { leadId, visitId } = await seed('VISIT_SCHEDULED');
    await service.updateOutcome(actorFor(SE_ID, 'SALES_EXEC'), visitId, {
      visitId,
      outcome: 'COMPLETED',
      notes: 'conducted',
    } as never);
    const rows = await timeline(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('VISIT');
    expect(rows[0].body).toContain('Visit completed');
    expect(rows[0].body).toContain('lead moved to Visited');
  });

  it('CANCELLED outcome leaves one VISIT row and no lead move', async () => {
    const { leadId, visitId } = await seed('VISIT_SCHEDULED');
    await service.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
      visitId,
      outcome: 'CANCELLED',
    } as never);
    const rows = await timeline(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain('Visit cancelled');
    expect(rows[0].body).not.toContain('lead moved');
  });

  // ── Back-step: Visit booked -> Visit requested (2026-10-09) ───────────────

  it('VISIT_SCHEDULED -> VISIT_REQUESTED cancels the open visit in the same move', async () => {
    const { leadId, visitId } = await seed('VISIT_SCHEDULED');
    const leads = new LeadsService({ $client: prisma as unknown as PrismaClient } as PrismaService);
    await leads.transition(actorFor(TC_ID, 'TELECALLER'), {
      leadId,
      toState: 'VISIT_REQUESTED',
    } as never);

    expect(await leadState(leadId)).toBe('VISIT_REQUESTED');
    const visit = await adminSeed((db) =>
      db.siteVisit.findUnique({ where: { id: visitId }, select: { status: true } }),
    );
    expect(visit?.status).toBe('CANCELLED');
    // The back step keeps the normal STATUS_CHANGE row; the cancelled visit gets none.
    const rows = await timeline(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('STATUS_CHANGE');
    expect(rows[0].body).toBe('Visit booked -> Visit requested');
  });
});

describe('the reschedule target is computed, not listed', () => {
  it('mirrors the state machine for every role', () => {
    // The property the implementation relies on: `allowedNextStates` answers both
    // "is there an edge" and "may this role drive it", so the sync cannot drift
    // from the machine. This pins the two cases the old hardcoded list got wrong.
    // A telecaller owns the re-engagement lane, so it can restamp from NO_SHOW;
    // an exec's lane starts at VISITED, so it cannot.
    expect(allowedNextStates('NO_SHOW', 'TELECALLER')).toContain('VISIT_SCHEDULED');
    expect(allowedNextStates('CONTACTED', 'TELECALLER')).toContain('VISIT_SCHEDULED');
    expect(allowedNextStates('VISITED', 'ADMIN')).not.toContain('VISIT_SCHEDULED');
  });
});
