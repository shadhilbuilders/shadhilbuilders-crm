// T-STATUS-ONE-TRUTH (2026-09-28) - cross-service agreement test.
//
// THE BUG THIS PINS. Four surfaces answered "which leads are new / overdue /
// idle" three different ways, so the numbers on screen disagreed:
//
//   admin/overview "Leads not called"   updatedAt <= now() - 1 day, any active state
//   leads page     "N overdue"          state='NEW' AND createdAt <= now() - 30 min
//   leads page     "N new today"        state='NEW' AND createdAt >= now() - 24h  <-- rolling
//   work dashboard "New today"          createdAt >= MIDNIGHT, ALL states         <-- no state filter
//
// The last two are the two halves of the defect, and neither is visible from
// inside a single service: each endpoint's own test happily asserted its own
// definition. "New today" on the dashboard counted leads already WON or LOST
// (closing a deal made the number go UP), and the leads page counted a rolling
// window, so the same words meant different populations.
//
// So this suite calls BOTH REAL SERVICES against a REAL database, over ONE
// shared fixture, and asserts the counts agree. It is deliberately not a unit
// test with stubs - a stub per service is exactly how the drift survived.
//
// TIME-OF-DAY SAFETY. A test that fails in the first hour of the day is worse
// than no test, so the fixture is built to be unambiguous whenever it runs:
// the two leads that must be OVERDUE are placed well in the past, and the
// "new today" expectation is DERIVED from the fixture timestamps with plain
// date arithmetic (not by calling the shared predicate - a test that computes
// its expectation from the function under test proves nothing).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';
import {
  prisma as runtimePrisma,
  type PrismaClient,
  withRlsContext,
} from '@shadhil/database';
import { OVERDUE_AFTER_MIN } from '@shadhil/api-types';

import { DashboardService } from '../dashboard/dashboard.service';
import { PrismaService } from '../prisma/prisma.module';
import { VisitsService } from '../visits/visits.service';
import { LeadsService } from './leads.service';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const prisma: PrismaClient | null = HAS_DB ? runtimePrisma : null;

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const PROJECT_ID = `statustruth-pr-${RUN}`;
const TEAM_ID = `statustruth-team-${RUN}`;
const ADMIN_ID = `statustruth-admin-${RUN}`;
const TC_ID = `statustruth-tc-${RUN}`;

const MIN = 60_000;

/** Local midnight - same framing the product uses for "today". */
function midnight(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

const NOW = new Date();
const MIDNIGHT = midnight(NOW);

/**
 * The fixture, and WHY each row is here:
 *
 *  - freshNew        NEW, 5 min old.       overdue NO  (inside the 30-min SLA)
 *  - overdueNew      NEW, 45 min old.      overdue YES (past the SLA)
 *  - lateLastNight   NEW, 2h before today  overdue YES, but NOT "new today" -
 *                                          this is the midnight-vs-rolling-24h
 *                                          divergence, and it is placed before
 *                                          midnight so it is unambiguous
 *                                          whenever the suite runs
 *  - wonToday        WON, created today    NOT "new today" - this is the
 *                                          "closing a deal raises the count" bug
 *  - lostToday       LOST, created today   NOT "new today"
 *  - contactedToday  CONTACTED, today      NOT "new today" (no longer NEW)
 */
type FixtureRow = { id: string; state: string; createdAt: Date };

/**
 * The DISCRIMINATOR for the rolling-window bug.
 *
 * midnight != now-24h, and the only place the two definitions disagree is
 * `[now - 24h, midnight)`: a lead created there is "in the last 24h" (so the
 * old rolling query counted it) but NOT "today" (so the correct one must not).
 * The width of that band is `24h - (time since midnight)`, so it shrinks as the
 * day advances - a row pinned at "midnight minus 2 hours" falls OUTSIDE it after
 * 22:00 local, and the test then cannot tell the two definitions apart at all
 * (it passes against the bug, which is worse than failing).
 *
 * So place it adaptively, as late as possible while staying strictly inside the
 * band:
 *   - `NOW - 23h` is always inside `[now-24h, now)` and is before midnight
 *     whenever the current time is before 23:00 local. Preferred because it is
 *     guaranteed to be inside the 24h window.
 *   - after 23:00 local that value crosses midnight, so fall back to
 *     `midnight - 30min`, which is before midnight and still inside the 24h
 *     window until 23:30 local.
 * Verified by the assertion below: if the chosen instant is not strictly before
 * midnight, the fixture is degenerate and this test says so instead of passing
 * vacuously.
 */
function discriminatorCreatedAt(now: Date, midnightAt: Date): Date {
  const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 60 * MIN);
  if (twentyThreeHoursAgo.getTime() < midnightAt.getTime()) return twentyThreeHoursAgo;
  return new Date(midnightAt.getTime() - 30 * MIN);
}

