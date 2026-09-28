// DashboardService.getExceptions - admin/owner problem inbox (2026-09-17).
//
// Pins:
//   1. ADMIN/OWNER only - a MANAGER call throws Forbidden before any query.
//   2. idleLeads: only rows the query returns (the SQL excludes terminal states
//      and rows touched within a day); service sorts oldest first + buckets
//      (overdue-NEW / 1-3 / 4-7 / 8-14 / 15-30 / 30+). projectId carried for links.
//   3. visitRisk: open visits today-or-past with reason overdue-past-due vs scheduled-today.
//   4. bookingMoney: TOKEN paid (awaiting approval) vs HOLD no-token.
//   5. teamHealth: staff whose newest touch >=1 day (quiet); active staff skipped.
//   6. Empty arrays (all-clear) when no rows.
//
// Test strategy: stub withRlsContext to invoke the callback with a fake tx whose
// $queryRaw / findMany return rows from a mutable FIXTURE (avoids the fragile
// call-count disambiguation). Same module-mock pattern as dashboard.service.test.ts.
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

import { DashboardService } from './dashboard.service';

type MockTx = {
  $queryRaw: Mock<() => Promise<unknown[]>>;
  siteVisit: { findMany: Mock<(args: Record<string, unknown>) => Promise<unknown[]>> };
  booking: { findMany: Mock<(args: Record<string, unknown>) => Promise<unknown[]>> };
};

// The service computes ages against the REAL wall clock (new Date() at call
// time), not a frozen constant. So fixture timestamps must be built from the
// real now too, or bucket/age assertions drift. `NOW` is captured at module load
// and reused so a single test's timestamps are self-consistent.
const NOW = new Date();
const DAY = 86_400_000;
function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}

// Mutable fixture read by the mocks; tests set these before calling the service.
const fixture: { idle: unknown[]; team: unknown[]; visits: unknown[]; bookings: unknown[] } = {
  idle: [],
  team: [],
  visits: [],
  bookings: [],
};

const tx = {
  $queryRaw: vi.fn(async () => {
    // $queryRaw is called exactly twice per getExceptions: first for idleLeads,
    // then for teamHealth. Key off the invocation index - deterministic.
    const call = vi.mocked(tx.$queryRaw).mock.calls.length;
    return call === 1 ? (fixture.idle[0] ?? []) : (fixture.team[0] ?? []);
  }),
  siteVisit: {
    findMany: vi.fn(async () => fixture.visits[0] ?? []),
  },
  booking: {
    findMany: vi.fn(async () => fixture.bookings[0] ?? []),
  },
} as unknown as MockTx;

vi.mock('@shadhil/database', () => {
  return {
    prisma: {},
    rlsContextFrom: vi.fn((actor: {
      sub: string;
      role: string;
      organizationId?: string | null;
    }) => ({
      userId: actor.sub,
      role: actor.role,
      organizationId: actor.organizationId ?? 'org',
    })),
    Prisma: {
      raw: (sql: string) => ({ raw: sql }),
      sql: (strings: TemplateStringsArray, ...args: unknown[]) => ({ sql: String.raw({ raw: strings }, ...args) }),
    },
    withRlsContext: vi.fn(
      async (
        _client: unknown,
        _ctx: unknown,
        callback: (t: unknown) => unknown,
      ) => callback(tx),
    ),
  };
});

const ownerActor: JwtPayload = {
  sub: 'owner-1',
  email: 'owner@shadhilbuilders.in',
  role: 'OWNER',
  organizationId: 'org',
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};
const adminActor: JwtPayload = { ...ownerActor, sub: 'admin-1', role: 'ADMIN' };
const managerActor: JwtPayload = { ...ownerActor, sub: 'mgr-1', role: 'MANAGER' };

