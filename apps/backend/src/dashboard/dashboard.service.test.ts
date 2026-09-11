// Dashboard service tests - autoplan 2026-09-08.
//
// Pins:
//   1. Role scoping: TELECALLER/SALES_EXEC see own leads (ownerId=actor.sub),
//      MANAGER sees team (via managerTeamId lookup), ADMIN/OWNER see all.
//   2. projectId filter applied to lead/visit/booking where clauses.
//   3. noShowRate guards divide-by-zero → 0.
//   4. avgTimeToFirstTouch null when no activity rows.
//   5. leadsOverTime + visitsThisWeek zero-fill missing days.
//   6. bookingsByStatus + teamPerformance owner-name join.
//
// Test strategy: stub withRlsContext to invoke the callback with a fake tx
// that records calls and returns canned rows (same as projects.service.test.ts).
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

import { DashboardService } from './dashboard.service';
import { withRlsContext } from '@shadhil/database';

type MockArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  by?: string[];
  _count?: Record<string, unknown>;
  select?: Record<string, unknown>;
};

type GroupByRow = {
  state?: string;
  source?: string | null;
  ownerId?: string;
  status?: string;
  role?: string;
  createdAt?: Date;
  _count?: { _all: number };
};

type MockTx = {
  lead: {
    count: Mock<(args: MockArgs) => Promise<number>>;
    groupBy: Mock<(args: MockArgs) => Promise<GroupByRow[]>>;
  };
  siteVisit: {
    count: Mock<(args: MockArgs) => Promise<number>>;
    findMany: Mock<(args: MockArgs) => Promise<Array<{ status: string; scheduledFor: Date }>>>;
  };
  booking: {
    count: Mock<(args: MockArgs) => Promise<number>>;
    groupBy: Mock<(args: MockArgs) => Promise<GroupByRow[]>>;
  };
  user: {
    findMany: Mock<(args: MockArgs) => Promise<Array<{ id: string; name: string }>>>;
    groupBy: Mock<(args: MockArgs) => Promise<GroupByRow[]>>;
  };
  team: {
    findFirst: Mock<(args: MockArgs) => Promise<{ id: string } | null>>;
  };
  auditLog: {
    count: Mock<(args: MockArgs) => Promise<number>>;
    groupBy: Mock<(args: MockArgs) => Promise<GroupByRow[]>>;
  };
  $queryRaw: Mock<(query: unknown) => Promise<Array<{ deltaMin: number | null }>>>;
};

const txCapture: { current: MockTx | undefined } = { current: undefined };

function makeTx(overrides: {
  leadCount?: number;
  teamId?: string | null;
  deltaMin?: number | null;
  visitStatuses?: Array<{ status: string; scheduledFor: Date }>;
}): MockTx {
  const now = new Date();
  return {
    lead: {
      count: vi.fn(async () => overrides.leadCount ?? 0),
      groupBy: vi.fn(async (args: MockArgs) => {
        const by = (args.by ?? []) as string[];
        if (by.includes('state')) {
          return [
            { state: 'NEW', _count: { _all: 3 } },
            { state: 'WON', _count: { _all: 1 } },
          ];
        }
        if (by.includes('source')) {
          return [
            { source: 'META_AD', _count: { _all: 2 } },
            { source: null, _count: { _all: 1 } },
          ];
        }
        if (by.includes('ownerId')) {
          return [
            { ownerId: 'owner-1', _count: { _all: 4 } },
            { ownerId: 'owner-2', _count: { _all: 2 } },
          ];
        }
        if (by.includes('createdAt')) {
          return [
            { createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000), _count: { _all: 5 } },
          ];
        }
        return [];
      }),
    },
    siteVisit: {
      count: vi.fn(async () => 2),
      findMany: vi.fn(async () => overrides.visitStatuses ?? []),
    },
    booking: {
      count: vi.fn(async () => 1),
      groupBy: vi.fn(async () => [
        { status: 'HOLD', _count: { _all: 1 } },
        { status: 'APPROVED', _count: { _all: 2 } },
      ]),
    },
    user: {
      findMany: vi.fn(async () => [
        { id: 'owner-1', name: 'Priya' },
        { id: 'owner-2', name: 'Arjun' },
      ]),
      groupBy: vi.fn(async (args: MockArgs) => {
        const by = (args.by ?? []) as string[];
        if (by.includes('role')) {
          return [
            { role: 'ADMIN', _count: { _all: 1 } },
            { role: 'MANAGER', _count: { _all: 2 } },
          ];
        }
        return [];
      }),
    },
    team: {
      findFirst: vi.fn(async () =>
        overrides.teamId === undefined ? { id: 'team-1' } : overrides.teamId === null ? null : { id: overrides.teamId },
      ),
    },
    auditLog: {
      count: vi.fn(async () => 3),
      groupBy: vi.fn(async () => [
        { createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000), _count: { _all: 2 } },
      ]),
    },
    $queryRaw: vi.fn(async () =>
      overrides.deltaMin === undefined
        ? [{ deltaMin: 45 }]
        : [{ deltaMin: overrides.deltaMin }],
    ),
  } as unknown as MockTx;
}