const DISCRIMINATOR_AT = discriminatorCreatedAt(NOW, MIDNIGHT);

const FIXTURE: FixtureRow[] = [
  { id: `statustruth-l-fresh-${RUN}`, state: 'NEW', createdAt: new Date(NOW.getTime() - 5 * MIN) },
  { id: `statustruth-l-overdue-${RUN}`, state: 'NEW', createdAt: new Date(NOW.getTime() - 45 * MIN) },
  { id: `statustruth-l-latenight-${RUN}`, state: 'NEW', createdAt: DISCRIMINATOR_AT },
  { id: `statustruth-l-won-${RUN}`, state: 'WON', createdAt: new Date(MIDNIGHT.getTime() + 60 * MIN) },
  { id: `statustruth-l-lost-${RUN}`, state: 'LOST', createdAt: new Date(MIDNIGHT.getTime() + 90 * MIN) },
  { id: `statustruth-l-contacted-${RUN}`, state: 'CONTACTED', createdAt: new Date(MIDNIGHT.getTime() + 30 * MIN) },
];

/**
 * OVERDUE is expected to be exactly 2 - time-of-day independent, because it
 * depends only on the 30-minute age boundary, not on midnight:
 *   overdueNew    (45 min)  YES
 *   lateLastNight (>1 day)  YES
 *   freshNew      (5 min)   NO
 * and no non-NEW lead can ever be overdue.
 */
const EXPECTED_OVERDUE = 2;

/**
 * "New today" is derived from the fixture with INDEPENDENT date arithmetic.
 * Deliberately not `isNewToday()` - importing the function under test to
 * compute its own expectation would make the assertion vacuous. The rule itself
 * is pinned with exact boundaries in packages/api-types/test/lead-status.test.ts.
 */
const EXPECTED_NEW_TODAY = FIXTURE.filter(
  (r) => r.state === 'NEW' && r.createdAt.getTime() >= MIDNIGHT.getTime(),
).length;

const ALL_LEAD_IDS = FIXTURE.map((r) => r.id);

/**
 * Visits for the "Visits at risk" card (T-VISIT-RISK-STATUS, 2026-09-28).
 *
 * The reported bug: a lead whose status is WON still appeared in the card.
 * Reproducing that needs REAL rows, because the defect was in a Prisma
 * relation filter (`lead: { state: ... }`) - a mocked client returns whatever
 * the fixture holds and never applies the `where` at all, so only a real
 * database can show whether the filter works.
 */
const VISITS = {
  /** The bug: a SCHEDULED visit on a lead that is already WON, slot long past. */
  onWon: `statustruth-v-won-${RUN}`,
  /** Same shape on a LOST lead. */
  onLost: `statustruth-v-lost-${RUN}`,
  /** Genuinely at risk: live lead, slot yesterday -> must be listed "overdue". */
  onActiveOverdue: `statustruth-v-active-${RUN}`,
  /** Live lead, slot earlier today -> must be listed "due today". */
  onActiveToday: `statustruth-v-today-${RUN}`,
  /** Already-concluded visit (COMPLETED) -> not open, must never be listed. */
  completed: `statustruth-v-done-${RUN}`,
};