describe('DashboardService.getExceptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.idle = [];
    fixture.team = [];
    fixture.visits = [];
    fixture.bookings = [];
  });

  it('rejects a MANAGER (non admin/owner) before running any query', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    await expect(svc.getExceptions(managerActor)).rejects.toThrow(
      /Only ADMIN or OWNER/,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('idleLeads sorts oldest first, buckets by age, carries projectId', async () => {
    fixture.idle.push([
      { id: 'l-b', name: 'Old', phone: '9', state: 'CONTACTED', ownerId: 'u-1', projectId: 'p-1', updatedAt: daysAgo(20), ownerName: 'Priya' },
      { id: 'l-a', name: 'Fresh', phone: '8', state: 'CONTACTED', ownerId: 'u-2', projectId: 'p-2', updatedAt: daysAgo(2), ownerName: 'Arjun' },
    ]);
    fixture.team.push([]);
    const svc = new DashboardService({ $client: {} } as never);
    const result = await svc.getExceptions(ownerActor);

    expect(result.idleLeads.length).toBe(2);
    expect(result.idleLeads[0]!.id).toBe('l-b');
    expect(result.idleLeads[0]!.idleDays).toBe(20);
    expect(result.idleLeads[0]!.bucket).toBe('idle-15-30');
    expect(result.idleLeads[1]!.id).toBe('l-a');
    expect(result.idleLeads[1]!.idleDays).toBe(2);
    expect(result.idleLeads[1]!.bucket).toBe('idle-1-3');
    expect(result.idleLeads[1]!.projectId).toBe('p-2');
  });

  it('a NEW lead past the 30-minute SLA is bucketed overdue', async () => {
    fixture.idle.push([
      { id: 'l-new', name: 'Overdue New', phone: '7', state: 'NEW', ownerId: 'u-1', projectId: 'p-1', updatedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), ownerName: null },
    ]);
    fixture.team.push([]);
    const svc = new DashboardService({ $client: {} } as never);
    const result = await svc.getExceptions(adminActor);
    expect(result.idleLeads[0]!.bucket).toBe('overdue');
  });

  it('visitRisk flags open visits today-or-past with the correct reason', async () => {
    fixture.visits.push([
      { id: 'v-past', leadId: 'l-1', lead: { name: 'Lead Past', projectId: 'p-1', state: 'NEGOTIATION' }, scheduledFor: daysAgo(1), status: 'SCHEDULED', user: { name: null } },
      { id: 'v-today', leadId: 'l-2', lead: { name: 'Lead Today', projectId: 'p-2', state: 'VISIT_SCHEDULED' }, scheduledFor: new Date(NOW.getTime() - 60 * 60 * 1000), status: 'RESCHEDULED', user: { name: 'Exec' } },
    ]);
    const svc = new DashboardService({ $client: {} } as never);
    const result = await svc.getExceptions(ownerActor);
    expect(result.visitRisk[0]!.id).toBe('v-past');
    expect(result.visitRisk[0]!.reason).toBe('overdue-past-due');
    // T-VISIT-RISK-STATUS: the lead's own state rides the row, so the card can
    // SHOW why a visit is listed instead of leaving the operator to guess.
    expect(result.visitRisk[0]!.leadStatus).toBe('NEGOTIATION');
    expect(result.visitRisk[1]!.reason).toBe('scheduled-today');
    expect(result.visitRisk[1]!.leadStatus).toBe('VISIT_SCHEDULED');
    expect(result.visitRisk[1]!.userName).toBe('Exec');
  });

  it('excludes a visit whose lead is already terminal (WON/LOST/RNR)', async () => {
    // THE regression, reported as "lead status is won but this leads shows in
    // visit at risk". Nothing cascades a visit when its lead reaches a terminal
    // state, so a SCHEDULED visit with a past `scheduledFor` outlives the deal
    // and used to sit on the card forever.
    //
    // The filter is asserted on the QUERY (the mock returns whatever the fixture
    // holds, so a post-hoc row filter would not be covered) - the service must
    // narrow server-side, or a 50-row `take` could be filled entirely by stale
    // rows and hide the live ones.
    fixture.visits.push([]);
    const svc = new DashboardService({ $client: {} } as never);
    await svc.getExceptions(ownerActor);

    const findManyArgs = (tx.siteVisit.findMany as Mock).mock.calls[0]![0];
    expect(findManyArgs.where).toMatchObject({
      status: { in: ['SCHEDULED', 'RESCHEDULED'] },
    });
    // The lead-relation filter is what makes the WON lead disappear. It must be
    // exactly the shared terminal trio - not an ad-hoc list.
    expect(findManyArgs.where).toMatchObject({
      lead: { state: { notIn: ['WON', 'LOST', 'RNR'] } },
    });
  });

  it('still lists a RESCHEDULED/NO_SHOW lead - the deal is live, so is the visit', async () => {
    // Guards against over-filtering: re-engagement states are ACTIVE, and a visit
    // on such a lead genuinely needs attention. Only WON/LOST/RNR are excluded.
    fixture.visits.push([
      { id: 'v-re', leadId: 'l-3', lead: { name: 'Re-engage', projectId: 'p-1', state: 'NO_SHOW' }, scheduledFor: daysAgo(2), status: 'RESCHEDULED', user: { name: 'Exec' } },
    ]);
    const svc = new DashboardService({ $client: {} } as never);
    const result = await svc.getExceptions(ownerActor);
    expect(result.visitRisk).toHaveLength(1);
    expect(result.visitRisk[0]!.leadStatus).toBe('NO_SHOW');
  });

  it('T-TOKEN-GATE: a TOKEN booking with NO amount is its own reason, not hold-no-token', async () => {
    // The defect these rows represent: the booking IS marked token-received, and
    // there is nothing recording how much. Reporting it as 'hold-no-token' read
    // as "the money is still with the customer" - backwards, and it hid the rows
    // from anyone looking for them. Naming it separately is what makes them
    // findable and fixable.
    fixture.bookings.push([
      { id: 'b-broken', lead: { name: 'Missing', projectId: 'p-1' }, unit: { unitNumber: 'C3' },
        amount: { toString: () => '4100000.00' }, tokenAmount: null, status: 'TOKEN', createdAt: daysAgo(4) },
    ]);
    const svc = new DashboardService({ $client: {} } as never);
    const result = await svc.getExceptions(ownerActor);
    expect(result.bookingMoney[0]!.reason).toBe('token-recorded-missing-amount');
    expect(result.bookingMoney[0]!.tokenAmount).toBeNull();
  });

  it('T-TOKEN-GATE: a HOLD booking with no token is still hold-no-token', async () => {
    // The new reason must not swallow the legitimate case: a HOLD booking simply
    // has no token yet, which is normal work rather than a data defect.
    fixture.bookings.push([
      { id: 'b-hold', lead: { name: 'Waiting', projectId: 'p-1' }, unit: { unitNumber: 'C4' },
        amount: { toString: () => '5100000.00' }, tokenAmount: null, status: 'HOLD', createdAt: daysAgo(2) },
    ]);
    const svc = new DashboardService({ $client: {} } as never);
    const result = await svc.getExceptions(ownerActor);
    expect(result.bookingMoney[0]!.reason).toBe('hold-no-token');
  });

  it('bookingMoney distinguishes token-paid (awaiting approval) from hold-no-token', async () => {
    fixture.bookings.push([
      { id: 'b-tok', lead: { name: 'Paid', projectId: 'p-1' }, unit: { unitNumber: 'A1' }, amount: { toString: () => '4200000.00' }, tokenAmount: { toString: () => '400000.00' }, status: 'TOKEN', createdAt: daysAgo(3) },
      { id: 'b-hold', lead: { name: 'Unpaid', projectId: 'p-2' }, unit: { unitNumber: 'B2' }, amount: { toString: () => '5100000.00' }, tokenAmount: null, status: 'HOLD', createdAt: daysAgo(5) },
    ]);
    const svc = new DashboardService({ $client: {} } as never);
    const result = await svc.getExceptions(adminActor);
    expect(result.bookingMoney[0]!.id).toBe('b-tok');
    expect(result.bookingMoney[0]!.reason).toBe('token-paid-awaiting-approval');
    expect(result.bookingMoney[0]!.stuckDays).toBe(3);
    expect(result.bookingMoney[1]!.reason).toBe('hold-no-token');
    expect(result.bookingMoney[1]!.unitNumber).toBe('B2');
  });

  it('teamHealth flags a quiet staff member (newest touch >=1 day) and skips active ones', async () => {
    fixture.team.push([
      { userId: 'u-quiet', userName: 'Quiet TC', role: 'TELECALLER', activeLeadCount: 3, maxTouch: daysAgo(4) },
      { userId: 'u-active', userName: 'Active TC', role: 'TELECALLER', activeLeadCount: 2, maxTouch: new Date(NOW.getTime() - 60 * 60 * 1000) },
    ]);
    const svc = new DashboardService({ $client: {} } as never);
    const result = await svc.getExceptions(ownerActor);
    expect(result.teamHealth.length).toBe(1);
    expect(result.teamHealth[0]!.userId).toBe('u-quiet');
    expect(result.teamHealth[0]!.kind).toBe('quiet');
    expect(result.teamHealth[0]!.quietDays).toBe(4);
  });

  it('returns empty arrays (all-clear) when no problems exist', async () => {
    fixture.team.push([]);
    const svc = new DashboardService({ $client: {} } as never);
    const result = await svc.getExceptions(ownerActor);
    expect(result.idleLeads).toEqual([]);
    expect(result.visitRisk).toEqual([]);
    expect(result.bookingMoney).toEqual([]);
    expect(result.teamHealth).toEqual([]);
  });
});