vi.mock('@shadhil/database', () => {
  return {
    prisma: {},
    rlsContextFrom: vi.fn((actor: {
      sub: string;
      role: string;
      teamId: string | null;
      organizationId?: string | null;
    }) => ({
      userId: actor.sub,
      role: actor.role,
      teamId: actor.teamId,
      organizationId: actor.organizationId ?? 'org_bootstrap',
    })),
    Prisma: {
      raw: (sql: string) => sql,
    },
    withRlsContext: vi.fn(
      async (
        _client: unknown,
        _ctx: unknown,
        callback: (t: unknown) => unknown,
      ) => {
        return callback(txCapture.current);
      },
    ),
  };
});

const ownerActor: JwtPayload = {
  sub: 'owner-1',
  email: 'owner@shadhilbuilders.in',
  role: 'OWNER',
  teamId: null,
  organizationId: 'org_bootstrap',
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};

const adminActor: JwtPayload = { ...ownerActor, sub: 'admin-1', role: 'ADMIN' };
const managerActor: JwtPayload = { ...ownerActor, sub: 'mgr-1', role: 'MANAGER' };
const telecallerActor: JwtPayload = { ...ownerActor, sub: 'tc-1', role: 'TELECALLER' };

describe('DashboardService.getStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = makeTx({});
  });

  it('ADMIN sees all leads (no owner/team narrowing)', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const tx = txCapture.current!;
    await svc.getStats(adminActor, {});
    const leadCountArgs = tx.lead.count.mock.calls[0]![0] as MockArgs;
    expect(leadCountArgs.where).not.toHaveProperty('ownerId');
    expect(leadCountArgs.where).not.toHaveProperty('teamId');
  });

  it('TELECALLER sees only own leads (ownerId=actor.sub)', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const tx = txCapture.current!;
    await svc.getStats(telecallerActor, {});
    const leadCountArgs = tx.lead.count.mock.calls[0]![0] as MockArgs;
    expect(leadCountArgs.where).toMatchObject({ ownerId: 'tc-1' });
  });

  it('MANAGER sees team leads (via managerTeamId lookup)', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const tx = txCapture.current!;
    await svc.getStats(managerActor, {});
    const leadCountArgs = tx.lead.count.mock.calls[0]![0] as MockArgs;
    expect(leadCountArgs.where).toMatchObject({ teamId: 'team-1' });
  });

  it('projectId filter is applied to the lead where clause', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const tx = txCapture.current!;
    await svc.getStats(adminActor, { projectId: 'proj-metro' });
    const leadCountArgs = tx.lead.count.mock.calls[0]![0] as MockArgs;
    expect(leadCountArgs.where).toMatchObject({ projectId: 'proj-metro' });
  });

  it('noShowRate guards divide-by-zero → 0 when no outcomes logged', async () => {
    txCapture.current = makeTx({ visitStatuses: [] });
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getStats(adminActor, {});
    expect(stats.kpis.noShowRate).toBe(0);
  });

  it('noShowRate computes NO_SHOW / (COMPLETED + NO_SHOW)', async () => {
    txCapture.current = makeTx({
      visitStatuses: [
        { status: 'COMPLETED', scheduledFor: new Date() },
        { status: 'COMPLETED', scheduledFor: new Date() },
        { status: 'NO_SHOW', scheduledFor: new Date() },
      ],
    });
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getStats(adminActor, {});
    expect(stats.kpis.noShowRate).toBeCloseTo(33.33, 1);
  });

  it('avgTimeToFirstTouch is null when no activity rows exist', async () => {
    txCapture.current = makeTx({ deltaMin: null });
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getStats(adminActor, {});
    expect(stats.kpis.avgTimeToFirstTouch).toBeNull();
  });

  it('avgTimeToFirstTouch returns rounded minutes when activity exists', async () => {
    txCapture.current = makeTx({ deltaMin: 45.6 });
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getStats(adminActor, {});
    expect(stats.kpis.avgTimeToFirstTouch).toBe(46);
  });

  it('leadsOverTime zero-fills to 14 days', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getStats(adminActor, {});
    expect(stats.leadsOverTime).toHaveLength(14);
    // The one seeded bucket (yesterday) has count 5; the rest are 0.
    const withData = stats.leadsOverTime.filter((b) => b.count > 0);
    expect(withData.length).toBeGreaterThanOrEqual(1);
  });

  it('visitsThisWeek zero-fills to 7 days (Mon-Sun)', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getStats(adminActor, {});
    expect(stats.visitsThisWeek).toHaveLength(7);
  });

  it('teamPerformance joins owner names', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getStats(adminActor, {});
    const byOwner = stats.teamPerformance.find((t) => t.ownerId === 'owner-1');
    expect(byOwner?.ownerName).toBe('Priya');
    expect(byOwner?.count).toBe(4);
  });

  it('bookingsByStatus returns status buckets', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getStats(adminActor, {});
    expect(stats.bookingsByStatus).toEqual([
      { status: 'HOLD', count: 1 },
      { status: 'APPROVED', count: 2 },
    ]);
  });

  it('leadSources filters out null sources', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getStats(adminActor, {});
    expect(stats.leadSources).toEqual([{ source: 'META_AD', count: 2 }]);
  });
});