const ALL_VISIT_IDS = Object.values(VISITS);

function actorFor(sub: string, role: JwtPayload['role']): JwtPayload {
  return {
    sub,
    email: `${sub}@test.local`,
    role,
    organizationId: ORG,
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
  };
}

async function adminSeed<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  if (prisma === null) throw new Error('prisma missing');
  return withRlsContext(
    prisma,
    { userId: ADMIN_ID, role: 'ADMIN', organizationId: ORG },
    async (tx) => fn(tx as unknown as PrismaClient),
  );
}

beforeAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.project.upsert({
      where: { id: PROJECT_ID },
      update: {},
      create: {
        id: PROJECT_ID,
        name: `Status Truth ${RUN}`,
        slug: PROJECT_ID,
        address: 'test',
        organizationId: ORG,
      },
    });
    await db.team.upsert({
      where: { id: TEAM_ID },
      update: {},
      create: { id: TEAM_ID, name: `Status Truth ${RUN}`, organizationId: ORG },
    });
    for (const [id, role, name] of [
      [ADMIN_ID, 'ADMIN', 'Status Truth Admin'],
      [TC_ID, 'TELECALLER', 'Status Truth Telecaller'],
    ] as const) {
      await db.user.upsert({
        where: { id },
        update: { role },
        create: {
          id,
          email: `${id}@test.local`,
          name,
          role,
          organizationId: ORG,
          mustChangePassword: false,
        },
      });
    }
    await db.teamMember.upsert({
      where: { userId_teamId: { userId: TC_ID, teamId: TEAM_ID } },
      update: {},
      create: { userId: TC_ID, teamId: TEAM_ID, organizationId: ORG },
    });

    // createdAt is @default(now()) and updatedAt is @updatedAt (Prisma owns
    // both), so neither can be set through `create({ data })`. Raw SQL is the
    // only way to place a row in the past - which is what makes this fixture
    // able to express the midnight boundary at all.
    //
    // `phone` carries a unique constraint, so it must differ per row; deriving
    // it from the id tail would NOT (every id shares the RUN suffix), which is
    // how the first version of this fixture collided.
    let n = 0;
    for (const row of FIXTURE) {
      n += 1;
      const phone = `91${String(Date.now()).slice(-6)}${String(n).padStart(3, '0')}`;
      await db.$executeRaw`
        INSERT INTO "Lead" ("id", "name", "phone", "phoneE164", "source", "state",
          "ownerId", "ownerType", "teamId", "projectId", "organizationId",
          "createdAt", "updatedAt")
        VALUES (${row.id}, ${`Status Truth ${n}`}, ${phone}, ${phone},
          'WHATSAPP', ${row.state}, ${TC_ID}, 'TELECALLER', ${TEAM_ID}, ${PROJECT_ID},
          ${ORG}, ${row.createdAt}, ${row.createdAt})
      `;
    }

    // SiteVisits for the "Visits at risk" card. `scheduledFor` is set in the
    // past for every one of them (it is the ONLY time filter on the query), so
    // any row that appears must have been allowed through by the lead-state
    // filter - which is exactly what the reported bug violated.
    const visits: Array<[string, string, string, Date]> = [
      [VISITS.onWon, FIXTURE[3].id, 'SCHEDULED', new Date(NOW.getTime() - 3 * 24 * 60 * MIN)],
      [VISITS.onLost, FIXTURE[4].id, 'SCHEDULED', new Date(NOW.getTime() - 2 * 24 * 60 * MIN)],
      [VISITS.onActiveOverdue, FIXTURE[2].id, 'SCHEDULED', new Date(NOW.getTime() - 24 * 60 * MIN)],
      [VISITS.onActiveToday, FIXTURE[0].id, 'RESCHEDULED', new Date(MIDNIGHT.getTime() + 60 * MIN)],
      [VISITS.completed, FIXTURE[5].id, 'COMPLETED', new Date(NOW.getTime() - 4 * 24 * 60 * MIN)],
    ];
    for (const [id, leadId, status, scheduledFor] of visits) {
      await db.$executeRaw`
        INSERT INTO "SiteVisit" ("id", "leadId", "organizationId", "userId",
          "scheduledFor", "status", "createdAt", "updatedAt")
        VALUES (${id}, ${leadId}, ${ORG}, ${TC_ID}, ${scheduledFor}, ${status},
          ${scheduledFor}, ${scheduledFor})
      `;
    }
  });
}, 60_000);

