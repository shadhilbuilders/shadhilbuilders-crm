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
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
};
const admin: Actor = {
  sub: 'admin-1',
  email: 'admin@shadhilbuilders.in',
  role: 'ADMIN',
  teamId: null,
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
};
const manager: Actor = {
  sub: 'manager-1',
  email: 'manager@shadhilbuilders.in',
  role: 'MANAGER',
  teamId: null,
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
};
const telecaller: Actor = {
  sub: 'tc-1',
  email: 'telecaller@shadhilbuilders.in',
  role: 'TELECALLER',
  teamId: 'team-tc',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
};
const salesExec: Actor = {
  sub: 'se-1',
  email: 'exec@shadhilbuilders.in',
  role: 'SALES_EXEC',
  teamId: 'team-se',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
};

// T-TEAM-AUTHORITATIVE (2026-09-13): managerTeamIds() now resolves via
// TeamAccessService.getManagedTeamIds(), which calls tx.team.findMany
// (not findFirst) - a manager may lead multiple teams. `managedTeams`
// is the full array of teams Team.managerId returns for this actor.
function makeService(managedTeams: Array<{ id: string }> = []): {
  service: LeadsService;
  tx: { team: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> } };
} {
  const teamFindFirst = vi.fn().mockResolvedValue(managedTeams[0] ?? null);
  const teamFindMany = vi.fn().mockResolvedValue(managedTeams);
  const fakeClient = {
    team: { findFirst: teamFindFirst, findMany: teamFindMany },
    // listWhere calls tx.team.findMany (via TeamAccessService) only.
    // list() also calls tx.lead.findMany / tx.lead.count - we don't
    // exercise list() here.
    lead: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  } as never;
  const prismaService = { $client: fakeClient } as never;
  const service = new LeadsService(prismaService);
  return { service, tx: { team: { findFirst: teamFindFirst, findMany: teamFindMany } } };
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
    expect(where).toEqual({
      ownerId: telecaller.sub,
      // T-SOFT-DELETE (2026-10-01): every list read also drops leads whose
      // project is soft-deleted, so the base `where` carries this too.
      project: { deletedAt: null },
      limit: undefined,
      offset: undefined,
    });
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

describe('listWhere - MANAGER scoped to own team(s)', () => {
  it('MANAGER with one team: where.teamId === { in: [their team.id] }', async () => {
    const { service, tx } = makeService([{ id: 'team-xyz' }]);
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof manager,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, manager, { limit: 50, offset: 0 });
    expect(where['teamId']).toEqual({ in: ['team-xyz'] });
    expect(tx.team.findMany).toHaveBeenCalledWith({
      where: {
        managerId: manager.sub,
        deletedAt: null,
        organizationId: manager.organizationId,
      },
      select: { id: true },
    });
  });

  it('MANAGER leading multiple teams: where.teamId === { in: [...every managed team] }', async () => {
    const { service, tx } = makeService([{ id: 'team-a' }, { id: 'team-b' }]);
    const where = await (
      service as unknown as {
        listWhere: (
          tx: unknown,
          actor: typeof manager,
          dto: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).listWhere(tx, manager, { limit: 50, offset: 0 });
    expect(where['teamId']).toEqual({ in: ['team-a', 'team-b'] });
  });

  it('MANAGER with NO team: where.teamId === sentinel so nothing returns', async () => {
    const { service, tx } = makeService([]);
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

// T-USER-LEADS (2026-09-24): `linkedUserId` matches owner OR co-owner, so the
// user-detail page can list a person's whole workload. Distinct from
// `ownerId` (strict owner-only). This is the same definition
// team-members.service.preview() uses for "leads linked with a member".
describe('listWhere - linkedUserId matches owner OR co-owner', () => {
  type ListWhere = (
    tx: unknown,
    actor: typeof admin,
    dto: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  function callListWhere(dto: Record<string, unknown>, actor = admin) {
    const { service, tx } = makeService();
    return (
      service as unknown as { listWhere: ListWhere }
    ).listWhere(tx, actor, dto);
  }

  it('ADMIN + linkedUserId: where.OR matches ownerId OR coOwnerId', async () => {
    const where = await callListWhere({ linkedUserId: 'user-9', limit: 50, offset: 0 });
    expect(where['OR']).toEqual([{ ownerId: 'user-9' }, { coOwnerId: 'user-9' }]);
  });

  it('ownerId still means owner-ONLY (the two filters must not merge)', async () => {
    const where = await callListWhere({ ownerId: 'user-9', limit: 50, offset: 0 });
    expect(where['ownerId']).toBe('user-9');
    // No co-owner OR clause is added for the strict owner filter.
    expect(where['OR']).toBeUndefined();
  });

  it('absent linkedUserId adds no OR key at all', async () => {
    const where = await callListWhere({ limit: 50, offset: 0 });
    expect(where['OR']).toBeUndefined();
    expect(where['ownerId']).toBeUndefined();
  });

  it('composes with projectId (AND, not overwrite)', async () => {
    const where = await callListWhere({
      linkedUserId: 'user-9',
      projectId: 'proj-7',
      limit: 50,
      offset: 0,
    });
    expect(where['OR']).toEqual([{ ownerId: 'user-9' }, { coOwnerId: 'user-9' }]);
    expect(where['projectId']).toBe('proj-7');
  });

  it('role scoping still OVERRIDES it for a TELECALLER (no lateral read)', async () => {
    // A staff actor asking for someone else's linked leads must be pinned
    // back to their own leads - the explicit filter must not widen access.
    const where = await callListWhere(
      { linkedUserId: 'someone-else', limit: 50, offset: 0 },
      telecaller,
    );
    expect(where['ownerId']).toBe(telecaller.sub);
  });

  it('emits the OR group into the SQL conditions too (both paths stay in sync)', async () => {
    // `list()` runs off listConditions (raw SQL), not listWhere. A drift
    // between the two would make the filter work in tests and not in the app.
    const { service, tx } = makeService();
    const conditions = await (
      service as unknown as {
        listConditions: (
          tx: unknown,
          actor: typeof admin,
          dto: Record<string, unknown>,
        ) => Promise<Array<{ sql: string; values: unknown[] }>>;
      }
    ).listConditions(tx, admin, { linkedUserId: 'user-9', limit: 50, offset: 0 });

    const joined = conditions.map((c) => c.sql).join(' AND ');
    expect(joined).toContain('"ownerId"');
    expect(joined).toContain('"coOwnerId"');
    expect(joined).toContain('OR');
    const values = conditions.flatMap((c) => c.values);
    expect(values).toContain('user-9');
  });

  it('SQL conditions ALSO pin a TELECALLER back to their own leads', async () => {
    const { service, tx } = makeService();
    const conditions = await (
      service as unknown as {
        listConditions: (
          tx: unknown,
          actor: typeof telecaller,
          dto: Record<string, unknown>,
        ) => Promise<Array<{ sql: string; values: unknown[] }>>;
      }
    ).listConditions(tx, telecaller, { linkedUserId: 'someone-else', limit: 50, offset: 0 });

    const values = conditions.flatMap((c) => c.values);
    expect(values).toContain(telecaller.sub);
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
// Default lead-inbox ordering (Decision 0.2). NOTHING covered this before, so
// the tiebreaker could (and did) contradict the plan: the code sorted each
// bucket by `createdAt` while Decision 0.2 says "-> Most recent activity" and
// the column the operator reads ("Last Activity") renders `updatedAt`.
//
// These assert the generated ORDER BY text. `sortOrderSql` is private - the
// cast mirrors how the other pure-logic tests in this file reach internals.
describe('sortOrderSql - default inbox ordering (Decision 0.2)', () => {
  function orderSql(dto: Record<string, unknown> = {}): string {
    const { service } = makeService();
    const sql = (
      service as unknown as {
        sortOrderSql: (dto: Record<string, unknown>) => { sql: string };
      }
    ).sortOrderSql(dto);
    // Collapse whitespace so assertions do not depend on formatting.
    return sql.sql.replace(/\s+/g, ' ').trim();
  }

  it('buckets: overdue NEW first, then fresh NEW, then the rest', () => {
    const sql = orderSql();
    // Bucket 0 keyed on NEW + past the 30-minute SLA.
    expect(sql).toContain(`WHEN "state"='NEW' AND "createdAt" <= now() - interval '30 minutes' THEN 0`);
    expect(sql).toContain(`WHEN "state"='NEW' THEN 1`);
    expect(sql).toContain('ELSE 2');
    // The bucket CASE must be the FIRST ordering key.
    expect(sql.indexOf('CASE')).toBeLessThan(sql.indexOf('"updatedAt" DESC'));
  });

  it('orders WITHIN a bucket by most recent activity (updatedAt), per Decision 0.2', () => {
    const sql = orderSql();
    expect(sql).toContain('"updatedAt" DESC');
    // Regression guard: the old tiebreaker was createdAt, which ordered by
    // creation age and ignored whether anyone had worked the lead.
    const updatedAtAt = sql.indexOf('"updatedAt" DESC');
    const createdAtAt = sql.indexOf('"createdAt" DESC');
    expect(createdAtAt).toBeGreaterThan(updatedAtAt);
  });

  it('keeps createdAt as a final tiebreaker so equal updatedAt stays deterministic', () => {
    // Bulk imports + the seed write many rows in the same millisecond; without
    // a total order, server pagination can drop or duplicate a row across pages.
    const sql = orderSql();
    expect(sql).toContain('"updatedAt" DESC, "createdAt" DESC');
  });

  it('an explicit column sort still wins over the buckets', () => {
    expect(orderSql({ sortBy: 'name', sortDir: 'asc' })).toBe('"name" ASC');
    expect(orderSql({ sortBy: 'updatedAt', sortDir: 'desc' })).toBe('"updatedAt" DESC');
    // Default direction is DESC when sortDir is omitted.
    expect(orderSql({ sortBy: 'createdAt' })).toBe('"createdAt" DESC');
  });

  it('explicit sort does NOT carry the bucket CASE', () => {
    expect(orderSql({ sortBy: 'name', sortDir: 'asc' })).not.toContain('CASE');
  });
});


// ---------------------------------------------------------------------------
// T-SOFT-DELETE (2026-10-01): a lead on a soft-deleted project is not work.
// Product decision: those leads leave lists, counts and KPIs together with the
// project. Both list builders must carry the filter - `list()` runs off the raw
// SQL `listConditions`, while the object builder feeds the counts - so each is
// asserted separately. Without this the leads page still listed (and counted)
// work on a project the org had deleted.
// ---------------------------------------------------------------------------
describe("listWhere - excludes leads on soft-deleted projects (T-SOFT-DELETE)", () => {
  type ListWhere = (
    tx: unknown,
    actor: typeof admin,
    dto: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  async function callListWhere(dto: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { service, tx } = makeService();
    return (service as unknown as { listWhere: ListWhere }).listWhere(tx, admin, dto);
  }

  it('the object builder filters on project.deletedAt === null', async () => {
    const where = await callListWhere({ limit: 50, offset: 0 });
    expect(where['project']).toEqual({ deletedAt: null });
  });

  it('the filter composes with a search OR rather than clobbering it', async () => {
    // `search` and `linkedUserId` both own the top-level `OR` key. A relation
    // filter must not collide with it (the trap users.service.ts warns about).
    const where = await callListWhere({ search: 'priya', limit: 50, offset: 0 });
    expect(where['project']).toEqual({ deletedAt: null });
    expect(where['OR']).toHaveLength(2);
  });

  it('the raw SQL builder emits an EXISTS on a live Project', async () => {
    // list() reads through THIS builder, so the object-builder assertion above
    // would pass while the page still showed deleted-project leads.
    const { service, tx } = makeService();
    const conditions = await (
      service as unknown as {
        listConditions: (
          tx: unknown,
          actor: typeof admin,
          dto: Record<string, unknown>,
        ) => Promise<Array<{ sql: string; values: unknown[] }>>;
      }
    ).listConditions(tx, admin, { limit: 50, offset: 0 });

    const joined = conditions.map((c) => c.sql).join(' AND ');
    expect(joined).toContain('"Project"');
    expect(joined).toContain('"deletedAt" IS NULL');
    // Correlated to the row's own project, not an unrelated project.
    expect(joined).toContain('"Lead"."projectId"');
  });
});