describe('DashboardService.getOverviewStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = makeTx({});
  });

  it('ADMIN can view the cross-project overview', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getOverviewStats(adminActor);
    expect(stats.kpis.totalLeads).toBe(0);
    expect(stats.kpis.reassignments7d).toBe(3);
    expect(stats.kpis.auditEvents24h).toBe(3);
    expect(stats.kpis.usersByRole).toEqual([
      { role: 'ADMIN', count: 1 },
      { role: 'MANAGER', count: 2 },
    ]);
  });

  it('OWNER can view the cross-project overview', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getOverviewStats(ownerActor);
    expect(stats.kpis.totalLeads).toBe(0);
  });

  it('MANAGER is rejected with 403 (overview is admin/owner only)', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    await expect(svc.getOverviewStats(managerActor)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('TELECALLER is rejected with 403', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    await expect(svc.getOverviewStats(telecallerActor)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('pipeline + visitsThisWeek + auditTimeline are zero-filled', async () => {
    const svc = new DashboardService({ $client: {} } as never);
    const stats = await svc.getOverviewStats(adminActor);
    expect(stats.pipeline).toEqual([
      { status: 'NEW', count: 3 },
      { status: 'WON', count: 1 },
    ]);
    expect(stats.visitsThisWeek).toHaveLength(7);
    // auditTimeline is the 90-day series backing the /overview interactive
    // area chart (7d/30d/90d ranges are filtered client-side).
    expect(stats.auditTimeline).toHaveLength(90);
  });
});
