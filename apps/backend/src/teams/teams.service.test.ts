// Teams service tests - T-Sidebar07 (2026-09-05) + org-Teams (2026-09-10).
//
// Pins:
//   1. withRlsContext is called with the actor's userId, role, teamId
//      (so RLS policies see the right session vars - critical for
//      the Team table which has FORCE RLS).
//   2. list(): filters to rows where the actor appears in the members
//      relation (defense-in-depth on top of the RLS policy); selects
//      id+name+defaultAssigneeId+manager(+name)+_count; orders by name asc.
//      Maps to TeamListItem with rename _count.members->memberCount AND a
//      managerName (null when unassigned).
//   3. getTeam(): ADMIN/OWNER only (403 otherwise); not-found -> 404; returns
//      manager + a simple member list (userId/name/email/role) - no
//      per-member `projects` field (ProjectMember, which that used to be
//      derived from, was retired T-TEAM-AUTHORITATIVE 2026-09-13).
//
// Test strategy: stub withRlsContext to invoke the callback with a
// fake tx that records calls and returns canned rows.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

// Track the tx that withRlsContext hands to the callback so tests
// can introspect what was called.
const txCapture: { current: any } = { current: undefined };

vi.mock('@shadhil/database', () => {
  const allTeamRows = [
    {
      id: 'team-construction',
      name: "Manager (placeholder)'s Team",
      defaultAssigneeId: 'tc-1',
      managerId: 'mgr-1',
      manager: { name: 'Maya Rao' },
      _count: { teamMembers: 4 },
    },
    {
      id: 'team-real-estate',
      name: 'Real Estate Desk',
      defaultAssigneeId: 'se-1',
      managerId: null,
      manager: null,
      _count: { teamMembers: 2 },
    },
  ];
  const tx = {
    team: {
      // T-TEAM-AUTHORITATIVE (2026-09-13): dispatch on the where shape so
      // this one mock serves both TeamAccessService.getManagedTeamIds()
      // (where: { managerId, deletedAt }, select: { id: true } only) and
      // TeamsService.list()'s own final query (where: { deletedAt } or
      // { deletedAt, id: { in } }, with the full select shape).
      findMany: vi.fn(async (args: { where?: { managerId?: string; id?: { in: string[] } } } = {}) => {
        const where = args.where ?? {};
        if (where.managerId !== undefined) {
          return allTeamRows
            .filter((t) => t.managerId === where.managerId)
            .map((t) => ({ id: t.id }));
        }
        if (where.id !== undefined) {
          return allTeamRows.filter((t) => where.id!.in.includes(t.id));
        }
        return allTeamRows;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === 'team-missing') return null;
        if (args.where.id === 'team-real-estate') {
          return {
            id: 'team-real-estate',
            name: 'Real Estate Desk',
            manager: null,
            deletedAt: null,
          };
        }
        return {
          id: 'team-construction',
          name: "Manager (placeholder)'s Team",
          manager: { id: 'mgr-1', name: 'Maya Rao', email: 'maya@x' },
          deletedAt: null,
        };
      }),
    },
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): dispatches on the
    // select shape - TeamAccessService.getOrdinaryMemberTeamIds() asks for
    // `select: { teamId: true }` (no fixtures in this suite hold a
    // TeamMember row, so [] there); getTeam() asks for
    // `select: { user: {...} } }` and gets the roster's ordinary members.
    teamMember: {
      findMany: vi.fn(async (args: { select?: { user?: unknown }; where?: { userId?: string } } = {}) => {
        if (args.select?.user !== undefined) {
          return [
            {
              user: {
                id: 'u-tc',
                name: 'Tele Caller One',
                email: 'tc1@x',
                role: 'TELECALLER',
              },
            },
          ];
        }
        // TeamAccessService.getOrdinaryMemberTeamIds(userId) shape
        // (select: { teamId: true }) - the telecaller fixture is an
        // ordinary member of team-construction via this row.
        if (args.where?.userId === 'tc-1') {
          return [{ teamId: 'team-construction' }];
        }
        return [];
      }),
    },
    user: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === 'mgr-1') {
          return { id: 'mgr-1', name: 'Maya Rao', email: 'maya@x', role: 'MANAGER' };
        }
        return null;
      }),
    },
  };
  return {
    prisma: {},
    rlsContextFrom: vi.fn((actor: {
      sub: string;
      role: string;
      organizationId?: string | null;
    }) => ({
      userId: actor.sub,
      role: actor.role,
      organizationId: actor.organizationId ?? 'ceid01lpfe1esm8jwsxid41k28',
    })),
    withRlsContext: vi.fn(
      async (
        _client: unknown,
        _ctx: unknown,
        callback: (t: typeof tx) => unknown,
      ) => {
        txCapture.current = tx;
        return callback(tx);
      },
    ),
  };
});

import { TeamsService } from './teams.service';
import { withRlsContext } from '@shadhil/database';

const ownerActor: JwtPayload = {
  sub: 'owner-1',
  email: 'owner@shadhilbuilders.in',
  role: 'OWNER',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};

