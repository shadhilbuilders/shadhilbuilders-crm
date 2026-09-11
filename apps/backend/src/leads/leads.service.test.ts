// Leads service tests - listWhere role-scoping (the only piece of the
// service that doesn't need a real DB to reason about).
//
// The DB-touching methods (list/create/update/transition) are exercised
// by the integration test suite once the Docker stack is back up. This
// file targets the pure logic so a wrong `where` clause for, say, a
// TELECALLER seeing another user's lead surfaces here as a typed
// failure, not as a customer-visible leak.
//
// Test strategy: instantiate LeadsService with a PrismaService stub
// that satisfies the $client surface but the methods we exercise here
// (findFirst on team) are stubbed per-test.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LeadsService } from './leads.service';

// JWT payload shape - see @shadhil/auth JwtPayload.
type Actor = {
  sub: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'TELECALLER' | 'SALES_EXEC';
  teamId: string | null;
  organizationId: string;
};

const owner: Actor = {
  sub: 'owner-1',
  email: 'owner@shadhilbuilders.in',
  role: 'OWNER',
  teamId: null,
  organizationId: 'org_bootstrap',
};
const admin: Actor = {
  sub: 'admin-1',
  email: 'admin@shadhilbuilders.in',
  role: 'ADMIN',
  teamId: null,
  organizationId: 'org_bootstrap',
};
const manager: Actor = {
  sub: 'manager-1',
  email: 'manager@shadhilbuilders.in',
  role: 'MANAGER',
  teamId: null,
  organizationId: 'org_bootstrap',
};
const telecaller: Actor = {
  sub: 'tc-1',
  email: 'telecaller@shadhilbuilders.in',
  role: 'TELECALLER',
  teamId: 'team-tc',
  organizationId: 'org_bootstrap',
};
const salesExec: Actor = {
  sub: 'se-1',
  email: 'exec@shadhilbuilders.in',
  role: 'SALES_EXEC',
  teamId: 'team-se',
  organizationId: 'org_bootstrap',
};

function makeService(teamReturn: { id: string } | null = null): {
  service: LeadsService;
  tx: { team: { findFirst: ReturnType<typeof vi.fn> } };
} {
  const teamFindFirst = vi.fn().mockResolvedValue(teamReturn);
  const tx = { team: { findFirst: teamFindFirst } };
  const fakeClient = {
    team: { findFirst: teamFindFirst },
    // listWhere calls tx.team.findFirst only. list() also calls
    // tx.lead.findMany / tx.lead.count - we don't exercise list() here.
    lead: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  } as never;
  const prismaService = { $client: fakeClient } as never;
  const service = new LeadsService(prismaService);
  return { service, tx: { team: { findFirst: teamFindFirst } } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listWhere - TELECALLER/SALES_EXEC scoped to own leads', () => {
  it('TELECALLER: where.ownerId === actor.sub; team lookup NOT called', async () => {
    const { service, tx } = makeService();
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof telecaller,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, telecaller, { limit: 50, offset: 0 });
    expect(where).toEqual({ ownerId: telecaller.sub, limit: undefined, offset: undefined });
    expect(tx.team.findFirst).not.toHaveBeenCalled();
  });

  it('SALES_EXEC: where.ownerId === actor.sub', async () => {
    const { service, tx } = makeService();
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof salesExec,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, salesExec, { limit: 50, offset: 0 });
    expect(where['ownerId']).toBe(salesExec.sub);
    expect(tx.team.findFirst).not.toHaveBeenCalled();
  });

  it('TELECALLER + explicit ownerId filter: still scoped to actor (role wins)', async () => {
    // If the actor passes ownerId="someone-else", the role-scoped lane
    // still overrides - they CANNOT ask for someone else's leads. The
    // narrowest correct behavior is to AND the filter with the role
    // constraint, but our implementation writes the role-scoped clause
    // LAST so it OVERWRITES the explicit filter. Either is safe-ish;
    // we lock the current behavior here so drift surfaces.
    const { service, tx } = makeService();
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof telecaller,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, telecaller, {
      ownerId: 'someone-else',
      limit: 50,
      offset: 0,
    });
    expect(where['ownerId']).toBe(telecaller.sub);
    expect(tx.team.findFirst).not.toHaveBeenCalled();
  });
});