afterAll(async () => {
  if (prisma === null) return;
  await adminSeed(async (db) => {
    await db.$executeRaw`DELETE FROM "SiteVisit" WHERE "id" = ANY(${ALL_VISIT_IDS})`;
    await db.$executeRaw`DELETE FROM "Lead" WHERE "id" = ANY(${ALL_LEAD_IDS})`;
    await db.$executeRaw`DELETE FROM "TeamMember" WHERE "teamId" = ${TEAM_ID}`;
    await db.$executeRaw`DELETE FROM "Team" WHERE "id" = ${TEAM_ID}`;
    await db.$executeRaw`DELETE FROM "User" WHERE "id" IN (${ADMIN_ID}, ${TC_ID})`;
    await db.$executeRaw`DELETE FROM "Project" WHERE "id" = ${PROJECT_ID}`;
  });
}, 60_000);

async function bothSurfaces() {
  const leads = new LeadsService(new PrismaService());
  // A REAL PrismaService, not a stub: the whole point of this suite is that both
  // services run their real SQL through withRlsContext against a real database.
  // (The dashboard's own unit suite passes `{ $client: {} }` because it mocks
  // withRlsContext - that stub cannot run a transaction, and using it here would
  // quietly turn this back into a test of nothing.)
  const dashboard = new DashboardService(new PrismaService());
  const envelope = await leads.list(actorFor(ADMIN_ID, 'ADMIN'), {
    projectId: PROJECT_ID,
    limit: 100,
    offset: 0,
  } as never);
  const stats = await dashboard.getStats(actorFor(ADMIN_ID, 'ADMIN'), {
    projectId: PROJECT_ID,
  } as never);
  return { envelope, stats };
}