const managerActor: JwtPayload = {
  sub: 'mgr-1',
  email: 'mgr@shadhilbuilders.in',
  role: 'MANAGER',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};

const telecallerActor: JwtPayload = {
  sub: 'tc-1',
  email: 'telecaller@shadhilbuilders.in',
  role: 'TELECALLER',
  organizationId: 'ceid01lpfe1esm8jwsxid41k28',
  iat: 1_000_000,
  exp: 1_000_000 + 3600,
  iss: 'shadhil-bff',
};

describe('TeamsService.list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = undefined;
  });

  it('passes the actor identity to withRlsContext so RLS sees the right session vars', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await svc.list(ownerActor);
    expect(withRlsContext).toHaveBeenCalledTimes(1);
    const ctx = (withRlsContext as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]![1];
    expect(ctx).toEqual({
      userId: 'owner-1',
      role: 'OWNER',
      organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    });
  });

  it('queries teams with the actor in the members relation and the right select shape', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await svc.list(ownerActor);
    const tx = txCapture.current;
    expect(tx).toBeDefined();
    expect(tx.team.findMany).toHaveBeenCalledTimes(1);
    const args = tx.team.findMany.mock.calls[0]![0];
    // OWNER is an overseer: no membership filter (sees every project),
    // just the soft-delete exclusion.
    expect(args.where).toEqual({ deletedAt: null });
    expect(args.select).toMatchObject({
      id: true,
      name: true,
      defaultAssigneeId: true,
      managerId: true,
      manager: { select: { name: true } },
      _count: { select: { teamMembers: true } },
    });
    expect(args.orderBy).toEqual({ name: 'asc' });
  });

  it('scopes non-overseer roles to their team memberships', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await svc.list(telecallerActor);
    const tx = txCapture.current;
    // T-TEAM-AUTHORITATIVE (2026-09-13): the LAST team.findMany call is
    // the final list query - TeamAccessService's own internal
    // findMany calls happen first.
    const lastCall = tx.team.findMany.mock.calls.at(-1)![0];
    expect(lastCall.where).toEqual({ deletedAt: null, id: { in: ['team-construction'] } });
  });

  it('MANAGER sees the union of teams they manage AND their legacy teamId membership', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await svc.list(managerActor);
    const tx = txCapture.current;
    const lastCall = tx.team.findMany.mock.calls.at(-1)![0];
    // managerActor manages team-construction (fixture managerId='mgr-1')
    // AND their own legacy teamId is also team-construction - deduped.
    expect(lastCall.where).toEqual({ deletedAt: null, id: { in: ['team-construction'] } });
  });

  it('maps to TeamListItem with managerName (null when unassigned)', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.list(ownerActor);
    expect(result).toEqual([
      {
        id: 'team-construction',
        name: "Manager (placeholder)'s Team",
        defaultAssigneeId: 'tc-1',
        memberCount: 4,
        managerId: 'mgr-1',
        managerName: 'Maya Rao',
      },
      {
        id: 'team-real-estate',
        name: 'Real Estate Desk',
        defaultAssigneeId: 'se-1',
        memberCount: 2,
        managerId: null,
        managerName: null,
      },
    ]);
  });
});

describe('TeamsService.getTeam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCapture.current = undefined;
  });

  it('forbids staff roles entirely (TELECALLER/SALES_EXEC cannot view any team roster)', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await expect(svc.getTeam(telecallerActor, 'team-construction')).rejects.toThrow(
      /ADMIN, OWNER, or a MANAGER/,
    );
  });

  it('T-TEAM-AUTHORITATIVE: a MANAGER CAN view a team they manage (Work -> My Teams)', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.getTeam(managerActor, 'team-construction');
    expect(result.id).toBe('team-construction');
  });

  it('a MANAGER CANNOT view a team they neither manage nor belong to', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await expect(svc.getTeam(managerActor, 'team-real-estate')).rejects.toThrow(
      /only view a team you manage or belong to/,
    );
  });

  it('throws 404 when the team does not exist', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    await expect(svc.getTeam(ownerActor, 'team-missing')).rejects.toThrow(
      /not found/,
    );
  });

  it('returns manager + members (no per-member projects field - retired with ProjectMember)', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.getTeam(ownerActor, 'team-construction');
    expect(result).toEqual({
      id: 'team-construction',
      name: "Manager (placeholder)'s Team",
      manager: { id: 'mgr-1', name: 'Maya Rao', email: 'maya@x' },
      members: [
        {
          userId: 'u-tc',
          name: 'Tele Caller One',
          email: 'tc1@x',
          role: 'TELECALLER',
        },
      ],
    });
  });

  it('returns a null manager when the team has none', async () => {
    const svc = new TeamsService({ $client: {} } as never);
    const result = await svc.getTeam(ownerActor, 'team-real-estate');
    expect(result.manager).toBeNull();
    // findUnique for real-estate returns manager null; user.findMany default
    // resolves to the u-tc member row.
    expect(result.id).toBe('team-real-estate');
  });
});