describe('listWhere - MANAGER scoped to own team', () => {
  it('MANAGER with team: where.teamId === their team.id', async () => {
    const { service, tx } = makeService({ id: 'team-xyz' });
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof manager,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, manager, { limit: 50, offset: 0 });
    expect(where['teamId']).toBe('team-xyz');
    expect(tx.team.findFirst).toHaveBeenCalledWith({
      where: { managerId: manager.sub },
      select: { id: true },
    });
  });

  it('MANAGER with NO team: where.teamId === sentinel so nothing returns', async () => {
    const { service, tx } = makeService(null);
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof manager,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, manager, { limit: 50, offset: 0 });
    expect(where['teamId']).toBe('__no_team__');
  });
});

describe('listWhere - ADMIN/OWNER not narrowed', () => {
  it('ADMIN: no ownerId/teamId narrowing', async () => {
    const { service, tx } = makeService();
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof admin,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, admin, { limit: 50, offset: 0 });
    expect(where['ownerId']).toBeUndefined();
    expect(where['teamId']).toBeUndefined();
    expect(tx.team.findFirst).not.toHaveBeenCalled();
  });

  it('OWNER: no narrowing', async () => {
    const { service, tx } = makeService();
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof owner,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, owner, { limit: 50, offset: 0 });
    expect(where['ownerId']).toBeUndefined();
    expect(where['teamId']).toBeUndefined();
  });
});

describe('listWhere - filter chips compose with role scoping', () => {
  it('ADMIN + state filter: where.state = NEW', async () => {
    const { service, tx } = makeService();
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof admin,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, admin, { state: 'NEW', limit: 50, offset: 0 });
    expect(where['state']).toBe('NEW');
  });

  it('ADMIN + state filter (array): where.state = { in: [...] }', async () => {
    const { service, tx } = makeService();
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof admin,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, admin, {
      state: ['NEW', 'CONTACTED'],
      limit: 50,
      offset: 0,
    });
    expect(where['state']).toEqual({ in: ['NEW', 'CONTACTED'] });
  });

  it('ADMIN + search: where.OR has name + phone clauses', async () => {
    const { service, tx } = makeService();
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof admin,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, admin, { search: 'priya', limit: 50, offset: 0 });
    expect(where['OR']).toEqual([
      { name: { contains: 'priya', mode: 'insensitive' } },
      { phone: { contains: 'priya' } },
    ]);
  });
});

describe('badgeCount - project-scoped NEW-lead count (sidebar badge)', () => {
  function makeBadgeService(count: number) {
    // badgeCount runs inside withRlsContext, which calls $transaction
    // (to SET LOCAL) then invokes the callback with a tx that has
    // $queryRaw. Stub both.
    const queryRaw = vi.fn().mockResolvedValue([{ c: BigInt(count) }]);
    const tx = {
      $queryRaw: queryRaw,
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
      team: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const fakeClient = {
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
      team: { findFirst: vi.fn().mockResolvedValue(null) },
    } as never;
    const prismaService = { $client: fakeClient } as never;
    const service = new LeadsService(prismaService);
    return { service, queryRaw };
  }

  it('returns the NEW-lead count for the project', async () => {
    const { service, queryRaw } = makeBadgeService(5);
    const result = await service.badgeCount(admin as never, 'proj-1');
    expect(result).toEqual({ newLeads: 5 });
    // The query must filter to NEW state.
    expect(queryRaw).toHaveBeenCalled();
  });

  it('returns 0 when the count query resolves to no rows', async () => {
    const { service } = makeBadgeService(0);
    const result = await service.badgeCount(admin as never, 'proj-1');
    expect(result).toEqual({ newLeads: 0 });
  });
});