describe('the two endpoints agree on "new today"', () => {
  it('the fixture can actually tell the two definitions apart', async () => {
    // Guards the guard. The rolling-24h bug is only detectable if the
    // discriminator lead sits inside `[now - 24h, midnight)`. If it does not,
    // this suite would pass against the bug - the worst possible outcome for a
    // regression test - so assert the preconditions explicitly and fail loudly
    // rather than reporting green.
    expect(DISCRIMINATOR_AT.getTime()).toBeLessThan(MIDNIGHT.getTime());
    expect(DISCRIMINATOR_AT.getTime()).toBeGreaterThan(NOW.getTime() - 24 * 60 * MIN);
    expect(EXPECTED_NEW_TODAY).toBeLessThan(
      FIXTURE.filter((r) => r.state === 'NEW').length,
    );
  });

  it('dashboard KPI === leads page count, and both equal the fixture truth', async () => {
    const { envelope, stats } = await bothSurfaces();
    // THE assertion that failed before this change: the dashboard had no state
    // filter, so WON/LOST created today were counted as "new".
    expect(stats.kpis.newLeadsToday).toBe(envelope.newTodayCount);
    // ...and the agreed number is the RIGHT one, not merely a shared mistake.
    expect(envelope.newTodayCount).toBe(EXPECTED_NEW_TODAY);
  });

  it('excludes a lead created before midnight on BOTH surfaces', async () => {
    const { envelope, stats } = await bothSurfaces();
    const late = FIXTURE.find((r) => r.id.includes('latenight'))!;
    // Preconditions: the row is NEW and genuinely before midnight, so if the
    // count is wrong the failure names the CAUSE rather than a bare number.
    const dbRow = await adminSeed((db) =>
      db.lead.findUnique({
        where: { id: late.id },
        select: { state: true, createdAt: true },
      }),
    );
    expect(dbRow?.state).toBe('NEW');
    expect(dbRow?.createdAt.getTime()).toBeLessThan(MIDNIGHT.getTime());
    // It IS in the list (it is an active lead)...
    expect(envelope.rows.some((r) => r.id === late.id)).toBe(true);
    // ...but it must not be in "new today", which is what the old rolling-24h
    // window wrongly did.
    expect(envelope.newTodayCount).toBe(EXPECTED_NEW_TODAY);
    expect(stats.kpis.newLeadsToday).toBe(EXPECTED_NEW_TODAY);
  });

  it('closing a lead today does not raise "new today"', async () => {
    // The state-scoping half, asserted as a BEHAVIOURAL invariant so it holds at
    // any time of day: before the fix, marking a deal WON today made the number
    // go UP by one.
    const dashboard = new DashboardService(new PrismaService());
    const target = FIXTURE.find((r) => r.state === 'NEW' && r.createdAt.getTime() >= MIDNIGHT.getTime());
    // Only meaningful when a today-created NEW lead exists (i.e. not in the
    // first minutes after midnight, when the fixture has none).
    if (target === undefined) return;
    const before = await dashboard.getStats(actorFor(ADMIN_ID, 'ADMIN'), {
      projectId: PROJECT_ID,
    } as never);
    await adminSeed(async (db) => {
      await db.lead.update({ where: { id: target.id }, data: { state: 'WON' } });
    });
    const after = await dashboard.getStats(actorFor(ADMIN_ID, 'ADMIN'), {
      projectId: PROJECT_ID,
    } as never);
    expect(after.kpis.newLeadsToday).toBe(before.kpis.newLeadsToday - 1);
    await adminSeed(async (db) => {
      await db.lead.update({ where: { id: target.id }, data: { state: 'NEW' } });
    });
  });
});

describe('the two endpoints agree on "overdue"', () => {
  it('dashboard KPI === leads page count, and both equal the fixture truth', async () => {
    const { envelope, stats } = await bothSurfaces();
    expect(stats.kpis.overdueLeads).toBe(envelope.overdueCount);
    expect(envelope.overdueCount).toBe(EXPECTED_OVERDUE);
  });

  it('the shared SLA constant is what both actually apply', async () => {
    // Guards against "they agree because both are stale": at 30 minutes, a
    // 45-minute-old NEW lead is overdue and a 5-minute-old one is not.
    expect(OVERDUE_AFTER_MIN).toBe(30);
    const { envelope, stats } = await bothSurfaces();
    expect(envelope.overdueCount).toBe(EXPECTED_OVERDUE);
    expect(stats.kpis.overdueLeads).toBe(EXPECTED_OVERDUE);
  });

  it('a lead that is not NEW is never overdue, however old', async () => {
    const { envelope, stats } = await bothSurfaces();
    // None of the fixture's WON/LOST/CONTACTED rows (created today) may appear
    // in an overdue count - the metric is NEW-only by contract.
    const nonNew = FIXTURE.filter((r) => r.state !== 'NEW').length;
    expect(nonNew).toBe(3);
    expect(envelope.overdueCount).toBe(EXPECTED_OVERDUE);
    expect(stats.kpis.overdueLeads).toBe(EXPECTED_OVERDUE);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-VISIT-RISK-STATUS (2026-09-28)
// "lead status is won and but this leads shows in visit at risk"
// ────────────────────────────────────────────────────────────────────────────
describe('"Visits at risk" excludes settled deals', () => {
  it('a SCHEDULED visit on a WON or LOST lead is NOT listed', async () => {
    // The reported bug, against real rows. These visits are open (SCHEDULED)
    // and their slot is long past, so only the lead-state filter keeps them off
    // the card. Nothing closes a visit when its lead goes terminal, which is why
    // they existed in the first place.
    const dashboard = new DashboardService(new PrismaService());
    const result = await dashboard.getExceptions(actorFor(ADMIN_ID, 'ADMIN'));
    const ids = result.visitRisk.map((v) => v.id);
    expect(ids).not.toContain(VISITS.onWon);
    expect(ids).not.toContain(VISITS.onLost);
  });

  it('a CONCLUDED visit is not listed, however old its lead is', async () => {
    const dashboard = new DashboardService(new PrismaService());
    const result = await dashboard.getExceptions(actorFor(ADMIN_ID, 'ADMIN'));
    expect(result.visitRisk.map((v) => v.id)).not.toContain(VISITS.completed);
  });

  it('STILL lists live work - over-filtering would be the opposite bug', async () => {
    // The card must keep doing its job. A visit on an active lead is exactly
    // what it is for, so assert the genuine rows survive.
    const dashboard = new DashboardService(new PrismaService());
    const result = await dashboard.getExceptions(actorFor(ADMIN_ID, 'ADMIN'));
    const ids = result.visitRisk.map((v) => v.id);
    expect(ids).toContain(VISITS.onActiveOverdue);
    expect(ids).toContain(VISITS.onActiveToday);
  });

  it('carries the LEAD status so the row is explainable', async () => {
    // Before this the card showed only the visit's own status, which is
    // permanently SCHEDULED/RESCHEDULED - so an operator could not see what
    // state the deal was in, which is exactly why the report was "I don't
    // understand why this is here".
    const dashboard = new DashboardService(new PrismaService());
    const result = await dashboard.getExceptions(actorFor(ADMIN_ID, 'ADMIN'));
    const overdue = result.visitRisk.find((v) => v.id === VISITS.onActiveOverdue);
    expect(overdue?.leadStatus).toBe(FIXTURE[2].state);
    expect(overdue?.reason).toBe('overdue-past-due');
    const today = result.visitRisk.find((v) => v.id === VISITS.onActiveToday);
    expect(today?.reason).toBe('scheduled-today');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T-VISIT-CLOSE (2026-09-28)
// A settled deal must not leave open visits behind. Nothing used to close them:
// `updateOutcome` was the only closer, and it is offered per-visit, so a lead
// that went LOST (or a booking that was approved/cancelled) left its scheduled
// visit open forever with a past `scheduledFor` - surfacing as phantom work on
// the "Visits at risk" card, the visit list and the calendar.
// ────────────────────────────────────────────────────────────────────────────
describe('settling a deal closes its open visits', () => {
  it('lead -> LOST cancels the open visit and audits WHY', async () => {
    // Uses the real service against the real DB, so the cascade is exercised
    // through withRlsContext (the same path production takes).
    const leads = new LeadsService(new PrismaService());
    const target = FIXTURE.find((r) => r.id.includes('overdue'))!;
    // Give the lead a fresh open visit so this test owns its own state.
    const visitId = `statustruth-v-close-${RUN}`;
    await adminSeed(async (db) => {
      await db.$executeRaw`
        INSERT INTO "SiteVisit" ("id", "leadId", "organizationId", "userId",
          "scheduledFor", "status", "createdAt", "updatedAt")
        VALUES (${visitId}, ${target.id}, ${ORG}, ${TC_ID},
          ${new Date(NOW.getTime() + 86_400_000)}, 'SCHEDULED', ${NOW}, ${NOW})
      `;
      await db.lead.update({ where: { id: target.id }, data: { state: 'NEGOTIATION' } });
    });

    await leads.transition(actorFor(ADMIN_ID, 'ADMIN'), {
      leadId: target.id,
      toState: 'LOST',
      reason: 'customer went cold',
    } as never);

    const visit = await adminSeed((db) =>
      db.siteVisit.findUnique({ where: { id: visitId }, select: { status: true } }),
    );
    expect(visit?.status).toBe('CANCELLED');

    // The audit row names the CAUSE, so a reader can judge whether cancelling
    // was right rather than just seeing that it happened.
    const audit = await adminSeed((db) =>
      db.auditLog.findFirst({
        where: { entityId: visitId, action: 'visit.cancel' },
        select: { after: true },
      }),
    );
    expect((audit?.after as { closedBecause?: string })?.closedBecause).toBe('lead-terminal');

    await adminSeed(async (db) => {
      await db.$executeRaw`DELETE FROM "AuditLog" WHERE "entityId" = ${visitId}`;
      await db.$executeRaw`DELETE FROM "SiteVisit" WHERE "id" = ${visitId}`;
      await db.lead.update({ where: { id: target.id }, data: { state: 'NEW' } });
    });
  });

  it('lead -> WON does NOT close visits (a handover may still be pending)', async () => {
    // The one deliberate exception. A won deal can still have a handover or site
    // meeting to conduct, so silently cancelling it would destroy real work.
    const leads = new LeadsService(new PrismaService());
    const target = FIXTURE.find((r) => r.id.includes('fresh'))!;
    const visitId = `statustruth-v-won-keep-${RUN}`;
    await adminSeed(async (db) => {
      await db.$executeRaw`
        INSERT INTO "SiteVisit" ("id", "leadId", "organizationId", "userId",
          "scheduledFor", "status", "createdAt", "updatedAt")
        VALUES (${visitId}, ${target.id}, ${ORG}, ${TC_ID},
          ${new Date(NOW.getTime() + 86_400_000)}, 'SCHEDULED', ${NOW}, ${NOW})
      `;
      await db.lead.update({ where: { id: target.id }, data: { state: 'BOOKING_INITIATED' } });
    });

    await leads.transition(actorFor(ADMIN_ID, 'ADMIN'), {
      leadId: target.id,
      toState: 'WON',
      reason: 'deal closed',
    } as never);

    const visit = await adminSeed((db) =>
      db.siteVisit.findUnique({ where: { id: visitId }, select: { status: true } }),
    );
    expect(visit?.status).toBe('SCHEDULED');

    await adminSeed(async (db) => {
      await db.$executeRaw`DELETE FROM "SiteVisit" WHERE "id" = ${visitId}`;
      await db.lead.update({ where: { id: target.id }, data: { state: 'NEW' } });
    });
  });

  it('refuses a visit outcome on a terminal lead (defence in depth)', async () => {
    // The cascade should have removed these rows, so this is the backstop: a
    // direct service call (or a race) must not advance a LOST lead to VISITED,
    // which the state machine forbids and the visit-level guard cannot see.
    const visits = new VisitsService(new PrismaService(), new LeadsService(new PrismaService()));
    const target = FIXTURE.find((r) => r.id.includes('contacted'))!;
    const visitId = `statustruth-v-term-${RUN}`;
    await adminSeed(async (db) => {
      await db.$executeRaw`
        INSERT INTO "SiteVisit" ("id", "leadId", "organizationId", "userId",
          "scheduledFor", "status", "createdAt", "updatedAt")
        VALUES (${visitId}, ${target.id}, ${ORG}, ${TC_ID},
          ${new Date(NOW.getTime() - 60 * 60 * 1000)}, 'SCHEDULED', ${NOW}, ${NOW})
      `;
      await db.lead.update({ where: { id: target.id }, data: { state: 'LOST' } });
    });

    await expect(
      visits.updateOutcome(actorFor(ADMIN_ID, 'ADMIN'), visitId, {
        visitId,
        outcome: 'COMPLETED',
        notes: 'should be refused',
      } as never),
    ).rejects.toMatchObject({ name: 'ConflictException' });

    // The lead is untouched - the point of the guard.
    const lead = await adminSeed((db) =>
      db.lead.findUnique({ where: { id: target.id }, select: { state: true } }),
    );
    expect(lead?.state).toBe('LOST');

    await adminSeed(async (db) => {
      await db.$executeRaw`DELETE FROM "SiteVisit" WHERE "id" = ${visitId}`;
      await db.lead.update({ where: { id: target.id }, data: { state: 'CONTACTED' } });
    });
  });
});
